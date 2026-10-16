import { grokProxyGet } from "./grok-direct-client";
import { buildGrokProxyGetHeaders } from "./grok-headers";
import {
  GrokBillingConfig,
  GrokSettings,
  GrokUserSubscription,
  type GrokCredentials,
} from "./grok-types";

// Chat-proxy reads for the quota gate (§5.3). Every reader returns a result union and never
// throws, so callers can fail open. The `ok` billing shape carries the same fields as
// OpenAIQuotaUsageResult so usage views can treat both providers alike.

export interface GrokProxyReadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  baseUrl?: string;
  now?: () => number;
}

type ProxyCredentials = Pick<GrokCredentials, "accessToken" | "userId">;

export type GrokQuotaUsageResult =
  | {
      kind: "ok";
      // Same names as OpenAIQuotaUsageResult.
      utilizationPct: number;
      cacheAgeMs: number;
      windowDurationMins: number | null;
      /** Unix seconds, like the OpenAI wham `resetsAt`. */
      resetsAt: number | null;
      limitId: string | null;
      // Grok specifics.
      periodType: string;
      periodStart: string;
      periodEnd: string;
      /** Epoch ms of periodEnd, or null when the timestamp is unparseable. */
      periodEndMs: number | null;
      prepaidBalance: number | null;
      raw: GrokBillingConfig;
    }
  | { kind: "lookup_failed"; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proxyHeaders(credentials: ProxyCredentials): Record<string, string> {
  return buildGrokProxyGetHeaders({ bearer: credentials.accessToken, userId: credentials.userId });
}

function numberOrNull(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/** `GET {proxy}/billing?format=credits` (camelCase; U0 item 3). */
export async function readGrokBilling(
  credentials: ProxyCredentials,
  options: GrokProxyReadOptions = {},
): Promise<GrokQuotaUsageResult> {
  try {
    const { json } = await grokProxyGet("/billing?format=credits", {
      headers: proxyHeaders(credentials),
      ...options,
    });

    const parsed = GrokBillingConfig.safeParse(json);

    if (!parsed.success) {
      return { kind: "lookup_failed", reason: `unexpected billing shape: ${parsed.error.message}` };
    }

    const config = parsed.data.config;

    if (!Number.isFinite(config.creditUsagePercent)) {
      return { kind: "lookup_failed", reason: "creditUsagePercent unavailable" };
    }

    const start = Date.parse(config.currentPeriod.start);
    const end = Date.parse(config.currentPeriod.end);
    const endMs = Number.isNaN(end) ? null : end;

    return {
      kind: "ok",
      utilizationPct: config.creditUsagePercent,
      cacheAgeMs: 0,
      windowDurationMins:
        endMs !== null && !Number.isNaN(start) && endMs > start
          ? Math.round((endMs - start) / 60_000)
          : null,
      resetsAt: endMs === null ? null : Math.floor(endMs / 1000),
      limitId: config.currentPeriod.type,
      periodType: config.currentPeriod.type,
      periodStart: config.currentPeriod.start,
      periodEnd: config.currentPeriod.end,
      periodEndMs: endMs,
      prepaidBalance: numberOrNull(config.prepaidBalance?.val),
      raw: parsed.data,
    };
  } catch (error) {
    return { kind: "lookup_failed", reason: reasonOf(error) };
  }
}

export type GrokSettingsResult =
  | {
      kind: "ok";
      /** D6: `true` excludes the token; null/false/absent allows it. */
      onDemandEnabled: boolean | null;
      minClientVersion: string | null;
      defaultModel: string | null;
      subscriptionTierDisplay: string | null;
      imageGenEnabled: boolean | null;
      videoGenEnabled: boolean | null;
      voiceModeEnabled: boolean | null;
    }
  | { kind: "lookup_failed"; reason: string };

/** `GET {proxy}/settings`. */
export async function readGrokSettings(
  credentials: ProxyCredentials,
  options: GrokProxyReadOptions = {},
): Promise<GrokSettingsResult> {
  try {
    const { json } = await grokProxyGet("/settings", {
      headers: proxyHeaders(credentials),
      ...options,
    });

    const parsed = GrokSettings.safeParse(json);

    if (!parsed.success) {
      return {
        kind: "lookup_failed",
        reason: `unexpected settings shape: ${parsed.error.message}`,
      };
    }

    const settings = parsed.data;

    return {
      kind: "ok",
      onDemandEnabled: settings.on_demand_enabled ?? null,
      minClientVersion: settings.min_client_version ?? null,
      defaultModel: settings.default_model ?? null,
      subscriptionTierDisplay: settings.subscription_tier_display ?? null,
      imageGenEnabled: settings.image_gen_enabled ?? null,
      videoGenEnabled: settings.video_gen_enabled ?? null,
      voiceModeEnabled: settings.voice_mode_enabled ?? null,
    };
  } catch (error) {
    return { kind: "lookup_failed", reason: reasonOf(error) };
  }
}

export type GrokSubscriptionResult =
  | {
      kind: "ok";
      userId: string;
      tier: string | null;
      hasGrokCodeAccess: boolean | null;
      /** `codingDataRetentionOptOut`: true means Zero Data Retention is on; null when absent. */
      dataRetentionOptOut: boolean | null;
    }
  | { kind: "lookup_failed"; reason: string };

/** `GET {proxy}/user?include=subscription`. */
export async function readGrokSubscription(
  credentials: ProxyCredentials,
  options: GrokProxyReadOptions = {},
): Promise<GrokSubscriptionResult> {
  try {
    const { json } = await grokProxyGet("/user?include=subscription", {
      headers: proxyHeaders(credentials),
      ...options,
    });

    const parsed = GrokUserSubscription.safeParse(json);

    if (!parsed.success) {
      return { kind: "lookup_failed", reason: `unexpected user shape: ${parsed.error.message}` };
    }

    return {
      kind: "ok",
      userId: parsed.data.userId,
      tier: parsed.data.subscriptionTier ?? null,
      hasGrokCodeAccess: parsed.data.hasGrokCodeAccess ?? null,
      dataRetentionOptOut: parsed.data.codingDataRetentionOptOut ?? null,
    };
  } catch (error) {
    return { kind: "lookup_failed", reason: reasonOf(error) };
  }
}
