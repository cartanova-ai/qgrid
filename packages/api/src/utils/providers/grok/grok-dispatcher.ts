import { createHash, randomUUID } from "node:crypto";

import { getLogger } from "@logtape/logtape";
import { z } from "zod";

import { type GrokProviderDispatcher } from "../../../application/qgrid/qgrid.dispatcher";
import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type MediaDispatcher,
  type MediaDispatchResult,
  type MediaTokenSelection,
  type ProviderToolCall,
  type ToolDefinition,
  type VoiceDispatcher,
} from "../common/provider-dispatcher";
import { type JsonValue } from "../common/provider-types";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import { ThinkingValidationError } from "../common/thinking";
import {
  buildGrokResponsesRequest,
  type GrokInputContentPart,
  type GrokInputItem,
  type GrokResponsesRequest,
  type GrokTool,
  type GrokUsage,
} from "./grok-backend-protocol";
import { GROK_BUILD_VERSION, GROK_USD_PER_TICK, type GrokReasoningEffort } from "./grok-constants";
import { GrokChatClient, GrokHttpError, GrokIdleTimeoutError } from "./grok-direct-client";
import { buildGrokChatHeaders } from "./grok-headers";
import { GrokModelCatalog, type GrokResolvedModel } from "./grok-models";
import {
  readGrokBilling,
  readGrokSettings,
  readGrokSubscription,
  type GrokQuotaUsageResult,
  type GrokSettingsResult,
  type GrokSubscriptionResult,
} from "./grok-quota";
import { grokNeedsRefresh } from "./grok-refresh";
import {
  GrokCredentials,
  type GrokImageEditRequest,
  type GrokImageGenerateRequest,
  type GrokImageResponse,
  type GrokMediaAuth,
  type GrokMediaPort,
  type GrokRefresher,
  type GrokSpeechResult,
  type GrokSttResponse,
  type GrokTranscribeRequest,
  type GrokTtsRequest,
  type GrokVideoStart,
  type GrokVideoStartRequest,
  type GrokVideoStatus,
  type GrokVoicePort,
} from "./grok-types";

const logger = getLogger(["qgrid", "grok-dispatcher"]);

export type GrokRequestClass = "chat" | "image" | "video" | "stt" | "tts";

export const GROK_LOOKUP_CACHE_TTL_MS = 60_000;
export const GROK_MAX_COOLDOWN_MS = 120_000;
export const GROK_DEFAULT_COOLDOWN_MS = 10_000;
export const GROK_MAX_COOLDOWN_WAIT_MS = 30_000;
export const GROK_QUOTA_BLOCK_FALLBACK_MS = 3_600_000;
export const GROK_ENTITLEMENT_BLOCK_MS = 3_600_000;
export const GROK_VERSION_GATE_REPROBE_MS = 600_000;
export const GROK_MAX_HOPS = 2;
export const GROK_MAX_REFRESHES = 1;
export const GROK_MAX_TRANSIENT_FAILOVERS = 1;
/** A token whose pre-lookup refresh failed transiently sits out selection this long (§5.1). */
export const GROK_REFRESH_FAILED_COOLDOWN_MS = 5_000;
/** Retries with the token's current credentials after a 401 that a newer bearer superseded. */
export const GROK_MAX_STALE_AUTH_RETRIES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GrokInvalidRequestError extends Error {
  readonly code = "GROK_INVALID_REQUEST" as const;

  constructor(message: string) {
    super(message);
    this.name = "GrokInvalidRequestError";
  }
}

export class GrokRateLimitedError extends Error {
  readonly code = "GROK_RATE_LIMITED" as const;
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message?: string) {
    super(message ?? `All grok tokens are rate limited; retry after ${retryAfterSec}s`);
    this.name = "GrokRateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

export class GrokCapacityError extends Error {
  readonly code = "GROK_CAPACITY" as const;

  constructor(message = "All grok tokens are at their in-flight request cap") {
    super(message);
    this.name = "GrokCapacityError";
  }
}

export class GrokOnDemandExcludedError extends Error {
  readonly code = "GROK_ON_DEMAND_EXCLUDED" as const;
  readonly tokenNames: string[];

  constructor(tokenNames: string[]) {
    super(
      `All grok tokens are excluded because on-demand billing is enabled: ${tokenNames.join(", ")}`,
    );
    this.name = "GrokOnDemandExcludedError";
    this.tokenNames = tokenNames;
  }
}

/**
 * xAI refuses video generation for Zero Data Retention accounts unless the caller supplies its own
 * `output.upload_url` (plan §11), which qgrid does not implement.
 */
export class GrokZdrVideoUnavailableError extends Error {
  readonly code = "GROK_ZDR_VIDEO_UNAVAILABLE" as const;
  readonly tokenNames: string[];

  constructor(tokenNames: string[]) {
    super(
      `Grok video is unavailable because Zero Data Retention is on for: ${tokenNames.join(", ")}. Turn off the data-retention opt-out at xAI, or use a non-ZDR account.`,
    );
    this.name = "GrokZdrVideoUnavailableError";
    this.tokenNames = tokenNames;
  }
}

/** The upstream 400 body for a ZDR account on POST /v1/videos/generations. */
const ZDR_VIDEO_REJECTION = /zero data retention/i;

export function isGrokZdrVideoRejection(error: GrokHttpError): boolean {
  return (
    error.status === 400 &&
    (ZDR_VIDEO_REJECTION.test(error.classification.message ?? "") ||
      ZDR_VIDEO_REJECTION.test(error.bodyText))
  );
}

export class GrokVersionGateError extends Error {
  readonly code = "GROK_VERSION_GATE" as const;
  readonly minClientVersion: string | undefined;

  constructor(minClientVersion: string | undefined) {
    super(
      `Grok chat proxy rejected client version ${GROK_BUILD_VERSION} (HTTP 426; requires ${
        minClientVersion ?? "a newer version"
      } or later). Bump GROK_BUILD_VERSION in grok-constants.ts and re-capture the golden fixture.`,
    );
    this.name = "GrokVersionGateError";
    this.minClientVersion = minClientVersion;
  }
}

export class GrokAttemptBudgetExceededError extends Error {
  readonly code = "GROK_ATTEMPT_BUDGET_EXCEEDED" as const;

  constructor(attempts: number, cause: unknown) {
    super(
      `Grok request failed after ${attempts} attempts: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "GrokAttemptBudgetExceededError";
  }
}

export class GrokNoWorkersError extends Error {
  readonly code = "NO_GROK_WORKERS" as const;

  constructor(message = "NO_GROK_WORKERS") {
    super(message);
    this.name = "GrokNoWorkersError";
  }
}

export class GrokCapabilityUnavailableError extends Error {
  readonly code = "GROK_CAPABILITY_UNAVAILABLE" as const;

  constructor(capability: string) {
    super(`Grok ${capability} is not configured on this server`);
    this.name = "GrokCapabilityUnavailableError";
  }
}

/** The refresher could not produce usable credentials for a token before the request was sent. */
export class GrokCredentialRefreshError extends Error {
  readonly code = "GROK_CREDENTIAL_REFRESH" as const;
  readonly reauthRequired: boolean;

  /**
   * `reauthRequired` defaults to the cause's convention: the port signals a dead refresh token with
   * GrokReauthRequiredError (grok-refresh.ts), checked by name so any GrokRefresher implementation
   * can use it.
   */
  constructor(
    cause: unknown,
    reauthRequired = cause instanceof Error && cause.name === "GrokReauthRequiredError",
  ) {
    super(
      `Grok credential refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "GrokCredentialRefreshError";
    this.reauthRequired = reauthRequired;
  }

  /** The refresher answered `reauth_required`: the refresh token is dead. */
  static reauthRequired(reason: string): GrokCredentialRefreshError {
    return new GrokCredentialRefreshError(reason, true);
  }
}

export class GrokIncompleteResponseError extends Error {
  readonly code = "GROK_INCOMPLETE_RESPONSE" as const;
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    super(`Grok response incomplete${reason ? `: ${reason}` : ""}`);
    this.name = "GrokIncompleteResponseError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Token state (§5.1)
// ---------------------------------------------------------------------------

type Cached<T> = { value: T; fetchedAt: number; generation: number };

type IneligibleReason =
  | "inactive"
  | "reauth"
  | "refresh_failed"
  | "on_demand"
  | "zdr"
  | "entitlement"
  | "quota"
  | "cooldown"
  | "capacity";

export interface GrokTokenState {
  id: number;
  name: string;
  weight: number;
  quotaThreshold: number | null;
  credentials: GrokCredentials | undefined;
  invalidReason: string | undefined;
  generation: number;
  inFlight: number;
  cooldowns: Map<GrokRequestClass, number>;
  quotaBlocks: Map<GrokRequestClass, number>;
  entitlementBlocks: Map<GrokRequestClass, number>;
  reauthRequired: boolean;
  /**
   * Until when the token is out of selection after a transient pre-lookup refresh failure: its
   * gating lookups could not run with a valid bearer, so the gates are unknown.
   */
  refreshFailedUntil: number;
  refreshFailure: unknown;
  billing: Cached<GrokQuotaUsageResult> | undefined;
  billingNotBefore: number;
  settings: Cached<GrokSettingsResult> | undefined;
  subscription: Cached<GrokSubscriptionResult> | undefined;
  /**
   * Zero Data Retention (plan §11): true excludes the token from video. Learned from
   * /user codingDataRetentionOptOut, confirmed by `x-zero-data-retention: true` or the upstream
   * ZDR 400; null is unknown and eligible.
   */
  zdr: boolean | null;
  overThreshold: boolean;
  lastTier: string | undefined;
  failoverCount: number;
}

export interface GrokTokenStateSnapshot {
  id: number;
  name: string;
  weight: number;
  active: boolean;
  invalidReason: string | null;
  inFlight: number;
  cooldownUntil: Partial<Record<GrokRequestClass, number>>;
  quotaBlockedUntil: Partial<Record<GrokRequestClass, number>>;
  entitlementBlocks: Partial<Record<GrokRequestClass, number>>;
  lastBilling: {
    utilizationPct: number;
    periodType: string;
    periodEnd: string;
    fetchedAt: number;
  } | null;
  quotaThreshold: number | null;
  overThreshold: boolean;
  onDemandExcluded: boolean;
  zdrVideoExcluded: boolean;
  lastTier: string | null;
  reauthRequired: boolean;
  failoverCount: number;
}

interface Reservation {
  token: GrokTokenState;
  release(): void;
}

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({ type: z.literal("input_image"), image_url: z.string().min(1) }),
  z.object({ type: z.literal("output_text"), text: z.string() }),
]);

const HistoryItem = z.union([
  z.object({
    type: z.literal("message").optional(),
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(ContentPart)]),
  }),
  z.object({
    type: z.literal("function_call"),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
    id: z.string().optional(),
  }),
  z.object({
    type: z.literal("function_call_output"),
    call_id: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string().optional(),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })).optional(),
    encrypted_content: z.string().optional(),
  }),
]);

function historyItems(history: readonly JsonValue[] | undefined): GrokInputItem[] {
  return (history ?? []).map((raw, index) => {
    const parsed = HistoryItem.safeParse(raw);
    if (!parsed.success) {
      throw new GrokInvalidRequestError(`Unsupported Grok history item at index ${index}`);
    }
    const item = parsed.data;
    if ("role" in item) return { type: "message", role: item.role, content: item.content };
    return item;
  });
}

function userMessage(req: GenerateRequest): GrokInputItem {
  const content: GrokInputContentPart[] = req.coldInput.map((input) => {
    if (input.type === "text") return { type: "input_text", text: input.text };
    if (input.type === "image") return { type: "input_image", image_url: input.url };
    if (input.type === "localImage") {
      throw new GrokInvalidRequestError("Grok does not accept local image paths; send a data URL");
    }
    return { type: "input_text", text: `${input.name}: ${input.path}` };
  });
  return { type: "message", role: "user", content };
}

function grokTools(tools: readonly ToolDefinition[] | undefined): GrokTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) =>
    tool.type === "function"
      ? {
          type: "function",
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.parameters,
          strict: tool.strict ?? false,
        }
      : { type: tool.type },
  );
}

/** Deterministic UUID-shaped id, so one qgrid conversation maps to one Grok conversation. */
function derivedGuid(namespace: string, key: string): string {
  const hex = createHash("sha256").update(`${namespace}\0${key}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function grokConversationIds(promptCacheKey: string | undefined): {
  convId: string;
  convGroupId: string;
} {
  const convId = promptCacheKey ? derivedGuid("grok-conv", promptCacheKey) : randomUUID();
  return { convId, convGroupId: derivedGuid("grok-conv-group", convId) };
}

/** USD from cost_in_usd_ticks, rounded to the tick resolution (1e-10). */
export function grokTicksToUsd(ticks: number): number {
  return Number((ticks * GROK_USD_PER_TICK).toFixed(10));
}

function parseMaxInflight(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    logger.warn(`ignoring QGRID_GROK_MAX_INFLIGHT_PER_TOKEN=${value}: not a positive integer`);
    return undefined;
  }
  return parsed;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

/** Imagine calls carry the token's session id like grok-build's per-request session header. */
function mediaAuth(credentials: GrokCredentials): GrokMediaAuth {
  return { bearer: credentials.accessToken, sessionId: credentials.sessionId };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function quotaMessage(entries: Array<{ name: string; threshold: number | null }>): string {
  const detail = entries
    .map((e) =>
      e.threshold === null ? `${e.name} (exhausted)` : `${e.name} (threshold ${e.threshold}%)`,
    )
    .join(", ");
  return detail
    ? `All grok tokens exceeded quota threshold: ${detail}`
    : "All grok tokens exceeded quota threshold";
}

function mapRecord(map: Map<GrokRequestClass, number>, now: number) {
  return Object.fromEntries([...map].filter(([, until]) => until > now));
}

/**
 * Persists a proven re-login requirement (`tokens.reauth_required`), mirroring the other providers'
 * auth-death path. `credentials` are the ones the failed attempt presented; the store skips the
 * write when the row has rotated since.
 */
export type GrokReauthReporter = (
  token: { id: number; name: string; credentials: GrokCredentials },
  reasonCode: string,
) => Promise<unknown>;

async function persistGrokReauth(
  token: { id: number; name: string; credentials: GrokCredentials },
  reasonCode: string,
): Promise<unknown> {
  // Loaded lazily: the token model pulls in the database layer, which the runtime does not need
  // until a token actually dies.
  const { deactivateAuthDeadToken } = await import("../../../application/qgrid/token-death");
  return deactivateAuthDeadToken({ ...token, provider: "grok" }, reasonCode);
}

/** Internal `grok:<code>` reason; provider text may carry account data, so only codes pass. */
function reauthReasonCode(code: unknown): string {
  return typeof code === "string" && /^[a-z_0-9]{1,80}$/.test(code)
    ? `grok:${code}`
    : "grok:unknown";
}

function oauthErrorOf(cause: unknown): unknown {
  return cause instanceof Error && "oauthError" in cause ? cause.oauthError : undefined;
}

/** The same bearer and refresh token: a failure judged against `b` applies to `a`. */
function sameCredentials(a: GrokCredentials | undefined, b: GrokCredentials): boolean {
  return a?.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface GrokDispatcherOptions {
  refresher: GrokRefresher;
  fetch?: typeof fetch;
  media?: GrokMediaPort;
  voice?: GrokVoicePort;
  now?: () => number;
  /** Default: QGRID_GROK_MAX_INFLIGHT_PER_TOKEN; undefined means uncapped (§5.6). */
  maxInflightPerToken?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  client?: GrokChatClient;
  catalog?: GrokModelCatalog;
  idleTimeoutMs?: number;
  /** Default: deactivateAuthDeadToken (application/qgrid/token-death.ts). */
  reportReauthRequired?: GrokReauthReporter;
}

type FailureAction =
  | { kind: "fail"; error: unknown }
  | { kind: "refresh"; presented: GrokCredentials }
  | { kind: "retry"; error: unknown }
  | { kind: "failover"; error: unknown; transient: boolean };

interface AttemptState {
  upstreamStarted: boolean;
  forwarded: boolean;
  /** The exact credentials this attempt presented (or tried to refresh); failures judge these. */
  presented: GrokCredentials | undefined;
}

export class GrokDispatcher implements GrokProviderDispatcher, MediaDispatcher, VoiceDispatcher {
  readonly tokens = new Map<number, GrokTokenState>();
  readonly selector = new SmoothWeightedRoundRobin();
  readonly refresher: GrokRefresher;
  readonly fetchImpl: typeof fetch;
  readonly media: GrokMediaPort | undefined;
  readonly voice: GrokVoicePort | undefined;
  readonly now: () => number;
  readonly maxInflightPerToken: number | undefined;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly client: GrokChatClient;
  readonly catalog: GrokModelCatalog;
  readonly idleTimeoutMs: number;
  readonly reportReauthRequired: GrokReauthReporter;
  readonly pendingBilling = new Map<number, Promise<void>>();
  readonly pendingSettings = new Map<number, Promise<void>>();
  readonly pendingSubscription = new Map<number, Promise<void>>();
  versionGate: { trippedAt: number; minClientVersion: string | undefined } | undefined;

  constructor(options: GrokDispatcherOptions) {
    this.refresher = options.refresher;
    this.fetchImpl = options.fetch ?? fetch;
    this.media = options.media;
    this.voice = options.voice;
    this.now = options.now ?? Date.now;
    this.maxInflightPerToken =
      "maxInflightPerToken" in options
        ? options.maxInflightPerToken
        : parseMaxInflight(process.env.QGRID_GROK_MAX_INFLIGHT_PER_TOKEN);
    this.sleep = options.sleep ?? defaultSleep;
    this.client = options.client ?? new GrokChatClient({ fetch: this.fetchImpl });
    this.catalog = options.catalog ?? new GrokModelCatalog();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reportReauthRequired = options.reportReauthRequired ?? persistGrokReauth;
  }

  // Tokens arrive through GrokTokenSink (TokenSubscriber reconciles on start).
  async start(): Promise<void> {
    logger.info(`started grok runtime with ${this.tokens.size} tokens`);
  }

  async stop(): Promise<void> {
    this.tokens.clear();
    this.pendingBilling.clear();
    this.pendingSettings.clear();
    this.pendingSubscription.clear();
    for (const id of this.selector.weights.keys()) this.selector.removeToken(id);
    this.versionGate = undefined;
  }

  // ---- GrokTokenSink -------------------------------------------------------

  onTokenAdded(
    id: number,
    name: string,
    credentials: unknown,
    quotaThreshold: number | null,
    weight: number,
  ): void {
    this.upsertToken(id, name, credentials, quotaThreshold, weight);
  }

  onTokenUpdated(
    id: number,
    name: string,
    credentials: unknown,
    quotaThreshold: number | null,
    weight: number,
  ): void {
    this.upsertToken(id, name, credentials, quotaThreshold, weight);
  }

  onTokenRemoved(id: number): void {
    this.tokens.delete(id);
    this.selector.removeToken(id);
    this.pendingBilling.delete(id);
    this.pendingSettings.delete(id);
    this.pendingSubscription.delete(id);
  }

  replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: unknown;
      quotaThreshold: number | null;
      weight: number;
    }>,
  ): void {
    const ids = new Set(rows.map((row) => row.id));
    for (const id of this.tokens.keys()) if (!ids.has(id)) this.onTokenRemoved(id);
    for (const row of rows)
      this.upsertToken(row.id, row.name, row.credentials, row.quotaThreshold, row.weight);
  }

  upsertToken(
    id: number,
    name: string,
    rawCredentials: unknown,
    quotaThreshold: number | null,
    weight: number,
  ): void {
    const parsed = GrokCredentials.safeParse(rawCredentials);
    // Only paths are logged; values may be secrets.
    let invalidReason = parsed.success
      ? undefined
      : `invalid credentials at ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "<root>"))].join(", ")}`;
    if (!invalidReason && (!Number.isInteger(weight) || weight < 1 || weight > 100)) {
      invalidReason = `invalid weight ${weight}`;
    }
    const credentials = parsed.success ? parsed.data : undefined;
    const old = this.tokens.get(id);
    if (old) {
      const credentialsChanged =
        old.credentials?.accessToken !== credentials?.accessToken ||
        old.credentials?.refreshToken !== credentials?.refreshToken;
      const thresholdChanged = old.quotaThreshold !== quotaThreshold;
      old.name = name;
      old.weight = weight;
      old.quotaThreshold = quotaThreshold;
      old.credentials = credentials;
      old.invalidReason = invalidReason;
      if (credentialsChanged || thresholdChanged) {
        old.generation++;
        old.billing = undefined;
        old.settings = undefined;
        old.subscription = undefined;
        old.overThreshold = false;
      }
      if (credentialsChanged) {
        old.reauthRequired = false;
        old.refreshFailedUntil = 0;
        old.refreshFailure = undefined;
        // New credentials may belong to another account; ZDR is account-level.
        old.zdr = null;
      }
    } else {
      this.tokens.set(id, {
        id,
        name,
        weight,
        quotaThreshold,
        credentials,
        invalidReason,
        generation: 1,
        inFlight: 0,
        cooldowns: new Map(),
        quotaBlocks: new Map(),
        entitlementBlocks: new Map(),
        reauthRequired: false,
        refreshFailedUntil: 0,
        refreshFailure: undefined,
        billing: undefined,
        billingNotBefore: 0,
        settings: undefined,
        subscription: undefined,
        zdr: null,
        overThreshold: false,
        lastTier: credentials?.subscriptionTier,
        failoverCount: 0,
      });
    }
    if (invalidReason) {
      logger.warn(`grok token ${name}[${id}] treated as inactive: ${invalidReason}`);
      this.selector.removeToken(id);
    } else {
      this.selector.setToken(id, weight);
    }
  }

  // ---- Eligibility (§5.1) -------------------------------------------------

  /**
   * `held` counts reservations the caller already holds on `token` (re-checks mid-request).
   * `ungated` skips the admission gates and checks only that the credentials are usable.
   */
  ineligibility(
    token: GrokTokenState,
    requestClass: GrokRequestClass,
    now: number,
    held = 0,
    ungated = false,
  ): IneligibleReason | undefined {
    if (!token.credentials || token.invalidReason) return "inactive";
    if (token.reauthRequired) return "reauth";
    if (token.refreshFailedUntil > now) return "refresh_failed";
    if (ungated) return undefined;
    const settings = token.settings?.value;
    if (settings?.kind === "ok" && settings.onDemandEnabled === true) return "on_demand";
    if (requestClass === "video" && token.zdr === true) return "zdr";
    if ((token.entitlementBlocks.get(requestClass) ?? 0) > now) return "entitlement";
    if ((token.quotaBlocks.get(requestClass) ?? 0) > now) return "quota";
    if (token.quotaThreshold !== null && token.overThreshold) return "quota";
    if ((token.cooldowns.get(requestClass) ?? 0) > now) return "cooldown";
    if (this.maxInflightPerToken !== undefined && token.inFlight - held >= this.maxInflightPerToken)
      return "capacity";
    return undefined;
  }

  isEligible(token: GrokTokenState, requestClass: GrokRequestClass): boolean {
    return this.ineligibility(token, requestClass, this.now()) === undefined;
  }

  /**
   * Refreshes the 60 s settings/subscription/billing caches. Lookup failures fail open, so an
   * expired bearer is refreshed first: a lookup with it would fail and open every gate. A failed
   * refresh therefore takes the token out of selection (`refresh_failed`) instead of failing open.
   */
  async prefetch(token: GrokTokenState, signal?: AbortSignal): Promise<void> {
    if (!token.credentials || token.invalidReason || token.reauthRequired) return;
    let now = this.now();
    const tasks: Promise<void>[] = [];
    const stale = (entry: Cached<unknown> | undefined) =>
      !entry ||
      entry.generation !== token.generation ||
      now - entry.fetchedAt >= GROK_LOOKUP_CACHE_TTL_MS;
    const billingDue = () =>
      (token.quotaThreshold !== null || [...token.quotaBlocks.values()].some((u) => u > now)) &&
      stale(token.billing) &&
      now >= token.billingNotBefore;
    if (!stale(token.settings) && !stale(token.subscription) && !billingDue()) return;

    if (grokNeedsRefresh(token.credentials, now)) {
      // Do not hammer the IdP: the cooldown expires before the next refresh is tried.
      if (token.refreshFailedUntil > now) return;
      const presented = token.credentials;
      try {
        await this.freshCredentials(token, signal ?? new AbortController().signal);
      } catch (error) {
        // Lookups with this bearer would fail open, so the gates stay unknown and the token sits
        // out selection until a later refresh succeeds.
        if (signal?.aborted) return;
        if (error instanceof Error && error.name === "GrokReauthRequiredError")
          this.markReauthRequired(token, presented, reauthReasonCode(oauthErrorOf(error)));
        else this.markRefreshFailed(token, presented, error);
        return;
      }
      if (!token.credentials || token.reauthRequired || this.tokens.get(token.id) !== token) return;
      now = this.now();
    }

    if (stale(token.settings)) tasks.push(this.loadSettings(token));
    if (stale(token.subscription)) tasks.push(this.loadSubscription(token));
    const blocked = [...token.quotaBlocks.values()].some((until) => until > now);
    if ((token.quotaThreshold !== null || blocked) && stale(token.billing)) {
      if (now >= token.billingNotBefore) tasks.push(this.loadBilling(token));
    }
    await Promise.all(tasks);
  }

  /** Transient refresh failure for `presented`; ignored when the token already holds newer ones. */
  markRefreshFailed(token: GrokTokenState, presented: GrokCredentials, error: unknown): void {
    if (this.tokens.get(token.id) !== token || !sameCredentials(token.credentials, presented))
      return;
    token.refreshFailedUntil = this.now() + GROK_REFRESH_FAILED_COOLDOWN_MS;
    token.refreshFailure = error;
    logger.warn(
      `grok token ${token.name}[${token.id}] refresh failed; out of selection for ${GROK_REFRESH_FAILED_COOLDOWN_MS}ms: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }

  loadSettings(token: GrokTokenState): Promise<void> {
    const pending = this.pendingSettings.get(token.id);
    if (pending) return pending;
    const generation = token.generation;
    const credentials = token.credentials!;
    const promise = readGrokSettings(credentials, { fetch: this.fetchImpl })
      .then((result) => {
        if (this.tokens.get(token.id) !== token || token.generation !== generation) return;
        token.settings = { value: result, fetchedAt: this.now(), generation };
        if (result.kind === "lookup_failed") {
          logger.warn("quota_threshold gate: settings_lookup_fail_open", {
            tokenId: token.id,
            tokenName: token.name,
            lookupReason: result.reason,
          });
          return;
        }
        if (result.subscriptionTierDisplay) token.lastTier = result.subscriptionTierDisplay;
        if (result.onDemandEnabled === true) {
          logger.info(
            `quota_threshold gate: on_demand_excluded ${token.name}[${token.id}] (on_demand_enabled=true)`,
          );
        }
      })
      .finally(() => {
        if (this.pendingSettings.get(token.id) === promise) this.pendingSettings.delete(token.id);
      });
    this.pendingSettings.set(token.id, promise);
    return promise;
  }

  /** /user codingDataRetentionOptOut is the primary ZDR signal; a failed read keeps the last value. */
  loadSubscription(token: GrokTokenState): Promise<void> {
    const pending = this.pendingSubscription.get(token.id);
    if (pending) return pending;
    const generation = token.generation;
    const credentials = token.credentials!;
    const promise = readGrokSubscription(credentials, { fetch: this.fetchImpl })
      .then((result) => {
        if (this.tokens.get(token.id) !== token || token.generation !== generation) return;
        token.subscription = { value: result, fetchedAt: this.now(), generation };
        if (result.kind === "lookup_failed") {
          logger.debug(`grok subscription lookup failed for ${token.name}[${token.id}]`, {
            lookupReason: result.reason,
          });
          return;
        }
        if (result.dataRetentionOptOut !== null) {
          this.setZdr(token, result.dataRetentionOptOut, "codingDataRetentionOptOut");
        }
      })
      .finally(() => {
        if (this.pendingSubscription.get(token.id) === promise)
          this.pendingSubscription.delete(token.id);
      });
    this.pendingSubscription.set(token.id, promise);
    return promise;
  }

  setZdr(token: GrokTokenState, zdr: boolean, source: string): void {
    if (this.tokens.get(token.id) !== token || token.zdr === zdr) return;
    token.zdr = zdr;
    logger.info(
      zdr
        ? `grok token ${token.name}[${token.id}] excluded from video: zero data retention (${source})`
        : `grok token ${token.name}[${token.id}] video eligible: zero data retention off (${source})`,
    );
  }

  /** `x-zero-data-retention: true` confirms ZDR; its absence never clears it (next /user read does). */
  observeResponseHeaders(
    token: GrokTokenState,
    credentials: GrokCredentials,
    headers: { zeroDataRetention?: boolean },
  ): void {
    if (token.credentials?.accessToken !== credentials.accessToken) return;
    if (headers.zeroDataRetention === true) this.setZdr(token, true, "x-zero-data-retention");
  }

  loadBilling(token: GrokTokenState): Promise<void> {
    const pending = this.pendingBilling.get(token.id);
    if (pending) return pending;
    const generation = token.generation;
    const credentials = token.credentials!;
    const promise = readGrokBilling(credentials, { fetch: this.fetchImpl })
      .then((result) => {
        if (this.tokens.get(token.id) !== token || token.generation !== generation) return;
        const now = this.now();
        token.billing = { value: result, fetchedAt: now, generation };
        if (result.kind === "lookup_failed") {
          token.overThreshold = false;
          logger.warn("quota_threshold gate: lookup_fail_open", {
            tokenId: token.id,
            tokenName: token.name,
            lookupReason: result.reason,
          });
          return;
        }
        const limit = token.quotaThreshold ?? 100;
        const over = token.quotaThreshold !== null && result.utilizationPct >= token.quotaThreshold;
        if (over && !token.overThreshold) {
          logger.info(
            `quota_threshold gate: over_threshold ${token.name}[${token.id}] (${result.utilizationPct}% >= ${token.quotaThreshold}%)`,
          );
        }
        if (!over && token.overThreshold) {
          logger.info(
            `quota_threshold gate: recovered ${token.name}[${token.id}] (${result.utilizationPct}% < ${token.quotaThreshold}%)`,
          );
        }
        token.overThreshold = over;
        if (result.utilizationPct < limit && token.quotaBlocks.size) {
          token.quotaBlocks.clear();
          logger.info(
            `quota_threshold gate: exhaustion_cleared ${token.name}[${token.id}] (${result.utilizationPct}% < ${limit}%)`,
          );
        }
      })
      .finally(() => {
        if (this.pendingBilling.get(token.id) === promise) this.pendingBilling.delete(token.id);
      });
    this.pendingBilling.set(token.id, promise);
    return promise;
  }

  // ---- Selection (§5.2) ---------------------------------------------------

  reserve(token: GrokTokenState): Reservation {
    token.inFlight++;
    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        token.inFlight = Math.max(0, token.inFlight - 1);
      },
    };
  }

  checkVersionGate(requestClass: GrokRequestClass): void {
    if (requestClass !== "chat" || !this.versionGate) return;
    if (this.now() - this.versionGate.trippedAt < GROK_VERSION_GATE_REPROBE_MS) {
      throw new GrokVersionGateError(this.versionGate.minClientVersion);
    }
    // Re-probe: let requests through; a fresh 426 trips the gate again.
  }

  async selectToken(
    requestClass: GrokRequestClass,
    options: {
      preferredTokenId?: number;
      requirePreferredToken?: boolean;
      excluded?: ReadonlySet<number>;
      signal?: AbortSignal;
      deadline?: number;
      ungated?: boolean;
    } = {},
  ): Promise<Reservation> {
    this.checkVersionGate(requestClass);
    const excluded = options.excluded ?? new Set<number>();

    if (options.preferredTokenId !== undefined) {
      const preferred = this.tokens.get(options.preferredTokenId);
      if (preferred && !excluded.has(preferred.id)) {
        for (let round = 0; ; round++) {
          await this.prefetch(preferred, options.signal);
          options.signal?.throwIfAborted();
          const now = this.now();
          const reason = this.ineligibility(preferred, requestClass, now, 0, options.ungated);
          if (!reason) return this.reserve(preferred);
          if (!options.requirePreferredToken) break;
          // An exact target has no alternative: wait out one failed refresh, like a cooldown.
          const waitMs = preferred.refreshFailedUntil - now;
          if (
            reason === "refresh_failed" &&
            round === 0 &&
            waitMs <= GROK_MAX_COOLDOWN_WAIT_MS &&
            (options.deadline === undefined || now + waitMs < options.deadline)
          ) {
            await this.sleep(Math.max(0, waitMs), options.signal);
            continue;
          }
          throw this.preferredError(preferred, reason);
        }
      } else if (options.requirePreferredToken) {
        throw new GrokNoWorkersError(
          `Preferred grok token ${options.preferredTokenId} is not available`,
        );
      }
    }

    for (let round = 0; ; round++) {
      const candidates = [...this.tokens.values()].filter((token) => !excluded.has(token.id));
      await Promise.all(candidates.map((token) => this.prefetch(token, options.signal)));
      options.signal?.throwIfAborted();
      // Synchronous from here to reserve(): concurrent selections cannot overshoot the cap.
      const now = this.now();
      const reasons = new Map<GrokTokenState, IneligibleReason>();
      const eligible = new Set<number>();
      for (const token of candidates) {
        const reason = this.ineligibility(token, requestClass, now);
        if (reason) reasons.set(token, reason);
        else eligible.add(token.id);
      }
      if (eligible.size) {
        const selected = this.selector.select(eligible);
        const token = selected === null ? undefined : this.tokens.get(selected);
        if (token) return this.reserve(token);
      }

      const present = new Set(reasons.values());
      if (present.has("capacity")) throw new GrokCapacityError();
      if (present.has("cooldown") || present.has("refresh_failed")) {
        // A failed refresh is a short transient cooldown: wait once, then re-run the lookups.
        const until = (token: GrokTokenState, reason: IneligibleReason) =>
          reason === "cooldown"
            ? (token.cooldowns.get(requestClass) ?? now)
            : reason === "refresh_failed"
              ? token.refreshFailedUntil
              : Number.POSITIVE_INFINITY;
        const soonest = Math.min(...[...reasons].map(([token, reason]) => until(token, reason)));
        const waitMs = Math.max(0, Math.min(soonest - now, GROK_MAX_COOLDOWN_WAIT_MS));
        const withinDeadline = options.deadline === undefined || now + waitMs < options.deadline;
        if (round === 0 && withinDeadline) {
          await this.sleep(waitMs, options.signal);
          continue;
        }
        const cooling = [...reasons].filter(([, reason]) => reason === "cooldown");
        if (cooling.length) {
          const soonestCooldown = Math.min(...cooling.map(([token]) => until(token, "cooldown")));
          throw new GrokRateLimitedError(Math.max(1, Math.ceil((soonestCooldown - now) / 1000)));
        }
        const failed = [...reasons].find(([, reason]) => reason === "refresh_failed");
        throw new GrokCredentialRefreshError(failed?.[0].refreshFailure ?? "refresh failed", false);
      }
      if (present.has("quota")) {
        const over = [...reasons]
          .filter(([, reason]) => reason === "quota")
          .map(([token]) => ({
            name: token.name,
            threshold: token.overThreshold ? token.quotaThreshold : null,
          }));
        logger.warn("quota_threshold gate: all_exceeded", {
          provider: "grok",
          overThresholdTokens: over,
        });
        throw new QuotaThresholdExceededError(quotaMessage(over));
      }
      if (present.has("on_demand")) {
        throw new GrokOnDemandExcludedError(
          [...reasons].filter(([, reason]) => reason === "on_demand").map(([token]) => token.name),
        );
      }
      if (present.has("zdr")) {
        throw new GrokZdrVideoUnavailableError(
          [...reasons].filter(([, reason]) => reason === "zdr").map(([token]) => token.name),
        );
      }
      throw new GrokNoWorkersError();
    }
  }

  preferredError(token: GrokTokenState, reason: IneligibleReason): Error {
    const now = this.now();
    if (reason === "quota") {
      return new QuotaThresholdExceededError(
        quotaMessage([
          { name: token.name, threshold: token.overThreshold ? token.quotaThreshold : null },
        ]),
      );
    }
    if (reason === "cooldown") {
      const until = Math.max(...token.cooldowns.values());
      return new GrokRateLimitedError(Math.max(1, Math.ceil((until - now) / 1000)));
    }
    if (reason === "capacity") return new GrokCapacityError();
    if (reason === "refresh_failed")
      return new GrokCredentialRefreshError(token.refreshFailure ?? "refresh failed", false);
    if (reason === "on_demand") return new GrokOnDemandExcludedError([token.name]);
    if (reason === "zdr") return new GrokZdrVideoUnavailableError([token.name]);
    return new GrokNoWorkersError(`Preferred grok token ${token.id} is not available (${reason})`);
  }

  // ---- Failure handling (§5.4) -------------------------------------------

  applyHttpFailure(
    token: GrokTokenState,
    requestClass: GrokRequestClass,
    error: GrokHttpError,
  ): void {
    const now = this.now();
    const { classification } = error;
    if (classification.kind === "rate_limited") {
      const cooldownMs = Math.min(
        classification.retryAfterSec === undefined
          ? GROK_DEFAULT_COOLDOWN_MS
          : classification.retryAfterSec * 1000,
        GROK_MAX_COOLDOWN_MS,
      );
      token.cooldowns.set(requestClass, now + cooldownMs);
      logger.info(
        `grok token ${token.name}[${token.id}] cooldown ${cooldownMs}ms (${requestClass})`,
      );
    } else if (classification.kind === "quota_exhausted") {
      const billing = token.billing?.value;
      const periodEnd = billing?.kind === "ok" ? billing.periodEndMs : null;
      const until =
        periodEnd !== null && periodEnd > now ? periodEnd : now + GROK_QUOTA_BLOCK_FALLBACK_MS;
      token.quotaBlocks.set(requestClass, until);
      token.billing = undefined;
      // A billing read right after the 429 may still lag the proxy; wait one cache period.
      token.billingNotBefore = now + GROK_LOOKUP_CACHE_TTL_MS;
      logger.info(
        `quota_threshold gate: exhausted ${token.name}[${token.id}] until ${new Date(until).toISOString()} (${classification.code ?? "429"})`,
      );
    } else if (classification.kind === "entitlement" && requestClass !== "chat") {
      token.entitlementBlocks.set(requestClass, now + GROK_ENTITLEMENT_BLOCK_MS);
    } else if (classification.kind === "version_gate" && requestClass === "chat") {
      this.versionGate = { trippedAt: now, minClientVersion: classification.minClientVersion };
      logger.error(
        `grok chat proxy version gate tripped: ${GROK_BUILD_VERSION} < ${classification.minClientVersion ?? "?"}`,
      );
    }
  }

  classifyFailure(
    token: GrokTokenState,
    requestClass: GrokRequestClass,
    error: unknown,
    presented: GrokCredentials | undefined,
    refreshedThisRequest: boolean,
    refreshBudgetLeft: boolean,
  ): FailureAction {
    if (error instanceof GrokIdleTimeoutError) {
      // Reached only before any event: no upstream execution was observed.
      return requestClass === "chat"
        ? { kind: "failover", error, transient: true }
        : { kind: "fail", error };
    }
    if (error instanceof GrokCredentialRefreshError) {
      // Nothing reached upstream; another token can serve the request.
      // Judged against the credentials this refresh started from: if a concurrent refresh or a
      // subscriber update already replaced them, the failure says nothing about the new ones.
      if (presented) {
        if (error.reauthRequired)
          this.markReauthRequired(token, presented, reauthReasonCode(oauthErrorOf(error.cause)));
        else this.markRefreshFailed(token, presented, error.cause);
      }
      return { kind: "failover", error, transient: false };
    }
    if (!(error instanceof GrokHttpError)) return { kind: "fail", error };
    if (requestClass === "video" && isGrokZdrVideoRejection(error)) {
      // The ZDR signal was stale or unknown. The 400 is a definite rejection (no job was created),
      // so the start may move to another token under the media entitlement rules.
      this.setZdr(token, true, "upstream video 400");
      token.entitlementBlocks.set("video", this.now() + GROK_ENTITLEMENT_BLOCK_MS);
      return { kind: "failover", error, transient: false };
    }
    this.applyHttpFailure(token, requestClass, error);
    const { classification } = error;
    if (classification.kind === "version_gate") {
      return { kind: "fail", error: new GrokVersionGateError(classification.minClientVersion) };
    }
    if (classification.shouldRetry === false) return { kind: "fail", error };
    switch (classification.kind) {
      case "auth":
        if (!presented || !token.credentials) return { kind: "failover", error, transient: false };
        if (token.credentials.accessToken !== presented.accessToken) {
          // Stale 401: a newer bearer was installed while this attempt was in flight. It says
          // nothing about the current credentials, so neither refresh nor mark them; retry them.
          return { kind: "retry", error };
        }
        if (refreshedThisRequest) {
          // A 401 with just-refreshed credentials: only a new login recovers.
          this.markReauthRequired(token, presented, "grok:unauthorized_after_refresh");
          return { kind: "failover", error, transient: false };
        }
        if (refreshBudgetLeft) return { kind: "refresh", presented };
        return { kind: "failover", error, transient: false };
      case "rate_limited":
      case "quota_exhausted":
        return { kind: "failover", error, transient: false };
      case "entitlement":
        // Chat 403 is permanent for the request (grok-build rule); media fails over once.
        return requestClass === "chat"
          ? { kind: "fail", error }
          : { kind: "failover", error, transient: false };
      case "transient":
        if (requestClass === "chat") return { kind: "failover", error, transient: true };
        // Media/voice POSTs are never replayed once the body may have been executed. The media
        // and voice clients surface such failures as GrokMediaDeliveryError, GrokMediaTimeoutError
        // or `shouldRetry: false` (all handled above); a status-0 GrokHttpError that reaches this
        // point is a connect failure that provably happened before any byte was sent, so it fails
        // over once (transient: GROK_MAX_TRANSIENT_FAILOVERS). An HTTP 5xx never fails over.
        return error.status === 0
          ? { kind: "failover", error, transient: true }
          : { kind: "fail", error };
      default:
        return { kind: "fail", error };
    }
  }

  /**
   * Marks `token` dead in memory and, on the first transition, persists `tokens.reauth_required`.
   * `credentials` are the ones the failed attempt presented; a token already holding newer ones
   * (another bearer or refresh token) is left alone.
   */
  markReauthRequired(
    token: GrokTokenState,
    credentials: GrokCredentials,
    reasonCode: string,
  ): void {
    if (this.tokens.get(token.id) !== token) return;
    if (!sameCredentials(token.credentials, credentials)) return;
    if (token.reauthRequired) return;
    token.reauthRequired = true;
    logger.warn(`grok token ${token.name}[${token.id}] requires re-authentication (${reasonCode})`);
    void this.reportReauthRequired(
      { id: token.id, name: token.name, credentials },
      reasonCode,
    ).catch((error: unknown) => {
      logger.warn(
        `grok token ${token.name}[${token.id}] reauth_required persist failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    });
  }

  /**
   * Runs `attempt` with the §5.1 attempt budget: one forced refresh, at most GROK_MAX_HOPS
   * failovers (one of them transient). `canRetry` reports whether upstream execution may have
   * started, in which case nothing is retried.
   *
   * The reservation is held from selection until the request leaves the token (failover) or ends,
   * so a refresh and its same-token retry never step outside the in-flight cap. Whenever the
   * attempt is about to present credentials other than the ones the token's gates were evaluated
   * with (a refresh happened), the lookups and gates are re-run before anything is sent.
   */
  async withAttempts<T>(
    requestClass: GrokRequestClass,
    selection: MediaTokenSelection & { signal: AbortSignal; deadline?: number; ungated?: boolean },
    attempt: (
      token: GrokTokenState,
      credentials: GrokCredentials,
      state: AttemptState,
    ) => Promise<T>,
  ): Promise<T> {
    const excluded = new Set<number>();
    const refreshed = new Set<number>();
    let refreshes = 0;
    let hops = 0;
    let transientFailovers = 0;
    let attempts = 0;
    let staleRetries = 0;
    let reservation = await this.selectToken(requestClass, { ...selection, excluded });
    // The credentials the current token's gates were last evaluated with.
    let gated = reservation.token.credentials;
    try {
      for (;;) {
        const token = reservation.token;
        const state: AttemptState = {
          upstreamStarted: false,
          forwarded: false,
          presented: token.credentials,
        };
        let action: FailureAction;
        attempts++;
        try {
          let credentials: GrokCredentials;
          try {
            credentials = await this.freshCredentials(token, selection.signal);
          } catch (error) {
            if (selection.signal.aborted) throw error;
            throw new GrokCredentialRefreshError(error);
          }
          state.presented = credentials;
          const blocked =
            credentials.accessToken === gated?.accessToken
              ? undefined
              : await this.regate(token, requestClass, selection.signal, selection.ungated);
          gated = credentials;
          if (blocked) action = { kind: "failover", error: blocked, transient: false };
          else return await attempt(token, credentials, state);
        } catch (error) {
          if (selection.signal.aborted) throw abortReason(selection.signal);
          if (state.forwarded || state.upstreamStarted) throw error;
          action = this.classifyFailure(
            token,
            requestClass,
            error,
            state.presented,
            refreshed.has(token.id),
            refreshes < GROK_MAX_REFRESHES,
          );
        }

        if (action.kind === "fail") throw action.error;
        if (action.kind === "retry") {
          // Same token, current credentials, reservation still held.
          if (staleRetries++ < GROK_MAX_STALE_AUTH_RETRIES) continue;
          // Allowance spent: this token must not be reselected by the failover below.
          excluded.add(token.id);
          action = { kind: "failover", error: action.error, transient: false };
        }
        if (action.kind === "refresh") {
          refreshes++;
          refreshed.add(token.id);
          // The reservation stays held across the refresh: the retry is part of this attempt.
          const next = await this.tryRefresh(token, action.presented, selection.signal);
          if (next.kind === "refreshed") continue;
          action = { kind: "failover", error: next.error, transient: false };
        }

        // Failover: never past an exact target, the hop budget, or one transient retry.
        if (selection.requirePreferredToken) throw action.error;
        if (action.transient && ++transientFailovers > GROK_MAX_TRANSIENT_FAILOVERS)
          throw action.error;
        if (++hops > GROK_MAX_HOPS)
          throw new GrokAttemptBudgetExceededError(attempts, action.error);
        // Rate-limit/quota/reauth state already excludes the token; failures that leave no state
        // behind must not be retried on the same token within this request.
        if (action.transient || action.error instanceof GrokCredentialRefreshError)
          excluded.add(token.id);
        token.failoverCount++;
        logger.info(`grok failover from ${token.name}[${token.id}] (${requestClass})`, {
          reason: action.error instanceof Error ? action.error.message : String(action.error),
        });
        reservation.release();
        try {
          reservation = await this.selectToken(requestClass, {
            excluded,
            signal: selection.signal,
            ...(selection.deadline === undefined ? {} : { deadline: selection.deadline }),
          });
        } catch (selectionError) {
          if (selectionError instanceof GrokNoWorkersError) throw action.error;
          throw selectionError;
        }
        gated = reservation.token.credentials;
      }
    } finally {
      reservation.release();
    }
  }

  /**
   * Re-runs the lookups and gates for a token whose credentials changed after selection. Returns
   * the gate's error when the token is no longer eligible; the caller still holds one reservation.
   */
  private async regate(
    token: GrokTokenState,
    requestClass: GrokRequestClass,
    signal: AbortSignal,
    ungated?: boolean,
  ): Promise<Error | undefined> {
    await this.prefetch(token, signal);
    signal.throwIfAborted();
    const reason = this.ineligibility(token, requestClass, this.now(), 1, ungated);
    return reason ? this.preferredError(token, reason) : undefined;
  }

  /**
   * The one forced refresh after an upstream 401. A refreshed token is retried; otherwise the
   * request fails over. Only a `reauth_required` answer marks the token dead — a thrown refresh
   * failure is treated as transient and leaves the token alive.
   */
  private async tryRefresh(
    token: GrokTokenState,
    presented: GrokCredentials,
    signal: AbortSignal,
  ): Promise<{ kind: "refreshed" } | { kind: "failover"; error: GrokCredentialRefreshError }> {
    let result: Awaited<ReturnType<GrokRefresher["refreshAfterUnauthorized"]>>;
    try {
      result = await this.refresher.refreshAfterUnauthorized(
        { tokenId: token.id, credentials: presented },
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      return { kind: "failover", error: new GrokCredentialRefreshError(error) };
    }
    if (result.status === "refreshed") {
      this.storeCredentials(token, result.credentials);
      return { kind: "refreshed" };
    }
    this.markReauthRequired(token, presented, reauthReasonCode(result.reason));
    return { kind: "failover", error: GrokCredentialRefreshError.reauthRequired(result.reason) };
  }

  async freshCredentials(token: GrokTokenState, signal: AbortSignal): Promise<GrokCredentials> {
    const current = token.credentials;
    if (!current) throw new GrokNoWorkersError(`grok token ${token.id} has no valid credentials`);
    const fresh = await this.refresher.ensureFresh(
      { tokenId: token.id, credentials: current },
      signal,
    );
    this.storeCredentials(token, fresh);
    return fresh;
  }

  storeCredentials(token: GrokTokenState, credentials: GrokCredentials): void {
    // A subscriber update may already have replaced the row; never overwrite newer credentials.
    if (this.tokens.get(token.id) !== token) return;
    if (token.credentials?.accessToken === credentials.accessToken) return;
    token.credentials = credentials;
    token.reauthRequired = false;
    // Lookups cached (or in flight) under the old bearer may be fail-open lookup_failed results;
    // a new generation makes the next selection re-read them with this bearer. The cached values
    // still gate until then (same account), and the subscriber's echo of this row is a no-op.
    token.generation++;
    this.pendingBilling.delete(token.id);
    this.pendingSettings.delete(token.id);
    this.pendingSubscription.delete(token.id);
  }

  // ---- Chat ---------------------------------------------------------------

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.runChat(req);
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    try {
      cb.onComplete(await this.runChat(req, cb.onDelta));
    } catch (error) {
      cb.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  buildChatBody(req: GenerateRequest): {
    body: GrokResponsesRequest;
    model: GrokResolvedModel;
    convId: string;
    convGroupId: string;
    turnIdx: number;
  } {
    if (req.imageGeneration !== undefined && req.imageGeneration !== false) {
      throw new GrokInvalidRequestError(
        "imageGeneration is not supported on grok chat models; use the Grok image endpoint",
      );
    }
    if (req.imageGenerationOptions !== undefined) {
      throw new GrokInvalidRequestError(
        "imageGenerationOptions is not supported on grok chat models",
      );
    }
    if (req.serviceTier !== undefined) {
      throw new GrokInvalidRequestError("serviceTier is not supported on grok chat models");
    }
    // providerOptions.xai: the proxy's acceptance of these fields is unverified, so they are
    // rejected rather than forwarded or silently dropped.
    const xai = req.providerOptions?.xai;
    if (xai !== null && typeof xai === "object" && !Array.isArray(xai)) {
      for (const key of ["serviceTier", "parallelToolCalls"] as const) {
        if (xai[key] !== undefined && xai[key] !== null) {
          throw new GrokInvalidRequestError(
            `providerOptions.xai.${key} is not supported on grok chat models: the subscription proxy's handling is unverified`,
          );
        }
      }
    }
    if (req.thinking === false) {
      throw new ThinkingValidationError(
        "thinking:false is unavailable for Grok models: thinking-off support has not been verified on the subscription proxy",
      );
    }
    const model = this.catalog.resolve(req.model);
    if (!model.known) {
      // The proxy may serve another model for an unlisted id; the result's model shows which.
      logger.info(`grok model "${model.id}" is not in the catalog; forwarding it unvalidated`);
    }
    let effort: GrokReasoningEffort = model.defaultEffort;
    if (req.effort !== undefined) {
      const validated = this.catalog.validateEffort(model.id, req.effort);
      if (validated) effort = validated;
      else logger.debug(`ignoring effort "${req.effort}" for grok/${model.id}`);
    }
    const history = historyItems(req.coldHistory);
    const { convId, convGroupId } = grokConversationIds(req.promptCacheKey);
    const turnIdx =
      history.filter((item) => item.type === "message" && item.role === "user").length + 1;
    const tools = grokTools(req.tools);
    const body = buildGrokResponsesRequest({
      model: model.id,
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      history: [...history, userMessage(req)],
      promptCacheKey: convId,
      effort,
      ...(req.outputSchema === undefined ? {} : { outputSchema: { schema: req.outputSchema } }),
      ...(tools ? { tools } : {}),
    });
    return { body, model, convId, convGroupId, turnIdx };
  }

  async runChat(req: GenerateRequest, onDelta?: (text: string) => void): Promise<GenerateResult> {
    const { body, model, convId, convGroupId, turnIdx } = this.buildChatBody(req);
    const timeoutMs = req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.abortSignal ? AbortSignal.any([req.abortSignal, timeout]) : timeout;
    signal.throwIfAborted();
    const deadline = this.now() + timeoutMs;
    return this.withAttempts(
      "chat",
      {
        ...(req.preferredTokenId === undefined ? {} : { preferredTokenId: req.preferredTokenId }),
        ...(req.requirePreferredToken ? { requirePreferredToken: true } : {}),
        signal,
        deadline,
      },
      (token, credentials, state) =>
        this.chatAttempt(token, credentials, state, {
          req,
          body,
          model,
          convId,
          convGroupId,
          turnIdx,
          signal,
          ...(onDelta ? { onDelta } : {}),
        }),
    );
  }

  async chatAttempt(
    token: GrokTokenState,
    credentials: GrokCredentials,
    state: AttemptState,
    context: {
      req: GenerateRequest;
      body: GrokResponsesRequest;
      model: GrokResolvedModel;
      convId: string;
      convGroupId: string;
      turnIdx: number;
      signal: AbortSignal;
      onDelta?: (text: string) => void;
    },
  ): Promise<GenerateResult> {
    const { req, model } = context;
    const startedAt = this.now();
    const headers = buildGrokChatHeaders({
      bearer: credentials.accessToken,
      model: model.id,
      convId: context.convId,
      reqId: randomUUID(),
      sessionId: credentials.sessionId,
      agentId: credentials.agentId,
      userId: credentials.userId,
      convGroupId: context.convGroupId,
      turnIdx: context.turnIdx,
      zstd: true,
    });
    let stream: Awaited<ReturnType<GrokChatClient["stream"]>>;
    try {
      stream = await this.client.stream({
        body: context.body,
        headers,
        signal: context.signal,
        idleTimeoutMs: this.idleTimeoutMs,
      });
    } catch (error) {
      if (error instanceof GrokHttpError)
        this.observeResponseHeaders(token, credentials, error.responseHeaders);
      throw error;
    }
    this.observeResponseHeaders(token, credentials, stream.headers);
    // A successful chat proves the client version is accepted again.
    this.versionGate = undefined;
    if (this.catalog.isStale(stream.headers.modelsEtag)) {
      void this.catalog.refresh(credentials, { fetch: this.fetchImpl }).then((result) => {
        if (result.kind === "lookup_failed")
          logger.warn(`grok model catalog refresh failed: ${result.reason}`);
      });
    }

    let text = "";
    let firstDeltaAt: number | undefined;
    let usage: GrokUsage | undefined;
    let servingModel = model.id;
    let outputMessageAccepted = false;
    const toolCalls: ProviderToolCall[] = [];
    let completed = false;

    for await (const event of stream.events) {
      state.upstreamStarted = true;
      if (event.type === "created") {
        if (event.model) servingModel = event.model;
      } else if (event.type === "text-delta") {
        if (outputMessageAccepted) continue;
        firstDeltaAt ??= this.now();
        text += event.text;
        if (context.onDelta) {
          state.forwarded = true;
          context.onDelta(event.text);
        }
      } else if (event.type === "output-item" && event.completed) {
        const item = event.item;
        if (item.type === "function_call") {
          const callId = item.call_id;
          const name = item.name;
          const args = item.arguments;
          if (typeof callId === "string" && typeof name === "string" && typeof args === "string") {
            toolCalls.push({ toolCallId: callId, toolName: name, input: args });
          }
        } else if (
          item.type === "message" &&
          req.stopAfterOutputMessage &&
          !outputMessageAccepted &&
          Array.isArray(item.content)
        ) {
          const messageText = item.content
            .map((part: unknown) =>
              part !== null &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "output_text" &&
              "text" in part &&
              typeof part.text === "string"
                ? part.text
                : "",
            )
            .join("");
          if (messageText) outputMessageAccepted = req.stopAfterOutputMessage(messageText);
        }
      } else if (event.type === "completed") {
        completed = true;
        if (event.model) servingModel = event.model;
        usage = event.usage;
      } else if (event.type === "incomplete") {
        throw new GrokIncompleteResponseError(event.reason);
      } else if (event.type === "error") {
        throw event.error;
      }
    }
    if (!completed)
      throw new GrokIncompleteResponseError("stream ended without response.completed");

    const ticks = usage?.costInUsdTicks;
    const contextTokens =
      usage?.contextInputTokens === undefined && usage?.contextOutputTokens === undefined
        ? undefined
        : (usage.contextInputTokens ?? 0) + (usage.contextOutputTokens ?? 0);
    const contextWindow = stream.headers.contextWindow ?? model.contextWindow;
    return {
      text,
      tokenName: token.name,
      usage: {
        totalTokens: usage?.totalTokens ?? 0,
        inputTokens: usage?.inputTokens ?? 0,
        cachedInputTokens: usage?.cachedInputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningOutputTokens: usage?.reasoningTokens ?? 0,
        ...(contextTokens === undefined ? {} : { contextTokens }),
      },
      durationMs: this.now() - startedAt,
      ttftMs: firstDeltaAt === undefined ? null : firstDeltaAt - startedAt,
      model: servingModel,
      ...(servingModel === model.id ? {} : { requestedModel: model.id }),
      threadCoord: { workerId: token.id, threadId: req.promptCacheKey ?? "", epoch: -1 },
      ...(ticks === undefined ? {} : { costUsd: grokTicksToUsd(ticks), costSource: "provider" }),
      providerMetadata: {
        xai: {
          ...(ticks === undefined ? {} : { costInUsdTicks: ticks }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
        },
      },
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  // ---- Media and voice (§5.7) --------------------------------------------

  async runPort<T>(
    requestClass: GrokRequestClass,
    selection: MediaTokenSelection & { ungated?: boolean },
    signal: AbortSignal | undefined,
    call: (credentials: GrokCredentials) => Promise<T>,
  ): Promise<MediaDispatchResult<T>> {
    const active = signal ?? new AbortController().signal;
    return this.withAttempts(
      requestClass,
      {
        ...(selection.preferredTokenId === undefined
          ? {}
          : { preferredTokenId: selection.preferredTokenId }),
        ...(selection.requirePreferredToken ? { requirePreferredToken: true } : {}),
        ...(selection.ungated ? { ungated: true } : {}),
        signal: active,
      },
      async (token, credentials) => ({
        result: await call(credentials),
        tokenId: token.id,
        tokenName: token.name,
      }),
    );
  }

  requireMedia(): GrokMediaPort {
    if (!this.media) throw new GrokCapabilityUnavailableError("media");
    return this.media;
  }

  requireVoice(): GrokVoicePort {
    if (!this.voice) throw new GrokCapabilityUnavailableError("voice");
    return this.voice;
  }

  async generateImages(
    request: GrokImageGenerateRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokImageResponse>> {
    const media = this.requireMedia();
    const { preferredTokenId, requirePreferredToken, ...portRequest } = request;
    return this.runPort(
      "image",
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => media.generateImages(mediaAuth(credentials), portRequest),
    );
  }

  async editImages(
    request: GrokImageEditRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokImageResponse>> {
    const media = this.requireMedia();
    const { preferredTokenId, requirePreferredToken, ...portRequest } = request;
    return this.runPort(
      "image",
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => media.editImages(mediaAuth(credentials), portRequest),
    );
  }

  async startVideo(
    request: GrokVideoStartRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokVideoStart>> {
    const media = this.requireMedia();
    const { preferredTokenId, requirePreferredToken, ...portRequest } = request;
    return this.runPort(
      "video",
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => media.startVideo(mediaAuth(credentials), portRequest),
    );
  }

  /**
   * Polls on the token that started the job; no selection, no failover. The job is already
   * admitted (and billed), so quota, cooldown and capacity gates must not strand its result.
   */
  async getVideo(
    tokenId: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<MediaDispatchResult<GrokVideoStatus>> {
    const media = this.requireMedia();
    return this.runPort(
      "video",
      { preferredTokenId: tokenId, requirePreferredToken: true, ungated: true },
      signal,
      (credentials) => media.getVideo(mediaAuth(credentials), requestId, signal),
    );
  }

  async transcribe(
    request: GrokTranscribeRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokSttResponse>> {
    const voice = this.requireVoice();
    const { preferredTokenId, requirePreferredToken, ...portRequest } = request;
    return this.runPort(
      "stt",
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => voice.transcribe(credentials.accessToken, portRequest),
    );
  }

  async speak(
    request: GrokTtsRequest & { signal?: AbortSignal } & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokSpeechResult>> {
    const voice = this.requireVoice();
    const { preferredTokenId, requirePreferredToken, ...portRequest } = request;
    return this.runPort(
      "tts",
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => voice.speak(credentials.accessToken, portRequest),
    );
  }

  // ---- Observability (§5.8) -----------------------------------------------

  tokenStates(): GrokTokenStateSnapshot[] {
    const now = this.now();
    return [...this.tokens.values()]
      .map((token): GrokTokenStateSnapshot => {
        const billing = token.billing?.value;
        const settings = token.settings?.value;
        return {
          id: token.id,
          name: token.name,
          weight: token.weight,
          active: token.credentials !== undefined && token.invalidReason === undefined,
          invalidReason: token.invalidReason ?? null,
          inFlight: token.inFlight,
          cooldownUntil: mapRecord(token.cooldowns, now),
          quotaBlockedUntil: mapRecord(token.quotaBlocks, now),
          entitlementBlocks: mapRecord(token.entitlementBlocks, now),
          lastBilling:
            billing?.kind === "ok"
              ? {
                  utilizationPct: billing.utilizationPct,
                  periodType: billing.periodType,
                  periodEnd: billing.periodEnd,
                  fetchedAt: token.billing!.fetchedAt,
                }
              : null,
          quotaThreshold: token.quotaThreshold,
          overThreshold: token.overThreshold,
          onDemandExcluded: settings?.kind === "ok" && settings.onDemandEnabled === true,
          zdrVideoExcluded: token.zdr === true,
          lastTier: token.lastTier ?? null,
          reauthRequired: token.reauthRequired,
          failoverCount: token.failoverCount,
        };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** Chat-proxy version gate state for the usage endpoint. */
  versionGateState(): {
    tripped: boolean;
    minClientVersion: string | null;
    trippedAt: number | null;
  } {
    return {
      tripped: this.versionGate !== undefined,
      minClientVersion: this.versionGate?.minClientVersion ?? null,
      trippedAt: this.versionGate?.trippedAt ?? null,
    };
  }

  /** Same shape as OpenAIDispatcher.getQuotaSnapshot; reads caches only. */
  getQuotaSnapshot(): Array<{
    name: string;
    usedPercent: number | null;
    threshold: number | null;
    blocked: boolean;
    resetsAt: number | null;
    zdrVideoExcluded: boolean;
  }> {
    const now = this.now();
    return [...this.tokens.values()]
      .map((token) => {
        const billing = token.billing?.value;
        const fresh =
          billing?.kind === "ok" &&
          token.billing!.generation === token.generation &&
          now - token.billing!.fetchedAt < GROK_LOOKUP_CACHE_TTL_MS;
        return {
          name: token.name,
          usedPercent: fresh ? billing.utilizationPct : null,
          threshold: token.quotaThreshold,
          blocked:
            token.overThreshold || [...token.quotaBlocks.values()].some((until) => until > now),
          resetsAt: fresh ? billing.periodEndMs : null,
          zdrVideoExcluded: token.zdr === true,
        };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
