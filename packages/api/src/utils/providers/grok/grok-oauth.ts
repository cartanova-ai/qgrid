// Grok (xAI) login: OIDC discovery, PKCE authorize URL, loopback/paste code exchange, RFC 8628
// device code, and the post-login identity lookup. Mechanism follows grok-build 1.0.45
// crates/codegen/xai-grok-login/src (oidc/protocol.rs, oidc/login.rs, device_code.rs).
// Error messages never carry response bodies: token endpoints can echo credentials.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  GROK_AUTH_ISSUER,
  GROK_BUILD_VERSION,
  GROK_CHAT_PROXY_URL,
  GROK_DEVICE_CODE_URL,
  GROK_DEVICE_TOKEN_URL,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_REFERRER,
  GROK_OAUTH_SCOPES,
} from "./grok-constants";
import { buildGrokProxyGetHeaders, grokShellUserAgent } from "./grok-headers";
import {
  GrokCredentials,
  GrokUserSubscription,
  decodeGrokJwt,
  isGrokAccessToken,
} from "./grok-types";

export type GrokFetch = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GrokOAuthErrorCode =
  | "invalid_callback_input"
  | "authorization_failed"
  | "state_mismatch"
  | "token_exchange_failed"
  | "invalid_token_response"
  | "invalid_access_token"
  | "missing_refresh_token"
  | "missing_expiry"
  | "user_id_unresolved"
  | "user_lookup_failed"
  | "invalid_credentials"
  | "device_flow_not_enabled"
  | "device_code_failed"
  | "invalid_device_code_response"
  | "device_token_failed"
  | "access_denied"
  | "expired_token";

/** Login failure. `retryable` marks network/5xx failures where the same step may be retried. */
export class GrokOAuthError extends Error {
  override readonly name = "GrokOAuthError";
  constructor(
    readonly code: GrokOAuthErrorCode,
    message: string,
    readonly options: { status?: number; oauthError?: string; retryable?: boolean } = {},
  ) {
    super(message);
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  /** OAuth `error` code, only when it is a plain lowercase identifier. */
  get oauthError(): string | undefined {
    return this.options.oauthError;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface GrokOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  source: "discovery" | "fallback";
}

// grok-build caches 1 h (oidc/protocol.rs:269) and has no fallback (discovery errors abort the
// login, protocol.rs:279-302). qgrid caches 24 h and falls back to fixed paths: the token path
// is the one grok-build itself hard-codes for the device grant (device_code.rs:187); the
// authorize path is not present in the source and is unverified.
export const GROK_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;
export const GROK_FALLBACK_AUTHORIZATION_ENDPOINT = `${GROK_AUTH_ISSUER}/oauth2/authorize`;
export const GROK_FALLBACK_TOKEN_ENDPOINT = `${GROK_AUTH_ISSUER}/oauth2/token`;

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;
const USER_LOOKUP_TIMEOUT_MS = 15_000;

const DiscoveryDocument = z.looseObject({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
});

let discoveryCache: { endpoints: GrokOAuthEndpoints; fetchedAt: number } | undefined;

/** Clears the module-level discovery cache (tests and operator resets). */
export function resetGrokDiscoveryCache(): void {
  discoveryCache = undefined;
}

// A discovery document that redirected the token endpoint off xAI would ship refresh tokens to a
// third party, so only https endpoints on x.ai hosts are accepted; anything else falls back.
function isTrustedEndpoint(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))
  );
}

export interface GrokOAuthIo {
  fetch?: GrokFetch;
  now?: () => number;
}

/**
 * `GET {issuer}/.well-known/openid-configuration`, cached 24 h. Any failure uses the fallback
 * endpoints without caching them, so the next call retries discovery.
 */
export async function getGrokOAuthEndpoints(io: GrokOAuthIo = {}): Promise<GrokOAuthEndpoints> {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const now = io.now ?? Date.now;
  const cached = discoveryCache;

  if (cached && now() - cached.fetchedAt < GROK_DISCOVERY_TTL_MS) return cached.endpoints;

  try {
    const response = await fetchImpl(`${GROK_AUTH_ISSUER}/.well-known/openid-configuration`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": grokShellUserAgent() },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (response.ok) {
      const document = DiscoveryDocument.safeParse(await response.json());

      if (
        document.success &&
        isTrustedEndpoint(document.data.authorization_endpoint) &&
        isTrustedEndpoint(document.data.token_endpoint)
      ) {
        const endpoints: GrokOAuthEndpoints = {
          authorizationEndpoint: document.data.authorization_endpoint,
          tokenEndpoint: document.data.token_endpoint,
          source: "discovery",
        };

        discoveryCache = { endpoints, fetchedAt: now() };

        return endpoints;
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Network failure, timeout, or a non-JSON body: fall through to the fixed endpoints.
  }

  return {
    authorizationEndpoint: GROK_FALLBACK_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: GROK_FALLBACK_TOKEN_ENDPOINT,
    source: "fallback",
  };
}

// ---------------------------------------------------------------------------
// PKCE and authorize URL
// ---------------------------------------------------------------------------

export interface GrokPkce {
  codeVerifier: string;
  codeChallenge: string;
}

/** S256 over a base64url verifier of 32 random bytes (oidc/protocol.rs:314-320). */
export function generateGrokPkce(): GrokPkce {
  const codeVerifier = randomBytes(32).toString("base64url");

  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

/** RFC 3986 unreserved-only encoding, matching Rust `urlencoding::encode` (space → %20). */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export const GROK_OAUTH_SCOPE = GROK_OAUTH_SCOPES.join(" ");

export interface GrokAuthorizeUrlInput {
  authorizationEndpoint: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

/** Authorize URL with grok-build's query order (oidc/protocol.rs:321-366). */
export function buildGrokAuthorizeUrl(input: GrokAuthorizeUrlInput): string {
  const query: [string, string][] = [
    ["response_type", "code"],
    ["client_id", GROK_OAUTH_CLIENT_ID],
    ["redirect_uri", input.redirectUri],
    ["scope", GROK_OAUTH_SCOPE],
    ["code_challenge", input.codeChallenge],
    ["code_challenge_method", "S256"],
    ["state", input.state],
    ["nonce", input.nonce],
    ["referrer", GROK_OAUTH_REFERRER],
  ];

  const search = query.map(([key, value]) => `${key}=${encodeQueryValue(value)}`).join("&");

  return `${input.authorizationEndpoint}?${search}`;
}

export function grokLoopbackRedirectUri(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new RangeError("redirect port must be an integer in 1..65535");

  return `http://127.0.0.1:${port}/callback`;
}

export interface StartGrokOAuthInput extends GrokOAuthIo {
  state: string;
  /** Loopback port; defaults to a random port in the ephemeral range. */
  redirectPort?: number;
}

export interface StartGrokOAuthResult {
  authorizeUrl: string;
  verifier: string;
  redirectUri: string;
}

export async function startGrokOAuth(input: StartGrokOAuthInput): Promise<StartGrokOAuthResult> {
  if (!input.state) throw new TypeError("state must be non-empty");
  const endpoints = await getGrokOAuthEndpoints(input);
  const pkce = generateGrokPkce();
  const redirectUri = grokLoopbackRedirectUri(input.redirectPort ?? randomInt(49_152, 65_536));

  return {
    authorizeUrl: buildGrokAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state: input.state,
      nonce: randomUUID(),
    }),
    verifier: pkce.codeVerifier,
    redirectUri,
  };
}

// ---------------------------------------------------------------------------
// Callback / paste parsing
// ---------------------------------------------------------------------------

export interface GrokCallbackInput {
  code: string;
  /** Empty for a bare pasted code, which carries no state (oidc/login.rs:33-60). */
  state: string;
}

const OAUTH_ERROR_CODE = /^[a-z_]{1,80}$/;

function safeOAuthErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && OAUTH_ERROR_CODE.test(value) ? value : undefined;
}

/** Accepts the full callback URL or a bare authorization code (oidc/login.rs:30-60). */
export function parseGrokCallbackInput(input: string): GrokCallbackInput {
  const trimmed = input.trim();

  if (!trimmed) throw new GrokOAuthError("invalid_callback_input", "empty callback input");

  let url: URL | undefined;

  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }

  if (url) {
    const code = url.searchParams.get("code");

    if (code) return { code, state: url.searchParams.get("state") ?? "" };
    const error = url.searchParams.get("error");

    if (error) {
      const oauthError = safeOAuthErrorCode(error);
      throw new GrokOAuthError(
        "authorization_failed",
        `authorization failed: ${oauthError ?? "unknown_error"}`,
        oauthError === undefined ? {} : { oauthError },
      );
    }

    throw new GrokOAuthError("invalid_callback_input", "callback URL has no code parameter");
  }

  if (/\s/.test(trimmed))
    throw new GrokOAuthError("invalid_callback_input", "authorization code contains whitespace");

  return { code: trimmed, state: "" };
}

function statesEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);

  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Token exchange and finishing
// ---------------------------------------------------------------------------

export const GrokTokenResponse = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  id_token: z.string().nullish(),
  expires_in: z.number().nonnegative().nullish(),
  scope: z.string().nullish(),
  token_type: z.string().nullish(),
});

export type GrokTokenResponse = z.infer<typeof GrokTokenResponse>;

const OAuthErrorBody = z.looseObject({ error: z.string() });

/** Reads the OAuth `error` code from a failed response without retaining the body. */
export async function readGrokOAuthErrorCode(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => "");

  try {
    const parsed = OAuthErrorBody.safeParse(JSON.parse(text));

    return parsed.success ? safeOAuthErrorCode(parsed.data.error) : undefined;
  } catch {
    return undefined;
  }
}

function formHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "user-agent": grokShellUserAgent(),
    ...extra,
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
}

async function parseTokenResponse(response: Response): Promise<GrokTokenResponse> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new GrokOAuthError("invalid_token_response", "token response is not JSON");
  }

  const parsed = GrokTokenResponse.safeParse(body);

  if (!parsed.success)
    throw new GrokOAuthError("invalid_token_response", "token response failed validation");

  return parsed.data;
}

function networkError(code: GrokOAuthErrorCode, what: string, error: unknown): GrokOAuthError {
  const reason = error instanceof Error ? error.name : "unknown";

  return new GrokOAuthError(code, `${what} request failed (${reason})`, { retryable: true });
}

export interface FinishGrokLoginInput extends GrokOAuthIo {
  tokens: GrokTokenResponse;
  requestedScopes?: readonly string[];
}

/**
 * Validates the token response, resolves the account id (JWT `sub`, confirmed by
 * `GET /user?include=subscription`), and builds stored credentials.
 */
export async function finishGrokLogin(input: FinishGrokLoginInput): Promise<GrokCredentials> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const { tokens } = input;

  if (!isGrokAccessToken(tokens.access_token))
    throw new GrokOAuthError(
      "invalid_access_token",
      `access token is not an at+jwt issued by ${GROK_AUTH_ISSUER}`,
    );

  if (!tokens.refresh_token)
    throw new GrokOAuthError("missing_refresh_token", "token response has no refresh token");

  const decoded = decodeGrokJwt(tokens.access_token);
  const subject = decoded?.payload.sub;

  if (!subject)
    throw new GrokOAuthError("user_id_unresolved", "access token has no subject (sub) claim");

  let response: Response;

  try {
    response = await fetchImpl(`${GROK_CHAT_PROXY_URL}/user?include=subscription`, {
      method: "GET",
      headers: buildGrokProxyGetHeaders({ bearer: tokens.access_token, userId: subject }),
      signal: AbortSignal.timeout(USER_LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError("user_lookup_failed", "user lookup", error);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GrokOAuthError("user_lookup_failed", `user lookup failed: HTTP ${response.status}`, {
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let userBody: unknown;

  try {
    userBody = await response.json();
  } catch {
    throw new GrokOAuthError("user_id_unresolved", "user lookup returned non-JSON");
  }

  const user = GrokUserSubscription.safeParse(userBody);

  if (!user.success)
    throw new GrokOAuthError("user_id_unresolved", "user lookup did not return a valid userId");

  const issuedAt = now();

  const expiresAtMs =
    typeof tokens.expires_in === "number"
      ? issuedAt + tokens.expires_in * 1000
      : typeof decoded?.payload.exp === "number"
        ? decoded.payload.exp * 1000
        : undefined;

  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs))
    throw new GrokOAuthError("missing_expiry", "token response has no expiry");

  const grantedScopes = tokens.scope?.split(" ").filter(Boolean);

  const candidate = {
    authMode: "oauth" as const,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    issuer: GROK_AUTH_ISSUER,
    clientId: GROK_OAUTH_CLIENT_ID,
    scopes:
      grantedScopes && grantedScopes.length > 0
        ? grantedScopes
        : [...(input.requestedScopes ?? GROK_OAUTH_SCOPES)],
    userId: user.data.userId,
    sessionId: randomUUID(),
    agentId: randomUUID(),
    ...(user.data.subscriptionTier ? { subscriptionTier: user.data.subscriptionTier } : {}),
  };

  const credentials = GrokCredentials.safeParse(candidate);

  if (!credentials.success)
    throw new GrokOAuthError("invalid_credentials", "credentials failed validation");

  return credentials.data;
}

export interface CompleteGrokOAuthInput extends GrokOAuthIo {
  codeOrUrl: string;
  verifier: string;
  redirectUri: string;
  /** The state issued with the authorize URL; a pasted URL must echo it. */
  state: string;
}

export async function completeGrokOAuth(input: CompleteGrokOAuthInput): Promise<GrokCredentials> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const callback = parseGrokCallbackInput(input.codeOrUrl);

  // A bare code carries no state; the caller binds it to the pending login (oidc/login.rs:452-455).
  if (callback.state && !statesEqual(input.state, callback.state))
    throw new GrokOAuthError("state_mismatch", "OAuth state mismatch");

  const endpoints = await getGrokOAuthEndpoints(input);
  let response: Response;

  try {
    response = await fetchImpl(endpoints.tokenEndpoint, {
      method: "POST",
      // oidc/protocol.rs:385-399: form body, x-grok-client-version, shared-client UA.
      headers: formHeaders({ "x-grok-client-version": GROK_BUILD_VERSION }),
      body: new URLSearchParams([
        ["grant_type", "authorization_code"],
        ["code", callback.code],
        ["redirect_uri", input.redirectUri],
        ["client_id", GROK_OAUTH_CLIENT_ID],
        ["code_verifier", input.verifier],
      ]),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError("token_exchange_failed", "token exchange", error);
  }

  if (!response.ok) {
    const oauthError = await readGrokOAuthErrorCode(response);
    throw new GrokOAuthError(
      "token_exchange_failed",
      `token exchange failed: HTTP ${response.status} ${oauthError ?? "unknown"}`,
      {
        status: response.status,
        ...(oauthError === undefined ? {} : { oauthError }),
        retryable: response.status >= 500,
      },
    );
  }

  return finishGrokLogin({
    ...input,
    fetch: fetchImpl,
    tokens: await parseTokenResponse(response),
  });
}

// ---------------------------------------------------------------------------
// Device code (RFC 8628)
// ---------------------------------------------------------------------------

// device_code.rs:19-20
export const GROK_DEVICE_DEFAULT_INTERVAL_S = 5;
export const GROK_DEVICE_SLOW_DOWN_INCREMENT_S = 5;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// The dashboard renders the URL and code to a human (device_code.rs:266-271 → `ui`).
const DEVICE_CLIENT_SURFACE = "ui";

function isAllowedVerificationUri(value: string): boolean {
  // device_code.rs:475-488: reject control characters, require https (http only on loopback).
  if ([...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f))
    return false;
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === "https:") return true;

  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

const DeviceCodeResponse = z.looseObject({
  device_code: z.string().min(1),
  user_code: z.string().regex(/^[A-Za-z0-9-]+$/),
  verification_uri: z.string().refine(isAllowedVerificationUri),
  verification_uri_complete: z.string().refine(isAllowedVerificationUri).nullish(),
  expires_in: z.number().positive(),
  interval: z.number().int().positive().nullish(),
});

export interface GrokDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Seconds to wait before the next poll. */
  interval: number;
}

function deviceHeaders(): Record<string, string> {
  return formHeaders({
    "x-grok-client-version": GROK_BUILD_VERSION,
    "x-grok-client-surface": DEVICE_CLIENT_SURFACE,
  });
}

export async function startGrokDeviceCode(io: GrokOAuthIo = {}): Promise<GrokDeviceCode> {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  let response: Response;

  try {
    response = await fetchImpl(GROK_DEVICE_CODE_URL, {
      method: "POST",
      headers: deviceHeaders(),
      body: new URLSearchParams([
        ["client_id", GROK_OAUTH_CLIENT_ID],
        ["scope", GROK_OAUTH_SCOPE],
        ["referrer", GROK_OAUTH_REFERRER],
      ]),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError("device_code_failed", "device code", error);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);

    if (response.status === 404)
      throw new GrokOAuthError("device_flow_not_enabled", "device-code login is not available", {
        status: 404,
      });
    throw new GrokOAuthError(
      "device_code_failed",
      `device code request failed: HTTP ${response.status}`,
      { status: response.status, retryable: response.status >= 500 || response.status === 429 },
    );
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new GrokOAuthError("invalid_device_code_response", "device code response is not JSON");
  }

  const parsed = DeviceCodeResponse.safeParse(body);

  if (!parsed.success)
    throw new GrokOAuthError(
      "invalid_device_code_response",
      "device code response failed validation",
    );
  const data = parsed.data;

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    ...(data.verification_uri_complete
      ? { verificationUriComplete: data.verification_uri_complete }
      : {}),
    expiresIn: data.expires_in,
    interval: data.interval ?? GROK_DEVICE_DEFAULT_INTERVAL_S,
  };
}

export type GrokDevicePollResult =
  | { status: "pending"; interval: number }
  | { status: "complete"; credentials: GrokCredentials };

export interface PollGrokDeviceCodeInput extends GrokOAuthIo {
  deviceCode: string;
  /** Current poll interval in seconds; the result carries the interval for the next poll. */
  interval: number;
}

/**
 * One poll of the device token endpoint. The caller sleeps `interval` seconds between polls and
 * enforces the device-code expiry; this function never loops.
 */
export async function pollGrokDeviceCode(
  input: PollGrokDeviceCodeInput,
): Promise<GrokDevicePollResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const interval = Math.max(1, Math.ceil(input.interval));
  let response: Response;

  try {
    response = await fetchImpl(GROK_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: deviceHeaders(),
      body: new URLSearchParams([
        ["grant_type", DEVICE_GRANT_TYPE],
        ["device_code", input.deviceCode],
        ["client_id", GROK_OAUTH_CLIENT_ID],
      ]),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError("device_token_failed", "device token", error);
  }

  if (response.ok)
    return {
      status: "complete",
      credentials: await finishGrokLogin({
        ...input,
        fetch: fetchImpl,
        tokens: await parseTokenResponse(response),
      }),
    };

  const oauthError = await readGrokOAuthErrorCode(response);

  switch (oauthError) {
    case "authorization_pending":
      return { status: "pending", interval };
    case "slow_down":
      return { status: "pending", interval: interval + GROK_DEVICE_SLOW_DOWN_INCREMENT_S };
    case "access_denied":
      throw new GrokOAuthError("access_denied", "authorization denied by the user", {
        status: response.status,
        oauthError,
      });
    case "expired_token":
      throw new GrokOAuthError("expired_token", "device code expired", {
        status: response.status,
        oauthError,
      });
    default:
      throw new GrokOAuthError(
        "device_token_failed",
        `device token request failed: HTTP ${response.status} ${oauthError ?? "unknown"}`,
        {
          status: response.status,
          ...(oauthError === undefined ? {} : { oauthError }),
          retryable: oauthError === undefined && response.status >= 500,
        },
      );
  }
}
