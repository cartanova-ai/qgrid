import { beforeEach, describe, expect, it, vi } from "vitest";

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock("./openai-refresh", () => ({ handleChatgptAuthTokensRefresh: refreshMock }));

import { QueryInput, QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { type GenerateRequest } from "../common/provider-dispatcher";
import {
  buildOpenAIResponsesRequest,
  normalizeOpenAIEvent,
  type OpenAINormalizedEvent,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";
import { ImageGenerationError, OpenAIDispatcher } from "./openai-dispatcher";
import { buildStandaloneImageRequest } from "./openai-image-generation";
import { type OpenAITransportKind } from "./openai-transport-config";

const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  accessTokenExpiresAt: 1,
  accountId: "acct",
};

function config(): OpenAITransportKind {
  return "https";
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "gpt-test",
    coldHistory: [{ type: "message", role: "assistant", content: "old" }],
    coldInput: [{ type: "text", text: "new", text_elements: [] }],
    ...overrides,
  };
}

function dispatcher(
  run: (
    options: OpenAIResponsesOptions,
    signal?: AbortSignal,
  ) => AsyncIterable<OpenAINormalizedEvent>,
) {
  return new OpenAIDispatcher(config(), { clientFactory: () => ({ responses: run }) });
}

async function* events(...values: OpenAINormalizedEvent[]) {
  yield* values;
}

async function tickTimer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OpenAIDispatcher direct runtime", () => {
  it.each(["gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"])(
    "disables thinking and omits summaries through generate/stream for %s",
    async (model) => {
      const run = vi.fn((options: OpenAIResponsesOptions) => {
        expect(buildOpenAIResponsesRequest(options).reasoning).toEqual({ effort: "none" });
        expect(options.outputSchema).toEqual({ schema: { type: "object" } });
        return events({ type: "completed", responseId: "r" });
      });
      const d = dispatcher(run);
      await d.onTokenAdded(1, "one", credentials);
      const req = request({ model, thinking: false, effort: "high", reasoningSummary: "detailed", outputSchema: { type: "object" } });
      await d.generate(req);
      const complete = vi.fn();
      await d.generateStream(req, { onDelta: vi.fn(), onComplete: complete, onError: vi.fn() });
      expect(complete).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["gpt-6-astra", "requires thinking"],
    ["gpt-6.1-sol", "requires thinking"],
    ["gpt-5.4", "has not been verified"],
  ])("rejects thinking:false for %s before token selection", async (model, reason) => {
    const run = vi.fn(() => events());
    // No tokens: validation must win over NO_OPENAI_WORKERS and never contact transport.
    const d = dispatcher(run);
    const req = request({ model, thinking: false });
    await expect(d.generate(req)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(reason) });
    const onError = vi.fn();
    const onComplete = vi.fn();
    await expect(d.generateStream(req, { onDelta: vi.fn(), onError, onComplete })).rejects.toThrow(model);
    expect(onError).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([true, undefined])("preserves effort and summary with thinking=%s on an off-unsupported model", async (thinking) => {
    const run = vi.fn((options: OpenAIResponsesOptions) => {
      expect(options.reasoning).toEqual({ effort: "high", summary: "detailed" });
      return events({ type: "completed", responseId: "r" });
    });
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    await d.generate(request({ model: "gpt-6-astra", thinking, effort: "high", reasoningSummary: "detailed" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("explicit true enables reasoning with absent or invalid effort without changing omission", async () => {
    const observed: Array<OpenAIResponsesOptions["reasoning"]> = [];
    const d = dispatcher((options) => {
      observed.push(options.reasoning);
      return events({ type: "completed", responseId: "r" });
    });
    await d.onTokenAdded(1, "one", credentials);
    for (const effort of [undefined, "invalid"]) {
      await d.generate(request({ model: "gpt-6-sol", thinking: true, effort }));
      await d.generate(request({ model: "gpt-6-sol", effort }));
    }
    expect(observed).toEqual([{ effort: "low" }, undefined, { effort: "low" }, undefined]);
  });

  it("applies thinking:false to the automatic image text driver", async () => {
    const run = vi.fn((options: OpenAIResponsesOptions) => {
      expect(options.reasoning).toEqual({ effort: "none" });
      expect(options.imageGeneration).toBeUndefined();
      return events({ type: "text-delta", text: "hello" }, { type: "completed", responseId: "r" });
    });
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    await d.generate(request({ model: "gpt-6-sol", thinking: false, imageGeneration: "auto" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["png", "jpeg", "webp"] as const)("forwards %s format and preserves returned MIME", async (outputFormat) => {
    const args = QueryInput.parse({ prompt: "draw", imageGeneration: true, imageGenerationOptions: { outputFormat } });
    let body: ReturnType<typeof buildOpenAIResponsesRequest> | undefined;
    const d = dispatcher((options) => {
      body = buildOpenAIResponsesRequest(options);
      return events({ type: "image", base64: "data", mimeType: `image/${outputFormat}` }, { type: "completed", responseId: "r" });
    });
    await d.onTokenAdded(1, "one", credentials);
    const result = await d.generate(request({ imageGeneration: args.imageGeneration, imageGenerationOptions: args.imageGenerationOptions }));
    expect(body?.tools).toEqual([{ type: "image_generation", output_format: outputFormat }]);
    expect(result.images).toMatchObject([{ mediaType: `image/${outputFormat}` }]);
  });

  it("rejects unsupported output formats and non-PNG transparent requests", () => {
    for (const imageGenerationOptions of [{ outputFormat: "gif" }, { outputFormat: "webp", background: "transparent" }, { outputFormat: "jpeg", background: "transparent" }]) {
      expect(QueryInput.safeParse({ prompt: "draw", imageGeneration: true, imageGenerationOptions }).success).toBe(false);
    }
  });

  it.each(["auto", "1152x2560"])("forwards %s size hints and preserves hosted observations", async (size) => {
    const args = QueryInput.parse({ prompt: "draw in 9:20", imageGeneration: true, imageGenerationOptions: { size } });
    const generation = { route: "codex-responses" as const, size: "841x1870", quality: "low" };
    const d = dispatcher((options) => {
      expect(buildOpenAIResponsesRequest(options).tools).toContainEqual({ type: "image_generation", size });
      return events({ type: "image", base64: "data", mimeType: "image/png", generation }, { type: "completed", responseId: "r" });
    });
    await d.onTokenAdded(1, "one", credentials);
    const result = await d.generate(request({ imageGeneration: args.imageGeneration, imageGenerationOptions: args.imageGenerationOptions }));
    expect(result.images).toMatchObject([{ generation }]);
  });

  beforeEach(() => { refreshMock.mockReset(); });

  it("refreshes a quota 401 once, shares the recovery, and uses the new credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rate_limits: { primary_window: { used_percent: 20 } },
      })));
    refreshMock.mockResolvedValue({ accessToken: "new-access", chatgptAccountId: "acct" });
    const factory = vi.fn(() => ({ responses: () => events({ type: "completed", responseId: "r" }) }));
    const d = new OpenAIDispatcher(config(), { fetch: fetchMock, clientFactory: factory });
    await d.onTokenAdded(1, "one", credentials);
    const [first, second] = await Promise.all([
      d.getRateLimitsByTokenId(1), d.getRateLimitsByTokenId(1),
    ]);
    expect(first).toEqual(second);
    expect(first.data.rateLimits.primary?.usedPercent).toBe(20);
    expect(refreshMock).toHaveBeenCalledExactlyOnceWith(1);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer new-access");
    await d.generate(request());
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { accessToken: "new-access", accountId: "acct" },
    }), 1);
  });

  it("does not loop when quota still returns 401 after refresh", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("", { status: 401 })));
    refreshMock.mockResolvedValue({ accessToken: "new-access", chatgptAccountId: "acct" });
    const d = new OpenAIDispatcher(config(), { fetch: fetchMock });
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.getRateLimitsByTokenId(1)).rejects.toThrow("HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 500, 503])("does not refresh credentials for quota HTTP %s", async (status) => {
    const d = new OpenAIDispatcher(config(), {
      fetch: vi.fn().mockResolvedValue(new Response("", { status })),
    });
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.getRateLimitsByTokenId(1)).rejects.toThrow(`HTTP ${status}`);
    expect(refreshMock).not.toHaveBeenCalled();
    expect(d.countActiveTokens()).toBe(1);
  });

  it("propagates refresh failure instead of retrying rejected credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    refreshMock.mockRejectedValue(new Error("OpenAI refresh failed: 401 refresh_token_reused"));
    const d = new OpenAIDispatcher(config(), { fetch: fetchMock });
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.getRateLimitsByTokenId(1)).rejects.toThrow("refresh_token_reused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a newer subscriber credential and never caches an old generation's lookup", async () => {
    let finishRefresh!: (value: { accessToken: string; chatgptAccountId: string }) => void;
    refreshMock.mockImplementation(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const quota = (percent: number) => new Response(JSON.stringify({
      rate_limits: { primary_window: { used_percent: percent } },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(quota(20))
      .mockResolvedValueOnce(quota(30));
    const d = new OpenAIDispatcher(config(), { fetch: fetchMock });
    await d.onTokenAdded(1, "one", credentials);
    const pending = d.getRateLimitsByTokenId(1);
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    await d.onTokenUpdated(1, "one", { ...credentials, accessToken: "subscriber-access" });
    finishRefresh({ accessToken: "older-refresh-access", chatgptAccountId: "acct" });
    await pending;
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer subscriber-access");
    expect((await d.getRateLimitsByTokenId(1)).data.rateLimits.primary?.usedPercent).toBe(30);
  });

  it("does not share pending quota requests across subscriber generations", async () => {
    let finishOld!: (value: Response) => void;
    const quota = (percent: number) => new Response(JSON.stringify({
      rate_limits: { primary_window: { used_percent: percent } },
    }));
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(quota(10));
    const d = new OpenAIDispatcher(config(), { fetch: fetchMock });
    await d.onTokenAdded(1, "one", credentials);
    const old = d.getRateLimitsByTokenId(1);
    await d.onTokenUpdated(1, "one", { ...credentials, accessToken: "new" });
    const current = d.getRateLimitsByTokenId(1);
    finishOld(quota(90));
    await old;
    expect((await current).data.rateLimits.primary?.usedPercent).toBe(10);
    expect((await d.getRateLimitsByTokenId(1)).data.rateLimits.primary?.usedPercent).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["transparent", "opaque", "auto"] as const)(
    "preserves %s background through validation and Responses serialization",
    async (background) => {
      const args = QueryInput.parse({
        model: "openai/gpt-test",
        prompt: "an isolated red circle",
        imageGeneration: true,
        imageGenerationOptions: { background, quality: "high", size: "1024x1024" },
      });
      let body: ReturnType<typeof buildOpenAIResponsesRequest> | undefined;
      const d = dispatcher((options) => {
        body = buildOpenAIResponsesRequest(options);
        return events(
          { type: "image", id: "i", base64: "png", mimeType: "image/png" },
          { type: "completed", responseId: "r" },
        );
      });
      await d.onTokenAdded(1, "one", credentials);
      await d.generate(request({
        imageGeneration: args.imageGeneration,
        imageGenerationOptions: args.imageGenerationOptions,
      }));
      expect(body?.tools).toEqual([{
        type: "image_generation", background, quality: "high", size: "1024x1024",
      }]);
    },
  );

  it("rejects unsupported image backgrounds", () => {
    expect(QueryInput.safeParse({
      prompt: "a circle", imageGeneration: true,
      imageGenerationOptions: { background: "green" },
    }).success).toBe(false);
  });

  it("passes the resolved transport to the injectable client factory", async () => {
    const factory = vi.fn(
      (_options: import("./openai-direct-client").OpenAIDirectClientOptions) => ({
        responses: () => events({ type: "completed", responseId: "r" }),
      }),
    );
    const d = new OpenAIDispatcher("websocket", { clientFactory: factory });
    await d.onTokenAdded(1, "one", credentials);
    await d.generate(request());
    await d.generate(request());
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ transportKind: "websocket" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("maps complete cold context and Responses controls, then maps usage and affinity", async () => {
    let mapped: OpenAIResponsesOptions | undefined;
    const d = dispatcher((options) => {
      mapped = options;
      return events(
        { type: "text-delta", text: "hello" },
        {
          type: "completed",
          responseId: "r1",
          usage: {
            inputTokens: 8,
            cachedInputTokens: 3,
            outputTokens: 2,
            reasoningTokens: 1,
            totalTokens: 10,
          },
        },
      );
    });
    await d.onTokenAdded(7, "primary", credentials, null, 1);

    const result = await d.generate(
      request({
        systemPrompt: "system",
        effort: "high",
        reasoningSummary: "none",
        verbosity: "low",
        serviceTier: "fast",
        promptCacheKey: "cache-key",
        outputSchema: { type: "object", additionalProperties: false },
      }),
    );

    expect(mapped).toMatchObject({
      model: "gpt-test",
      instructions: "system",
      reasoning: { effort: "high" },
      verbosity: "low",
      serviceTier: "priority",
      promptCacheKey: "cache-key",
      outputSchema: { schema: { type: "object", additionalProperties: false } },
    });
    expect(mapped?.reasoning).not.toHaveProperty("summary");
    expect(mapped?.history).toEqual([
      { type: "message", role: "assistant", content: "old" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
    ]);
    expect(result).toMatchObject({
      text: "hello",
      tokenName: "primary",
      usage: {
        inputTokens: 8,
        cachedInputTokens: 3,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 10,
      },
      threadCoord: { workerId: 7, threadId: "cache-key", epoch: -1 },
    });
  });

  it("streams final-answer deltas incrementally while checking message boundaries", async () => {
    const d = dispatcher(() =>
      events(
        { type: "output-item", item: { id: "m", type: "message", phase: "final_answer", content: [] } },
        { type: "text-delta", text: "a", itemId: "m" },
        { type: "text-delta", text: "b", itemId: "m" },
        { type: "output-item", completed: true, item: { id: "m", type: "message", phase: "final_answer", content: [{type: "output_text", text: "ab"}] } },
        { type: "completed", responseId: "r" },
      ),
    );
    await d.onTokenAdded(1, "one", credentials);
    const deltas: string[] = [];
    const complete = vi.fn();
    await d.generateStream(request({stopAfterOutputMessage: () => false}), {
      onDelta: (v) => deltas.push(v),
      onComplete: complete,
      onError: vi.fn(),
    });
    expect(deltas).toEqual(["a", "b"]);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ text: "ab" }));
  });

  it("reports the selected token and the first-delta TTFT as progress before completing", async () => {
    const d = dispatcher(() =>
      events(
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "completed", responseId: "r" },
      ),
    );
    await d.onTokenAdded(1, "one", credentials);
    const progress = vi.fn();

    await d.generate(request({ onProgress: progress }));

    expect(progress).toHaveBeenNthCalledWith(1, { tokenName: "one" });
    expect(progress).toHaveBeenNthCalledWith(2, { ttftMs: expect.any(Number) });
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("still rejects an upstream failure after accepting a completed output message", async () => {
    const failure = new Error("upstream failed after tool request");
    const d = dispatcher(() => events(
      {type: "text-delta", text: "tool request"},
      {type: "output-item", completed: true, item: {type: "message", content: [{type: "output_text", text: "tool request"}]}},
      {type: "error", error: failure},
    ));
    await d.onTokenAdded(1, "one", credentials);
    const complete = vi.fn();
    const onError = vi.fn();
    await expect(d.generateStream(request({stopAfterOutputMessage: () => true}), {onDelta: vi.fn(), onComplete: complete, onError})).rejects.toBe(failure);
    expect(complete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("returns multiple hosted images with one driver request", async () => {
    const run = vi.fn(() => events(
      { type: "image", id: "first", base64: "first", mimeType: "image/png" },
      { type: "image", id: "second", base64: "second", mimeType: "image/webp" },
      { type: "completed", responseId: "driver" },
    ));
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    const result = await d.generate(request({ imageGeneration: true }));
    expect(result.images).toMatchObject([{ data: "first", mediaType: "image/png" }, { data: "second", mediaType: "image/webp" }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("preserves aggregate hosted image usage separately from driver usage (driver usage: %s)", async (withDriverUsage) => {
    const imageUsage = {
      input_tokens: 2260,
      input_tokens_details: { image_tokens: 2012, text_tokens: 248 },
      output_tokens: 1415,
      output_tokens_details: { image_tokens: 1415, text_tokens: 0 },
      total_tokens: 3675,
    };
    const rawEvents = [
      ...["first", "second"].map((id) => ({ type: "response.output_item.done", item: {
        id, type: "image_generation_call", result: "UklGRgAAAABXRUJQ",
        size: "1037x1516", quality: "medium", background: "opaque", output_format: "webp",
      } })),
      { type: "response.completed", response: {
        id: "r", model: "gpt-6-luna",
        ...(withDriverUsage ? { usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } : {}),
        tool_usage: { image_gen: imageUsage },
        tools: [{ type: "image_generation", model: "gpt-image-2-codex", quality: "auto", size: "auto", background: "auto", output_format: "webp", n: 1 }],
      } },
    ];
    const d = dispatcher((options) => {
      expect(buildOpenAIResponsesRequest(options).tools).toEqual([{
        type: "image_generation", quality: "high", size: "1024x1536", output_format: "webp",
      }]);
      return events(...rawEvents.map(normalizeOpenAIEvent).filter((event): event is OpenAINormalizedEvent => event !== undefined));
    });
    await d.onTokenAdded(1, "one", credentials);
    const result = await d.generate(request({ model: "gpt-6-luna", imageGeneration: true,
      imageGenerationOptions: { quality: "high", size: "1024x1536", outputFormat: "webp" },
    }));
    expect(result.usage).toMatchObject({
      inputTokens: withDriverUsage ? 10 : 0,
      outputTokens: withDriverUsage ? 3 : 0,
      totalTokens: withDriverUsage ? 13 : 0,
    });
    const generation = { route: "codex-responses", model: "gpt-image-2-codex", size: "1037x1516", quality: "medium", background: "opaque" };
    expect(result.images?.map((image) => image.generation)).toEqual([
      { ...generation, usage: imageUsage }, generation,
    ]);
  });

  it("registers only the internal image function and allows text-only replies", async () => {
    const run = vi.fn((options: OpenAIResponsesOptions) => {
      const body = buildOpenAIResponsesRequest(options);
      expect(options.imageGeneration).toBeUndefined();
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.instructions).toContain("self-contained prompt");
      expect(body.tools).toEqual([expect.objectContaining({
        type: "function", name: "generate_image", strict: false,
        parameters: {
          type: "object", additionalProperties: false,
          required: ["prompt", "transparent_background", "num_last_images_to_include"],
          properties: {
            prompt: expect.objectContaining({ type: "string", minLength: 1 }),
            transparent_background: { type: "boolean" },
            num_last_images_to_include: { type: "integer", minimum: 0, maximum: 5 },
          },
        },
      })]);
      return events({ type: "text-delta", text: "hello" }, { type: "completed", responseId: "r" });
    });
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    const result = await d.generate(request({ imageGeneration: "auto" }));
    expect(run).toHaveBeenCalledOnce();
    expect(result.text).toBe("hello");
    expect(result.images).toBeUndefined();
  });

  it.each(["zero-usage", "model-config"])("does not treat completed %s metadata as hosted image execution", async (metadata) => {
    const completed = normalizeOpenAIEvent({
      type: "response.completed",
      response: {
        id: "text-response", model: "gpt-6-luna",
        usage: { input_tokens: 164, output_tokens: 9, total_tokens: 173 },
        tools: metadata === "model-config"
          ? [{ type: "image_generation", model: "gpt-image-2-codex" }]
          : [{ type: "function", name: "generate_image" }],
        ...(metadata === "zero-usage" ? { tool_usage: { image_gen: {
          input_tokens: 0, output_tokens: 0, total_tokens: 0,
          input_tokens_details: { text_tokens: 0, image_tokens: 0 },
          output_tokens_details: { image_tokens: 0, text_tokens: 0 },
        } } } : {}),
        output: [{ type: "message" }],
      },
    });
    expect(completed).toMatchObject({ type: "completed", imageGeneration: { route: "codex-responses" } });
    const run = vi.fn(() => events({ type: "text-delta", text: "hello" }, completed!));
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    const result = await d.generate(request({ imageGeneration: "auto" }));
    expect(result).toMatchObject({ text: "hello", model: "gpt-6-luna", usage: { inputTokens: 164, outputTokens: 9, totalTokens: 173 } });
    expect(result.images).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([false, true])("runs a standalone image call (transparent: %s) and preserves driver and image usage", async (transparent) => {
    const calls: OpenAIResponsesOptions[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const item = { type: "function_call", call_id: "call", name: "generate_image", arguments: JSON.stringify({ prompt: "a complete new image prompt", transparent_background: transparent, num_last_images_to_include: 0 }) };
    const generation = {
      route: "codex-images" as const, model: "gpt-image-2", size: "1024x1024", quality: "medium",
      background: transparent ? "transparent" : "opaque",
      usage: { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 100, total_tokens: 120 },
    };
    const d = dispatcher((options, signal) => {
      calls.push(options); signals.push(signal);
      if (calls.length === 1) return events(
        { type: "output-item", item: { ...item, arguments: "" }, completed: false },
        { type: "output-item", item, completed: true },
        { type: "output-item", item, completed: true },
        { type: "completed", responseId: "driver", model: "actual-driver", usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1, totalTokens: 13 } },
      );
      return events({ type: "image", base64: "png", mimeType: "image/png", generation }, { type: "completed", responseId: "image", model: "gpt-image-2", usage: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 1998 } });
    });
    await d.onTokenAdded(1, "one", credentials);
    const history = [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/ref.png" }] }];
    const result = await d.generate(request({ imageGeneration: "auto", systemPrompt: "system", coldHistory: history, imageGenerationOptions: { quality: "high", size: "1024x1536" } }));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.instructions).toContain("system");
    expect(calls[0]!.history[0]).toEqual(history[0]);
    expect(calls[1]).toEqual({
      model: "gpt-image-2", imageGeneration: { background: transparent ? "transparent" : "opaque", output_format: "png", quality: "high", size: "1024x1536" },
      history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "a complete new image prompt" }] }],
    });
    expect(buildStandaloneImageRequest(calls[1]!).url).toMatch(/\/images\/generations$/);
    expect(calls[1]!.tools).toBeUndefined();
    expect(calls[1]!.outputSchema).toBeUndefined();
    expect(signals[0]).toBe(signals[1]);
    expect(result).toMatchObject({ model: "actual-driver", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cachedInputTokens: 2, reasoningOutputTokens: 1 }, images: [{ generation }] });
    expect(d.clients.size).toBe(1);
  });

  it("edits with only the selected recent images in chronological order despite longer image history", async () => {
    const calls: OpenAIResponsesOptions[] = [];
    const history = [
      ...Array.from({ length: 6 }, (_, i) => ({ type: "message", role: "user", content: [{ type: "input_image", image_url: `https://example.com/${i}.png` }] })),
      { type: "image_generation_call", result: "UklGRgAAAABXRUJQ", output_format: "webp" },
      { type: "message", role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/last.png" } }] },
    ];
    const d = dispatcher((options) => {
      calls.push(options);
      if (calls.length === 1) return events(
        { type: "output-item", completed: true, item: { type: "function_call", call_id: "edit", name: "generate_image", arguments: JSON.stringify({ prompt: "combine these references", transparent_background: false, num_last_images_to_include: 3 }) } },
        { type: "completed", responseId: "driver" },
      );
      return events({ type: "image", base64: "png", mimeType: "image/png" }, { type: "completed", responseId: "image" });
    });
    await d.onTokenAdded(1, "one", credentials);
    await d.generate(request({ imageGeneration: "auto", coldHistory: history, coldInput: [{ type: "image", url: "https://example.com/current.png" }] }));
    expect(calls[0]!.history).toHaveLength(history.length + 1);
    const direct = buildStandaloneImageRequest(calls[1]!);
    expect(direct.url).toMatch(/\/images\/edits$/);
    expect(direct.body.prompt).toBe("user:\ncombine these references");
    expect(direct.body.images).toEqual([
      { image_url: "data:image/webp;base64,UklGRgAAAABXRUJQ" },
      { image_url: "https://example.com/last.png" },
      { image_url: "https://example.com/current.png" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("rejects incomplete, invalid, multiple and mixed automatic image calls before standalone execution", async () => {
    const args = { prompt: "remove background", transparent_background: true, num_last_images_to_include: 0 };
    const item = { type: "function_call", call_id: "call", name: "generate_image", arguments: JSON.stringify(args) };
    const done = { type: "output-item" as const, item, completed: true };
    const badEvents: OpenAINormalizedEvent[][] = [
      [{ ...done, completed: false }],
      ...[
        "{", "[]", "null", JSON.stringify({ prompt: "x" }),
        JSON.stringify({ ...args, extra: true }),
        JSON.stringify({ ...args, prompt: " " }),
        JSON.stringify({ ...args, transparent_background: "true" }),
        ...[-1, 0.5, 6, "1"].map((count) => JSON.stringify({ ...args, num_last_images_to_include: count })),
        // Valid count, but this conversation has no images.
        JSON.stringify({ ...args, num_last_images_to_include: 1 }),
      ].map((arguments_) => [{ ...done, item: { ...item, arguments: arguments_ } }]),
      [done, { ...done, item: { ...item, call_id: "second" } }],
      [done, { ...done, item: { ...item, arguments: JSON.stringify({ ...args, transparent_background: false }) } }],
      [{ ...done, item: { ...item, call_id: "" } }],
      [{ ...done, item: { ...item, name: "unexpected" } }],
      [done, { type: "image", base64: "png", mimeType: "image/png" }],
      [{ type: "output-item", item: { type: "image_generation_call" }, completed: false }],
      [{ type: "completed", responseId: "native", imageGeneration: { route: "codex-responses", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } }],
    ];
    for (const stream of badEvents) {
      const run = vi.fn(() => events(...stream, { type: "completed", responseId: "driver" }));
      const d = dispatcher(run);
      await d.onTokenAdded(1, "one", credentials);
      await expect(d.generate(request({ imageGeneration: "auto" }))).rejects.toMatchObject({ kind: "incomplete" });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("requires driver completion before running its image call", async () => {
    const run = vi.fn(() => events({ type: "output-item", completed: true, item: {
      type: "function_call", call_id: "call", name: "generate_image",
      arguments: JSON.stringify({ prompt: "draw", transparent_background: false, num_last_images_to_include: 0 }),
    } }));
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.generate(request({ imageGeneration: "auto" }))).rejects.toMatchObject({ kind: "incomplete" });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(["jpeg", "webp"] as const)("rejects automatic %s output before driver transport", async (outputFormat) => {
    const run = vi.fn(() => events());
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.generate(request({ imageGeneration: "auto", imageGenerationOptions: { outputFormat } }))).rejects.toMatchObject({ kind: "gate", message: expect.stringContaining("PNG") });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects structured output in auto mode before transport", async () => {
    const run = vi.fn(() => events());
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.generate(request({ imageGeneration: "auto", outputSchema: { type: "object" } }))).rejects.toMatchObject({ kind: "gate" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["missing-image", "missing-completion", "cancel", "error", "network", "references"])("keeps completed driver accounting after standalone %s", async (failure) => {
    const controller = new AbortController();
    const networkError = new TypeError("fetch failed", { cause: new Error("connection reset") });
    let count = 0;
    const d = dispatcher(async function* (_options, signal) {
      count++;
      if (count === 1) {
        yield { type: "text-delta", text: "I will draw it." };
        yield { type: "output-item", completed: true, item: { type: "function_call", call_id: "call", name: "generate_image", arguments: JSON.stringify({ prompt: "transparent", transparent_background: true, num_last_images_to_include: failure === "references" ? 1 : 0 }) } };
        yield { type: "completed", responseId: "driver", model: "gpt-6-luna", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, reasoningTokens: 5, totalTokens: 120 } };
      } else {
        if (failure === "cancel") { controller.abort(); expect(signal?.aborted).toBe(true); throw signal!.reason; }
        if (failure === "network") throw networkError;
        if (failure === "error") { yield { type: "error", error: new Error("image failed") }; return; }
        if (failure === "missing-image") yield { type: "completed", responseId: "image" };
        else yield { type: "image", base64: "png", mimeType: "image/png" };
      }
    });
    await d.onTokenAdded(1, "one", credentials);
    const error = await d.generate(request({ imageGeneration: "auto", abortSignal: controller.signal })).catch((error) => error);
    expect(error).toMatchObject({
      kind: "incomplete",
      name: failure === "cancel" ? "AbortError" : failure === "network" ? "TypeError" : "ImageGenerationError",
      completedDriver: {
        text: "I will draw it.", tokenName: "one", model: "gpt-6-luna", requestedModel: "gpt-test",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, reasoningOutputTokens: 5, totalTokens: 120 },
        durationMs: expect.any(Number), ttftMs: expect.any(Number),
      },
    });
    expect(error.completedDriver.images).toBeUndefined();
    if (failure === "network") {
      expect(error.message).toBe(networkError.message);
      expect(error.cause).toBe(networkError);
      expect(error.cause.cause.message).toBe("connection reset");
    }
    expect(count).toBe(failure === "references" ? 1 : 2);
  });

  it("does not start standalone generation after cancellation", async () => {
    const controller = new AbortController();
    const run = vi.fn(async function* () {
      yield { type: "output-item" as const, completed: true, item: { type: "function_call", call_id: "call", name: "generate_image", arguments: '{"prompt":"transparent","transparent_background":true,"num_last_images_to_include":0}' } };
      yield { type: "completed" as const, responseId: "driver" };
      controller.abort();
    });
    const d = dispatcher(run);
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.generate(request({ imageGeneration: "auto", abortSignal: controller.signal }))).rejects.toMatchObject({ name: "AbortError", completedDriver: { tokenName: "one" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["incomplete-driver", "direct-image", "plain-text"])("does not invent completed driver accounting for %s", async (path) => {
    const failure = new Error("generation failed");
    const d = dispatcher(async function* () {
      if (path === "incomplete-driver") yield { type: "output-item", completed: true, item: {
        type: "function_call", call_id: "call", name: "generate_image", arguments: '{"prompt":"draw","transparent_background":false,"num_last_images_to_include":0}',
      } };
      else yield { type: "completed", responseId: "response" };
      throw failure;
    });
    await d.onTokenAdded(1, "one", credentials);
    const error = await d.generate(request({
      imageGeneration: path === "incomplete-driver" ? "auto" : path === "direct-image" ? true : undefined,
      model: path === "direct-image" ? "gpt-image-2" : "gpt-6-luna",
    })).catch((error) => error);
    expect(error).toBe(failure);
    expect(error.completedDriver).toBeUndefined();
  });

  it("maps images and preserves image failure classifications", async () => {
    const success = dispatcher(() =>
      events(
        { type: "image", id: "i", base64: "png", mimeType: "image/png" },
        { type: "completed", responseId: "r" },
      ),
    );
    await success.onTokenAdded(1, "one", credentials);
    await expect(success.generate(request({ imageGeneration: true }))).resolves.toMatchObject({
      images: [{ data: "png" }],
    });

    const notCalled = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await notCalled.onTokenAdded(1, "one", credentials);
    await expect(notCalled.generate(request({ imageGeneration: true }))).rejects.toMatchObject({
      kind: "not_called",
    });
    await expect(
      notCalled.generateStream(request({ imageGeneration: true }), {
        onDelta: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      }),
    ).rejects.toEqual(expect.any(ImageGenerationError));
  });

  it("uses weighted routing, while preferred affinity does not advance weighted state", async () => {
    const names: string[] = [];
    const d = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await d.onTokenAdded(1, "one", credentials, null, 1);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, null, 2);
    for (let i = 0; i < 6; i++) names.push((await d.generate(request())).tokenName);
    expect(names.filter((n) => n === "two")).toHaveLength(4);
    expect((await d.generate(request({ preferredTokenId: 1 }))).tokenName).toBe("one");
    expect((await d.generate(request())).tokenName).toBe("two");
  });

  it("required preferred token 이 없으면 다른 토큰으로 대체하지 않는다", async () => {
    const d = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await d.onTokenAdded(1, "one", credentials);

    await expect(
      d.generate(request({ preferredTokenId: 99, requirePreferredToken: true })),
    ).rejects.toThrow("Preferred openai token 99 is not available");
  });

  it("required preferred token 이 threshold 를 넘으면 eligible 토큰으로 대체하지 않는다", async () => {
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: () => events({ type: "completed", responseId: "r" }) }),
      fetch: async () =>
        new Response(
          JSON.stringify({ rate_limits: { primary_window: { used_percent: 90 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await d.onTokenAdded(1, "one", credentials, null);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, 80);

    const error = await d
      .generate(request({ preferredTokenId: 2, requirePreferredToken: true }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(QuotaThresholdExceededError);
    expect(error.message).toContain("two (threshold 80%)");
  });

  it("runs concurrent requests without queueing and tracks in-flight counts", async () => {
    const releases: Array<() => void> = [];
    const d = dispatcher(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => releases.push(resolve));
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);

    // 동시성 상한이 없다: 토큰 하나에 세 요청이 즉시 모두 시작된다.
    const first = d.generate(request());
    const second = d.generate(request());
    const third = d.generate(request());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(d.inFlight).toBe(3);

    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second, third]);
    expect(d.inFlight).toBe(0);
  });

  it("aborts active transport work through the caller signal", async () => {
    const d = dispatcher((_options, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);
    const controller = new AbortController();
    const pending = d.generate(request({ abortSignal: controller.signal }));
    await tickTimer();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(d.inFlight).toBe(0);
  });

  it("rechecks abort after delayed quota selection and does not start the request", async () => {
    let releaseQuota!: () => void;
    const started = vi.fn(() => events({ type: "completed", responseId: "r" }));
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: started }),
      fetch: async () => {
        await new Promise<void>((resolve) => (releaseQuota = resolve));
        return new Response(
          JSON.stringify({
            rate_limits: { primary_window: { used_percent: 1 } },
          }),
          { status: 200 },
        );
      },
    });
    await d.onTokenAdded(1, "one", credentials, 80);
    const controller = new AbortController();
    const pending = d.generate(request({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(releaseQuota).toBeTypeOf("function"));
    controller.abort();
    releaseQuota();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(started).not.toHaveBeenCalled();
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "one" });
  });

  it("enforces timeout during an active response stream", async () => {
    let calls = 0;
    const d = dispatcher((_options, signal) => ({
      async *[Symbol.asyncIterator]() {
        calls++;
        if (calls === 1) {
          await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.generate(request({ timeoutMs: 5 }))).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "one" });
  });

  it("applies credential metadata updates while requests are active", async () => {
    let release!: () => void;
    let call = 0;
    const d = dispatcher(() => ({
      async *[Symbol.asyncIterator]() {
        call++;
        if (call === 1) await new Promise<void>((resolve) => (release = resolve));
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "old", credentials);
    const active = d.generate(request());
    await vi.waitFor(() => expect(call).toBe(1));
    await d.onTokenUpdated(1, "new", { ...credentials, accessToken: "replacement" });
    release();
    await active;
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "new" });
  });

  it("retires a replaced client only after its in-flight requests finish", async () => {
    let release!: () => void;
    let call = 0;
    const close = vi.fn();
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({
        responses: () => ({
          async *[Symbol.asyncIterator]() {
            call++;
            if (call === 1) await new Promise<void>((resolve) => (release = resolve));
            yield { type: "completed", responseId: "r" } as const;
          },
        }),
        close,
      }),
    });
    await d.onTokenAdded(1, "old", credentials);
    const active = d.generate(request());
    await vi.waitFor(() => expect(call).toBe(1));

    await d.onTokenUpdated(1, "new", { ...credentials, accessToken: "replacement" });
    // 세대 교체는 새 요청이 새 client 를 만들 뿐, 진행 중인 client 를 끊지 않는다.
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "new" });
    expect(close).not.toHaveBeenCalled();

    release();
    await expect(active).resolves.toMatchObject({ tokenName: "new" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cancels a hung quota lookup when the caller aborts", async () => {
    const started = vi.fn(() => events({ type: "completed", responseId: "r" }));
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: started }),
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    await d.onTokenAdded(1, "one", credentials, 80);
    const controller = new AbortController();
    const pending = d.generate(request({ abortSignal: controller.signal }));
    await tickTimer();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(started).not.toHaveBeenCalled();
  });

  it("routes past an over-threshold token instead of treating it as capacity", async () => {
    const names: string[] = [];
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: () => events({ type: "completed", responseId: "r" }) }),
      fetch: async () =>
        new Response(
          JSON.stringify({ rate_limits: { primary_window: { used_percent: 90 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    // one: threshold 없음(항상 eligible), two: threshold 초과 → 항상 one 으로 라우팅된다.
    await d.onTokenAdded(1, "one", credentials, null);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, 80);
    for (let i = 0; i < 4; i++) names.push((await d.generate(request())).tokenName);
    expect(names).toEqual(["one", "one", "one", "one"]);
  });

  it("fails quota lookup open, gates all exceeded tokens, and recovers after lifecycle update", async () => {
    const completeClient = () => ({
      responses: () => events({ type: "completed", responseId: "r" }),
    });
    const failOpen = new OpenAIDispatcher(config(), {
      clientFactory: completeClient,
      fetch: async () => new Response("down", { status: 503 }),
    });
    await failOpen.onTokenAdded(1, "one", credentials, 80);
    await expect(failOpen.generate(request())).resolves.toMatchObject({ tokenName: "one" });

    const blocked = new OpenAIDispatcher(config(), {
      clientFactory: completeClient,
      fetch: async () =>
        new Response(
          JSON.stringify({
            rate_limits: {
              limit_id: "codex",
              primary_window: { used_percent: 90, window_minutes: 300, reset_at: 123 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await blocked.onTokenAdded(1, "one", credentials, 80);
    await expect(blocked.generate(request())).rejects.toBeInstanceOf(Error);
    await blocked.onTokenUpdated(1, "one", credentials, null, 1);
    await expect(blocked.generate(request())).resolves.toMatchObject({ tokenName: "one" });
    blocked.onTokenDeactivated(1);
    await expect(blocked.generate(request())).rejects.toThrow("NO_OPENAI_WORKERS");
  });
});

describe("effort 어휘 해석 (Codex 카탈로그 기준)", () => {
  async function mappedEffortFor(model: string, effort: string): Promise<unknown> {
    let mapped: OpenAIResponsesOptions | undefined;
    const d = dispatcher((options) => {
      mapped = options;
      return events({ type: "completed", responseId: "r1" });
    });
    await d.onTokenAdded(7, "primary", credentials, null, 1);
    await d.generate(request({ model, effort }));
    return mapped?.reasoning?.effort;
  }

  it("모델이 지원하는 값은 그대로 보내고, 상한 초과·공개 API 어휘는 reasoning 에서 빼 백엔드 기본값을 쓴다", async () => {
    await expect(mappedEffortFor("gpt-6-astra", "ultra")).resolves.toBe("ultra");
    await expect(mappedEffortFor("gpt-6.1-sol", "ultra")).resolves.toBe("ultra");
    await expect(mappedEffortFor("gpt-6-sol", "ultra")).resolves.toBe("ultra");
    await expect(mappedEffortFor("gpt-6-luna", "max")).resolves.toBe("max");
    await expect(mappedEffortFor("gpt-6-luna", "ultra")).resolves.toBeUndefined();
    await expect(mappedEffortFor("gpt-5.6-terra", "ultra")).resolves.toBe("ultra");
    await expect(mappedEffortFor("gpt-5.5", "xhigh")).resolves.toBe("xhigh");
    await expect(mappedEffortFor("gpt-5.5", "max")).resolves.toBeUndefined();
    await expect(mappedEffortFor("gpt-5.6-terra", "minimal")).resolves.toBeUndefined();
  });
});
