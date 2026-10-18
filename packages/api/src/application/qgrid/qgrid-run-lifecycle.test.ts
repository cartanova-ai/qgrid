import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  afterQuery,
  beforeQuery,
  finishRunAborted,
  finishRunWithError,
} from "./qgrid-run-lifecycle";
import { type QueryOutput } from "./qgrid.types";

const {
  appendStepMock,
  aggregateStepUsageMock,
  finishRunMock,
  createRunMock,
  expireStaleToolWaitingRunsMock,
  continueToolRunMock,
} = vi.hoisted(() => ({
  appendStepMock: vi.fn(),
  aggregateStepUsageMock: vi.fn(),
  finishRunMock: vi.fn(),
  createRunMock: vi.fn(),
  expireStaleToolWaitingRunsMock: vi.fn(),
  continueToolRunMock: vi.fn(),
}));

vi.mock("../request-log/request-log.model", () => ({
  RequestLogModel: {
    appendStep: appendStepMock,
    aggregateStepUsage: aggregateStepUsageMock,
    finishRun: finishRunMock,
    createRun: createRunMock,
    expireStaleToolWaitingRuns: expireStaleToolWaitingRunsMock,
    continueToolRun: continueToolRunMock,
  },
}));

function queryOutput(overrides: Partial<QueryOutput> = {}): QueryOutput {
  return {
    text: "hello",
    content: [],
    finishReason: "stop",
    tokenName: "tok-A",
    model: "gpt-5-codex",
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    durationMs: 120,
    ttftMs: 39,
    costUsd: 0.001,
    costSource: "pricing_table",
    ...overrides,
  };
}

let lifecycleNow = Date.now();

describe("qgrid run lifecycle start", () => {
  beforeEach(() => {
    lifecycleNow += 60_001;
    vi.spyOn(Date, "now").mockReturnValue(lifecycleNow);
    createRunMock.mockReset().mockResolvedValue(10);
    expireStaleToolWaitingRunsMock.mockReset().mockResolvedValue([]);
    continueToolRunMock.mockReset().mockResolvedValue(3);
    aggregateStepUsageMock.mockReset().mockResolvedValue({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 0,
      fallback_count: 0,
      cost_usd: 0,
    });
    finishRunMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a running parent with the full requested model before an initial query", async () => {
    const history = JSON.stringify([
      { type: "message", role: "user", content: "earlier" },
      { type: "message", role: "system", content: "hidden" },
      { type: "tool-result", output: "ignored" },
    ]);

    await expect(
      beforeQuery({
        prompt: "hi",
        system: "system",
        model: "openai/gpt-5-codex",
        projectName: "project",
        history,
      }),
    ).resolves.toEqual({ requestLogId: 10, stepIndex: 0 });

    expect(createRunMock).toHaveBeenCalledWith({
      user_prompt: "hi",
      system_prompt: "system",
      requested_model_name: "openai/gpt-5-codex",
      effort: undefined,
      service_tier: undefined,
      project_name: "project",
      history: [{ type: "message", role: "user", content: "earlier" }],
      is_image_generation: undefined,
      json_schema: null,
    });
  });

  it.each([
    ["openai/gpt-6-sol", "fast", "fast"],
    ["openai/gpt-6-sol", "flex", "flex"],
    ["openai/gpt-6-sol", undefined, undefined],
    ["anthropic/claude-sonnet-5-5", "fast", undefined],
  ] as const)("logs service tier for %s with %s", async (model, serviceTier, expected) => {
    await beforeQuery({ prompt: "hi", model, serviceTier });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ service_tier: expected }));
  });

  it("logs current-turn input images on the run", async () => {
    await beforeQuery({
      prompt: "describe",
      model: "openai/gpt-6-sol",
      input: [
        { type: "text", text: "describe", text_elements: [] },
        { type: "image", url: "data:image/jpeg;base64,AQID" },
      ],
    });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({
      input_images: [{ mediaType: "image/jpeg", data: "AQID", byteSize: 3 }],
    }));
  });

  it.each([false, true, undefined])("does not log ignored effort when thinking is %s", async (thinking) => {
    await beforeQuery({ prompt: "hi", model: "openai/gpt-6-sol", thinking, effort: "high" });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({
      effort: thinking === false ? undefined : "high",
    }));
  });

  it.each([false, true])("classifies automatic image output only when produced (%s)", async (hasImage) => {
    const args = { prompt: "chat", model: "openai/gpt-6-astra", imageGeneration: "auto" as const };
    const run = await beforeQuery(args);
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ is_image_generation: false }));
    await afterQuery(run.requestLogId, run.stepIndex, args, queryOutput({
      content: hasImage ? [{ type: "image", data: "png" }] : [{ type: "text", text: "hello" }],
    }));
    const finish = finishRunMock.mock.calls[0]![1];
    expect(finish.is_image_generation).toBe(hasImage ? true : undefined);
    expect(finish.image_cost_method).toBe(hasImage ? "assumed:gpt-image-2:medium:1536x1024:png" : null);
  });

  it("stores attached tool definitions on the run and omits them when absent", async () => {
    const tools = [
      { name: "getWeather", description: "Get weather for a city", inputSchema: { type: "object" } },
      { name: "sendMail", inputSchema: { type: "object" } },
    ];

    await beforeQuery({ prompt: "hi", model: "openai/gpt-5-codex", tools });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ tools }));

    createRunMock.mockClear();
    await beforeQuery({ prompt: "hi", model: "openai/gpt-5-codex", tools: [] });
    expect(createRunMock).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined }));
  });

  it("continues an existing parent and completes tool results before the next step", async () => {
    const order: string[] = [];
    continueToolRunMock.mockImplementationOnce(async () => {
      order.push("continue-tool-run");
      return 3;
    });
    expireStaleToolWaitingRunsMock.mockImplementationOnce(async () => {
      order.push("cleanup-stale");
      return [77];
    });
    const args = {
      prompt: "continue",
      runContext: { requestLogId: 10 },
      toolResults: [{ toolCallId: "call-1", output: "sunny" }],
    };

    await expect(beforeQuery(args)).resolves.toEqual({ requestLogId: 10, stepIndex: 3 });

    expect(createRunMock).not.toHaveBeenCalled();
    expect(continueToolRunMock).toHaveBeenCalledWith(10, [
      { toolCallId: "call-1", output: "sunny" },
    ]);
    expect(order).toEqual(["continue-tool-run", "cleanup-stale"]);
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it("cleans up only stale unresolved tool-wait runs reported by the model", async () => {
    expireStaleToolWaitingRunsMock.mockResolvedValueOnce([77]);

    await beforeQuery({ prompt: "hi", model: "openai/gpt-5-codex" });

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledWith(
      30 * 60 * 1000,
      "tool-call run: no follow-up within 30 minutes",
    );
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it("throttles stale cleanup while still creating every requested run", async () => {
    await beforeQuery({ prompt: "one", model: "openai/gpt-5-codex" });
    await beforeQuery({ prompt: "two", model: "openai/gpt-5-codex" });

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight stale cleanup across concurrent requests", async () => {
    let resolveCleanup: ((ids: number[]) => void) | undefined;
    expireStaleToolWaitingRunsMock.mockReturnValueOnce(
      new Promise<number[]>((resolve) => {
        resolveCleanup = resolve;
      }),
    );

    const first = beforeQuery({ prompt: "one", model: "openai/gpt-5-codex" });
    await vi.waitFor(() => expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1));
    const second = beforeQuery({ prompt: "two", model: "openai/gpt-5-codex" });

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1);
    resolveCleanup?.([]);
    await Promise.all([first, second]);

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledTimes(2);
  });


});

describe("qgrid run lifecycle TTFT", () => {
  beforeEach(() => {
    appendStepMock.mockReset();
    aggregateStepUsageMock.mockReset();
    aggregateStepUsageMock.mockResolvedValue({
      input_tokens: 5,
      output_tokens: 7,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 120,
    });
    finishRunMock.mockReset();
  });

  it("appends generate step ttft_ms from QueryOutput", async () => {
    await afterQuery(10, 2, { prompt: "hi" }, queryOutput({ ttftMs: 44 }));

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 2,
        type: "generate",
        duration_ms: 120,
        ttft_ms: 44,
      }),
    );
  });

  it("preserves generate step ttft_ms zero when no first-token timing is available", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "hi" },
      queryOutput({ finishReason: "tool-calls", ttftMs: 0 }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        ttft_ms: 0,
      }),
    );
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it("does not pass ttft into finishRun params because the model derives the run value", async () => {
    await afterQuery(10, 2, { prompt: "hi" }, queryOutput({ ttftMs: 44 }));

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.not.objectContaining({
        ttft_ms: expect.anything(),
        ttftMs: expect.anything(),
      }),
    );
  });

  it.each(["fast", "flex", undefined] as const)("records the final turn service tier: %s", async (serviceTier) => {
    await afterQuery(10, 2, { prompt: "hi", model: "openai/gpt-6-sol", serviceTier }, queryOutput());
    expect(finishRunMock).toHaveBeenCalledWith(10, expect.objectContaining({
      service_tier: serviceTier ?? null,
    }));
  });

  it("persists an immediate structured final answer as JSON text", async () => {
    await afterQuery(
      10,
      0,
      {
        prompt: "answer",
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        jsonSchema: JSON.stringify({
          type: "object",
          properties: { result: { type: "string" } },
        }),
      },
      queryOutput({
        text: '{"result":"ok"}',
        content: [{ type: "text", text: '{"result":"ok"}' }],
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 0,
        type: "generate",
        finish_reason: "stop",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: "succeeded",
        response: '{"result":"ok"}',
      }),
    );
  });

  it("persists a tool turn and a structured final answer on the continued run", async () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { result: { type: "string" } },
    });
    const first = await afterQuery(
      10,
      0,
      { prompt: "lookup", tools: [{ name: "lookup", inputSchema: {} }], jsonSchema: schema },
      queryOutput({
        text: "",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: '{"key":"value"}',
          },
        ],
        finishReason: "tool-calls",
      }),
    );

    expect(first).toEqual({ runContext: { requestLogId: 10 } });
    expect(finishRunMock).not.toHaveBeenCalled();
    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 0,
        type: "tool_call",
        tool_call_id: "call-1",
      }),
    );

    await afterQuery(
      10,
      2,
      {
        prompt: "continue",
        tools: [{ name: "lookup", inputSchema: {} }],
        jsonSchema: schema,
        runContext: { requestLogId: 10 },
        toolResults: [{ toolCallId: "call-1", output: '{"value":"found"}' }],
      },
      queryOutput({
        text: '{"result":"found"}',
        content: [{ type: "text", text: '{"result":"found"}' }],
        finishReason: "stop",
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 2,
        type: "generate",
        finish_reason: "stop",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: "succeeded",
        response: '{"result":"found"}',
      }),
    );
  });

  it("finishes runs with image data-url img tags in response", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "draw", imageGeneration: true },
      queryOutput({
        text: "image ready",
        content: [
          { type: "text", text: "image ready" },
          { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" },
        ],
      }),
    );

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        response:
          'image ready\n<img src="data:image/png;base64,iVBORw0KGgoBAgM" alt="green triangle" />',
      }),
    );
  });

  it("records image generation as a completed synthetic tool call step", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "draw a green triangle", model: "openai/gpt-5.5", imageGeneration: true },
      queryOutput({
        text: "image ready",
        content: [
          { type: "text", text: "image ready" },
          { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" },
        ],
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 2,
        type: "tool_call",
        tool_call_index: 0,
        tool_call_id: "image_generation:2:0",
        tool_name: "image_generation",
        tool_args: JSON.stringify({
          prompt: "draw a green triangle",
          driverModel: "openai/gpt-5.5",
          tool: {
            type: "image_generation",
            outputFormat: "png",
          },
          pricingAssumption: {
            model: "gpt-image-2",
            quality: "medium",
            size: "1536x1024",
          },
        }),
        tool_result: '<img src="data:image/png;base64,iVBORw0KGgoBAgM" alt="green triangle" />',
      }),
    );
  });

  it("stores the hosted per-image estimate when image usage is absent", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "draw", imageGeneration: true },
      queryOutput({
        content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle",
          generation: { route: "codex-responses", size: "841x1870" },
        }],
      }),
    );

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        image_cost_usd: 41000,
        is_image_generation: true,
        image_cost_method: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    );
  });

  it.each([
    ["openai/gpt-5.5", "transparent"],
    ["openai/gpt-image-2", "opaque"],
  ] as const)("keeps standalone %s accounting out of text usage and records image usage once", async (model, background) => {
    const generation = {
      route: "codex-images" as const, model: "gpt-image-2" as const,
      size: "1254x1254", quality: "medium", background,
    };
    aggregateStepUsageMock.mockResolvedValueOnce({
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      duration_ms: 120, fallback_count: 0, cost_usd: 0, cost_source: "pricing_table",
    });
    await afterQuery(10, 0, {
      prompt: "draw", model, imageGeneration: true,
      imageGenerationOptions: { quality: "high", size: "1024x1024", background },
    }, queryOutput({
      model: "gpt-image-2", costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [
        { type: "image", data: "first", generation: { ...generation, usage: {
          input_tokens: 10, output_tokens: 100, total_tokens: 110,
          input_tokens_details: { text_tokens: 4, image_tokens: 6 },
        } } },
        { type: "image", data: "second", generation },
      ],
    }));
    expect(appendStepMock).toHaveBeenCalledWith(10, expect.objectContaining({
      type: "generate", model_name: "openai/gpt-image-2", requested_model_name: model,
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
    }));
    expect(finishRunMock).toHaveBeenCalledWith(10, expect.objectContaining({
      input_tokens: 0, output_tokens: 0, cost_usd: 0, image_cost_usd: 3_068,
      image_cost_method: "estimated:gpt-image-2:reported-usage:public-prices:conservative",
    }));
  });

  it("records auto chat driver cost and standalone image usage cost separately", async () => {
    aggregateStepUsageMock.mockResolvedValueOnce({
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0,
      duration_ms: 120, fallback_count: 0, cost_usd: 20, cost_source: "pricing_table",
    });
    await afterQuery(10, 0, {
      prompt: "draw", model: "openai/gpt-6-luna", imageGeneration: "auto",
    }, queryOutput({
      model: "gpt-6-luna", costUsd: 0.00002,
      usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: "image", data: "image", generation: {
        route: "codex-images", model: "gpt-image-2", background: "opaque",
        usage: {
          input_tokens: 10, output_tokens: 100, total_tokens: 110,
          input_tokens_details: { text_tokens: 4, image_tokens: 6 },
        },
      } }],
    }));
    expect(finishRunMock).toHaveBeenCalledWith(10, expect.objectContaining({
      model_name: "openai/gpt-6-luna", requested_model_name: "openai/gpt-6-luna",
      input_tokens: 100, output_tokens: 20, cost_usd: 20, image_cost_usd: 3_068,
      is_image_generation: true,
      image_cost_method: "estimated:gpt-image-2:reported-usage:public-prices:conservative",
    }));
    expect(appendStepMock.mock.calls.filter(([, step]) => step.type === "generate")).toHaveLength(1);
  });

  it("uses requested image quality and size for cost estimate", async () => {
    await afterQuery(
      10,
      2,
      {
        prompt: "draw",
        imageGeneration: true,
        imageGenerationOptions: { quality: "high", size: "1024x1024" },
      },
      queryOutput({
        content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" }],
      }),
    );

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        image_cost_usd: 211000,
        image_cost_method: "assumed:gpt-image-2:high:1024x1024:png",
      }),
    );
  });

  it("stores full routed models, fallback count, TTL split, and exact step cost", async () => {
    aggregateStepUsageMock.mockResolvedValueOnce({
      input_tokens: 100_000,
      output_tokens: 20,
      cache_read_tokens: 10_000,
      cache_creation_tokens: 80_000,
      cache_creation_5m_tokens: 30_000,
      cache_creation_1h_tokens: 50_000,
      duration_ms: 120,
      cost_usd: 3_000,
      cost_source: "provider",
      fallback_count: 1,
    });

    await afterQuery(
      10,
      2,
      { prompt: "hi", model: "anthropic/claude-fable-5" },
      queryOutput({
        model: "claude-opus-4-8",
        requestedModel: "claude-fable-5",
        modelFallbacks: [
          {
            trigger: "refusal",
            fromModel: "claude-fable-5",
            toModel: "claude-opus-4-8",
          },
        ],
        costUsd: 0.003,
        costSource: "provider",
        usage: {
          input_tokens: 100_000,
          output_tokens: 20,
          reasoning_tokens: 0,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 80_000,
          cache_creation_5m_input_tokens: 30_000,
          cache_creation_1h_input_tokens: 50_000,
        },
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-fable-5",
        model_name: "anthropic/claude-opus-4-8",
        fallback_count: 1,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: 3_000,
        cost_source: "provider",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-fable-5",
        model_name: "anthropic/claude-opus-4-8",
        fallback_count: 1,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: 3_000,
        cost_source: "provider",
      }),
    );
  });

  it("preserves the exact Anthropic 1M requested route after provider canonicalization", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "hi", model: "anthropic/claude-sonnet-4-6[1m]" },
      queryOutput({
        model: "claude-sonnet-4-6",
        requestedModel: "claude-sonnet-4-6",
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-sonnet-4-6[1m]",
        model_name: "anthropic/claude-sonnet-4-6",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-sonnet-4-6[1m]",
        model_name: "anthropic/claude-sonnet-4-6",
      }),
    );
  });
});

describe("qgrid run lifecycle terminal rollup", () => {
  beforeEach(() => {
    appendStepMock.mockReset().mockResolvedValue(1);
    aggregateStepUsageMock.mockReset().mockResolvedValue({
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 20,
      cache_creation_tokens: 40,
      cache_creation_5m_tokens: 15,
      cache_creation_1h_tokens: 25,
      duration_ms: 900,
      fallback_count: 1,
      cost_usd: 7_500,
      cost_source: "mixed",
    });
    finishRunMock.mockReset();
  });

  it.each(["error", "aborted"] as const)("records a completed chat stage once before %s rollup", async (status) => {
    const args = { prompt: "draw", model: "openai/gpt-6-astra", imageGeneration: "auto" as const };
    const result = queryOutput({ model: "gpt-6-luna", requestedModel: "gpt-6-astra" });
    const completedStep = { stepIndex: 2, result };
    if (status === "error") await finishRunWithError(10, "image failed", args, completedStep);
    else await finishRunAborted(10, args, completedStep);
    expect(appendStepMock).toHaveBeenCalledOnce();
    expect(appendStepMock).toHaveBeenCalledWith(10, expect.objectContaining({
      step_index: 2, type: "generate", model_name: "openai/gpt-6-luna",
      requested_model_name: "openai/gpt-6-astra", input_tokens: 5, output_tokens: 7,
      cost_usd: 1_000, cost_source: "pricing_table", ttft_ms: 39,
    }));
    expect(appendStepMock.mock.invocationCallOrder[0]).toBeLessThan(aggregateStepUsageMock.mock.invocationCallOrder[0]!);
    expect(finishRunMock).toHaveBeenCalledOnce();
    expect(finishRunMock).toHaveBeenCalledWith(10, expect.objectContaining({
      status, error_message: status === "error" ? "image failed" : "client disconnected",
      token_name: "tok-A", model_name: "openai/gpt-6-luna", requested_model_name: "openai/gpt-6-astra",
      // Existing steps and the final completed driver are rolled up together.
      input_tokens: 120, output_tokens: 30, cost_usd: 7_500, cost_source: "mixed",
    }));
    const finish = finishRunMock.mock.calls[0]![1];
    expect(finish.image_cost_usd).toBeUndefined();
    expect(finish.image_cost_method).toBeUndefined();
    expect(finish.is_image_generation).toBeUndefined();
  });

  it("still attempts aggregation and terminal status when the completed driver step cannot be logged", async () => {
    appendStepMock.mockRejectedValueOnce(new Error("step write failed"));
    await expect(finishRunWithError(10, "image failed", {
      prompt: "draw", model: "openai/gpt-6-luna",
    }, { stepIndex: 0, result: queryOutput({ model: "gpt-6-luna" }) })).resolves.toBeUndefined();
    expect(aggregateStepUsageMock).toHaveBeenCalledWith(10);
    expect(finishRunMock).toHaveBeenCalledWith(10, expect.objectContaining({
      status: "error", error_message: "image failed", model_name: "openai/gpt-6-luna", token_name: "tok-A",
    }));
  });

  it("does not replace the original failure when terminal persistence also fails", async () => {
    finishRunMock.mockRejectedValueOnce(new Error("terminal write failed"));
    await expect(finishRunWithError(10, "image failed", { prompt: "draw" }, {
      stepIndex: 0, result: queryOutput(),
    })).resolves.toBeUndefined();
  });

  it("keeps incurred step usage and cost when a run ends in error", async () => {
    await finishRunWithError(10, "provider failed", {
      prompt: "continue",
      history: JSON.stringify([{ type: "message", role: "user", content: "prior" }]),
    });

    expect(finishRunMock).toHaveBeenCalledWith(10, {
      status: "error",
      error_message: "provider failed",
      history: [{ type: "message", role: "user", content: "prior" }],
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 20,
      cache_creation_tokens: 40,
      cache_creation_5m_tokens: 15,
      cache_creation_1h_tokens: 25,
      duration_ms: 900,
      fallback_count: 1,
      cost_usd: 7_500,
      cost_source: "mixed",
    });
  });

  it("keeps incurred step usage and cost when a run is aborted", async () => {
    await finishRunAborted(10, { prompt: "continue" });

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: "aborted",
        error_message: "client disconnected",
        input_tokens: 120,
        output_tokens: 30,
        cost_usd: 7_500,
        cost_source: "mixed",
      }),
    );
  });

  it("still writes the terminal status when usage aggregation fails", async () => {
    aggregateStepUsageMock.mockRejectedValueOnce(new Error("aggregate failed"));

    await finishRunWithError(10, "provider failed");

    expect(finishRunMock).toHaveBeenCalledWith(10, {
      status: "error",
      error_message: "provider failed",
      history: undefined,
    });
  });
});
