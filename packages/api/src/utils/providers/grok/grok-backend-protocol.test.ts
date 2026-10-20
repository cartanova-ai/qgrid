import { zstdDecompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/golden-responses-1.0.60.json";
import {
  buildGrokResponsesRequest,
  classifyGrokHttpError,
  encodeGrokRequestBody,
  encodeGrokRequestBodyPlain,
  normalizeGrokEvent,
  normalizeGrokSSE,
  parseGrokSSE,
  readGrokResponseHeaders,
  type GrokNormalizedEvent,
} from "./grok-backend-protocol";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sse(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

async function collect(body: ReadableStream<Uint8Array>): Promise<GrokNormalizedEvent[]> {
  const events: GrokNormalizedEvent[] = [];
  for await (const event of normalizeGrokSSE(body)) events.push(event);
  return events;
}

describe("buildGrokResponsesRequest", () => {
  it("emits the captured body keys in fixture order", () => {
    const body = buildGrokResponsesRequest({
      model: "grok-4.7",
      systemPrompt: "system",
      history: [{ type: "message", role: "user", content: "hi" }],
      promptCacheKey: "conv-1",
      effort: "high",
      tools: [{ type: "function", name: "f", parameters: { type: "object" }, strict: true }],
    });
    expect(Object.keys(body)).toEqual(golden.request.bodyKeys);
    expect(body.include).toEqual(golden.request.body.include);
    expect(body.reasoning).toEqual(golden.request.body.reasoning);
    expect(body.store).toBe(golden.request.body.store);
    expect(body.stream).toBe(golden.request.body.stream);
    expect(body.prompt_cache_key).toBe("conv-1");
    expect(body.input[0]).toEqual({ type: "message", role: "system", content: "system" });
  });

  it("replays full history, appends optional keys in order and never sends server state", () => {
    const body = buildGrokResponsesRequest({
      model: "grok-4.5",
      history: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what colour?" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
        { type: "reasoning", id: "rs_1", encrypted_content: "enc" },
        { type: "reasoning", id: "rs_foreign", summary: [{ type: "summary_text", text: "x" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "message", role: "assistant", content: "Red." },
      ],
      promptCacheKey: "conv-2",
      effort: "xhigh",
      outputSchema: { name: "pong", schema: { type: "object" } },
      tools: [{ type: "web_search" }, { type: "x_search" }],
      toolChoice: "auto",
      maxOutputTokens: 256,
    });
    expect(Object.keys(body)).toEqual([
      "include",
      "input",
      "model",
      "prompt_cache_key",
      "reasoning",
      "store",
      "stream",
      "text",
      "tools",
      "tool_choice",
      "max_output_tokens",
    ]);
    expect(body.input.map((item) => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(body.input[1]).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "enc",
    });
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "pong", strict: true, schema: { type: "object" } },
    });
    for (const key of ["instructions", "previous_response_id", "conversation"])
      expect(body).not.toHaveProperty(key);
  });

  it("rejects invalid options", () => {
    const base = { model: "grok-4.7", history: [], promptCacheKey: "k", effort: "high" } as const;
    expect(() => buildGrokResponsesRequest({ ...base, promptCacheKey: "" })).toThrow(TypeError);
    expect(() => buildGrokResponsesRequest({ ...base, maxOutputTokens: 0 })).toThrow(TypeError);
  });
});

describe("Grok body encoding", () => {
  const body = buildGrokResponsesRequest({
    model: "grok-4.7",
    history: [{ type: "message", role: "user", content: "ping" }],
    promptCacheKey: "k",
    effort: "low",
  });

  it("zstd-compresses JSON that round-trips", async () => {
    const encoded = await encodeGrokRequestBody(body);
    expect(encoded.contentEncoding).toBe("zstd");
    expect(JSON.parse(zstdDecompressSync(encoded.bytes).toString("utf8"))).toEqual(body);
  });

  it("has a plain variant", () => {
    const encoded = encodeGrokRequestBodyPlain(body);
    expect(encoded.contentEncoding).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(body);
  });
});

describe("normalizeGrokEvent / normalizeGrokSSE", () => {
  it("accepts every captured event type and ends at response.completed without [DONE]", async () => {
    expect(golden.response.endsWithDone).toBe(false);
    const chunks = golden.response.eventTypes.map((type) => {
      if (type === "response.created") return sse(type, { response: { id: "resp_1" } });
      if (type.endsWith(".delta")) return sse(type, { item_id: "it", delta: "x" });
      if (type.startsWith("response.output_item."))
        return sse(type, { item: { type: "message", id: "it" } });
      if (type === "response.completed")
        return sse(type, {
          response: { id: "resp_1", model: "grok-4.7", usage: golden.response.terminalUsage },
        });
      return sse(type, { item_id: "it" });
    });
    // Split mid-way through a block and a CRLF to exercise chunk boundaries.
    const joined = chunks.join("").replace("\n\n", "\r\n\r\n");
    const events = await collect(streamOf(joined.slice(0, 37), joined.slice(37, 38), joined.slice(38)));
    expect(events.map((event) => event.type)).toEqual([
      "created",
      "output-item",
      "reasoning-summary-delta",
      "output-item",
      "text-delta",
      "completed",
    ]);
    expect(events.at(-1)).toEqual({
      type: "completed",
      terminal: true,
      responseId: "resp_1",
      model: "grok-4.7",
      usage: {
        inputTokens: 27150,
        cachedInputTokens: 6528,
        outputTokens: 336,
        reasoningTokens: 335,
        totalTokens: 27486,
        numSourcesUsed: 0,
        numServerSideToolsUsed: 0,
        costInUsdTicks: 465240000,
        contextInputTokens: 27150,
        contextOutputTokens: 344,
      },
    });
  });

  it("treats incomplete and failed as terminal", async () => {
    const incomplete = await collect(
      streamOf(
        sse("response.incomplete", {
          response: { id: "r", incomplete_details: { reason: "max_output_tokens" } },
        }),
        sse("response.output_text.delta", { delta: "ignored after terminal" }),
      ),
    );
    expect(incomplete).toEqual([
      { type: "incomplete", terminal: true, responseId: "r", reason: "max_output_tokens" },
    ]);
    const failed = normalizeGrokEvent({
      data: JSON.stringify({
        type: "response.failed",
        response: { error: { code: "server_error", message: "boom" } },
      }),
    });
    expect(failed).toMatchObject({ type: "error", terminal: true, error: { code: "server_error" } });
  });

  it("uses the SSE event name when the data has no type and tolerates [DONE]", () => {
    expect(
      normalizeGrokEvent({ event: "response.output_text.delta", data: '{"delta":"hi"}' }),
    ).toEqual({ type: "text-delta", text: "hi" });
    expect(normalizeGrokEvent({ data: "[DONE]" })).toBeUndefined();
  });

  it("rejects a stream that closes before a terminal event and invalid JSON", async () => {
    await expect(collect(streamOf(sse("response.created", {})))).rejects.toThrow(
      /closed before a terminal event/,
    );
    expect(() => normalizeGrokEvent({ data: "{" })).toThrow(/Invalid Grok SSE JSON/);
  });

  it("parses event names, comments and a BOM", async () => {
    const blocks = [];
    for await (const block of parseGrokSSE(streamOf("\uFEFF: ping\n\nevent: a\ndata: 1\ndata: 2\n\n")))
      blocks.push(block);
    expect(blocks).toEqual([{ event: "a", data: "1\n2" }]);
  });
});

describe("readGrokResponseHeaders", () => {
  it("reads the captured response headers", () => {
    expect(readGrokResponseHeaders(new Headers(golden.response.headers))).toEqual({
      contextWindow: 256000,
      modelsEtag: '"4849638883941606653"',
      requestId: "19bfa1b2-a163-9e0c-8de1-832a73e2695e",
      rateLimitLimitTokens: 53000000,
      rateLimitRemainingTokens: 53000000,
      rateLimitLimitRequests: 8300,
      rateLimitRemainingRequests: 8300,
      zeroDataRetention: true,
    });
  });

  it("reads x-zero-data-retention only as an explicit boolean", () => {
    expect(readGrokResponseHeaders({ "X-Zero-Data-Retention": "TRUE" })).toEqual({
      zeroDataRetention: true,
    });
    expect(readGrokResponseHeaders({ "x-zero-data-retention": "false" })).toEqual({
      zeroDataRetention: false,
    });
    expect(readGrokResponseHeaders({ "x-zero-data-retention": "zdr" })).toEqual({});
    expect(readGrokResponseHeaders({})).toEqual({});
  });
});

describe("classifyGrokHttpError", () => {
  it("classifies the U0 426 body as a version gate and parses the minimum version", () => {
    const body = JSON.stringify({
      error:
        "Your Grok CLI version (0.0.1) is outdated. Please update to version 1.0.13 or later to continue.",
    });
    expect(classifyGrokHttpError(426, body, {})).toMatchObject({
      kind: "version_gate",
      status: 426,
      minClientVersion: "1.0.13",
    });
  });

  it("classifies a 400 invalid_image body", () => {
    const body = JSON.stringify({
      code: "invalid_image",
      error: "Image dimensions must be at least 8 pixels on each side",
    });
    expect(classifyGrokHttpError(400, body, {})).toEqual({
      kind: "invalid_request",
      status: 400,
      code: "invalid_image",
      message: "Image dimensions must be at least 8 pixels on each side",
    });
  });

  it("separates rate limiting from subscription exhaustion", () => {
    expect(
      classifyGrokHttpError(429, "slow down", new Headers({ "retry-after": "17" })),
    ).toMatchObject({ kind: "rate_limited", retryAfterSec: 17 });
    expect(
      classifyGrokHttpError(
        429,
        JSON.stringify({ error: "Too many requests: subscription:free-usage-exhausted" }),
        { "Retry-After": "60" },
      ),
    ).toMatchObject({ kind: "quota_exhausted", code: "subscription:free-usage-exhausted" });
  });

  it("parses an HTTP-date Retry-After", () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    const result = classifyGrokHttpError(429, "", { "retry-after": date });
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(28);
    expect(result.retryAfterSec).toBeLessThanOrEqual(31);
  });

  it.each([
    [401, "auth"],
    [403, "entitlement"],
    [422, "invalid_request"],
    [404, "permanent"],
    [408, "transient"],
    [500, "transient"],
    [503, "transient"],
    [0, "transient"],
  ] as const)("maps %i to %s", (status, kind) => {
    expect(classifyGrokHttpError(status, "", {}).kind).toBe(kind);
  });

  it("exposes x-should-retry overrides", () => {
    expect(classifyGrokHttpError(500, "", { "x-should-retry": "false" }).shouldRetry).toBe(false);
    expect(classifyGrokHttpError(409, "", { "x-should-retry": "true" }).shouldRetry).toBe(true);
    expect(classifyGrokHttpError(500, "", {})).not.toHaveProperty("shouldRetry");
  });

  it("caps the surfaced message length", () => {
    expect(classifyGrokHttpError(500, "x".repeat(5000), {}).message).toHaveLength(500);
  });
});
