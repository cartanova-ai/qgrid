import { zstdDecompressSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/golden-responses-1.0.60.json";
import { buildGrokResponsesRequest } from "./grok-backend-protocol";
import {
  GrokChatClient,
  GrokHttpError,
  GrokIdleTimeoutError,
  grokProxyGet,
} from "./grok-direct-client";

const body = buildGrokResponsesRequest({
  model: "grok-4.7",
  history: [{ type: "message", role: "user", content: "ping" }],
  promptCacheKey: "11111111-1111-4111-8111-111111111111",
  effort: "high",
});

const headers = { "content-type": "application/json", authorization: "Bearer t" };

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

const completedStream = sse(
  golden.response.eventTypes.map((type) =>
    type === "response.output_text.delta"
      ? { type, delta: "pong", item_id: "m" }
      : type === "response.completed"
        ? { type, response: { id: "r", usage: golden.response.terminalUsage } }
        : { type, response: { id: "r" } },
  ),
);

function openStream(): { stream: ReadableStream<Uint8Array>; push(text: string): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, push: (text) => controller.enqueue(new TextEncoder().encode(text)) };
}

describe("GrokChatClient", () => {
  it("POSTs a zstd body and parses the fixture stream without [DONE]", async () => {
    let sent: { url: string; init: RequestInit | undefined } | undefined;
    const client = new GrokChatClient({
      fetch: async (input, init) => {
        sent = { url: String(input), init };
        return new Response(completedStream, { status: 200, headers: golden.response.headers });
      },
    });
    const result = await client.stream({ body, headers });
    expect(sent?.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(new Headers(sent?.init?.headers).get("content-encoding")).toBe("zstd");
    const raw = sent?.init?.body;
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(zstdDecompressSync(raw as Uint8Array).toString("utf8"))).toEqual(body);
    expect(result.headers).toMatchObject({
      contextWindow: 256000,
      modelsEtag: '"4849638883941606653"',
      rateLimitLimitTokens: 53000000,
      rateLimitRemainingRequests: 8300,
    });
    const events = [];
    for await (const event of result.events) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["created", "text-delta", "completed"]);
    const last = events.at(-1);
    expect(last?.type === "completed" && last.usage?.costInUsdTicks).toBe(465240000);
  });

  it("can send a plain JSON body", async () => {
    let sent: RequestInit | undefined;
    const client = new GrokChatClient({
      fetch: async (_input, init) => {
        sent = init;
        return new Response(completedStream, { status: 200 });
      },
    });
    await client.stream({ body, headers: { ...headers, "content-encoding": "zstd" }, encoding: "plain" });
    expect(new Headers(sent?.headers).has("content-encoding")).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(sent?.body as Uint8Array))).toEqual(body);
  });

  it("rejects non-2xx with the classified error and body text", async () => {
    const client = new GrokChatClient({
      fetch: async () =>
        new Response('{"error":"Your Grok CLI version (0.0.1) is outdated. Please update to version 1.0.13 or later"}', {
          status: 426,
        }),
    });
    const error = await client.stream({ body, headers }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    const http = error as GrokHttpError;
    expect(http.classification).toMatchObject({ kind: "version_gate", minClientVersion: "1.0.13" });
    expect(http.bodyText).toContain("outdated");
  });

  it("classifies a connect failure as transient status 0", async () => {
    const client = new GrokChatClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await client.stream({ body, headers }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect((error as GrokHttpError).classification).toMatchObject({ kind: "transient", status: 0 });
  });

  it("fails with GrokIdleTimeoutError and cancels the request when the stream stalls", async () => {
    const { stream, push } = openStream();
    let requestSignal: AbortSignal | undefined;
    const client = new GrokChatClient({
      fetch: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(stream, { status: 200 });
      },
    });
    const result = await client.stream({ body, headers, idleTimeoutMs: 20 });
    push(sse([{ type: "response.created", response: { id: "r" } }]));
    const seen: string[] = [];
    const error = await (async () => {
      for await (const event of result.events) seen.push(event.type);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["created"]);
    expect(error).toBeInstanceOf(GrokIdleTimeoutError);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("honors caller abort mid-stream", async () => {
    const { stream, push } = openStream();
    const controller = new AbortController();
    const client = new GrokChatClient({ fetch: async () => new Response(stream, { status: 200 }) });
    const result = await client.stream({ body, headers, signal: controller.signal });
    push(sse([{ type: "response.created", response: { id: "r" } }]));
    const pending = (async () => {
      for await (const event of result.events) {
        if (event.type === "created") controller.abort(new Error("caller gone"));
      }
    })();
    await expect(pending).rejects.toThrow("caller gone");
  });

  it("rejects before fetch when already aborted", async () => {
    let called = false;
    const client = new GrokChatClient({
      fetch: async () => {
        called = true;
        return new Response("");
      },
    });
    await expect(
      client.stream({ body, headers, signal: AbortSignal.abort(new Error("stop")) }),
    ).rejects.toThrow("stop");
    expect(called).toBe(false);
  });
});

describe("grokProxyGet", () => {
  it("returns JSON and response header info", async () => {
    const result = await grokProxyGet("/models", {
      headers: {},
      fetch: async (input) => {
        expect(String(input)).toBe("https://cli-chat-proxy.grok.com/v1/models");
        return new Response('{"data":[]}', { headers: { "x-models-etag": '"1"' } });
      },
    });
    expect(result).toMatchObject({ status: 200, json: { data: [] }, headers: { modelsEtag: '"1"' } });
  });

  it("throws GrokHttpError on non-2xx", async () => {
    await expect(
      grokProxyGet("/billing", { headers: {}, fetch: async () => new Response("no", { status: 401 }) }),
    ).rejects.toMatchObject({ classification: { kind: "auth", status: 401 } });
  });
});
