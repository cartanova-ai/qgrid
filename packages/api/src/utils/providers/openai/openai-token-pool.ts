import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { isOpenAICredentials } from "../common/credentials";
import { type MediaDispatchResult, type MediaTokenSelection } from "../common/provider-dispatcher";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import { isOpenAIUnauthorizedError } from "./openai-backend-protocol";
import { type OpenAIDirectCredentials } from "./openai-direct-client";
import { readOpenAIQuotaUsage, type OpenAIRateLimitsWithMeta } from "./openai-quota";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";

// Same category as before the dispatcher split, so log filters keep matching.
const logger = getLogger(["qgrid", "openai-dispatcher"]);

export type TokenMetadata = {
  name: string;
  credentials: OpenAICredentials;
  quotaThreshold?: number | null;
  weight: number;
  active: boolean;
  generation: number;
};

export type TokenSelection = { tokenId: number; metadata: TokenMetadata };

function quotaMessage(entries: Array<{ name: string; threshold: number }>): string {
  const detail = entries.map((e) => `${e.name} (threshold ${e.threshold}%)`).join(", ");

  return detail
    ? `All openai tokens exceeded quota threshold: ${detail}`
    : "All openai tokens exceeded quota threshold";
}

/**
 * The OpenAI subscription tokens every OpenAI API surface shares: weighted selection behind the
 * quota-threshold gate, rate-limit lookups, and OAuth refresh. Listeners registered with
 * `onTokenInvalidated` run when a token's credentials stop being usable (refreshed or removed), so
 * transports can drop clients built from them.
 */
export class OpenAITokenPool {
  readonly tokenMetadata = new Map<number, TokenMetadata>();
  readonly rateLimitsCache = new Map<number, OpenAIRateLimitsWithMeta & { generation: number }>();
  readonly pendingRateLimits = new Map<
    number,
    { token: TokenMetadata; generation: number; promise: Promise<OpenAIRateLimitsWithMeta> }
  >();
  static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  readonly selector = new SmoothWeightedRoundRobin();
  readonly quotaBlocked = new Set<number>();
  readonly invalidationListeners: Array<(tokenId: number) => void> = [];

  constructor(readonly fetchImpl: typeof fetch) {}

  onTokenInvalidated(listener: (tokenId: number) => void): void {
    this.invalidationListeners.push(listener);
  }

  notifyTokenInvalidated(tokenId: number): void {
    for (const listener of this.invalidationListeners) listener(tokenId);
  }

  /** Loads the active OpenAI tokens from the database. */
  async load(): Promise<void> {
    const { rows } = await TokenModel.findMany("A");

    for (const row of rows) {
      if (row.provider !== "openai") continue;

      if (!isOpenAICredentials(row.credentials)) {
        logger.warn(`skipping token ${row.name}: credentials are not OpenAI OAuth credentials`);
        continue;
      }

      this.setToken(row.id, row.name, row.credentials, row.quota_threshold, row.weight, row.active);
    }

    logger.info(`started direct OpenAI runtime with ${this.tokenMetadata.size} tokens`);
  }

  /** Forgets every token. In-flight rate-limit lookups are left to finish, as before. */
  clear(): void {
    this.tokenMetadata.clear();
    this.rateLimitsCache.clear();
    this.quotaBlocked.clear();
    this.selector.resetScores();
  }

  /**
   * Selects a token, runs one non-Responses call (realtime voice, Decisions), and on one 401
   * refreshes that token's credentials and retries once (as the Responses transports do). Any
   * other failure propagates: a failed call may already have consumed tokens.
   */
  async runWithToken<T>(
    selection: MediaTokenSelection,
    signal: AbortSignal | undefined,
    call: (credentials: OpenAIDirectCredentials) => Promise<T>,
  ): Promise<MediaDispatchResult<T>> {
    const active = signal ?? new AbortController().signal;

    const selected = await this.selectToken(
      selection.preferredTokenId,
      selection.requirePreferredToken ?? false,
      active,
    );

    const { tokenId, metadata } = selected;

    let credentials: OpenAIDirectCredentials = {
      accessToken: metadata.credentials.accessToken,
      accountId: metadata.credentials.accountId,
    };

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await call(credentials);
        this.invalidateRateLimitsCache(tokenId);

        return { result, tokenId, tokenName: metadata.name };
      } catch (error) {
        if (attempt === 0 && error instanceof Error && isOpenAIUnauthorizedError(error)) {
          credentials = await this.refreshCredentials(tokenId);
          continue;
        }

        throw error;
      }
    }
  }

  async onTokenAdded(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    this.setToken(id, name, credentials, quotaThreshold, weight, true);
  }

  async onTokenUpdated(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    const old = this.tokenMetadata.get(id);
    this.setToken(id, name, credentials, quotaThreshold, weight, old?.active ?? true);
  }

  async onTokenRemoved(id: number): Promise<void> {
    this.notifyTokenInvalidated(id);
    this.tokenMetadata.delete(id);
    this.selector.removeToken(id);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  onTokenDeactivated(id: number): void {
    const token = this.tokenMetadata.get(id);

    if (token) token.active = false;
    this.selector.resetScores();
  }

  onTokenActivated(id: number): void {
    const token = this.tokenMetadata.get(id);

    if (token) token.active = true;
    this.selector.resetScores();
  }

  async replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: OpenAICredentials;
      quotaThreshold?: number | null;
      weight: number;
    }>,
  ): Promise<void> {
    const ids = new Set(rows.map((r) => r.id));

    for (const id of this.tokenMetadata.keys()) if (!ids.has(id)) await this.onTokenRemoved(id);

    for (const row of rows)
      await this.onTokenUpdated(row.id, row.name, row.credentials, row.quotaThreshold, row.weight);
  }

  // 선호 토큰이 quota를 통과하면 다른 토큰 조회와 weighted 상태 변경을 생략한다.
  async selectToken(
    preferredTokenId: number | undefined,
    requirePreferredToken: boolean,
    signal: AbortSignal,
  ): Promise<TokenSelection> {
    if (preferredTokenId !== undefined) {
      const preferred = this.tokenMetadata.get(preferredTokenId);

      if (preferred?.active && (await this.isQuotaEligible(preferredTokenId, preferred, signal))) {
        return { tokenId: preferredTokenId, metadata: preferred };
      }

      if (requirePreferredToken) {
        if (!preferred?.active) {
          throw new Error(`Preferred openai token ${preferredTokenId} is not available`);
        }

        const threshold = preferred.quotaThreshold;

        if (threshold !== null && threshold !== undefined) {
          throw new QuotaThresholdExceededError(
            quotaMessage([{ name: preferred.name, threshold }]),
          );
        }
      }
    }

    // 콜드 캐시에서 토큰 수만큼 조회 지연이 쌓이지 않도록 병렬 판정한다.
    const activeTokens = [...this.tokenMetadata.entries()].filter(([, token]) => token.active);

    const checks = await Promise.all(
      activeTokens.map(async ([id, token]) => ({
        id,
        token,
        eligible: await this.isQuotaEligible(id, token, signal),
      })),
    );

    const eligible = new Set(checks.filter((c) => c.eligible).map((c) => c.id));

    if (eligible.size === 0) {
      const over = checks.flatMap((c) => {
        const threshold = c.token.quotaThreshold;

        return c.eligible || threshold === null || threshold === undefined
          ? []
          : [{ name: c.token.name, threshold }];
      });

      if (over.length) {
        logger.warn("quota_threshold gate: all_exceeded", {
          provider: "openai",
          overThresholdTokens: over,
        });
        throw new QuotaThresholdExceededError(quotaMessage(over));
      }

      throw new Error("NO_OPENAI_WORKERS");
    }

    const selected = this.selector.select(eligible);
    const metadata = selected !== null ? this.tokenMetadata.get(selected) : undefined;

    if (selected === null || !metadata) throw new Error("NO_OPENAI_WORKERS");

    return { tokenId: selected, metadata };
  }

  setToken(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold: number | null | undefined,
    weight: number,
    active: boolean,
  ): void {
    const old = this.tokenMetadata.get(id);

    if (old) {
      Object.assign(old, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        generation: old.generation + 1,
      });
    } else {
      this.tokenMetadata.set(id, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        generation: 1,
      });
    }

    this.selector.setToken(id, weight);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  async getRateLimitsByTokenId(
    tokenId: number,
    signal?: AbortSignal,
  ): Promise<OpenAIRateLimitsWithMeta> {
    const token = this.tokenMetadata.get(tokenId);

    if (!token) throw new Error(`openai token ${tokenId} not found`);
    const generation = token.generation;
    const cached = this.rateLimitsCache.get(tokenId);

    if (
      cached &&
      cached.generation === token.generation &&
      Date.now() - cached.cachedAt < OpenAITokenPool.RATE_LIMITS_CACHE_TTL
    )
      return cached;

    // TTL 만료 시 조회를 공유한다. 최초 호출자의 abort로 실패해도 isQuotaEligible은 fail-open한다.
    const pending = this.pendingRateLimits.get(tokenId);

    if (pending?.token === token && pending.generation === generation) return pending.promise;

    const fetchPromise = (async () => {
      const result = await readOpenAIQuotaUsage({
        credentials: token.credentials,
        refreshCredentials: () => this.refreshCredentials(tokenId),
        fetch: this.fetchImpl,
        signal,
      });

      if (result.kind === "lookup_failed") throw new Error(result.reason);

      if (!result.raw) throw new Error("OpenAI quota response missing raw rate limits");
      const entry = { data: result.raw, cachedAt: Date.now(), generation };

      if (this.tokenMetadata.get(tokenId) === token && token.generation === generation) {
        this.rateLimitsCache.set(tokenId, entry);
      }

      return entry;
    })().finally(() => {
      if (this.pendingRateLimits.get(tokenId)?.promise === fetchPromise) {
        this.pendingRateLimits.delete(tokenId);
      }
    });

    this.pendingRateLimits.set(tokenId, { token, generation, promise: fetchPromise });

    return fetchPromise;
  }

  async refreshCredentials(tokenId: number) {
    const previous = this.tokenMetadata.get(tokenId);
    const generation = previous?.generation;
    const refreshed = await handleChatgptAuthTokensRefresh(tokenId);

    const credentials = {
      accessToken: refreshed.accessToken,
      accountId: refreshed.chatgptAccountId,
    };

    const current = this.tokenMetadata.get(tokenId);

    if (!current?.active) throw new Error(`openai token ${tokenId} is no longer active`);

    // A subscriber update may already contain newer credentials. Never overwrite it
    // with the result of a refresh that started against an older generation.
    if (current === previous && current.generation === generation) {
      current.credentials = { ...current.credentials, ...credentials };
      this.notifyTokenInvalidated(tokenId);
      this.invalidateRateLimitsCache(tokenId);
    }

    return {
      accessToken: current.credentials.accessToken,
      accountId: current.credentials.accountId,
    };
  }

  async isQuotaEligible(id: number, token: TokenMetadata, signal?: AbortSignal): Promise<boolean> {
    if (token.quotaThreshold === null || token.quotaThreshold === undefined) return true;
    const generation = token.generation;
    const result = await readOpenAIQuotaUsage(async () => this.getRateLimitsByTokenId(id, signal));
    const current = this.tokenMetadata.get(id);

    // A token update (credential refresh, sync) landed mid-lookup: judge the updated token
    // instead of reporting it over quota.
    if (current !== token || token.generation !== generation) {
      return current?.active ? this.isQuotaEligible(id, current, signal) : false;
    }

    if (result.kind === "lookup_failed") {
      this.quotaBlocked.delete(id);
      logger.warn("quota_threshold gate: lookup_fail_open", {
        tokenId: id,
        tokenName: token.name,
        lookupReason: result.reason,
      });

      return true;
    }

    if (result.utilizationPct >= token.quotaThreshold) {
      if (!this.quotaBlocked.has(id))
        logger.info(
          `quota_threshold gate: over_threshold ${token.name}[${id}] (${result.utilizationPct}% >= ${token.quotaThreshold}%)`,
        );
      this.quotaBlocked.add(id);

      return false;
    }

    if (this.quotaBlocked.delete(id))
      logger.info(
        `quota_threshold gate: recovered ${token.name}[${id}] (${result.utilizationPct}% < ${token.quotaThreshold}%)`,
      );

    return true;
  }

  invalidateRateLimitsCache(id: number): void {
    this.rateLimitsCache.delete(id);
  }

  countActiveTokens(): number {
    return [...this.tokenMetadata.values()].filter((t) => t.active).length;
  }

  // 모니터링 폴링은 TTL 내 캐시만 읽고 fetch하지 않는다. 미조회 토큰은 usedPercent가 null이다.
  getQuotaSnapshot(): Array<{
    name: string;
    usedPercent: number | null;
    threshold: number | null;
    blocked: boolean;
    resetsAt: number | null;
  }> {
    const now = Date.now();

    return [...this.tokenMetadata.entries()]
      .map(([id, t]) => {
        const cached = this.rateLimitsCache.get(id);

        const fresh =
          cached !== undefined &&
          cached.generation === t.generation &&
          now - cached.cachedAt < OpenAITokenPool.RATE_LIMITS_CACHE_TTL;

        const primary = fresh ? cached.data.rateLimits?.primary : undefined;

        return {
          name: t.name,
          usedPercent: primary?.usedPercent ?? null,
          threshold: t.quotaThreshold ?? null,
          blocked: this.quotaBlocked.has(id),
          // wham의 Unix 초를 epoch ms로 변환한다.
          resetsAt:
            primary?.resetsAt !== null && primary?.resetsAt !== undefined
              ? primary.resetsAt * 1000
              : null,
        };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
