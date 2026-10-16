// Grok (xAI) token refresh: single-flight per token, early refresh with a stable per-account
// jitter, refresh-token retention when the IdP does not rotate, persist-before-resolve.
// Mechanism follows grok-build 1.0.45 xai-grok-login/src (oidc/protocol.rs:413-520,
// oidc/refresh.rs:21-27,260-264, model.rs:9). grok-build retries transient failures in place
// (3 attempts); qgrid does not, because the dispatcher owns the per-request attempt budget.
import { createHash } from "node:crypto";

import { getLogger } from "@logtape/logtape";

import { grokShellUserAgent } from "./grok-headers";
import {
  type GrokFetch,
  GrokTokenResponse,
  getGrokOAuthEndpoints,
  readGrokOAuthErrorCode,
} from "./grok-oauth";
import {
  GrokCredentials,
  type GrokRefreshResult,
  type GrokRefresher,
  type GrokTokenRef,
  decodeGrokJwt,
} from "./grok-types";

const logger = getLogger(["qgrid", "grok-refresh"]);

/** model.rs:9 DEFAULT_EARLY_INVALIDATION_SECS. */
export const GROK_REFRESH_MARGIN_MS = 300_000;
/** Upper bound of the per-account jitter added to the margin (inclusive). */
export const GROK_REFRESH_JITTER_MAX_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

/** oidc/refresh.rs:21-27: the only codes that end a refresh token's life. */
const TERMINAL_ERROR_CODES = new Set(["invalid_grant", "invalid_client"]);

/** The refresh token is dead; only a new login recovers. Never retry. */
export class GrokReauthRequiredError extends Error {
  override readonly name = "GrokReauthRequiredError";
  constructor(
    readonly oauthError: string,
    readonly status: number,
  ) {
    super(`Grok refresh rejected: HTTP ${status} ${oauthError}`);
  }
}

/** Network failure, timeout, 5xx, 429, or an unrecognized error; the refresh token still lives. */
export class GrokRefreshTransientError extends Error {
  override readonly name = "GrokRefreshTransientError";
  constructor(
    message: string,
    readonly status?: number,
    readonly oauthError?: string,
  ) {
    super(message);
  }
}

/** Stable jitter in [0, 60 s] derived from a per-account seed. */
export function grokRefreshJitterMs(seed: string): number {
  const digest = createHash("sha256").update(`grok-refresh:${seed}`).digest();
  return digest.readUInt32BE(0) % (GROK_REFRESH_JITTER_MAX_MS + 1);
}

/** True once `expiresAt - 300 s - jitter(userId)` is at or before `now`. */
export function grokNeedsRefresh(credentials: GrokCredentials, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - GROK_REFRESH_MARGIN_MS - grokRefreshJitterMs(credentials.userId) <= now;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type GrokPersistCredentials = (next: GrokCredentials) => Promise<void>;

export interface GrokRefreshCoordinatorOptions {
  fetch?: GrokFetch;
  now?: () => number;
  /** Persistence used by the `GrokRefresher` port methods (`ensureFresh`, `refreshAfterUnauthorized`). */
  persist?: (tokenId: number, next: GrokCredentials) => Promise<void>;
}

export class GrokRefreshCoordinator implements GrokRefresher {
  private readonly fetchImpl: GrokFetch;
  private readonly now: () => number;
  private readonly persistPort: GrokRefreshCoordinatorOptions["persist"];
  private readonly inflight = new Map<number, Promise<GrokCredentials>>();
  // Last credentials this process persisted per token. A caller holding an older snapshot must not
  // present a refresh token the IdP has already rotated away (that reads as invalid_grant).
  private readonly latest = new Map<number, GrokCredentials>();

  constructor(options: GrokRefreshCoordinatorOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.persistPort = options.persist;
  }

  needsRefresh(credentials: GrokCredentials, now: number = this.now()): boolean {
    return grokNeedsRefresh(credentials, now);
  }

  /**
   * Refreshes `tokenId`, coalescing concurrent calls into one HTTP request. Resolves only after
   * `persist` has stored the new credentials.
   */
  refresh(
    tokenId: number,
    credentials: GrokCredentials,
    persist: GrokPersistCredentials,
  ): Promise<GrokCredentials> {
    const existing = this.inflight.get(tokenId);
    if (existing) return existing;
    const promise = this.doRefresh(tokenId, this.newest(tokenId, credentials), persist).finally(
      () => this.inflight.delete(tokenId),
    );
    this.inflight.set(tokenId, promise);
    return promise;
  }

  async ensureFresh(token: GrokTokenRef, signal?: AbortSignal): Promise<GrokCredentials> {
    const current = this.newest(token.tokenId, token.credentials);
    if (!this.needsRefresh(current)) return current;
    return abortable(this.refresh(token.tokenId, current, this.portPersist(token.tokenId)), signal);
  }

  async refreshAfterUnauthorized(
    token: GrokTokenRef,
    signal?: AbortSignal,
  ): Promise<GrokRefreshResult> {
    const inflight = this.inflight.get(token.tokenId);
    const latest = this.latest.get(token.tokenId);
    // Another caller already replaced the rejected access token: reuse it instead of refreshing.
    if (
      !inflight &&
      latest &&
      latest.accessToken !== token.credentials.accessToken &&
      !this.needsRefresh(latest)
    )
      return { status: "refreshed", credentials: latest };
    try {
      const credentials = await abortable(
        this.refresh(token.tokenId, token.credentials, this.portPersist(token.tokenId)),
        signal,
      );
      return { status: "refreshed", credentials };
    } catch (error) {
      if (error instanceof GrokReauthRequiredError)
        return { status: "reauth_required", reason: error.oauthError };
      throw error;
    }
  }

  private portPersist(tokenId: number): GrokPersistCredentials {
    const persist = this.persistPort;
    if (!persist)
      return () =>
        Promise.reject(new Error("GrokRefreshCoordinator was created without a persist port"));
    return (next) => persist(tokenId, next);
  }

  private newest(tokenId: number, credentials: GrokCredentials): GrokCredentials {
    const latest = this.latest.get(tokenId);
    if (!latest || latest.userId !== credentials.userId) return credentials;
    return Date.parse(latest.expiresAt) > Date.parse(credentials.expiresAt) ? latest : credentials;
  }

  private async doRefresh(
    tokenId: number,
    credentials: GrokCredentials,
    persist: GrokPersistCredentials,
  ): Promise<GrokCredentials> {
    const { tokenEndpoint } = await getGrokOAuthEndpoints({
      fetch: this.fetchImpl,
      now: this.now,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(tokenEndpoint, {
        method: "POST",
        // oidc/protocol.rs:493-512: form body only; the shared client contributes the UA.
        headers: {
          "user-agent": grokShellUserAgent(),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams([
          ["grant_type", "refresh_token"],
          ["refresh_token", credentials.refreshToken],
          ["client_id", credentials.clientId],
        ]),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown";
      logger.warn(`grok refresh network failure token=${tokenId} reason=${reason}`);
      throw new GrokRefreshTransientError(`Grok refresh request failed (${reason})`);
    }

    if (!response.ok) {
      const oauthError = await readGrokOAuthErrorCode(response);
      logger.warn(
        `grok refresh failed token=${tokenId} status=${response.status} code=${oauthError ?? "unknown"}`,
      );
      // oidc/protocol.rs:413-430: 5xx and 429 are always transient; otherwise only a terminal code
      // ends the token.
      if (
        response.status < 500 &&
        response.status !== 429 &&
        oauthError !== undefined &&
        TERMINAL_ERROR_CODES.has(oauthError)
      )
        throw new GrokReauthRequiredError(oauthError, response.status);
      throw new GrokRefreshTransientError(
        `Grok refresh failed: HTTP ${response.status} ${oauthError ?? "unknown"}`,
        response.status,
        oauthError,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GrokRefreshTransientError("Grok refresh response is not JSON", response.status);
    }
    const tokens = GrokTokenResponse.safeParse(body);
    if (!tokens.success)
      throw new GrokRefreshTransientError(
        "Grok refresh response failed validation",
        response.status,
      );

    const rotated = Boolean(tokens.data.refresh_token);
    const exp = decodeGrokJwt(tokens.data.access_token)?.payload.exp;
    const expiresAtMs =
      typeof tokens.data.expires_in === "number"
        ? this.now() + tokens.data.expires_in * 1000
        : typeof exp === "number"
          ? exp * 1000
          : undefined;
    if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs))
      throw new GrokRefreshTransientError("Grok refresh response has no expiry", response.status);

    const next = GrokCredentials.safeParse({
      ...credentials,
      accessToken: tokens.data.access_token,
      // oidc/refresh.rs:260-264: keep the old refresh token when the IdP did not rotate it.
      refreshToken: tokens.data.refresh_token ?? credentials.refreshToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    if (!next.success) {
      logger.error(
        `grok refresh returned unusable credentials token=${tokenId} rotated=${rotated}`,
      );
      throw new GrokRefreshTransientError(
        "Grok refresh returned an access token that is not an auth.x.ai at+jwt",
        response.status,
      );
    }

    try {
      await persist(next.data);
    } catch (error) {
      // A rotated refresh token that is not persisted is lost: the next refresh with the old one
      // fails with invalid_grant. Keep it in memory so this process can still use it.
      if (rotated) this.latest.set(tokenId, next.data);
      logger.error(
        `grok refresh persist FAILED token=${tokenId} rotated=${rotated} err=${error instanceof Error ? error.name : "unknown"}`,
      );
      throw error;
    }
    this.latest.set(tokenId, next.data);
    logger.info(`grok token ${tokenId} refreshed (rotated=${rotated})`);
    return next.data;
  }
}
