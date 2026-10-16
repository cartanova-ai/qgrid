import { type OpenAICredentials } from "../../../application/token/token.types";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  jsonString,
  type QuotaRateLimits,
  type QuotaRateLimitSnapshot,
  type QuotaRateLimitWindow,
} from "../common/provider-types";
import { buildCodexIdentityHeaders } from "./openai-backend-protocol";

export const CHATGPT_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage" as const;

export type OpenAIRateLimitsWithMeta = {
  data: QuotaRateLimits;
  cachedAt: number;
};

export type OpenAIQuotaUsageResult =
  | {
      kind: "ok";
      utilizationPct: number;
      cacheAgeMs: number;
      windowDurationMins: number | null;
      resetsAt: number | null;
      limitId: string | null;
      raw?: QuotaRateLimits;
    }
  | { kind: "lookup_failed"; reason: string };

export interface OpenAIQuotaHttpOptions {
  credentials: Pick<OpenAICredentials, "accessToken" | "accountId">;
  refreshCredentials?: () => Promise<Pick<OpenAICredentials, "accessToken" | "accountId">>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

async function readDirect(options: OpenAIQuotaHttpOptions): Promise<OpenAIRateLimitsWithMeta> {
  const read = (credentials: OpenAIQuotaHttpOptions["credentials"]) =>
    (options.fetch ?? fetch)(CHATGPT_WHAM_USAGE_URL, {
      method: "GET",
      headers: buildCodexIdentityHeaders(credentials.accessToken, credentials.accountId),
      signal: options.signal,
    });

  let response = await read(options.credentials);

  if (response.status === 401 && options.refreshCredentials) {
    await response.body?.cancel();
    options.signal?.throwIfAborted();
    const credentials = await options.refreshCredentials();
    options.signal?.throwIfAborted();
    response = await read(credentials);
  }

  if (!response.ok) throw new Error(`OpenAI quota lookup failed: HTTP ${response.status}`);
  // Response.json() parses JSON text, which yields only JSON values.
  const body: JsonValue = await response.json();
  const data = normalizeWhamUsage(body);

  return { data, cachedAt: Date.now() };
}

function jsonObjectOrEmpty(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function windowFrom(value: JsonValue | undefined): QuotaRateLimitWindow | null {
  if (!isJsonObject(value)) return null;
  const source = value;
  const usedPercent = Number(source.usedPercent ?? source.used_percent);

  if (!Number.isFinite(usedPercent)) return null;
  const durationMins = source.windowDurationMins ?? source.window_minutes;
  const durationSeconds = source.limitWindowSeconds ?? source.limit_window_seconds;
  const resets = source.resetsAt ?? source.reset_at;

  return {
    usedPercent,
    windowDurationMins:
      durationMins !== null && durationMins !== undefined
        ? Number(durationMins)
        : durationSeconds !== null && durationSeconds !== undefined
          ? Number(durationSeconds) / 60
          : null,
    resetsAt: resets === null || resets === undefined ? null : Number(resets),
  };
}

function snapshotFrom(value: JsonValue | undefined): QuotaRateLimitSnapshot {
  const source = jsonObjectOrEmpty(value);

  return {
    limitId: jsonString(source.limitId ?? source.limit_id) ?? null,
    limitName: jsonString(source.limitName ?? source.limit_name) ?? null,
    primary: windowFrom(source.primary ?? source.primary_window),
    secondary: windowFrom(source.secondary ?? source.secondary_window),
    credits: source.credits ?? null,
    planType: jsonString(source.planType ?? source.plan_type) ?? null,
    rateLimitReachedType:
      jsonString(source.rateLimitReachedType ?? source.rate_limit_reached) ?? null,
  };
}

/** Normalizes snapshots that already use the app-server (camelCase) shape. */
function normalizeAppServerUsage(body: JsonObject): QuotaRateLimits {
  const byId = isJsonObject(body.rateLimitsByLimitId)
    ? Object.fromEntries(
        Object.entries(body.rateLimitsByLimitId).map(([id, snapshot]) => [
          id,
          snapshotFrom(snapshot),
        ]),
      )
    : null;

  return { rateLimits: snapshotFrom(body.rateLimits), rateLimitsByLimitId: byId };
}

function normalizeWhamUsage(value: JsonValue): QuotaRateLimits {
  const body = jsonObjectOrEmpty(value);

  if (isJsonObject(body.rateLimits)) return normalizeAppServerUsage(body);

  const container = isJsonObject(body.rate_limits) ? body.rate_limits : body;

  const shared: JsonObject = {
    plan_type: body.plan_type ?? container.plan_type,
    credits: body.credits ?? container.credits,
    rate_limit_reached: body.rate_limit_reached ?? container.rate_limit_reached,
  };

  const primary = snapshotFrom({
    ...shared,
    ...jsonObjectOrEmpty(container.rate_limit ?? container),
  });

  const additional = Array.isArray(container.additional_rate_limits)
    ? container.additional_rate_limits
    : Array.isArray(body.additional_rate_limits)
      ? body.additional_rate_limits
      : [];

  const byId = new Map<string, QuotaRateLimitSnapshot>();

  for (const entry of additional) {
    if (!isJsonObject(entry)) continue;

    const snapshot = snapshotFrom({
      ...shared,
      ...jsonObjectOrEmpty(entry.rate_limit ?? entry),
    });

    if (snapshot.limitId) byId.set(snapshot.limitId, snapshot);
  }

  return {
    rateLimits: primary,
    rateLimitsByLimitId: byId.size ? Object.fromEntries(byId) : null,
  };
}

export async function readOpenAIQuotaUsage(
  source: (() => Promise<OpenAIRateLimitsWithMeta>) | OpenAIQuotaHttpOptions,
): Promise<OpenAIQuotaUsageResult> {
  try {
    const direct = "credentials" in source;
    const { data, cachedAt } = await ("credentials" in source ? readDirect(source) : source());
    const rateLimits = data.rateLimits;
    const primary = rateLimits?.primary;

    if (!primary || !Number.isFinite(primary.usedPercent)) {
      return { kind: "lookup_failed", reason: "primary usedPercent unavailable" };
    }

    const result: OpenAIQuotaUsageResult = {
      kind: "ok",
      utilizationPct: primary.usedPercent,
      cacheAgeMs: Math.max(Date.now() - cachedAt, 0),
      windowDurationMins: primary.windowDurationMins,
      resetsAt: primary.resetsAt,
      limitId: rateLimits.limitId,
    };

    if (direct) result.raw = data;

    return result;
  } catch (e) {
    return { kind: "lookup_failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
