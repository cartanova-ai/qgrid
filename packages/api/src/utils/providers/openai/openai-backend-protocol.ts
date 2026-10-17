import os from "node:os";

import { z } from "zod";

import { ImageGenerationMetadata } from "../../../application/qgrid/qgrid.types";
import { type OpenAIEffort } from "../common/effort";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  jsonString,
} from "../common/provider-types";

export { type JsonValue } from "../common/provider-types";

export const CHATGPT_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses" as const;

export const CODEX_CLI_ORIGINATOR = "codex_cli_rs" as const;
export const CODEX_CLI_VERSION = "0.147.0" as const;

export interface CodexUserAgentPlatform {
  osType: string;
  osVersion: string;
  architecture: string;
  terminal: string;
}

function codexPlatform(): CodexUserAgentPlatform {
  const names: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "Mac OS",
    linux: "Linux",
    win32: "Windows",
  };

  const terminal = process.env.TERM_PROGRAM;
  const terminalVersion = process.env.TERM_PROGRAM_VERSION;

  return {
    osType: names[process.platform] ?? process.platform,
    osVersion: os.release(),
    architecture: process.arch,
    terminal: terminal ? `${terminal}${terminalVersion ? `/${terminalVersion}` : ""}` : "unknown",
  };
}

/** Matches the platform/terminal suffix emitted by the pinned Rust Codex CLI. */
export function codexCliUserAgent(platform: CodexUserAgentPlatform = codexPlatform()): string {
  return `codex_cli_rs/${CODEX_CLI_VERSION} (${platform.osType} ${platform.osVersion}; ${platform.architecture}) ${platform.terminal}`;
}

/** Raw Responses API items. Keeping these opaque preserves the complete conversation history. */
export type OpenAIResponseItem = JsonObject;

export interface OpenAIOutputSchema {
  name?: string;
  schema: JsonValue;
}

export interface OpenAIResponsesOptions {
  model: string;
  instructions?: string;
  /** Raw conversation items, forwarded unchanged. */
  history: readonly JsonValue[];
  tools?: readonly OpenAIResponseItem[];
  toolChoice?: string | OpenAIResponseItem;
  parallelToolCalls?: boolean;
  reasoning?: {
    effort?: OpenAIEffort | "none";
    summary?: "auto" | "concise" | "detailed";
  };
  verbosity?: "low" | "medium" | "high";
  serviceTier?: string;
  promptCacheKey?: string;
  outputSchema?: OpenAIOutputSchema;
  imageGeneration?: boolean | OpenAIResponseItem;
}

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: JsonValue[];
  tools?: OpenAIResponseItem[];
  tool_choice: string | OpenAIResponseItem;
  parallel_tool_calls: boolean;
  reasoning: OpenAIResponsesOptions["reasoning"] | null;
  store: false;
  stream: true;
  include: string[];
  service_tier?: string;
  prompt_cache_key?: string;
  text?: OpenAIResponsesText;
}

export interface OpenAIResponsesText {
  verbosity?: "low" | "medium" | "high";
  format?: {
    type: "json_schema";
    strict: true;
    schema: JsonValue;
    name: string;
  };
}

export function buildOpenAIResponsesRequest(
  options: OpenAIResponsesOptions,
): OpenAIResponsesRequest {
  const tools = options.tools ? [...options.tools] : [];

  if (options.imageGeneration) {
    tools.push(
      options.imageGeneration === true
        ? { type: "image_generation" }
        : { type: "image_generation", ...options.imageGeneration },
    );
  }

  const request: OpenAIResponsesRequest = {
    model: options.model,
    // Copy the array, not its items: raw items must arrive byte-for-byte equivalent.
    input: [...options.history],
    tool_choice: options.toolChoice ?? "auto",
    parallel_tool_calls: options.parallelToolCalls ?? true,
    reasoning: options.reasoning ?? null,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };

  if (options.instructions) request.instructions = options.instructions;

  if (tools.length) request.tools = tools;

  if (options.serviceTier) request.service_tier = options.serviceTier;

  if (options.promptCacheKey) request.prompt_cache_key = options.promptCacheKey;

  if (options.verbosity || options.outputSchema) {
    const text: OpenAIResponsesText = {};

    if (options.verbosity) text.verbosity = options.verbosity;

    if (options.outputSchema) {
      text.format = {
        type: "json_schema",
        strict: true,
        schema: options.outputSchema.schema,
        name: options.outputSchema.name ?? "codex_output_schema",
      };
    }

    request.text = text;
  }

  return request;
}

/** Codex CLI identity headers; correlation headers are present only when supplied. */
export type CodexIdentityHeaders = {
  Accept: "text/event-stream";
  Authorization: string;
  "ChatGPT-Account-ID": string;
  "Content-Type": "application/json";
  originator: typeof CODEX_CLI_ORIGINATOR;
  "User-Agent": string;
  "session-id"?: string;
  "thread-id"?: string;
  "x-client-request-id"?: string;
};

export function buildCodexIdentityHeaders(
  accessToken: string,
  accountId: string,
  correlation?: { sessionId?: string; threadId?: string; clientRequestId?: string },
): CodexIdentityHeaders {
  const headers: CodexIdentityHeaders = {
    Accept: "text/event-stream",
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-ID": accountId,
    "Content-Type": "application/json",
    originator: CODEX_CLI_ORIGINATOR,
    "User-Agent": codexCliUserAgent(),
  };

  if (correlation?.sessionId) headers["session-id"] = correlation.sessionId;

  if (correlation?.threadId) headers["thread-id"] = correlation.threadId;

  if (correlation?.clientRequestId) headers["x-client-request-id"] = correlation.clientRequestId;

  return headers;
}

export interface OpenAIUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type OpenAINormalizedEvent =
  | { type: "created"; responseId?: string }
  | { type: "text-delta"; text: string; itemId?: string }
  | {
      type: "image";
      id?: string;
      base64: string;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      revisedPrompt?: string;
      generation?: ImageGenerationMetadata;
    }
  | { type: "output-item"; item: OpenAIResponseItem; completed?: boolean }
  | {
      type: "completed";
      responseId: string;
      usage?: OpenAIUsage;
      model?: string;
      imageGeneration?: ImageGenerationMetadata;
    }
  | { type: "error"; error: OpenAIProtocolError };

export class OpenAIProtocolError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OpenAIProtocolError";
  }
}

const tokenCount = z.coerce.number().catch(0);

function jsonObjectOrEmpty(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function usageFrom(value: JsonObject): OpenAIUsage {
  const inputDetails = jsonObjectOrEmpty(value.input_tokens_details);
  const outputDetails = jsonObjectOrEmpty(value.output_tokens_details);

  return {
    inputTokens: tokenCount.parse(value.input_tokens ?? 0),
    cachedInputTokens: tokenCount.parse(inputDetails.cached_tokens ?? 0),
    outputTokens: tokenCount.parse(value.output_tokens ?? 0),
    reasoningTokens: tokenCount.parse(outputDetails.reasoning_tokens ?? 0),
    totalTokens: tokenCount.parse(value.total_tokens ?? 0),
  };
}

export function imageMimeType(
  base64: string,
  outputFormat?: JsonValue,
): "image/png" | "image/jpeg" | "image/webp" {
  // Inspect only the header, without decoding a potentially large image twice.
  const header = Buffer.from(base64.slice(0, 24), "base64");

  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";

  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";

  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";

  if (outputFormat === "jpeg") return "image/jpeg";

  if (outputFormat === "webp") return "image/webp";

  if (outputFormat === undefined || outputFormat === "png") return "image/png";
  const label = jsonString(outputFormat) ?? JSON.stringify(outputFormat);
  throw new OpenAIProtocolError(`Unsupported image output format: ${label}`);
}

type OpenAIImageEvent = Extract<OpenAINormalizedEvent, { type: "image" }>;

function imageEvent(item: JsonObject, result: string): OpenAIImageEvent {
  // PNG exposes dimensions in its fixed header. Other formats retain the
  // backend's observed size; never substitute requested image controls.
  const header = Buffer.from(result.slice(0, 32), "base64");

  const pngSize =
    header.length >= 24 &&
    header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    header.readUInt32BE(16) > 0 &&
    header.readUInt32BE(20) > 0
      ? `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`
      : undefined;

  const reportedSize = jsonString(item.size);

  const size =
    pngSize ??
    (reportedSize !== undefined && /^[1-9]\d*x[1-9]\d*$/.test(reportedSize)
      ? reportedSize
      : undefined);

  const id = jsonString(item.id);
  const model = jsonString(item.model);
  const quality = jsonString(item.quality);
  const background = jsonString(item.background);
  const revisedPrompt = jsonString(item.revised_prompt) ?? jsonString(item.revisedPrompt);
  const generation: ImageGenerationMetadata = { route: "codex-responses" };

  if (size) generation.size = size;

  if (model !== undefined) generation.model = model;

  if (quality !== undefined) generation.quality = quality;

  if (background !== undefined) generation.background = background;

  const event: OpenAIImageEvent = { type: "image", base64: result, mimeType: "image/png" };

  if (id !== undefined) event.id = id;
  event.base64 = result;
  event.mimeType = imageMimeType(result, item.output_format);
  event.generation = generation;

  if (revisedPrompt !== undefined) event.revisedPrompt = revisedPrompt;

  return event;
}

type OpenAICompletedEvent = Extract<OpenAINormalizedEvent, { type: "completed" }>;

function completedEvent(response: JsonObject): OpenAICompletedEvent {
  const toolUsage = jsonObjectOrEmpty(response.tool_usage);
  const parsedImageUsage = ImageGenerationMetadata.shape.usage.safeParse(toolUsage.image_gen);
  const imageUsage = parsedImageUsage.success ? parsedImageUsage.data : undefined;

  const imageTool = Array.isArray(response.tools)
    ? response.tools.find((tool) => isJsonObject(tool) && tool.type === "image_generation")
    : undefined;

  const imageModel = isJsonObject(imageTool) ? jsonString(imageTool.model) : undefined;
  const model = jsonString(response.model);

  const event: OpenAICompletedEvent = {
    type: "completed",
    responseId: jsonString(response.id) ?? "",
  };

  if (isJsonObject(response.usage)) event.usage = usageFrom(response.usage);

  if (model !== undefined) event.model = model;

  if (imageUsage || imageModel) {
    const imageGeneration: ImageGenerationMetadata = { route: "codex-responses" };

    if (imageModel) imageGeneration.model = imageModel;

    if (imageUsage) imageGeneration.usage = imageUsage;
    event.imageGeneration = imageGeneration;
  }

  return event;
}

export function normalizeOpenAIEvent(raw: JsonValue): OpenAINormalizedEvent | undefined {
  if (!isJsonObject(raw)) return undefined;
  const event = raw;
  const type = jsonString(event.type) ?? "";

  if (type === "response.created") {
    const responseId = isJsonObject(event.response) ? jsonString(event.response.id) : undefined;

    return responseId ? { type: "created", responseId } : { type: "created" };
  }

  const delta = jsonString(event.delta);

  if (type === "response.output_text.delta" && delta !== undefined) {
    const itemId = jsonString(event.item_id);

    return itemId === undefined
      ? { type: "text-delta", text: delta }
      : { type: "text-delta", text: delta, itemId };
  }

  if (
    (type === "response.output_item.added" || type === "response.output_item.done") &&
    isJsonObject(event.item)
  ) {
    const item = event.item;
    const result = jsonString(item.result);

    if (item.type === "image_generation_call" && result !== undefined) {
      return imageEvent(item, result);
    }

    return { type: "output-item", item, completed: type === "response.output_item.done" };
  }

  if (type === "response.completed") return completedEvent(jsonObjectOrEmpty(event.response));

  if (type === "error" || type === "response.failed" || type === "response.incomplete") {
    const source = jsonObjectOrEmpty(event.error ?? event.response ?? event);
    const nested = jsonObjectOrEmpty(source.error ?? source);

    return {
      type: "error",
      error: new OpenAIProtocolError(
        jsonString(nested.message) ?? `OpenAI stream ended with ${type}`,
        jsonString(nested.code),
      ),
    };
  }

  return undefined;
}
