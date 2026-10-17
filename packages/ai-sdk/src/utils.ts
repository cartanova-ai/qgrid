import {
  type JSONSchema7,
  type JSONValue,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3Message,
} from "@ai-sdk/provider";
import { type ModelMessage, type SystemModelMessage } from "ai";
import { z } from "zod";

import { type AppendStepInput, type CreateRunInput, type FinishRunInput } from "./index.types";

const createRunOutputSchema = z.object({ requestLogId: z.number() });
const appendStepOutputSchema = z.object({ stepId: z.number() });
const finishRunOutputSchema = z.object({ ok: z.boolean() });

// API helpers
export async function createRun(
  serverUrl: string,
  body: CreateRunInput,
): Promise<{ requestLogId: number }> {
  const res = await fetch(`${serverUrl}/api/qgrid/createRun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });

  return createRunOutputSchema.parse(await res.json());
}

export async function appendStep(
  serverUrl: string,
  body: AppendStepInput,
): Promise<{ stepId: number }> {
  const res = await fetch(`${serverUrl}/api/qgrid/appendStep`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });

  return appendStepOutputSchema.parse(await res.json());
}

export async function finishRun(serverUrl: string, body: FinishRunInput): Promise<{ ok: boolean }> {
  const res = await fetch(`${serverUrl}/api/qgrid/finishRun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });

  return finishRunOutputSchema.parse(await res.json());
}

/**
 * Decodes an AI SDK payload (tool input, tool output, tool error) into request-log text. JSON
 * cannot encode every JavaScript value (cycles, BigInt, bare undefined); those fall back to String().
 */
export const loggedPayloadText = z.unknown().transform((payload): string => {
  try {
    const json = JSON.stringify(payload);

    return json === undefined ? String(payload) : json;
  } catch {
    return String(payload);
  }
});

/** Like loggedPayloadText, but keeps strings verbatim (tool arguments that are already JSON text). */
export const toolPayloadText = z.union([z.string(), loggedPayloadText]);

export interface QgridToolDefinition {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

// Tool helpers
export function toQgridTool(tool: LanguageModelV3FunctionTool): QgridToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

type ToolCallWithResult = {
  callId: string;
  toolName: string;
  args: string;
  result: string;
};

export function extractToolResultsFromHistory(
  messages: LanguageModelV3Message[],
): ToolCallWithResult[] {
  const calls = new Map<string, { toolName: string; args: string }>();
  const results = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-call") {
          calls.set(part.toolCallId, {
            toolName: part.toolName,
            args: toolPayloadText.parse(part.input),
          });
        }
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-result") {
          const id = "toolCallId" in part ? part.toolCallId : "";
          const output = part.output;

          const text =
            "value" in output ? toolPayloadText.parse(output.value) : JSON.stringify(output);

          results.set(id, text);
        }
      }
    }
  }

  const out: ToolCallWithResult[] = [];

  for (const [callId, call] of calls) {
    if (results.has(callId)) {
      out.push({ callId, toolName: call.toolName, args: call.args, result: results.get(callId)! });
    }
  }

  return out;
}

// SSE parser
export type SSEEvent = { type: string; data: JSONValue };

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";

  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };

  signal?.addEventListener("abort", cancel, { once: true });

  try {
    signal?.throwIfAborted();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const raw = line.slice(6);

          try {
            yield { type: eventType || "message", data: JSON.parse(raw) };
          } catch {}

          eventType = "";
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);

    try {
      await reader.cancel();
    } catch {
      // An aborted or failed fetch body may already be errored.
    } finally {
      reader.releaseLock();
    }
  }
}

type PromptTextPart = { type: "input_text"; text: string };

/** Responses-style history item replayed to the qgrid server. */
export type PromptHistoryItem =
  | {
      type: "message";
      role: "user";
      content: Array<PromptTextPart | { type: "input_image"; image_url: string }>;
    }
  | { type: "message"; role: "assistant"; content: Array<{ type: "output_text"; text: string }> }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ExtractPromptAndHistoryResult = {
  prompt: string;
  system: string | undefined;
  history: PromptHistoryItem[];
  droppedImageCount: number;
};

type UserContent = Extract<LanguageModelV3Message, { role: "user" }>["content"];

type PromptContentPart = Extract<
  LanguageModelV3Message,
  { role: "user" | "assistant" }
>["content"][number];

// Prompt helpers
export function extractPromptAndHistory(
  messages: LanguageModelV3Message[],
): ExtractPromptAndHistoryResult {
  let droppedImageCount = 0;
  let system: string | undefined;
  const nonSystem: LanguageModelV3Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = msg.content;
    } else {
      nonSystem.push(msg);
    }
  }

  if (nonSystem.length === 0) {
    return { prompt: "", system, history: [], droppedImageCount };
  }

  const first = nonSystem[0];

  if (nonSystem.length === 1 && first.role === "user") {
    const extracted = extractPromptTextParts(first.content);
    droppedImageCount += extracted.droppedImageCount;

    return {
      prompt: extracted.text,
      system,
      history: [],
      droppedImageCount,
    };
  }

  const last = nonSystem[nonSystem.length - 1];
  let prompt = "";

  if (last.role === "user") {
    const extracted = extractPromptTextParts(last.content);
    prompt = extracted.text;
    droppedImageCount += extracted.droppedImageCount;
  }

  const historyEnd = last.role === "user" ? nonSystem.length - 1 : nonSystem.length;

  const history: PromptHistoryItem[] = [];

  for (let i = 0; i < historyEnd; i++) {
    const msg = nonSystem[i];

    if (msg.role === "user") {
      const extracted = extractPromptTextParts(msg.content);
      droppedImageCount += extracted.droppedImageCount;
      const content = extracted.parts;
      history.push({
        type: "message",
        role: "user",
        content: content.length > 0 ? content : [{ type: "input_text", text: extracted.text }],
      });
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if ("text" in part) {
          history.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: part.text }],
          });
        } else if ("toolName" in part && part.type === "tool-call") {
          history.push({
            type: "function_call",
            name: part.toolName,
            arguments: toolPayloadText.parse(part.input),
            call_id: part.toolCallId,
          });
        } else if (isImagePart(part)) {
          droppedImageCount++;
        }
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if ("toolName" in part && part.type === "tool-result") {
          const output = part.output;

          const text =
            "value" in output ? toolPayloadText.parse(output.value) : JSON.stringify(output);

          history.push({
            type: "function_call_output",
            call_id: ("toolCallId" in part ? part.toolCallId : "") ?? "",
            output: text,
          });
        }
      }
    }
  }

  return { prompt, system, history, droppedImageCount };
}

interface PromptTextParts {
  text: string;
  parts: PromptTextPart[];
  droppedImageCount: number;
}

function extractPromptTextParts(content: UserContent): PromptTextParts {
  const parts: PromptTextPart[] = [];
  let droppedImageCount = 0;

  for (const part of content) {
    if ("text" in part) {
      parts.push({ type: "input_text", text: part.text });
    } else if (isImagePart(part)) {
      droppedImageCount++;
    }
  }

  return { text: parts.map((part) => part.text).join("\n"), parts, droppedImageCount };
}

function isImagePart(part: PromptContentPart): boolean {
  return part.type === "file" && part.mediaType.toLowerCase().startsWith("image/");
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

const MAX_IMAGE_INPUT_DATA_URL_CHARS = 9_000_000;
const MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL = "9M";

export function assertImageInputFitsJsonTransport(imageUrls: string[]): void {
  let totalDataUrlChars = 0;

  for (const url of imageUrls) {
    if (!url.toLowerCase().startsWith("data:")) continue;
    totalDataUrlChars += url.length;

    if (url.length > MAX_IMAGE_INPUT_DATA_URL_CHARS) {
      throw new Error(
        `qgrid: image input is too large for JSON transport (${url.length} chars). Compress or resize it before passing it to generateImage, for example as WebP/JPEG under ${MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL} total base64 data-url chars.`,
      );
    }
  }

  if (totalDataUrlChars > MAX_IMAGE_INPUT_DATA_URL_CHARS) {
    throw new Error(
      `qgrid: image inputs are too large for JSON transport (${totalDataUrlChars} total chars). Compress or resize them before passing them to generateImage, for example as WebP/JPEG under ${MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL} total base64 data-url chars.`,
    );
  }
}

// --- shared helpers (used by both index.ts and logger.ts) ---

function extractTextContent(content: ModelMessage["content"]): string {
  if (!Array.isArray(content)) return content;
  const parts: string[] = [];

  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
  }

  return parts.join("\n");
}

const primitiveErrorSchema = z.union([z.string(), z.number(), z.nan(), z.boolean(), z.bigint()]);

/** Formats an error cause (thrown value, abort reason, AI SDK error field) for a request log. */
export function getErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return String(cause);

  if (cause === undefined || cause === null) return "unknown error";
  const primitive = primitiveErrorSchema.safeParse(cause);

  if (primitive.success) return String(primitive.data);

  try {
    return JSON.stringify(cause) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export function extractUserPrompt(
  prompt: string | ModelMessage[] | undefined,
  messages: ModelMessage[] | undefined,
): string {
  if (prompt !== undefined && !Array.isArray(prompt)) return prompt;
  const messageList = messages ?? prompt ?? [];

  for (let i = messageList.length - 1; i >= 0; i--) {
    const msg = messageList[i];

    if (msg?.role === "user") {
      return extractTextContent(msg.content);
    }
  }

  return "";
}

export function extractSystemPrompt(
  system: string | SystemModelMessage | SystemModelMessage[] | undefined,
): string | undefined {
  if (system === undefined || Array.isArray(system)) return undefined;

  // A string primitive is not an Object instance; a SystemModelMessage is.
  return system instanceof Object ? system.content : system;
}

type StoredHistoryMessage = {
  type: "message";
  role: "user" | "assistant";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
};

export function serializeHistory(messages: ModelMessage[] | undefined): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  const sliced = messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;
  const history: StoredHistoryMessage[] = [];

  for (const msg of sliced) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractTextContent(msg.content);

    if (text.length === 0) continue;
    history.push({
      type: "message",
      role: msg.role,
      content: [{ type: msg.role === "user" ? "input_text" : "output_text", text }],
    });
  }

  if (history.length === 0) return undefined;

  return JSON.stringify(history);
}

export function filterHistoryForStorage(history: PromptHistoryItem[]): string | undefined {
  const filtered = history.filter((item) => item.type === "message");

  return filtered.length > 0 ? JSON.stringify(filtered) : undefined;
}
