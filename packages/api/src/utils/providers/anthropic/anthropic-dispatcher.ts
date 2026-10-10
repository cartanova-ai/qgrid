/**
 * 요청마다 새 Claude 프로세스에 전체 대화 이력을 전달한다.
 * 반환한 threadCoord는 다음 요청의 세션 재사용이나 토큰 선택에 쓰지 않는다.
 */

import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type AnthropicCredentials } from "../../../application/token/token.types";
import { getExpiresAt, getRefreshToken } from "../common/credentials";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { serializeAndValidateDispatchSchema } from "../common/schema-validation";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import { assertSupportedOneMillionSuffix, canonicalAnthropicModel } from "./anthropic-constants";
import { invalidateAnthropicQuotaUsage, readAnthropicQuotaUsage } from "./anthropic-quota";
import { assertAnthropicThinkingRuntime, resolveAnthropicThinking } from "./anthropic-thinking";
import { makeAnthropicWorkerId, runClaudeSession } from "./claude-session";

const logger = getLogger(["qgrid", "anthropic-dispatcher"]);

// 1M context 생성은 100초 이상 걸릴 수 있다.
const DEFAULT_TIMEOUT_MS = 240_000;
const REFRESH_SAFETY_MS = 60_000;

interface PooledToken {
  id: number;
  name: string;
  credentials: AnthropicCredentials;
  quotaThreshold?: number | null;
  weight: number;
}

export class AnthropicDispatcher implements ProviderDispatcher {
  tokenPool = new Map<number, PooledToken>();
  readonly weightedSelector = new SmoothWeightedRoundRobin();
  inFlight = 0;

  async start(): Promise<void> {
    // NOTIFY는 기존 토큰을 재전송하지 않으므로 시작 시 DB에서 읽는다.
    const tokens = await TokenModel.findActiveByProvider("A", "anthropic");
    tokens.forEach((t) => {
      this.tokenPool.set(t.id, {
        id: t.id,
        name: t.name,
        credentials: t.credentials as AnthropicCredentials,
        quotaThreshold: t.quota_threshold,
        weight: t.weight,
      });
      this.weightedSelector.setToken(t.id, t.weight);
      logger.info(`worker spawned: ${t.name}`);
    });
  }

  async stop(): Promise<void> {
    const tokenIds = [...this.tokenPool.keys()];
    tokenIds.forEach((id) => this.weightedSelector.removeToken(id));
    this.tokenPool.clear();
    this.weightedSelector.resetScores();
  }

  // LISTEN/NOTIFY 연결이 끊긴 동안 놓친 변경을 DB 기준으로 맞춘다.
  replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: AnthropicCredentials;
      quotaThreshold?: number | null;
      weight: number;
    }>,
  ): void {
    const next = new Set(rows.map((r) => r.id));
    // 삭제할 키는 순회 전에 스냅샷한다.
    const currentIds = Array.from(this.tokenPool.keys());
    currentIds.forEach((id) => {
      if (!next.has(id)) this.onTokenRemoved(id);
    });
    rows.forEach((r) => {
      if (this.tokenPool.has(r.id)) {
        this.onTokenUpdated(r.id, r.name, r.credentials, r.quotaThreshold, r.weight);
      } else {
        this.onTokenAdded(r.id, r.name, r.credentials, r.quotaThreshold, r.weight);
      }
    });
  }

  onTokenAdded(
    id: number,
    name: string,
    credentials: AnthropicCredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): void {
    this.tokenPool.set(id, { id, name, credentials, quotaThreshold, weight });
    this.weightedSelector.setToken(id, weight);
  }

  onTokenUpdated(
    id: number,
    name: string,
    credentials: AnthropicCredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): void {
    this.tokenPool.set(id, { id, name, credentials, quotaThreshold, weight });
    this.weightedSelector.setToken(id, weight);
  }

  onTokenRemoved(id: number): void {
    this.tokenPool.delete(id);
    this.weightedSelector.removeToken(id);
  }

  // 지정 요청은 해당 토큰만 quota 판정하고 weighted 상태를 건드리지 않는다.
  // 미지정 요청만 quota 통과 후보로 smooth weighted round-robin 을 진행한다.
  async selectToken(model: string, preferredTokenId?: number): Promise<PooledToken | null> {
    const preferred =
      preferredTokenId === undefined ? undefined : this.tokenPool.get(preferredTokenId);
    if (preferredTokenId !== undefined && !preferred) {
      throw new Error(`Preferred anthropic token ${preferredTokenId} is not available`);
    }

    const rows = preferred ? [preferred] : [...this.tokenPool.values()];
    if (rows.length === 0) return null;
    const { eligible, overThresholdTokens } = await this.filterEligibleTokens(rows, model);
    if (eligible.length === 0) {
      logger.warn("quota_threshold gate: all_exceeded", {
        provider: "anthropic",
        tokenCount: rows.length,
        thresholdedTokenCount: rows.filter((r) => this.hasQuotaThreshold(r)).length,
        overThresholdTokens,
        reason: "all_exceeded",
      });
      const details = overThresholdTokens
        .map((token) => `${token.tokenName} (threshold ${token.threshold}%)`)
        .join(", ");
      throw new QuotaThresholdExceededError(
        details
          ? `All anthropic tokens exceeded quota threshold: ${details}`
          : "All anthropic tokens exceeded quota threshold",
      );
    }

    if (preferred) return preferred;

    const selectedId = this.weightedSelector.select(new Set(eligible.map((token) => token.id)));
    if (selectedId === null) return null;
    return this.tokenPool.get(selectedId) ?? null;
  }

  async filterEligibleTokens(
    rows: PooledToken[],
    model: string,
  ): Promise<{
    eligible: PooledToken[];
    overThresholdTokens: Array<{ tokenName: string; threshold: number }>;
  }> {
    const thresholded = rows.filter((token) => this.hasQuotaThreshold(token));
    if (thresholded.length === 0) return { eligible: rows, overThresholdTokens: [] };

    const eligibleIds = new Set(
      rows.filter((token) => !this.hasQuotaThreshold(token)).map((token) => token.id),
    );
    const overThresholdTokens: Array<{ tokenName: string; threshold: number }> = [];
    const checks = await Promise.allSettled(
      thresholded.map(async (token) => ({
        token,
        result: await readAnthropicQuotaUsage(token.credentials.accessToken, model),
      })),
    );

    checks.forEach((check, index) => {
      const token = check.status === "rejected" ? thresholded[index] : check.value.token;
      if (!token) return;
      const result =
        check.status === "fulfilled"
          ? check.value.result
          : { kind: "lookup_failed" as const, reason: String(check.reason) };
      if (result.kind === "lookup_failed") {
        logger.warn("quota_threshold gate: lookup_fail_open", {
          tokenId: token.id,
          tokenName: token.name,
          provider: "anthropic",
          threshold: token.quotaThreshold,
          reason: "lookup_fail_open",
          lookupReason: result.reason,
        });
        eligibleIds.add(token.id);
        return;
      }

      if (result.utilizationPct >= token.quotaThreshold) {
        logger.info("quota_threshold gate: over_threshold", {
          tokenId: token.id,
          tokenName: token.name,
          provider: "anthropic",
          threshold: token.quotaThreshold,
          cachedUtilization: result.utilizationPct,
          cacheAge: result.cacheAgeMs,
          reason: "over_threshold",
        });
        overThresholdTokens.push({ tokenName: token.name, threshold: token.quotaThreshold });
        return;
      }

      eligibleIds.add(token.id);
    });

    return { eligible: rows.filter((token) => eligibleIds.has(token.id)), overThresholdTokens };
  }

  hasQuotaThreshold(token: PooledToken): token is PooledToken & { quotaThreshold: number } {
    return token.quotaThreshold !== undefined && token.quotaThreshold !== null;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.run(req, () => {});
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    try {
      const result = await this.run(req, cb.onDelta, { includePartialMessages: true });
      cb.onThreadId?.(result.threadCoord.threadId);
      cb.onComplete(result);
    } catch (e) {
      cb.onError(e as Error);
    }
  }

  async run(
    req: GenerateRequest,
    onDelta: (t: string) => void,
    opts?: { includePartialMessages?: boolean },
  ): Promise<GenerateResult> {
    this.inFlight++;
    try {
      if (req.imageGeneration) {
        throw new Error("image generation is not supported on the Anthropic route");
      }
      assertSupportedOneMillionSuffix(req.model);
      const model = canonicalAnthropicModel(req.model);
      const thinking = resolveAnthropicThinking(model, req.thinking, req.effort);
      assertAnthropicThinkingRuntime(thinking.extraBody);
      const jsonSchema = serializeAndValidateDispatchSchema(req.outputSchema, "anthropic");

      const token = await this.selectToken(model, req.preferredTokenId);
      if (!token) throw new Error("No anthropic tokens available");

      // 만료 직전에 갱신하되 실패하면 기존 토큰으로 진행한다.
      let accessToken = token.credentials.accessToken;
      const expiresAt = getExpiresAt(token.credentials);
      if (
        expiresAt &&
        expiresAt - Date.now() < REFRESH_SAFETY_MS &&
        getRefreshToken(token.credentials)
      ) {
        try {
          const { QgridFrame } = await import("../../../application/qgrid/qgrid.frame");
          // provider 를 반드시 채워야 refreshToken 내부 TokenModel.save 가 성공한다.
          accessToken = await QgridFrame.refreshToken({
            id: token.id,
            provider: "anthropic",
            name: token.name,
            credentials: token.credentials,
          } as Parameters<typeof QgridFrame.refreshToken>[0]);
        } catch (e) {
          logger.warn(`refresh failed for ${token.name}: ${(e as Error).message}`);
        }
      }

      logger.info(`→ ${token.name} (model: ${model})`);
      const session = await runClaudeSession(
        {
          tokenId: token.id,
          token: accessToken,
          model,
          system: req.systemPrompt,
          jsonSchema,
          effort: req.effort,
          thinking: req.thinking,
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          coldHistory: req.coldHistory,
          input: req.coldInput,
          abortSignal: req.abortSignal,
          includePartialMessages: opts?.includePartialMessages,
        },
        onDelta,
      );

      if (session.quotaExhausted) {
        invalidateAnthropicQuotaUsage(token.credentials.accessToken);
        if (accessToken !== token.credentials.accessToken) {
          invalidateAnthropicQuotaUsage(accessToken);
        }
        throw new Error(`quota exhausted (${token.name})`);
      }
      if (session.isError) {
        // 종료 사유를 먼저 표시하고 응답 본문은 진단에 필요한 만큼만 남긴다.
        const reason =
          session.subtype ?? session.terminalReason ?? (session.isError ? "is_error" : "unknown");
        const body = session.text
          ? session.text.length > 500
            ? `${session.text.slice(0, 500)}…(${session.text.length} chars)`
            : session.text
          : `empty text, outputTokens=${session.usage.outputTokens}`;
        const refusal = session.refusal ? ` refusal=${JSON.stringify(session.refusal)}` : "";
        throw new Error(`claude error (${token.name}) [${reason}]: ${body}${refusal}`);
      }

      return {
        text: session.text,
        tokenName: token.name,
        usage: session.usage,
        durationMs: session.durationMs,
        ttftMs: session.ttftMs,
        costUsd: session.costUsd,
        // Claude Code의 모델 fallback을 비용·감사 로그에 반영한다.
        model: session.servedModel ?? model,
        requestedModel: model,
        modelFallbacks: session.modelFallbacks,
        threadCoord: {
          workerId: makeAnthropicWorkerId(token.id),
          threadId: session.sessionId,
          epoch: 0,
        },
      };
    } finally {
      this.inFlight--;
    }
  }
}
