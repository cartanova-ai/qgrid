import { promisify } from "node:util";
import { zstdCompress } from "node:zlib";

import { z } from "zod";

import { type JsonValue } from "../common/provider-types";
import { type GrokReasoningEffort } from "./grok-constants";

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export type GrokInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type GrokInputItem =
  | { type: "message"; role: "user" | "assistant"; content: string | GrokInputContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | {
      type: "reasoning";
      id?: string;
      summary?: Array<{ type: "summary_text"; text: string }>;
      encrypted_content?: string;
    };

export type GrokFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: JsonValue;
  strict: boolean;
};

export type GrokTool = GrokFunctionTool | { type: "web_search" } | { type: "x_search" };

export type GrokToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

export interface GrokResponsesOptions {
  model: string;
  /** Sent as the first `input` item; grok-build never uses `instructions`. */
  systemPrompt?: string;
  /** Full conversation history; qgrid replays it every turn (`store: false`). */
  history: readonly GrokInputItem[];
  /** grok-build sends the conversation id here. */
  promptCacheKey: string;
  effort: GrokReasoningEffort;
  outputSchema?: { name?: string; schema: JsonValue };
  tools?: readonly GrokTool[];
  toolChoice?: GrokToolChoice;
  maxOutputTokens?: number;
}

export type GrokInputWireItem =
  | { type: "message"; role: "system"; content: string }
  | Exclude<GrokInputItem, { type: "reasoning" }>
  | {
      type: "reasoning";
      id?: string;
      summary: Array<{ type: "summary_text"; text: string }>;
      encrypted_content: string;
    };

export interface GrokResponsesRequest {
  include: ["reasoning.encrypted_content", "no_inline_citations"];
  input: GrokInputWireItem[];
  model: string;
  prompt_cache_key: string;
  reasoning: { effort: GrokReasoningEffort; summary: "concise" };
  store: false;
  stream: true;
  text?: {
    format: { type: "json_schema"; name: string; strict: true; schema: JsonValue };
  };
  tools?: GrokTool[];
  tool_choice?: GrokToolChoice;
  max_output_tokens?: number;
}

export const GROK_DEFAULT_OUTPUT_SCHEMA_NAME = "qgrid_output";

function replayItem(item: GrokInputItem): GrokInputWireItem | undefined {
  if (item.type !== "reasoning") return item;

  // With store:false the proxy cannot resolve a reasoning item by id; without the encrypted
  // payload (for example reasoning from another account) the item is dropped, not replayed.
  if (!item.encrypted_content) return undefined;

  return {
    type: "reasoning",
    ...(item.id ? { id: item.id } : {}),
    summary: item.summary ?? [],
    encrypted_content: item.encrypted_content,
  };
}

/** Builds the `/responses` body in the key order of the 1.0.60 golden capture. */
export function buildGrokResponsesRequest(options: GrokResponsesOptions): GrokResponsesRequest {
  if (!options.model) throw new TypeError("Grok model is required");

  if (!options.promptCacheKey) throw new TypeError("Grok prompt_cache_key is required");

  if (
    options.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0)
  )
    throw new TypeError("maxOutputTokens must be a positive integer");

  const input: GrokInputWireItem[] = [];

  if (options.systemPrompt)
    input.push({ type: "message", role: "system", content: options.systemPrompt });

  for (const item of options.history) {
    const wire = replayItem(item);

    if (wire) input.push(wire);
  }

  const request: GrokResponsesRequest = {
    include: ["reasoning.encrypted_content", "no_inline_citations"],
    input,
    model: options.model,
    prompt_cache_key: options.promptCacheKey,
    reasoning: { effort: options.effort, summary: "concise" },
    store: false,
    stream: true,
  };

  if (options.outputSchema) {
    request.text = {
      format: {
        type: "json_schema",
        name: options.outputSchema.name ?? GROK_DEFAULT_OUTPUT_SCHEMA_NAME,
        strict: true,
        schema: options.outputSchema.schema,
      },
    };
  }

  if (options.tools?.length) request.tools = [...options.tools];

  if (options.toolChoice !== undefined) request.tool_choice = options.toolChoice;

  if (options.maxOutputTokens !== undefined) request.max_output_tokens = options.maxOutputTokens;

  return request;
}

export interface GrokEncodedBody {
  bytes: Uint8Array;
  contentEncoding: "zstd" | undefined;
}

const zstdCompressAsync = promisify(zstdCompress);

/** zstd-compressed JSON body, as the 1.0.60 binary sends it (`content-encoding: zstd`). */
export async function encodeGrokRequestBody(
  body: GrokResponsesRequest,
): Promise<GrokEncodedBody & { contentEncoding: "zstd" }> {
  const compressed = await zstdCompressAsync(Buffer.from(JSON.stringify(body), "utf8"));

  return {
    bytes: new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength),
    contentEncoding: "zstd",
  };
}

/** Plain JSON body; the proxy accepts it too (U0 item 1). */
export function encodeGrokRequestBodyPlain(
  body: GrokResponsesRequest,
): GrokEncodedBody & { contentEncoding: undefined } {
  return { bytes: new TextEncoder().encode(JSON.stringify(body)), contentEncoding: undefined };
}

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------

export class GrokProtocolError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "GrokProtocolError";
    this.code = code;
  }
}

export interface GrokUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  numSourcesUsed?: number;
  numServerSideToolsUsed?: number;
  /** 1 tick = GROK_USD_PER_TICK USD. */
  costInUsdTicks?: number;
  /** Live context size (`context_details`), distinct from cumulative input tokens. */
  contextInputTokens?: number;
  contextOutputTokens?: number;
}

export type GrokOutputItem = { type: string } & Record<string, unknown>;

export type GrokNormalizedEvent =
  | { type: "created"; responseId?: string; model?: string }
  | { type: "text-delta"; text: string; itemId?: string }
  | { type: "reasoning-summary-delta"; text: string; itemId?: string }
  | { type: "output-item"; item: GrokOutputItem; completed: boolean }
  | {
      type: "completed";
      terminal: true;
      responseId: string;
      model?: string;
      usage?: GrokUsage;
      output?: GrokOutputItem[];
    }
  | {
      type: "incomplete";
      terminal: true;
      responseId: string;
      reason?: string;
      model?: string;
      usage?: GrokUsage;
    }
  | { type: "error"; terminal: true; error: GrokProtocolError };

const count = z.number().int().nonnegative();

const WireUsage = z.object({
  input_tokens: count.optional(),
  input_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
  output_tokens: count.optional(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).nullish(),
  total_tokens: count.optional(),
  num_sources_used: count.optional(),
  num_server_side_tools_used: count.optional(),
  cost_in_usd_ticks: count.optional(),
  context_details: z
    .object({ input_tokens: count.optional(), output_tokens: count.optional() })
    .nullish(),
});

const WireItem = z.looseObject({ type: z.string() });

const WireResponse = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
  usage: WireUsage.nullish(),
  output: z.array(WireItem).optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).nullish(),
});

const WireEvent = z.looseObject({
  type: z.string(),
  response: WireResponse.optional(),
  item: WireItem.optional(),
  item_id: z.string().optional(),
  delta: z.string().optional(),
  message: z.string().optional(),
  code: z.string().nullish(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).nullish(),
});

export function grokUsageFrom(value: unknown): GrokUsage | undefined {
  const parsed = WireUsage.safeParse(value);

  if (!parsed.success) return undefined;
  const usage = parsed.data;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;

  return {
    inputTokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    ...(usage.num_sources_used === undefined ? {} : { numSourcesUsed: usage.num_sources_used }),
    ...(usage.num_server_side_tools_used === undefined
      ? {}
      : { numServerSideToolsUsed: usage.num_server_side_tools_used }),
    ...(usage.cost_in_usd_ticks === undefined ? {} : { costInUsdTicks: usage.cost_in_usd_ticks }),
    ...(usage.context_details?.input_tokens === undefined
      ? {}
      : { contextInputTokens: usage.context_details.input_tokens }),
    ...(usage.context_details?.output_tokens === undefined
      ? {}
      : { contextOutputTokens: usage.context_details.output_tokens }),
  };
}

export interface GrokRawSSEEvent {
  event?: string;
  data: string;
}

/**
 * Normalizes one SSE block. Returns `undefined` for well-formed events that carry nothing a
 * caller consumes (`response.in_progress`, part/done bookkeeping). Terminal events are
 * `response.completed | response.incomplete | response.failed | error`; the proxy does not
 * send `[DONE]`, and a `[DONE]` sentinel is ignored if one ever appears.
 */
export function normalizeGrokEvent(raw: GrokRawSSEEvent): GrokNormalizedEvent | undefined {
  if (raw.data.trim() === "[DONE]") return undefined;
  let json: unknown;

  try {
    json = JSON.parse(raw.data);
  } catch (error) {
    throw new GrokProtocolError(`Invalid Grok SSE JSON: ${String(error)}`);
  }

  const withType =
    json && typeof json === "object" && !("type" in json) && raw.event
      ? { ...json, type: raw.event }
      : json;

  const parsed = WireEvent.safeParse(withType);

  if (!parsed.success)
    throw new GrokProtocolError(`Unexpected Grok SSE event shape: ${parsed.error.message}`);
  const event = parsed.data;
  const response = event.response;

  switch (event.type) {
    case "response.created":
      return {
        type: "created",
        ...(response?.id ? { responseId: response.id } : {}),
        ...(response?.model ? { model: response.model } : {}),
      };
    case "response.output_text.delta":
      if (event.delta === undefined) return undefined;

      return {
        type: "text-delta",
        text: event.delta,
        ...(event.item_id ? { itemId: event.item_id } : {}),
      };
    case "response.reasoning_summary_text.delta":
      if (event.delta === undefined) return undefined;

      return {
        type: "reasoning-summary-delta",
        text: event.delta,
        ...(event.item_id ? { itemId: event.item_id } : {}),
      };
    case "response.output_item.added":
    case "response.output_item.done":
      if (!event.item) return undefined;

      return {
        type: "output-item",
        item: event.item,
        completed: event.type === "response.output_item.done",
      };
    case "response.completed": {
      const usage = response?.usage ? grokUsageFrom(response.usage) : undefined;

      return {
        type: "completed",
        terminal: true,
        responseId: response?.id ?? "",
        ...(response?.model ? { model: response.model } : {}),
        ...(usage ? { usage } : {}),
        ...(response?.output ? { output: response.output } : {}),
      };
    }

    case "response.incomplete": {
      const usage = response?.usage ? grokUsageFrom(response.usage) : undefined;
      const reason = response?.incomplete_details?.reason;

      return {
        type: "incomplete",
        terminal: true,
        responseId: response?.id ?? "",
        ...(reason ? { reason } : {}),
        ...(response?.model ? { model: response.model } : {}),
        ...(usage ? { usage } : {}),
      };
    }

    case "response.failed":
    case "error": {
      const nested = event.error ?? response?.error ?? undefined;
      const message = nested?.message ?? event.message ?? `Grok stream ended with ${event.type}`;
      const code = nested?.code ?? event.code ?? undefined;

      return { type: "error", terminal: true, error: new GrokProtocolError(message, code) };
    }

    default:
      return undefined;
  }
}

function parseSSEBlock(block: string): GrokRawSSEEvent | undefined {
  const data: string[] = [];
  let event: string | undefined;

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);

    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }

  if (!data.length) return undefined;

  return { ...(event === undefined ? {} : { event }), data: data.join("\n") };
}

/** Splits a byte stream into SSE blocks across arbitrary UTF-8/chunk boundaries. */
export async function* parseGrokSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GrokRawSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // A trailing CR may be the first half of a CRLF split across chunks; hold it back.
  let pending = "";
  let first = true;

  try {
    while (true) {
      const { done, value } = await reader.read();
      let chunk = pending + decoder.decode(value, { stream: !done });
      pending = "";

      if (first && chunk.length) {
        if (chunk.startsWith("\uFEFF")) chunk = chunk.slice(1);
        first = false;
      }

      if (!done && chunk.endsWith("\r")) {
        pending = "\r";
        chunk = chunk.slice(0, -1);
      }

      buffer += chunk.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      let index: number;

      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = parseSSEBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);

        if (block) yield block;
      }

      if (done) break;
    }

    if (buffer.trim()) {
      const block = parseSSEBlock(buffer);

      if (block) yield block;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Normalized stream that ends at the first terminal event and rejects a truncated stream. */
export async function* normalizeGrokSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<GrokNormalizedEvent> {
  for await (const raw of parseGrokSSE(body)) {
    const event = normalizeGrokEvent(raw);

    if (!event) continue;
    yield event;

    if ("terminal" in event) return;
  }

  throw new GrokProtocolError("Grok SSE connection closed before a terminal event");
}

// ---------------------------------------------------------------------------
// Response headers and HTTP errors
// ---------------------------------------------------------------------------

type HeaderSource = Headers | Readonly<Record<string, string | undefined>>;

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);

  return key === undefined ? undefined : headers[key];
}

function integerHeader(headers: HeaderSource, name: string): number | undefined {
  const value = headerValue(headers, name)?.trim();

  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** `Retry-After` as whole seconds (delta-seconds or HTTP-date). Uncapped; callers clamp. */
export function parseRetryAfterSec(
  headers: HeaderSource,
  now: number = Date.now(),
): number | undefined {
  const value = headerValue(headers, "retry-after")?.trim();

  if (!value) return undefined;

  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);

  if (Number.isNaN(date)) return undefined;

  return Math.max(0, Math.ceil((date - now) / 1000));
}

export function parseShouldRetry(headers: HeaderSource): boolean | undefined {
  const value = headerValue(headers, "x-should-retry")?.trim().toLowerCase();

  if (value === "true") return true;

  if (value === "false") return false;

  return undefined;
}

export interface GrokResponseHeaderInfo {
  contextWindow?: number;
  maxCompletionTokens?: number;
  modelsEtag?: string;
  requestId?: string;
  rateLimitLimitTokens?: number;
  rateLimitRemainingTokens?: number;
  rateLimitLimitRequests?: number;
  rateLimitRemainingRequests?: number;
  /** `x-zero-data-retention: true`: the account has Zero Data Retention on (U0, plan §11). */
  zeroDataRetention?: boolean;
}

/** Response headers grok-build reads (client.rs:187-224) plus the observed rate-limit set. */
export function readGrokResponseHeaders(headers: HeaderSource): GrokResponseHeaderInfo {
  const zdr = headerValue(headers, "x-zero-data-retention")?.trim().toLowerCase();

  const entries: Array<[keyof GrokResponseHeaderInfo, number | string | boolean | undefined]> = [
    ["contextWindow", integerHeader(headers, "x-grok-context-window")],
    ["maxCompletionTokens", integerHeader(headers, "x-grok-max-completion-tokens")],
    ["modelsEtag", headerValue(headers, "x-models-etag")],
    ["requestId", headerValue(headers, "x-request-id")],
    ["rateLimitLimitTokens", integerHeader(headers, "x-ratelimit-limit-tokens")],
    ["rateLimitRemainingTokens", integerHeader(headers, "x-ratelimit-remaining-tokens")],
    ["rateLimitLimitRequests", integerHeader(headers, "x-ratelimit-limit-requests")],
    ["rateLimitRemainingRequests", integerHeader(headers, "x-ratelimit-remaining-requests")],
    ["zeroDataRetention", zdr === "true" ? true : zdr === "false" ? false : undefined],
  ];

  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export type GrokHttpErrorKind =
  | "auth"
  | "version_gate"
  | "rate_limited"
  | "quota_exhausted"
  | "entitlement"
  | "invalid_request"
  | "transient"
  | "permanent";

export interface GrokHttpErrorClassification {
  kind: GrokHttpErrorKind;
  status: number;
  retryAfterSec?: number;
  code?: string;
  message?: string;
  /** `x-should-retry` override from the server; callers must honor it over `kind`. */
  shouldRetry?: boolean;
  /** Minimum CLI version named by a 426 body. */
  minClientVersion?: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 500;
const SUBSCRIPTION_CODE_PATTERN = /subscription:[a-z0-9][a-z0-9_.-]*/i;

const ErrorBody = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .union([
      z.string(),
      z.looseObject({
        code: z.string().optional(),
        message: z.string().optional(),
        type: z.string().optional(),
      }),
    ])
    .optional(),
});

function parseErrorBody(bodyText: string): { code?: string; message?: string } {
  let json: unknown;

  try {
    json = JSON.parse(bodyText);
  } catch {
    return bodyText.trim() ? { message: bodyText.trim() } : {};
  }

  const parsed = ErrorBody.safeParse(json);

  if (!parsed.success) return bodyText.trim() ? { message: bodyText.trim() } : {};
  const { error } = parsed.data;
  const code = parsed.data.code ?? (typeof error === "object" ? error.code : undefined);

  const message =
    (typeof error === "string" ? error : error?.message) ?? parsed.data.message ?? undefined;

  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

/**
 * Classifies a non-2xx proxy or api.x.ai response. Pass `status = 0` for a network failure.
 * The body is not trusted to be JSON.
 */
export function classifyGrokHttpError(
  status: number,
  bodyText: string,
  headers: HeaderSource,
): GrokHttpErrorClassification {
  const body = parseErrorBody(bodyText);

  const message =
    body.message === undefined ? undefined : body.message.slice(0, MAX_ERROR_MESSAGE_LENGTH);

  const shouldRetry = parseShouldRetry(headers);
  const retryAfterSec = parseRetryAfterSec(headers);

  const base = {
    status,
    ...(body.code ? { code: body.code } : {}),
    ...(message === undefined ? {} : { message }),
    ...(shouldRetry === undefined ? {} : { shouldRetry }),
    ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
  };

  const subscriptionCode = SUBSCRIPTION_CODE_PATTERN.exec(bodyText)?.[0];

  if (status === 401) return { kind: "auth", ...base };

  if (status === 426) {
    const minClientVersion = /\bversion\s+(\d+\.\d+\.\d+)\s+or later/i.exec(bodyText)?.[1];

    return { kind: "version_gate", ...base, ...(minClientVersion ? { minClientVersion } : {}) };
  }

  if (status === 429) {
    if (subscriptionCode) return { kind: "quota_exhausted", ...base, code: subscriptionCode };

    return { kind: "rate_limited", ...base };
  }

  if (status === 403) return { kind: "entitlement", ...base };

  if (status === 400 || status === 422) return { kind: "invalid_request", ...base };

  if (status === 0 || status === 408 || status >= 500) return { kind: "transient", ...base };

  return { kind: "permanent", ...base };
}
