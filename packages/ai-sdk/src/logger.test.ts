import { generateText, isStepCount, Output, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createQgridLogger } from "./logger";

const SERVER = "http://localhost:44900";

type Logged = Record<string, unknown>;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Stubs the qgrid logging endpoints. Each createRun gets the next request-log ID.
function mockQgridServer() {
  const calls: Array<{ path: string; input: Logged }> = [];
  let nextRequestLogId = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace("/api/qgrid/", "");
      calls.push({ path, input: JSON.parse(String(init?.body)).input });
      if (path === "createRun") return json({ requestLogId: nextRequestLogId++ });
      return json({ stepId: 1, ok: true });
    }),
  );
  const inputs = (path: string) => calls.filter((c) => c.path === path).map((c) => c.input);
  return {
    calls,
    createRuns: () => inputs("createRun"),
    steps: () => inputs("appendStep"),
    finishes: () => inputs("finishRun"),
  };
}

function usage(input: number, output: number, reasoning = 0) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output - reasoning, reasoning },
  };
}

const stop = { unified: "stop", raw: "stop" } as const;
const toolCalls = { unified: "tool-calls", raw: "tool_calls" } as const;

function textModel(text = "Hi there", provider = "google.generative-ai", modelId = "gemini-3-flash") {
  return new MockLanguageModelV3({
    provider,
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: stop,
      usage: usage(100, 50),
      response: { modelId: `${modelId}-001` },
      warnings: [],
    }),
  });
}

// Step 0 calls getWeather; step 1 answers.
function weatherModel() {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "google.generative-ai",
    modelId: "gemini-3-flash",
    doGenerate: async () =>
      step++ === 0
        ? {
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "getWeather",
                input: JSON.stringify({ city: "Seoul" }),
              },
            ],
            finishReason: toolCalls,
            usage: usage(200, 30),
            response: { modelId: "gemini-3-flash-001" },
            warnings: [],
          }
        : {
            content: [{ type: "text", text: "Seoul is 22°C" }],
            finishReason: stop,
            usage: usage(400, 80),
            response: { modelId: "gemini-3-flash-001" },
            warnings: [],
          },
  });
}

// Never answers until aborted.
function hangingModel() {
  return new MockLanguageModelV3({
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => {
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
      }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createQgridLogger", () => {
  it("logs a text generation as one run", async () => {
    const server = mockQgridServer();

    const result = await generateText({
      model: textModel(),
      instructions: "You are helpful",
      prompt: "Hello",
      telemetry: createQgridLogger({ serverUrl: SERVER, projectName: "test" }),
    });

    expect(result.text).toBe("Hi there");
    expect(server.createRuns()).toEqual([
      expect.objectContaining({
        userPrompt: "Hello",
        systemPrompt: "You are helpful",
        modelName: "google/gemini-3-flash",
        projectName: "test",
        isStructured: false,
        jsonSchema: null,
      }),
    ]);
    expect(server.createRuns()[0]).not.toHaveProperty("history");
    expect(server.steps()).toEqual([
      expect.objectContaining({
        requestLogId: 1,
        stepIndex: 0,
        type: "generate",
        finishReason: "stop",
        modelName: "google/gemini-3-flash-001",
        requestedModelName: "google/gemini-3-flash",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ]);
    expect(server.finishes()).toEqual([
      expect.objectContaining({
        requestLogId: 1,
        status: "succeeded",
        response: "Hi there",
        tokenName: "external",
        modelName: "google/gemini-3-flash-001",
        requestedModelName: "google/gemini-3-flash",
        totalInputTokens: 100,
        totalOutputTokens: 50,
      }),
    ]);
    expect(server.finishes()[0]).not.toHaveProperty("responseJsonOk");
  });

  it("logs the Output.object schema and response validity", async () => {
    const server = mockQgridServer();

    await generateText({
      model: textModel('{"answer":"integrated"}', "google", "gemini-3.5-flash-lite"),
      prompt: "Return an answer object",
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
      telemetry: createQgridLogger({ serverUrl: SERVER, projectName: "structured" }),
    });

    const [createInput] = server.createRuns();
    expect(createInput).toMatchObject({ isStructured: true, projectName: "structured" });
    expect(JSON.parse(String(createInput?.jsonSchema))).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    });
    expect(server.finishes()).toEqual([
      expect.objectContaining({
        status: "succeeded",
        response: '{"answer":"integrated"}',
        responseJsonOk: true,
      }),
    ]);
  });

  it("logs a multi-step tool run with tool result and duration", async () => {
    const server = mockQgridServer();

    await generateText({
      model: weatherModel(),
      prompt: "Weather in Seoul",
      tools: {
        getWeather: tool({
          inputSchema: z.object({ city: z.string() }),
          execute: async () => ({ temperature: 22 }),
        }),
      },
      stopWhen: isStepCount(3),
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    expect(server.steps().map((s) => [s.type, s.stepIndex])).toEqual([
      ["generate", 0],
      ["tool_call", 0],
      ["generate", 1],
    ]);
    expect(server.steps()[1]).toMatchObject({
      toolCallIndex: 0,
      toolCallId: "call_1",
      toolName: "getWeather",
      toolArgs: '{"city":"Seoul"}',
      toolResult: '{"temperature":22}',
      toolDurationMs: expect.any(Number),
      modelName: "google/gemini-3-flash-001",
      requestedModelName: "google/gemini-3-flash",
    });
    expect(server.finishes()).toEqual([
      expect.objectContaining({
        status: "succeeded",
        response: "Seoul is 22°C",
        totalInputTokens: 600,
        totalOutputTokens: 110,
      }),
    ]);
  });

  it("logs a failed tool execution as a tool_call step with its error", async () => {
    const server = mockQgridServer();

    await generateText({
      model: weatherModel(),
      prompt: "Weather in Seoul",
      tools: {
        getWeather: tool({
          inputSchema: z.object({ city: z.string() }),
          execute: async (): Promise<{ temperature: number }> => {
            throw new Error("weather service down");
          },
        }),
      },
      stopWhen: isStepCount(3),
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    const toolStep = server.steps().find((s) => s.type === "tool_call");
    expect(toolStep).toMatchObject({ toolName: "getWeather" });
    expect(String(toolStep?.error)).toContain("weather service down");
    expect(toolStep).not.toHaveProperty("toolResult");
    expect(server.finishes()).toEqual([expect.objectContaining({ status: "succeeded" })]);
  });

  it("logs an unresolved client-side tool call when the run finishes", async () => {
    const server = mockQgridServer();

    await generateText({
      model: weatherModel(),
      prompt: "Weather in Seoul",
      tools: { getWeather: tool({ inputSchema: z.object({ city: z.string() }) }) },
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    expect(server.steps().map((s) => s.type)).toEqual(["generate", "tool_call"]);
    expect(server.steps()[1]).toMatchObject({
      stepIndex: 0,
      toolName: "getWeather",
      toolArgs: '{"city":"Seoul"}',
    });
    expect(server.steps()[1]).not.toHaveProperty("toolResult");
    expect(server.finishes()).toEqual([expect.objectContaining({ status: "succeeded" })]);
  });

  it("logs step reasoning text and reasoning tokens", async () => {
    const server = mockQgridServer();
    const model = new MockLanguageModelV3({
      provider: "openai.responses",
      modelId: "gpt-5.4",
      doGenerate: async () => ({
        content: [
          { type: "reasoning", text: "Need a concise answer." },
          { type: "text", text: "ok" },
        ],
        finishReason: stop,
        usage: usage(10, 20, 7),
        warnings: [],
      }),
    });

    await generateText({
      model,
      prompt: "Think briefly",
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    expect(server.steps()[0]).toMatchObject({
      type: "generate",
      reasoningText: "Need a concise answer.",
      reasoningTokens: 7,
    });
  });

  it("logs the last user message as the prompt and earlier user/assistant text as history", async () => {
    const server = mockQgridServer();

    await generateText({
      model: textModel(),
      allowSystemInMessages: true,
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "tool-call", toolCallId: "call_1", toolName: "getX", input: { id: 1 } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "getX",
              output: { type: "text", value: "x" },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "follow-up" }] },
      ],
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    const [createInput] = server.createRuns();
    expect(createInput?.userPrompt).toBe("follow-up");
    expect(JSON.parse(String(createInput?.history))).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ]);
  });

  it.each([
    {
      provider: "openai.responses",
      requestedModelId: "gpt-5.4",
      servedModelId: "openai/gpt-5.4-2026-06-01",
      requestedModelName: "openai/gpt-5.4",
      modelName: "openai/gpt-5.4-2026-06-01",
    },
    {
      provider: "anthropic.messages",
      requestedModelId: "anthropic/claude-sonnet-4-7",
      servedModelId: "claude-sonnet-4-7-20260715",
      requestedModelName: "anthropic/claude-sonnet-4-7",
      modelName: "anthropic/claude-sonnet-4-7-20260715",
    },
  ])("canonicalizes the $provider telemetry provider prefix", async (names) => {
    const server = mockQgridServer();
    const model = new MockLanguageModelV3({
      provider: names.provider,
      modelId: names.requestedModelId,
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: stop,
        usage: usage(1, 1),
        response: { modelId: names.servedModelId },
        warnings: [],
      }),
    });

    await generateText({ model, prompt: "test", telemetry: createQgridLogger({ serverUrl: SERVER }) });

    expect(server.createRuns()[0]?.modelName).toBe(names.requestedModelName);
    expect(server.finishes()[0]).toMatchObject({
      modelName: names.modelName,
      requestedModelName: names.requestedModelName,
    });
  });

  it("does not log qgrid provider calls, which the qgrid server logs itself", async () => {
    const server = mockQgridServer();

    await generateText({
      model: textModel("ok", "qgrid", "openai/gpt-6-sol"),
      prompt: "test",
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    expect(server.calls).toEqual([]);
  });

  it("does not log a generation with providerOptions.qgrid.logger false", async () => {
    const server = mockQgridServer();

    const result = await generateText({
      model: textModel("not logged"),
      prompt: "private request",
      providerOptions: { qgrid: { logger: false } },
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });

    expect(result.text).toBe("not logged");
    expect(server.calls).toEqual([]);
  });

  it("reports a createRun failure once and keeps the generation running", async () => {
    const errors: Error[] = [];
    const fetchMock = vi.fn(async () => {
      throw new Error("server down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateText({
      model: weatherModel(),
      prompt: "Weather in Seoul",
      tools: {
        getWeather: tool({
          inputSchema: z.object({ city: z.string() }),
          execute: async () => ({ temperature: 22 }),
        }),
      },
      stopWhen: isStepCount(3),
      telemetry: createQgridLogger({ serverUrl: SERVER, onLogError: (e) => errors.push(e) }),
    });

    expect(result.text).toBe("Seoul is 22°C");
    expect(errors.map((e) => e.message)).toEqual(["server down"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("finishes the run as error when the provider fails", async () => {
    const server = mockQgridServer();
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("LLM failed");
      },
    });

    await expect(
      generateText({
        model,
        prompt: "test",
        maxRetries: 0,
        telemetry: createQgridLogger({ serverUrl: SERVER }),
      }),
    ).rejects.toThrow("LLM failed");

    expect(server.finishes()).toEqual([
      expect.objectContaining({ status: "error", errorMessage: "Error: LLM failed" }),
    ]);
  });

  it("finishes the run as aborted when generateText is cancelled", async () => {
    const server = mockQgridServer();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      generateText({
        model: hangingModel(),
        prompt: "test",
        abortSignal: controller.signal,
        telemetry: createQgridLogger({ serverUrl: SERVER }),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(server.finishes()).toEqual([
      expect.objectContaining({
        status: "aborted",
        errorMessage: expect.stringContaining("AbortError"),
      }),
    ]);
  });

  it("logs a consumed streamText generation", async () => {
    const server = mockQgridServer();
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "1" });
            controller.enqueue({ type: "text-delta", id: "1", delta: "streamed" });
            controller.enqueue({ type: "text-end", id: "1" });
            controller.enqueue({ type: "finish", finishReason: stop, usage: usage(5, 3) });
            controller.close();
          },
        }),
      }),
    });

    const result = streamText({
      model,
      prompt: "stream",
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });
    await result.consumeStream();

    await vi.waitFor(() =>
      expect(server.finishes()).toEqual([
        expect.objectContaining({
          status: "succeeded",
          response: "streamed",
          totalInputTokens: 5,
          totalOutputTokens: 3,
        }),
      ]),
    );
    expect(server.steps()).toEqual([expect.objectContaining({ type: "generate", stepIndex: 0 })]);
  });

  it("finishes the run as error when the stream emits an error part", async () => {
    const server = mockQgridServer();
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "error", error: new Error("stream boom") });
            controller.close();
          },
        }),
      }),
    });

    const result = streamText({
      model,
      prompt: "stream",
      onError: () => {},
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });
    await result.consumeStream();

    await vi.waitFor(() =>
      expect(server.finishes()).toEqual([expect.objectContaining({ status: "error" })]),
    );
  });

  it("finishes the run as aborted when streamText is cancelled", async () => {
    const server = mockQgridServer();
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(stream) {
            stream.enqueue({ type: "text-start", id: "1" });
            stream.enqueue({ type: "text-delta", id: "1", delta: "partial" });
          },
        }),
      }),
    });

    const result = streamText({
      model,
      prompt: "stream",
      abortSignal: controller.signal,
      telemetry: createQgridLogger({ serverUrl: SERVER }),
    });
    setTimeout(() => controller.abort(), 20);
    await result.consumeStream();

    await vi.waitFor(() =>
      expect(server.finishes()).toEqual([expect.objectContaining({ status: "aborted" })]),
    );
  });

  it("logs concurrent calls through one logger as separate runs", async () => {
    const server = mockQgridServer();
    const telemetry = createQgridLogger({ serverUrl: SERVER });

    await Promise.all([
      generateText({ model: textModel("first"), prompt: "a", telemetry }),
      generateText({ model: textModel("second"), prompt: "b", telemetry }),
    ]);

    const finishes = server.finishes();
    expect(finishes).toHaveLength(2);
    expect(new Set(finishes.map((f) => f.requestLogId))).toEqual(new Set([1, 2]));
    const responseByRun = new Map(finishes.map((f) => [f.requestLogId, f.response]));
    const promptByRun = new Map(server.createRuns().map((c, i) => [i + 1, c.userPrompt]));
    expect(responseByRun.get(1)).toBe(promptByRun.get(1) === "a" ? "first" : "second");
    expect(server.steps().map((s) => s.requestLogId).sort()).toEqual([1, 2]);
  });

  it("finishes a run that never reports a terminal event once, after the stale-run timeout", async () => {
    const server = mockQgridServer();
    const controller = new AbortController();

    const generation = generateText({
      model: hangingModel(),
      prompt: "test",
      abortSignal: controller.signal,
      telemetry: createQgridLogger({ serverUrl: SERVER, staleRunTimeoutMs: 50 }),
    }).catch(() => undefined);

    await vi.waitFor(() =>
      expect(server.finishes()).toEqual([
        expect.objectContaining({ status: "error", errorMessage: expect.stringContaining("stale-run") }),
      ]),
    );

    controller.abort();
    await generation;
    expect(server.finishes()).toHaveLength(1);
  });

  it("uses the configured tokenName", async () => {
    const server = mockQgridServer();

    await generateText({
      model: textModel(),
      prompt: "test",
      telemetry: createQgridLogger({ serverUrl: SERVER, tokenName: "my-custom-token" }),
    });

    expect(server.finishes()[0]?.tokenName).toBe("my-custom-token");
  });
});
