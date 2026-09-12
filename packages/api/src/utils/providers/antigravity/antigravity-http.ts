import { randomUUID } from "node:crypto";

import { type AntigravityCredentials } from "../../../application/token/token.types";
import { flattenColdHistory, userInputToText } from "../anthropic/stream-json-adapter";
import {
  type GenerateRequest,
  type ProviderTokenUsageBreakdown,
} from "../common/provider-dispatcher";

export const ANTIGRAVITY_API = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
export const ANTIGRAVITY_CONTROL_API = "https://cloudcode-pa.googleapis.com/v1internal:";
export type HttpDeps = { fetch?: typeof fetch };
type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};

export class AntigravityHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Antigravity HTTP ${status} (${code})`);
    this.name = "AntigravityHttpError";
  }
}

export async function checkedJson(response: Response): Promise<RecordValue> {
  const data = record(await response.json().catch(() => null));
  if (!response.ok) {
    const error = record(data.error);
    const candidate = typeof data.error === "string" ? data.error : error.status;
    const code =
      typeof candidate === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(candidate)
        ? candidate
        : "UPSTREAM_ERROR";
    throw new AntigravityHttpError(response.status, code);
  }
  return data;
}

export function antigravityHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "qgrid-antigravity-http/0.1",
  };
}

export async function antigravityControl(
  method: "loadCodeAssist" | "onboardUser" | "fetchAvailableModels" | "retrieveUserQuotaSummary",
  accessToken: string,
  body: RecordValue,
  signal: AbortSignal,
  deps: HttpDeps = {},
): Promise<RecordValue> {
  const base = method === "loadCodeAssist" ? ANTIGRAVITY_CONTROL_API : ANTIGRAVITY_API;
  return checkedJson(
    await (deps.fetch ?? fetch)(base + method, {
      method: "POST",
      headers: antigravityHeaders(accessToken),
      body: JSON.stringify(body),
      signal,
    }),
  );
}

export function buildAntigravityRequest(
  req: GenerateRequest,
  projectId: string,
  wireModel: string,
) {
  if (req.coldInput.some((input) => input.type !== "text")) {
    throw new Error("Antigravity HTTP currently supports text input only");
  }
  const current = userInputToText(req.coldInput);
  const history = req.coldHistory?.length ? flattenColdHistory(req.coldHistory) : "";
  const text = history
    ? `Prior conversation context:\n${history}\n\nCurrent user message:\n${current}`
    : current;
  return {
    project: projectId,
    model: wireModel,
    requestId: `agent-${randomUUID()}`,
    userAgent: "antigravity",
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text }] }],
      ...(req.systemPrompt ? { systemInstruction: { parts: [{ text: req.systemPrompt }] } } : {}),
      // Never include credit fallback, native tools, or CLI/environment instructions.
      generationConfig: { thinkingConfig: { thinkingLevel: req.effort ?? "low" } },
    },
  };
}

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
export function antigravityUsage(value: unknown): ProviderTokenUsageBreakdown {
  const usage = record(value);
  const reasoning = number(usage.thoughtsTokenCount);
  return {
    inputTokens: number(usage.promptTokenCount),
    cachedInputTokens: number(usage.cachedContentTokenCount),
    outputTokens: number(usage.candidatesTokenCount) + reasoning,
    reasoningOutputTokens: reasoning,
    totalTokens: number(usage.totalTokenCount),
  };
}

export function readAntigravityEvent(value: unknown) {
  const root = record(value);
  if (root.error)
    throw new AntigravityHttpError(number(record(root.error).code) || 502, "STREAM_ERROR");
  const response = record(root.response ?? root);
  if (record(response.promptFeedback).blockReason)
    throw new Error("Antigravity blocked the prompt");
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const candidate = record(candidates[0]);
  const parts = record(candidate.content).parts;
  let text = "";
  if (Array.isArray(parts)) {
    for (const item of parts) {
      const part = record(item);
      if (part.functionCall) throw new Error("Antigravity returned an unexpected native tool call");
      if (!part.thought && typeof part.text === "string") text += part.text;
    }
  }
  const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : undefined;
  if (finish && finish !== "STOP") throw new Error(`Antigravity generation stopped (${finish})`);
  return {
    text,
    finish,
    usage: response.usageMetadata ? antigravityUsage(response.usageMetadata) : undefined,
    model: typeof response.modelVersion === "string" ? response.modelVersion : undefined,
  };
}

function parseSseBlock(block: string): unknown {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return !data || data === "[DONE]" ? undefined : (JSON.parse(data) as unknown);
}

/** Read JSON SSE frames without depending on the OpenAI event protocol. */
export async function* antigravitySse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r\n\r\n|\n\n/.exec(buffer))) {
        const parsed = parseSseBlock(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (parsed !== undefined) yield parsed;
      }
      if (buffer.length > 1_048_576) throw new Error("Antigravity SSE frame exceeds 1 MiB");
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed !== undefined) yield parsed;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function generateAntigravityHttp(
  req: GenerateRequest,
  credentials: AntigravityCredentials,
  wireModel: string,
  onDelta?: (text: string) => void,
  deps: HttpDeps = {},
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(req.timeoutMs ?? 240_000),
    ...(req.abortSignal ? [req.abortSignal] : []),
  ]);
  const startedAt = performance.now();
  const response = await (deps.fetch ?? fetch)(
    ANTIGRAVITY_API + (onDelta ? "streamGenerateContent?alt=sse" : "generateContent"),
    {
      method: "POST",
      signal,
      headers: antigravityHeaders(credentials.accessToken),
      body: JSON.stringify(buildAntigravityRequest(req, credentials.projectId, wireModel)),
    },
  );
  if (!response.ok) await checkedJson(response);
  let text = "";
  let usage = antigravityUsage({});
  let model: string | undefined;
  let finished = false;
  let ttftMs: number | null = null;
  const consume = (raw: unknown) => {
    const event = readAntigravityEvent(raw);
    if (event.text) {
      ttftMs ??= Math.round(performance.now() - startedAt);
      text += event.text;
      onDelta?.(event.text);
    }
    if (event.usage) usage = event.usage;
    if (event.model) model = event.model;
    if (event.finish) finished = true;
  };
  if (onDelta) {
    if (!response.body) throw new Error("Antigravity response has no stream");
    for await (const event of antigravitySse(response.body)) consume(event);
  } else {
    consume(await checkedJson(response));
  }
  if (!finished) throw new Error("Antigravity response ended without a successful finish");
  return { text, usage, model, ttftMs, durationMs: Math.round(performance.now() - startedAt) };
}
