import { type LanguageModelV3FunctionTool, type LanguageModelV3Message } from "@ai-sdk/provider";

import {
  type AppendStepInput,
  type CreateRunInput,
  type FinishRunInput,
  type QgridInputPart,
} from "./index.types";

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
  return res.json() as Promise<{ requestLogId: number }>;
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
  return res.json() as Promise<{ stepId: number }>;
}

export async function finishRun(serverUrl: string, body: FinishRunInput): Promise<{ ok: boolean }> {
  const res = await fetch(`${serverUrl}/api/qgrid/finishRun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: body }),
  });
  return res.json() as Promise<{ ok: boolean }>;
}

// Tool helpers
export function toQgridTool(tool: LanguageModelV3FunctionTool): {
  name: string;
  description?: string;
  inputSchema: unknown;
} {
  const source = tool as LanguageModelV3FunctionTool & {
    inputSchema?: unknown;
    parameters?: unknown;
  };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: source.inputSchema ?? source.parameters ?? {},
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
            args: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
          });
        }
      }
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if ("type" in part && part.type === "tool-result") {
          const id = "toolCallId" in part ? part.toolCallId : "";
          const output = part.output;
          const text =
            "value" in output
              ? typeof output.value === "string"
                ? output.value
                : JSON.stringify(output.value)
              : JSON.stringify(output);
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
export type SSEEvent = { type: string; data: Record<string, unknown> };

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

type ExtractPromptAndHistoryResult = {
  prompt: string;
  system: string | undefined;
  history: unknown[];
  /** Current user turn parts; present only when it carries an image. */
  input?: QgridInputPart[];
  imageUrls: string[];
  droppedImageCount: number;
};

type PromptContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

// Prompt helpers
// User image parts are forwarded only with includeImages; assistant images are always dropped.
export function extractPromptAndHistory(
  messages: LanguageModelV3Message[],
  options: { includeImages?: boolean } = {},
): ExtractPromptAndHistoryResult {
  const includeImages = options.includeImages ?? false;
  const imageUrls: string[] = [];
  let droppedImageCount = 0;
  let system: string | undefined;
  const nonSystem: LanguageModelV3Message[] = [];
  const extractUser = (content: LanguageModelV3Message["content"]) => {
    const extracted = extractPromptParts(content, includeImages);
    imageUrls.push(...extracted.imageUrls);
    droppedImageCount += extracted.droppedImageCount;
    return extracted;
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      system = extractPromptParts(msg.content, false).text;
    } else {
      nonSystem.push(msg);
    }
  }

  if (nonSystem.length === 0) {
    return { prompt: "", system, history: [], imageUrls, droppedImageCount };
  }
  const last = nonSystem[nonSystem.length - 1];
  let prompt = "";
  let input: QgridInputPart[] | undefined;
  if (last.role === "user") {
    const extracted = extractUser(last.content);
    prompt = extracted.text;
    input = inputPartsFromPromptParts(extracted.parts);
  }
  const historyEnd = last.role === "user" ? nonSystem.length - 1 : nonSystem.length;

  const history: unknown[] = [];
  for (let i = 0; i < historyEnd; i++) {
    const msg = nonSystem[i];
    if (msg.role === "user") {
      const extracted = extractUser(msg.content);
      const content = extracted.parts;
      history.push({
        type: "message",
        role: "user",
        content: content.length > 0 ? content : [{ type: "input_text", text: extracted.text }],
      });
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          history.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: part.text }],
          });
        } else if ("toolName" in part && part.type === "tool-call") {
          history.push({
            type: "function_call",
            name: part.toolName,
            arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
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
            "value" in output
              ? typeof output.value === "string"
                ? output.value
                : JSON.stringify(output.value)
              : JSON.stringify(output);
          history.push({
            type: "function_call_output",
            call_id: ("toolCallId" in part ? part.toolCallId : "") ?? "",
            output: text,
          });
        }
      }
    }
  }

  return { prompt, system, history, imageUrls, droppedImageCount, ...(input ? { input } : {}) };
}

function extractPromptParts(
  content: LanguageModelV3Message["content"],
  includeImages: boolean,
): {
  text: string;
  parts: PromptContentPart[];
  imageUrls: string[];
  droppedImageCount: number;
} {
  if (typeof content === "string") {
    return {
      text: content,
      parts: [{ type: "input_text", text: content }],
      imageUrls: [],
      droppedImageCount: 0,
    };
  }
  const parts: PromptContentPart[] = [];
  const texts: string[] = [];
  const imageUrls: string[] = [];
  let droppedImageCount = 0;
  for (const part of content) {
    if ("text" in part && typeof part.text === "string") {
      parts.push({ type: "input_text", text: part.text });
      texts.push(part.text);
    } else if (isImagePart(part)) {
      const url = includeImages ? imageUrl(part) : undefined;
      if (url) {
        parts.push({ type: "input_image", image_url: url });
        imageUrls.push(url);
      } else {
        droppedImageCount++;
      }
    }
  }
  return { text: texts.join("\n"), parts, imageUrls, droppedImageCount };
}

function inputPartsFromPromptParts(parts: PromptContentPart[]): QgridInputPart[] | undefined {
  if (!parts.some((part) => part.type === "input_image")) return undefined;
  return parts.flatMap((part): QgridInputPart[] => {
    if (part.type === "input_image") return [{ type: "image", url: part.image_url }];
    return part.text ? [{ type: "text", text: part.text, text_elements: [] }] : [];
  });
}

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  return (
    record.type === "image" ||
    (record.type === "file" &&
      typeof record.mediaType === "string" &&
      record.mediaType.toLowerCase().startsWith("image/"))
  );
}

// AI SDK image/file part data → URL the Responses API accepts (data:/http(s):), else undefined.
function imageUrl(part: unknown): string | undefined {
  const record = part as Record<string, unknown>;
  const mediaType =
    typeof record.mediaType === "string" && record.mediaType !== "image/*"
      ? record.mediaType
      : "image/png";
  const data = record.data ?? record.image;
  if (data instanceof URL) return /^https?:$/i.test(data.protocol) ? data.toString() : undefined;
  if (data instanceof Uint8Array) return `data:${mediaType};base64,${bytesToBase64(data)}`;
  if (data instanceof ArrayBuffer) {
    return `data:${mediaType};base64,${bytesToBase64(new Uint8Array(data))}`;
  }
  if (typeof data !== "string") return undefined;
  if (/^(https?:|data:)/i.test(data)) return data;
  // Any other scheme is not base64 payload.
  return /^[a-z][a-z0-9+.-]*:/i.test(data) ? undefined : `data:${mediaType};base64,${data}`;
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
        `qgrid: image input is too large for JSON transport (${url.length} chars). Compress or resize it before passing it to qgrid, for example as WebP/JPEG under ${MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL} total base64 data-url chars.`,
      );
    }
  }
  if (totalDataUrlChars > MAX_IMAGE_INPUT_DATA_URL_CHARS) {
    throw new Error(
      `qgrid: image inputs are too large for JSON transport (${totalDataUrlChars} total chars). Compress or resize them before passing them to qgrid, for example as WebP/JPEG under ${MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL} total base64 data-url chars.`,
    );
  }
}

// --- shared helpers (used by both index.ts and logger.ts) ---

export function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && "type" in part) {
        if (part.type === "text" && "text" in part && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n");
}

export function getErrorMessage(value: unknown): string {
  if (value instanceof Error) return String(value);
  if (value === undefined || value === null) return "unknown error";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export function extractUserPrompt(prompt: unknown, messages: unknown): string {
  if (typeof prompt === "string") return prompt;
  const messageList = Array.isArray(messages) ? messages : Array.isArray(prompt) ? prompt : [];
  for (let i = messageList.length - 1; i >= 0; i--) {
    const msg = getRecord(messageList[i]);
    if (msg?.role === "user") {
      return extractTextContent(msg.content);
    }
  }
  return "";
}

export function extractSystemPrompt(system: unknown): string | undefined {
  if (typeof system === "string") return system;
  if (system && typeof system === "object" && "content" in system) {
    const content = (system as { content: unknown }).content;
    if (typeof content === "string") return content;
  }
  return undefined;
}

export function serializeHistory(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const lastRecord = getRecord(messages[messages.length - 1]);
  const sliced = lastRecord?.role === "user" ? messages.slice(0, -1) : messages;
  const history: Array<Record<string, unknown>> = [];
  for (const msg of sliced) {
    const record = getRecord(msg);
    if (record?.role !== "user" && record?.role !== "assistant") continue;
    const text = extractTextContent(record.content);
    if (text.length === 0) continue;
    history.push({
      type: "message",
      role: record.role,
      content: [{ type: record.role === "user" ? "input_text" : "output_text", text }],
    });
  }
  if (history.length === 0) return undefined;
  return safeStringify(history);
}

export function filterHistoryForStorage(history: unknown[]): string | undefined {
  const filtered = history.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return record.type === "message" && (record.role === "user" || record.role === "assistant");
  });
  return filtered.length > 0 ? JSON.stringify(filtered) : undefined;
}
