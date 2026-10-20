import { EventEmitter } from "node:events";

import Fastify from "fastify";
import { BadRequestException, ServiceUnavailableException, Sonamu } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SD } from "../../i18n/sd.generated";
import { handleServerError } from "../../server-error-handler";
import { mapRequestBodyTooLarge, QgridFrame } from "./qgrid.frame";
import { QgridDispatcher, QgridDispatcherClass } from "./qgrid.dispatcher";
import {
  GenerateImagesInput,
  MEDIA_MAX_INLINE_BYTES,
  QueryInput,
  REQUEST_BODY_LIMIT_BYTES,
  TranscribeInput,
  VideoStartInput,
} from "./qgrid.types";
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_SCOPES,
  type GrokCredentials,
  GrokCapacityError,
  GrokInvalidRequestError,
  GrokNoWorkersError,
  GrokOAuthError,
  GrokOnDemandExcludedError,
  GrokRateLimitedError,
  GrokZdrVideoUnavailableError,
} from "../../utils/providers/grok";
import { ImageGenerationError } from "../../utils/providers/openai/openai-dispatcher";
import type {
  GenerateRequest,
  GenerateResult,
  GenerateStreamCallbacks,
} from "../../utils/providers/common/provider-dispatcher";

const {
  findOneMock,
  findManyMock,
  findActiveByProviderAndNameMock,
  toggleActiveMock,
  saveMock,
  updateFieldsMock,
  requestLogSaveMock,
  requestLogCreateRunMock,
  requestLogFinishRunMock,
  appendStepMock,
  continueToolRunMock,
  dispatcherQueryMock,
  dispatcherQueryStreamMock,
  beforeQueryMock,
  afterQueryMock,
  finishRunWithErrorMock,
  finishRunAbortedMock,
  getRateLimitsByTokenIdMock,
  replaceByAccountMock,
  completeGrokOAuthMock,
  startGrokDeviceCodeMock,
  pollGrokDeviceCodeMock,
} = vi.hoisted(() => {
  // isolate:false 공유 레지스트리 방어: 같은 fork 에서 앞선 파일이 request-log/token/
  // run-lifecycle 실모듈을 캐시해 두면 아래 vi.mock 들이 조용히 무시된다(실 DB 호출로
  // 폭발). import 보다 먼저 레지스트리를 비워 이 파일은 항상 mock 그래프로 시작한다.
  vi.resetModules();
  return {
    findOneMock: vi.fn(),
    findManyMock: vi.fn(),
    findActiveByProviderAndNameMock: vi.fn(),
    toggleActiveMock: vi.fn(),
    saveMock: vi.fn(),
    updateFieldsMock: vi.fn(),
    requestLogSaveMock: vi.fn(),
    requestLogCreateRunMock: vi.fn(),
    requestLogFinishRunMock: vi.fn(),
    appendStepMock: vi.fn(),
    continueToolRunMock: vi.fn(),
    dispatcherQueryMock: vi.fn(),
    dispatcherQueryStreamMock: vi.fn(),
    beforeQueryMock: vi.fn(),
    afterQueryMock: vi.fn(),
    finishRunWithErrorMock: vi.fn(),
    finishRunAbortedMock: vi.fn(),
    getRateLimitsByTokenIdMock: vi.fn(),
    replaceByAccountMock: vi.fn(),
    completeGrokOAuthMock: vi.fn(),
    startGrokDeviceCodeMock: vi.fn(),
    pollGrokDeviceCodeMock: vi.fn(),
  };
});

// OAuth pending state lives in the cache; a Map stub supports the round trip.
vi.mock("sonamu/cache", () => {
  const store = new Map<string, string>();
  return {
    getCacheManagerRef: () => ({
      set: async ({ key, value }: { key: string; value: string }) => {
        store.set(key, value);
      },
      get: async ({ key }: { key: string }) => store.get(key),
      delete: async ({ key }: { key: string }) => {
        store.delete(key);
      },
    }),
  };
});

// Token exchange and device endpoints hit xAI; startGrokOAuth stays real (fetch is stubbed).
vi.mock("../../utils/providers/grok", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/providers/grok")>()),
  completeGrokOAuth: completeGrokOAuthMock,
  startGrokDeviceCode: startGrokDeviceCodeMock,
  pollGrokDeviceCode: pollGrokDeviceCodeMock,
}));

vi.mock("../request-log/request-log.model", () => ({
  MICRO_USD: 1_000_000,
  RequestLogModel: {
    save: requestLogSaveMock,
    createRun: requestLogCreateRunMock,
    finishRun: requestLogFinishRunMock,
    appendStep: appendStepMock,
    continueToolRun: continueToolRunMock,
  },
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    findOne: findOneMock,
    findMany: findManyMock,
    findActiveByProviderAndName: findActiveByProviderAndNameMock,
    toggleActive: toggleActiveMock,
    save: saveMock,
    updateFields: updateFieldsMock,
    replaceByAccount: replaceByAccountMock,
  },
}));

// QgridFrame의 token-death 연결은 이 스위트의 관심사가 아니다. isolate:false 워커에서
// 부분 TokenModel mock으로 token-death 실제 모듈을 먼저 캐시하지 않도록 경계를 끊는다.
vi.mock("./token-death", () => ({
  deactivateAuthDeadToken: vi.fn(),
  notifyTokenAdded: vi.fn(),
}));

vi.mock("./qgrid.dispatcher", async (importOriginal) => {
  const original = await importOriginal<typeof import("./qgrid.dispatcher")>();
  return {
    ...original,
    QgridDispatcher: {
      query: dispatcherQueryMock,
      queryStream: dispatcherQueryStreamMock,
      openaiDispatcher: {
        getRateLimitsByTokenId: getRateLimitsByTokenIdMock,
      },
      grokDispatcher: null,
      startupState: { openai: "starting", anthropic: "starting" },
      tokens: new Map(),
      subscriber: null,
    },
  };
});

vi.mock("./qgrid-run-lifecycle", () => ({
  beforeQuery: beforeQueryMock,
  afterQuery: afterQueryMock,
  finishRunWithError: finishRunWithErrorMock,
  finishRunAborted: finishRunAbortedMock,
}));

const tokenEntry = {
  id: 1,
  created_at: new Date("2026-06-30T00:00:00.000Z"),
  provider: "anthropic",
  credentials: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 3_600_000,
    accountUuid: "acc-1",
  },
  name: "tok-A",
  active: true,
  reauth_required: false,
  ord: 0,
  quota_threshold: null,
  weight: 1,
  keepalive_enabled: false,
};

describe("QgridFrame.toggleToken", () => {
  beforeEach(() => {
    toggleActiveMock.mockReset();
  });

  it("does not reactivate a token whose login has expired", async () => {
    toggleActiveMock.mockResolvedValue({ active: false, reauthRequired: true });

    await expect(QgridFrame.toggleToken(1)).rejects.toThrow("Re-login required");
  });

  it("reactivates a manually disabled token without requiring login", async () => {
    toggleActiveMock.mockResolvedValue({ active: true, reauthRequired: false });

    await expect(QgridFrame.toggleToken(1)).resolves.toEqual({ active: true });
  });
});

function deeplyNestedInputSchema(depth: number): unknown {
  return JSON.parse(`${"[".repeat(depth)}0${"]".repeat(depth)}`) as unknown;
}

describe("QgridFrame.updateToken", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue([1]);
    updateFieldsMock.mockReset().mockResolvedValue(1);
    requestLogSaveMock.mockReset();
    requestLogSaveMock.mockResolvedValue([1]);
    appendStepMock.mockReset();
    appendStepMock.mockResolvedValue(1);
    dispatcherQueryMock.mockReset();
    findActiveByProviderAndNameMock.mockReset();
  });

  it("rejects quota thresholds outside bounds before updating", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", 0)).rejects.toThrow(
      "quotaThreshold must be an integer between 1 and 100, or null",
    );

    expect(updateFieldsMock).not.toHaveBeenCalled();
  });

  it("updates only the supplied quota threshold", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", 80)).resolves.toEqual({ updated: true });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, {
      name: "tok-A",
      quota_threshold: 80,
    });
  });

  it("rejects invalid weights before updating", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", undefined, 0)).rejects.toThrow(
      "weight must be an integer between 1 and 100",
    );

    expect(updateFieldsMock).not.toHaveBeenCalled();
  });

  it("updates only the supplied weight", async () => {
    await expect(QgridFrame.updateToken(1, undefined, undefined, 4)).resolves.toEqual({
      updated: true,
    });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, { weight: 4 });
  });

  it("updates only the supplied keepalive switch", async () => {
    await expect(QgridFrame.updateToken(1, undefined, undefined, undefined, true)).resolves.toEqual({
      updated: true,
    });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, { keepalive_enabled: true });
  });

  it("reports a missing token from the atomic update result", async () => {
    updateFieldsMock.mockResolvedValueOnce(0);

    await expect(QgridFrame.updateToken(404, undefined, undefined, 4)).resolves.toEqual({
      updated: false,
    });
  });
});

describe("QgridFrame.query request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 41, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    finishRunWithErrorMock.mockReset();
    finishRunAbortedMock.mockReset();
    dispatcherQueryMock.mockReset();
    findActiveByProviderAndNameMock.mockReset();
  });

  function queryOutput() {
    return {
      text: "hello",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      tokenName: "tok-A",
      model: "gpt-5-codex",
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      durationMs: 120,
      ttftMs: 39,
      costUsd: 0.001,
      costSource: "pricing_table",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 2,
          systemHash: "system-hash",
        },
      },
    };
  }

  it("creates a run before dispatch when logger is omitted", async () => {
    const order: string[] = [];
    beforeQueryMock.mockImplementationOnce(async () => {
      order.push("before");
      return { requestLogId: 41, stepIndex: 0 };
    });
    dispatcherQueryMock.mockImplementationOnce(async () => {
      order.push("dispatch");
      return queryOutput();
    });
    afterQueryMock.mockImplementationOnce(async () => {
      order.push("after");
      return {};
    });

    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const result = await QgridFrame.query(args);

    expect(order).toEqual(["before", "dispatch", "after"]);
    expect(beforeQueryMock).toHaveBeenCalledWith(args);
    expect(afterQueryMock).toHaveBeenCalledWith(41, 0, args, expect.objectContaining({ text: "hello" }));
    expect(result.runContext).toEqual(queryOutput().runContext);
    expect(result.requestLogId).toBe(41);
  });

  it("tokenName 을 활성 토큰 id 로 해석해 지정 요청으로 전달한다", async () => {
    findActiveByProviderAndNameMock.mockResolvedValueOnce({
      ...tokenEntry,
      id: 17,
      name: "anthropic/tok-A",
    });
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());

    await QgridFrame.query({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      tokenName: "anthropic/tok-A",
    });

    expect(findActiveByProviderAndNameMock).toHaveBeenCalledWith(
      "A",
      "anthropic",
      "anthropic/tok-A",
    );
    expect(dispatcherQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTokenId: 17, requirePreferredToken: true }),
      expect.any(AbortSignal),
    );
  });

  it("tokenName 에 해당하는 활성 토큰이 없으면 대체 없이 실패한다", async () => {
    findActiveByProviderAndNameMock.mockResolvedValueOnce(undefined);

    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tokenName: "anthropic/missing",
      }),
    ).rejects.toThrow("Active token not found: anthropic/missing");

    expect(dispatcherQueryMock).not.toHaveBeenCalled();
    expect(beforeQueryMock).not.toHaveBeenCalled();
  });

  it("tokenName provider 와 model provider 가 다르면 조회 전에 실패한다", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tokenName: "openai/tok-A",
      }),
    ).rejects.toThrow("Token provider does not match model provider");

    expect(findActiveByProviderAndNameMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("persists an immediate tools+schema structured answer as final JSON text", async () => {
    const output = {
      ...queryOutput(),
      text: '{"result":"ok"}',
      content: [{ type: "text" as const, text: '{"result":"ok"}' }],
    };
    dispatcherQueryMock.mockResolvedValueOnce(output);
    const args = {
      prompt: "answer",
      model: "openai/gpt-5.6-terra",
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      }),
    };

    await expect(QgridFrame.query(args)).resolves.toMatchObject({
      text: '{"result":"ok"}',
      content: [{ type: "text", text: '{"result":"ok"}' }],
      finishReason: "stop",
    });
    expect(beforeQueryMock).toHaveBeenCalledWith(args);
    expect(afterQueryMock).toHaveBeenCalledWith(41, 0, args, output);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
  });

  it("does not create or update logs when logger is false", async () => {
    const output = queryOutput();
    dispatcherQueryMock.mockResolvedValueOnce(output);

    await expect(
      QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex", logger: false }),
    ).resolves.toEqual(output);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(afterQueryMock).not.toHaveBeenCalled();
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
  });

  it("merges a tool run id with the provider thread coordinate", async () => {
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
    afterQueryMock.mockResolvedValueOnce({ runContext: { requestLogId: 41 } });

    const result = await QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex" });

    expect(result.runContext).toEqual({
      requestLogId: 41,
      threadCoord: queryOutput().runContext.threadCoord,
    });
  });

  it("finishes the pre-created run when provider execution fails", async () => {
    dispatcherQueryMock.mockRejectedValueOnce(new Error("provider failed"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };

    await expect(QgridFrame.query(args)).rejects.toThrow("provider failed");

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "provider failed", args);
  });

  it.each(["error", "abort", "logger-disabled"])("handles completed driver accounting on image %s", async (mode) => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const responseRaw = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      transport: "http", request: { raw: requestRaw }, reply: { raw: responseRaw },
    } as never);
    const error = new ImageGenerationError("incomplete", "image failed");
    error.completedDriver = {
      text: "drawing", tokenName: "one", model: "gpt-6-luna", durationMs: 20, ttftMs: 2,
      threadCoord: { workerId: 1, threadId: "", epoch: -1 },
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 120 },
    };
    dispatcherQueryMock.mockImplementationOnce(async () => {
      if (mode === "abort") { responseRaw.destroyed = true; responseRaw.emit("close"); }
      throw error;
    });
    const args = {
      prompt: "draw", model: "openai/gpt-6-luna", imageGeneration: "auto" as const,
      serviceTier: "fast" as const,
      ...(mode === "logger-disabled" ? { logger: false } : {}),
    };
    await expect(QgridFrame.query(args)).rejects.toBe(error);
    expect(afterQueryMock).not.toHaveBeenCalled();
    if (mode === "logger-disabled") {
      expect(beforeQueryMock).not.toHaveBeenCalled();
      expect(finishRunWithErrorMock).not.toHaveBeenCalled();
      expect(finishRunAbortedMock).not.toHaveBeenCalled();
    } else {
      const completedStep = expect.objectContaining({
        stepIndex: 0,
        result: expect.objectContaining({
          model: "gpt-6-luna", tokenName: "one", costUsd: 0.00004,
          usage: expect.objectContaining({ input_tokens: 100, output_tokens: 20 }),
        }),
      });
      if (mode === "abort") expect(finishRunAbortedMock).toHaveBeenCalledWith(41, args, completedStep);
      else expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "image failed", args, completedStep);
    }
  });

  it("marks an incoherent structured envelope failure as a request-log error", async () => {
    const error = new Error(
      "tool-call emulation: structured response envelope is missing required keys: toolCalls",
    );
    dispatcherQueryMock.mockRejectedValueOnce(error);
    const args = {
      prompt: "answer",
      model: "anthropic/claude-sonnet-4-6",
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      jsonSchema: JSON.stringify({ type: "object", properties: {} }),
    };

    await expect(QgridFrame.query(args)).rejects.toThrow(error.message);
    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, error.message, args);
    expect(afterQueryMock).not.toHaveBeenCalled();
  });

  it("aborts provider execution and marks the run aborted when the HTTP response closes early", async () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const responseRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      transport: "http",
      request: { raw: requestRaw },
      reply: { raw: responseRaw },
    } as never);
    let providerSignal: AbortSignal | undefined;
    dispatcherQueryMock.mockImplementationOnce(
      (_args: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
            once: true,
          });
        }),
    );
    const args = { prompt: "hi", model: "anthropic/claude-opus-5" };

    const queryPromise = QgridFrame.query(args);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    responseRaw.destroyed = true;
    responseRaw.emit("close");

    await expect(queryPromise).rejects.toThrow("provider aborted");
    expect(providerSignal?.aborted).toBe(true);
    expect(finishRunAbortedMock).toHaveBeenCalledWith(41, args);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(requestRaw.listenerCount("aborted")).toBe(0);
    expect(responseRaw.listenerCount("close")).toBe(0);
  });

  it("returns the provider result when afterQuery persistence fails", async () => {
    const output = queryOutput();
    dispatcherQueryMock.mockResolvedValueOnce(output);
    afterQueryMock.mockRejectedValueOnce(new Error("request log unavailable"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };

    await expect(QgridFrame.query(args)).resolves.toEqual({ ...output, requestLogId: 41 });

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "request log unavailable", args);
  });

  it.each([
    ["malformed JSON", '{"type":"object"'],
    ["unsupported top-level array schema", '{"type":"array","items":{"type":"string"}}'],
  ])("returns a deterministic 400 before logging or dispatch for %s", async (_label, jsonSchema) => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        jsonSchema,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("qgrid: jsonSchema"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a deeply nested tools-only schema before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        tools: [{ name: "deepTool", inputSchema: deeplyNestedInputSchema(256) }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("tools[0].inputSchema exceeds depth limit"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsupported composed-schema reference before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        jsonSchema: JSON.stringify({
          $id: "urn:example:answer",
          type: "object",
          properties: { answer: { type: "string" } },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("$id is not supported"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed normalization keyword before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        jsonSchema: JSON.stringify({
          type: "object",
          anyOf: {},
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("caller schema cannot be normalized"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unrestricted positional tuple before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.6-terra",
        jsonSchema: JSON.stringify({
          type: "object",
          properties: {
            tuple: {
              type: "array",
              items: [{ type: "string" }],
              additionalItems: true,
            },
          },
          required: ["tuple"],
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("unrestricted tuple rest is not supported"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  // SON-532: anthropic 은 strictify 를 거치지 않으므로 strict 변환이 다루지 못하던 형태
  // (positional tuple 등)도 거절 사유가 아니다 — 원형 그대로 프롬프트에 안내된다.
  it.each([
    [
      "positional tuple",
      {
        type: "object",
        properties: {
          tuple: { type: "array", items: [{ type: "string" }, { type: "integer" }] },
        },
        required: ["tuple"],
      },
    ],
    [
      "tuple nested under not",
      { type: "object", not: { type: "array", items: [{ type: "string" }] } },
    ],
    [
      "prefixItems tuple with missing type",
      {
        type: "object",
        properties: { tuple: { prefixItems: [{ type: "string" }, { type: "integer" }] } },
        required: ["tuple"],
      },
    ],
    [
      "prefixItems tuple with nullable union type",
      {
        type: "object",
        properties: {
          tuple: {
            type: ["array", "null"],
            prefixItems: [{ type: "string" }, { type: "integer" }],
          },
        },
        required: ["tuple"],
      },
    ],
  ] as const)(
    "accepts an Anthropic schema with %s and proceeds to dispatch (SON-532)",
    async (_label, schema) => {
      beforeQueryMock.mockResolvedValueOnce({ requestLogId: 41, stepIndex: 0 });
      dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
      afterQueryMock.mockResolvedValueOnce({});

      await expect(
        QgridFrame.query({
          prompt: "hi",
          model: "anthropic/claude-opus-4-8",
          jsonSchema: JSON.stringify(schema),
        }),
      ).resolves.toMatchObject({ text: "hello" });

      expect(dispatcherQueryMock).toHaveBeenCalledOnce();
    },
  );

  it("returns 400 for an OpenAI tuple under not instead of changing negative semantics", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.6-terra",
        jsonSchema: JSON.stringify({
          type: "object",
          not: {
            type: "array",
            items: [{ type: "string" }],
          },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        "positional tuple schemas are not supported in this schema position",
      ),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a definition referenced under not before globally normalizing it", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.6-terra",
        jsonSchema: JSON.stringify({
          type: "object",
          $defs: {
            Forbidden: {
              type: "object",
              properties: { value: { const: 0 } },
              required: ["value"],
            },
          },
          not: { $ref: "#/$defs/Forbidden" },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        "schema references are not supported in this schema position",
      ),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a literal JSON value",
      {
        type: "object",
        properties: {
          payload: { $ref: "#/$defs/Carrier/enum/0" },
        },
        required: ["payload"],
        $defs: {
          Carrier: {
            enum: [{ type: "object", properties: { value: { type: "string" } } }],
          },
        },
      },
      "$ref target must be the document root or a definition root",
    ],
    [
      "a conditional schema position",
      {
        type: "object",
        properties: {
          payload: { $ref: "#/if" },
        },
        required: ["payload"],
        if: {
          type: "object",
          properties: { secret: { type: "string" } },
        },
      },
      "$ref target must be the document root or a definition root",
    ],
  ] as const)(
    "returns 400 for an OpenAI ref targeting %s before logging or dispatch",
    async (_label, schema, message) => {
      await expect(
        QgridFrame.query({
          prompt: "hi",
          model: "openai/gpt-5.6-terra",
          jsonSchema: JSON.stringify(schema),
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(message),
      });

      expect(beforeQueryMock).not.toHaveBeenCalled();
      expect(dispatcherQueryMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined],
    ["nullable union", ["array", "null"]],
  ] as const)(
    "returns 400 for an OpenAI positional tuple with %s type before logging or dispatch",
    async (_label, type) => {
      await expect(
        QgridFrame.query({
          prompt: "hi",
          model: "openai/gpt-5.6-terra",
          jsonSchema: JSON.stringify({
            type: "object",
            properties: {
              tuple: {
                ...(type === undefined ? {} : { type }),
                items: [{ type: "string" }, { type: "integer" }],
              },
            },
            required: ["tuple"],
          }),
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(
          'positional tuple schemas must declare type "array"',
        ),
      });

      expect(beforeQueryMock).not.toHaveBeenCalled();
      expect(dispatcherQueryMock).not.toHaveBeenCalled();
    },
  );

  // SON-532: argv 64KiB 제한은 --json-schema 전용이었다. 프롬프트 전달은 system 크기
  // 분기(--system-prompt-file)가 흡수하므로 전역 복잡도 한도만 남는다.
  it("accepts an Anthropic schema that exceeds the old argv size limit (SON-532)", async () => {
    beforeQueryMock.mockResolvedValueOnce({ requestLogId: 41, stepIndex: 0 });
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
    afterQueryMock.mockResolvedValueOnce({});

    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tools: [
          {
            name: "lookup",
            description: "x".repeat(64 * 1024),
            inputSchema: { type: "object" },
          },
        ],
        jsonSchema: JSON.stringify({
          type: "object",
          properties: { answer: { type: "string" } },
        }),
      }),
    ).resolves.toMatchObject({ text: "hello" });

    expect(dispatcherQueryMock).toHaveBeenCalledOnce();
  });

  it("accepts logger: false in the wire schema", () => {
    expect(QueryInput.safeParse({ prompt: "hi", logger: false }).success).toBe(true);
  });

  it.each([
    { imageGeneration: undefined },
    { imageGeneration: "auto" as const },
    { imageGeneration: true, tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
    { imageGeneration: true, jsonSchema: '{"type":"object"}' },
    { imageGeneration: true, imageGenerationOptions: { outputFormat: "webp" as const } },
  ])("rejects unsupported standalone image requests before logging: %j", async (options) => {
    await expect(QgridFrame.query({
      prompt: "draw", model: "openai/gpt-image-2", ...options,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    { imageGenerationOptions: { outputFormat: "webp" as const } },
    { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
    { jsonSchema: '{"type":"object"}' },
  ])("rejects unsupported auto image controls before logging: %j", async (options) => {
    await expect(QgridFrame.query({
      prompt: "draw", model: "openai/gpt-6-luna", imageGeneration: "auto", ...options,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("accepts bounded positive integer timeout values only", () => {
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 360_000 }).success).toBe(true);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 0 }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 1.5 }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 1_800_001 }).success).toBe(false);
  });
});

describe("QgridFrame.prepareStream", () => {
  beforeEach(() => {
    dispatcherQueryMock.mockReset();
    requestLogSaveMock.mockReset();
  });

  it("rejects an image model without a streaming image flag", async () => {
    await expect(QgridFrame.prepareStream({
      prompt: "draw", model: "openai/gpt-image-2",
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each([true, "auto"] as const)("rejects imageGeneration=%s before creating an SSE stream", async (imageGeneration) => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "draw",
        model: "openai/gpt-5-codex",
        imageGeneration,
      }),
    ).rejects.toThrow(/imageGeneration is not supported with streaming/);

    expect(dispatcherQueryMock).not.toHaveBeenCalled();
    expect(requestLogSaveMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid schema before allocating a stream id", async () => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: "null",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'qgrid: jsonSchema top-level type must be "object"',
    });
  });

  it("accepts an Anthropic tuple under patternProperties and allocates a stream id (SON-532)", async () => {
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "anthropic/claude-opus-4-8",
      jsonSchema: JSON.stringify({
        type: "object",
        patternProperties: {
          "^tuple$": {
            type: "array",
            prefixItems: [{ type: "string" }],
          },
        },
      }),
    });

    expect(streamId).toEqual(expect.any(String));
  });

  it("returns 400 for a deeply nested tool schema before allocating a stream id", async () => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tools: [{ name: "deepTool", inputSchema: deeplyNestedInputSchema(256) }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("tools[0].inputSchema exceeds depth limit"),
    });
  });

  // strict 합성 시절엔 $defs rebase 때문에 named anchor $ref 를 거절해야 했다.
  // 프롬프트 전달은 원문을 그대로 안내하므로 재작성이 없고 거절 사유도 사라진다(SON-532).
  it("accepts a named-anchor $ref on Anthropic and allocates a stream id (SON-532)", async () => {
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { answer: { $ref: "#named-anchor" } },
      }),
    });

    expect(streamId).toEqual(expect.any(String));
  });

  it("accepts an Anthropic schema beyond the old argv limit and allocates a stream id (SON-532)", async () => {
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      tools: [
        {
          name: "lookup",
          description: "x".repeat(64 * 1024),
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(streamId).toEqual(expect.any(String));
  });
});

describe("QgridFrame raw lifecycle API", () => {
  it("maps the requested model and structured metadata through the external createRun API", async () => {
    requestLogCreateRunMock.mockReset().mockResolvedValue(81);
    const jsonSchema = JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    });

    await expect(
      QgridFrame.createRun({
        userPrompt: "hi",
        modelName: "google/gemini-3-flash",
        projectName: "external",
        isStructured: true,
        jsonSchema,
      }),
    ).resolves.toEqual({ requestLogId: 81 });

    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_model_name: "google/gemini-3-flash",
        is_structured: true,
        json_schema: jsonSchema,
      }),
    );
    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ model_name: expect.anything() }),
    );
  });

  it("passes optional response JSON validity through the external finishRun API", async () => {
    requestLogFinishRunMock.mockReset().mockResolvedValue(undefined);

    await QgridFrame.finishRun({
      requestLogId: 82,
      status: "succeeded",
      response: '{"answer":"ok"}',
      tokenName: "external",
      responseJsonOk: true,
    });

    expect(requestLogFinishRunMock).toHaveBeenCalledWith(
      82,
      expect.objectContaining({ response_json_ok: true }),
    );
  });
});

describe("QgridFrame.queryStream request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 52, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    finishRunWithErrorMock.mockReset();
    finishRunAbortedMock.mockReset();
    dispatcherQueryStreamMock.mockReset();
  });

  function streamOutput() {
    return {
      text: "hello",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      tokenName: "tok-A",
      model: "gpt-5-codex",
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      durationMs: 120,
      ttftMs: 39,
      costUsd: 0.001,
      costSource: "pricing_table",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 2,
          systemHash: "system-hash",
        },
      },
    };
  }

  function installSseContext() {
    let closeHandler: (() => void) | undefined;
    const sse = {
      closed: false,
      publish: vi.fn(),
      onClose: vi.fn((handler: () => void) => {
        closeHandler = handler;
      }),
      end: vi.fn(async () => {}),
      triggerClose: () => closeHandler?.(),
    };
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      createSSE: vi.fn(() => sse),
    } as never);
    return sse;
  }

  it("creates the running row before starting provider streaming", async () => {
    const order: string[] = [];
    const sse = installSseContext();
    beforeQueryMock.mockImplementationOnce(async () => {
      order.push("before");
      return { requestLogId: 52, stepIndex: 0 };
    });
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
      order.push("dispatch");
      callbacks.onComplete(streamOutput());
      },
    );
    afterQueryMock.mockImplementationOnce(async () => {
      order.push("after");
      return {};
    });
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(order).toEqual(["before", "dispatch", "after"]);
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ requestLogId: 52, runContext: streamOutput().runContext }),
    );
  });

  it("captures client close while beforeQuery is pending and skips provider dispatch", async () => {
    const sse = installSseContext();
    let beforeQueryStarted!: () => void;
    let resolveBeforeQuery!: (value: { requestLogId: number; stepIndex: number }) => void;
    const started = new Promise<void>((resolve) => {
      beforeQueryStarted = resolve;
    });
    beforeQueryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBeforeQuery = resolve;
          beforeQueryStarted();
        }),
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    const streamPromise = QgridFrame.queryStream(streamId);
    await started;
    expect(sse.onClose).toHaveBeenCalledOnce();
    sse.triggerClose();
    resolveBeforeQuery({ requestLogId: 52, stepIndex: 0 });
    await streamPromise;

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(dispatcherQueryStreamMock).not.toHaveBeenCalled();
    expect(sse.end).toHaveBeenCalledOnce();
  });

  it("publishes the provider result when afterQuery persistence fails", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    afterQueryMock.mockRejectedValueOnce(new Error("request log unavailable"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(52, "request log unavailable", args);
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ text: "hello", runContext: streamOutput().runContext }),
    );
    expect(sse.publish).not.toHaveBeenCalledWith("error", expect.anything());
  });

  it("publishes an error when provider execution fails while the client is connected", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (_args: unknown, callbacks: { onError: (error: Error) => void }) => {
        callbacks.onError(new Error("provider failed"));
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(52, "provider failed", args);
    expect(finishRunAbortedMock).not.toHaveBeenCalled();
    expect(sse.publish).toHaveBeenCalledWith("error", { message: "provider failed" });
  });

  it.each([
    ["openai", "openai/gpt-5.6-terra", "gpt-5.6-terra"],
    ["anthropic", "anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"],
  ] as const)(
    "finishes a malformed %s structured stream through the real dispatcher without hanging",
    async (provider, requestedModel, servedModel) => {
      const sse = installSseContext();
      const { QgridDispatcherClass } =
        await vi.importActual<typeof import("./qgrid.dispatcher")>("./qgrid.dispatcher");
      const dispatcher = new QgridDispatcherClass();
      const generateStream = vi.fn(
        async (
          _request: unknown,
          callbacks: {
            onComplete: (result: {
              text: string;
              tokenName: string;
              usage: {
                totalTokens: number;
                inputTokens: number;
                cachedInputTokens: number;
                outputTokens: number;
                reasoningOutputTokens: number;
              };
              durationMs: number;
              model: string;
              threadCoord: { workerId: number; threadId: string; epoch: number };
            }) => void;
          },
        ) => {
          // 실제 provider adapter 완료 지점: toolCalls 누락 envelope가 dispatcher mapper에서 throw.
          callbacks.onComplete({
            text: '{"action":"answer","answer":{"result":"ok"}}',
            tokenName: `${provider}/test`,
            usage: {
              totalTokens: 10,
              inputTokens: 5,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
            },
            durationMs: 12,
            model: servedModel,
            threadCoord: { workerId: 1, threadId: "thread-malformed", epoch: 0 },
          });
        },
      );
      if (provider === "openai") {
        dispatcher.openaiDispatcher = { generateStream } as never;
      } else {
        dispatcher.anthropicDispatcher = { generateStream } as never;
      }
      dispatcherQueryStreamMock.mockImplementationOnce((args, callbacks, signal) =>
        dispatcher.queryStream(args, callbacks, signal),
      );

      const args = {
        prompt: "answer",
        model: requestedModel,
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        jsonSchema: JSON.stringify({
          type: "object",
          properties: { result: { type: "string" } },
        }),
      };
      const { streamId } = await QgridFrame.prepareStream(args);

      await expect(QgridFrame.queryStream(streamId)).resolves.toBeUndefined();

      expect(generateStream).toHaveBeenCalledOnce();
      expect(finishRunWithErrorMock).toHaveBeenCalledWith(
        52,
        expect.stringContaining("invalid tool envelope"),
        args,
      );
      const errorMessage = finishRunWithErrorMock.mock.calls[0]?.[1];
      expect(afterQueryMock).not.toHaveBeenCalled();
      expect(sse.publish).toHaveBeenCalledWith("error", { message: errorMessage });
      expect(sse.end).toHaveBeenCalledOnce();
    },
  );

  it("marks the run aborted on close regardless of the provider error message", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onError: (error: Error) => void },
        signal: AbortSignal,
      ) => {
        expect(signal.aborted).toBe(false);
        sse.triggerClose();
        expect(signal.aborted).toBe(true);
        callbacks.onError(new Error("provider connection reset"));
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(sse.publish).not.toHaveBeenCalled();
  });

  it("records a provider result after close but finishes the run as aborted", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        sse.triggerClose();
        callbacks.onComplete(streamOutput());
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(afterQueryMock).toHaveBeenCalledWith(52, 0, args, streamOutput());
    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(sse.publish).not.toHaveBeenCalled();
  });

  it("marks the run aborted when the client closes before afterQuery commits", async () => {
    const sse = installSseContext();
    let afterQueryStarted!: () => void;
    let resolveAfterQuery!: (value: object) => void;
    const started = new Promise<void>((resolve) => {
      afterQueryStarted = resolve;
    });
    afterQueryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAfterQuery = resolve;
          afterQueryStarted();
        }),
    );
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    const streamPromise = QgridFrame.queryStream(streamId);
    await started;
    sse.triggerClose();
    resolveAfterQuery({});
    await streamPromise;

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(sse.publish).not.toHaveBeenCalledWith("done", expect.anything());
  });

  it("streams with thread context but no log writes when logger is false", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "openai/gpt-5-codex",
      logger: false,
    });

    await QgridFrame.queryStream(streamId);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(afterQueryMock).not.toHaveBeenCalled();
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(sse.onClose).toHaveBeenCalledOnce();
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ runContext: streamOutput().runContext }),
    );
  });
});

describe("QgridFrame.usage", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    getRateLimitsByTokenIdMock.mockReset();
  });

  it("does not fetch usage for confirmed expired tokens", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [{ ...tokenEntry, provider: "openai", active: false, reauth_required: true }],
    });
    await expect(QgridFrame.usage(1)).resolves.toEqual({ error: "re-login required" });
    expect(getRateLimitsByTokenIdMock).not.toHaveBeenCalled();
  });

  it("does not label transient refresh failures as expired sessions", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [{ ...tokenEntry, provider: "anthropic", credentials: {
        accessToken: "access", refreshToken: "refresh", expiresAt: 0, accountUuid: "account",
      } }],
    });
    vi.spyOn(QgridFrame, "refreshToken").mockRejectedValueOnce(new Error("network timeout"));
    await expect(QgridFrame.usage(1)).resolves.toEqual({
      error: "Token refresh failed; usage is unavailable",
    });
  });

  it("returns empty usage for inactive OpenAI tokens without asking for workers", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [
        {
          ...tokenEntry,
          provider: "openai",
          credentials: {
            accessToken: "access",
            refreshToken: "refresh",
            accountId: "account",
          },
          active: false,
        },
      ],
    });

    await expect(QgridFrame.usage(1)).resolves.toEqual({
      provider: "openai",
      fiveHour: null,
      sevenDay: null,
    });
    expect(getRateLimitsByTokenIdMock).not.toHaveBeenCalled();
  });

  it("returns the provider-reported OpenAI window duration", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [{ ...tokenEntry, provider: "openai", active: true }],
    });
    getRateLimitsByTokenIdMock.mockResolvedValueOnce({
      data: {
        rateLimits: {
          primary: { usedPercent: 11, resetsAt: 1_784_000_000, windowDurationMins: 10_080 },
          secondary: null,
        },
      },
    });

    await expect(QgridFrame.usage(1)).resolves.toEqual({
      provider: "openai",
      fiveHour: {
        utilization: 11,
        resetsAt: new Date(1_784_000_000 * 1_000).toISOString(),
        windowDurationMins: 10_080,
      },
      sevenDay: null,
    });
  });
});

function grokJwtSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function grokCredentials(overrides: Partial<GrokCredentials> = {}): GrokCredentials {
  return {
    authMode: "oauth",
    accessToken: `${grokJwtSegment({ alg: "ES256", typ: "at+jwt" })}.${grokJwtSegment({
      iss: "https://auth.x.ai",
      sub: "11111111-0000-4000-8000-000000000001",
      exp: 2_000_000_000,
    })}.c2ln`,
    refreshToken: "grok-refresh-1",
    expiresAt: "2030-01-01T00:00:00Z",
    issuer: "https://auth.x.ai",
    clientId: GROK_OAUTH_CLIENT_ID,
    scopes: [...GROK_OAUTH_SCOPES],
    userId: "11111111-0000-4000-8000-000000000001",
    sessionId: "22222222-0000-4000-8000-000000000001",
    agentId: "33333333-0000-4000-8000-000000000001",
    subscriptionTier: "Super",
    ...overrides,
  };
}

describe("QgridFrame Grok registration and routing", () => {
  beforeEach(() => {
    // Discovery fails offline, so startGrokOAuth uses the fixed xAI endpoints.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    replaceByAccountMock.mockReset().mockResolvedValue([1]);
    completeGrokOAuthMock.mockReset();
    startGrokDeviceCodeMock.mockReset();
    pollGrokDeviceCodeMock.mockReset();
    findManyMock.mockReset();
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 51, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    dispatcherQueryMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.assign(QgridDispatcher, { grokDispatcher: null });
    delete QgridDispatcher.startupState.grok;
  });

  async function startGrokLogin(name: string) {
    const result = await QgridFrame.oauthStartGrok(name);
    const url = new URL(result.authUrl);
    return { result, url, state: url.searchParams.get("state") ?? "" };
  }

  it("oauthStartGrok returns an xAI authorize URL with the Grok client id in paste mode", async () => {
    const { result, url, state } = await startGrokLogin("grok-a");

    expect(result.mode).toBe("code");
    expect(url.origin).toBe("https://auth.x.ai");
    expect(url.searchParams.get("client_id")).toBe(GROK_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(state.length).toBeGreaterThan(20);
  });

  it("oauthComplete binds a bare code to the pending Grok login and stores Grok credentials", async () => {
    const { url, state } = await startGrokLogin("grok-a");
    const credentials = grokCredentials();
    completeGrokOAuthMock.mockResolvedValueOnce(credentials);

    await expect(QgridFrame.oauthComplete("  bare-code-123  ")).resolves.toEqual({
      added: true,
      name: "grok-a",
    });

    expect(completeGrokOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codeOrUrl: "  bare-code-123  ",
        state,
        redirectUri: url.searchParams.get("redirect_uri"),
        verifier: expect.any(String),
      }),
    );
    expect(replaceByAccountMock).toHaveBeenCalledWith("grok", credentials.userId, {
      provider: "grok",
      credentials,
      name: "grok-a",
    });
    // The pending login is single-use.
    await expect(QgridFrame.oauthComplete("bare-code-123")).rejects.toThrow("code#state");
  });

  it("oauthComplete accepts the pasted callback URL by its state", async () => {
    const { url, state } = await startGrokLogin("grok-b");
    completeGrokOAuthMock.mockResolvedValueOnce(grokCredentials());
    const pasted = `${url.searchParams.get("redirect_uri")}?code=abc&state=${state}`;

    await expect(QgridFrame.oauthComplete(pasted)).resolves.toEqual({ added: true, name: "grok-b" });
    expect(completeGrokOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ codeOrUrl: pasted, state }),
    );
  });

  it("oauthComplete rejects an exchange that does not yield an at+jwt", async () => {
    await startGrokLogin("grok-a");
    completeGrokOAuthMock.mockRejectedValueOnce(
      new GrokOAuthError("invalid_access_token", "access token is not an at+jwt"),
    );

    await expect(QgridFrame.oauthComplete("bare-code")).rejects.toThrow(
      SD("qgrid.grokLoginFailed")("access token is not an at+jwt"),
    );
    expect(replaceByAccountMock).not.toHaveBeenCalled();
  });

  it("refuses to store API-key shaped credentials", async () => {
    await startGrokLogin("grok-a");
    completeGrokOAuthMock.mockResolvedValueOnce(grokCredentials({ accessToken: "xai-api-key" }));

    await expect(QgridFrame.oauthComplete("bare-code")).rejects.toThrow(
      SD("qgrid.grokNotOAuthToken"),
    );
    expect(replaceByAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a bare code when no Grok login is pending", async () => {
    await expect(QgridFrame.oauthComplete("orphan-code")).rejects.toThrow("code#state");
    expect(completeGrokOAuthMock).not.toHaveBeenCalled();
  });

  it("device code login polls pending, slow_down, then added", async () => {
    startGrokDeviceCodeMock.mockResolvedValueOnce({
      deviceCode: "dev-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://accounts.x.ai/device",
      expiresIn: 600,
      interval: 5,
    });
    const credentials = grokCredentials();
    pollGrokDeviceCodeMock
      .mockResolvedValueOnce({ status: "pending", interval: 5 })
      .mockResolvedValueOnce({ status: "pending", interval: 10 })
      .mockResolvedValueOnce({ status: "complete", credentials });

    await expect(QgridFrame.oauthStartGrokDevice("grok-dev")).resolves.toMatchObject({
      userCode: "ABCD-EFGH",
      interval: 5,
    });
    await expect(QgridFrame.oauthPollGrokDevice("dev-1")).resolves.toEqual({
      status: "pending",
      intervalSec: 5,
    });
    await expect(QgridFrame.oauthPollGrokDevice("dev-1")).resolves.toEqual({
      status: "slow_down",
      intervalSec: 10,
    });
    await expect(QgridFrame.oauthPollGrokDevice("dev-1")).resolves.toEqual({
      status: "added",
      name: "grok-dev",
    });

    expect(pollGrokDeviceCodeMock).toHaveBeenLastCalledWith({ deviceCode: "dev-1", interval: 10 });
    expect(replaceByAccountMock).toHaveBeenCalledWith("grok", credentials.userId, {
      provider: "grok",
      credentials,
      name: "grok-dev",
    });
    await expect(QgridFrame.oauthPollGrokDevice("dev-1")).rejects.toThrow("expired");
  });

  it("device code polling drops the login when the user denies it", async () => {
    startGrokDeviceCodeMock.mockResolvedValueOnce({
      deviceCode: "dev-2",
      userCode: "WXYZ",
      verificationUri: "https://accounts.x.ai/device",
      expiresIn: 600,
      interval: 5,
    });
    pollGrokDeviceCodeMock.mockRejectedValueOnce(
      new GrokOAuthError("access_denied", "authorization denied by the user"),
    );

    await QgridFrame.oauthStartGrokDevice("grok-dev");
    await expect(QgridFrame.oauthPollGrokDevice("dev-2")).rejects.toThrow("denied");
    await expect(QgridFrame.oauthPollGrokDevice("dev-2")).rejects.toThrow("expired");
    expect(pollGrokDeviceCodeMock).toHaveBeenCalledTimes(1);
  });

  it("query with grok/<model> reaches the registered Grok dispatcher", async () => {
    const generate = vi.fn(async () => ({
      text: "grok says hi",
      tokenName: "grok-a",
      usage: {
        totalTokens: 3,
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
      durationMs: 5,
      model: "grok-4.7",
      threadCoord: { workerId: 1, threadId: "t", epoch: 0 },
    }));
    const routing = new QgridDispatcherClass({
      grokDispatcher: {
        generate,
        generateStream: vi.fn(),
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        onTokenAdded: vi.fn(),
        onTokenUpdated: vi.fn(),
        onTokenRemoved: vi.fn(),
        replaceTokens: vi.fn(),
      },
    });
    dispatcherQueryMock.mockImplementationOnce(
      (input: Parameters<typeof routing.query>[0], signal?: AbortSignal) =>
        routing.query(input, signal),
    );

    const result = await QgridFrame.query({ prompt: "hi", model: "grok/grok-4.7" });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: "grok-4.7" }));
    expect(result.text).toBe("grok says hi");
  });

  it("usage reports cached Grok billing without keepalive", async () => {
    const credentials = grokCredentials();
    findManyMock.mockResolvedValueOnce({
      rows: [{ ...tokenEntry, id: 9, provider: "grok", name: "grok-a", credentials }],
    });
    Object.assign(QgridDispatcher, {
      grokDispatcher: {
        tokenStates: () => [
          {
            id: 9,
            name: "grok-a",
            lastBilling: {
              utilizationPct: 42,
              periodType: "USAGE_PERIOD_TYPE_WEEKLY",
              periodEnd: "2030-01-08T00:00:00Z",
              fetchedAt: 1,
            },
            onDemandExcluded: true,
            zdrVideoExcluded: true,
            lastTier: "Ultra",
          },
        ],
      },
    });

    await expect(QgridFrame.usage(9)).resolves.toEqual({
      provider: "grok",
      fiveHour: null,
      sevenDay: { utilization: 42, resetsAt: "2030-01-08T00:00:00Z" },
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      tier: "Ultra",
      onDemandExcluded: true,
      zdrVideoExcluded: true,
      keepaliveApplicable: false,
    });
  });

  it("usage falls back to the stored tier before the first billing fetch", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [
        { ...tokenEntry, id: 9, provider: "grok", name: "grok-a", credentials: grokCredentials() },
      ],
    });

    await expect(QgridFrame.usage(9)).resolves.toMatchObject({
      provider: "grok",
      sevenDay: null,
      tier: "Super",
      onDemandExcluded: false,
      zdrVideoExcluded: false,
      keepaliveApplicable: false,
    });
  });

  it("health includes the Grok startup state", async () => {
    QgridDispatcher.startupState.grok = "ready";

    const health = await QgridFrame.health();

    expect(health.providers.grok).toBe("ready");
    expect(health.ready).toBe(true);
  });
});


// ─── U11: Grok media/voice endpoints, providerOptions/providerMetadata, tool emulation ───

type FakeGrok = Record<string, ReturnType<typeof vi.fn>>;

function grokTurn(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text: "grok says hi",
    tokenName: "grok/a",
    usage: {
      totalTokens: 30,
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 10,
      reasoningOutputTokens: 2,
      contextTokens: 30,
    },
    durationMs: 5,
    ttftMs: 2,
    model: "grok-4.7",
    threadCoord: { workerId: 7, threadId: "t", epoch: -1 },
    costUsd: 0.000_338,
    costSource: "provider" as const,
    providerMetadata: { xai: { costInUsdTicks: 3_380_000, contextWindow: 256_000 } },
    ...overrides,
  };
}

function directProvider(result: GenerateResult) {
  return {
    generate: vi.fn(async (_req: GenerateRequest) => result),
    generateStream: vi.fn(async (_req: GenerateRequest, cb: GenerateStreamCallbacks) => {
      cb.onDelta(result.text);
      cb.onComplete(result);
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onTokenAdded: vi.fn(),
    onTokenUpdated: vi.fn(),
    onTokenRemoved: vi.fn(),
    replaceTokens: vi.fn(),
  };
}

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString("base64");

describe("QgridFrame Grok media and voice (U11)", () => {
  let grok: FakeGrok;

  beforeEach(() => {
    requestLogCreateRunMock.mockReset().mockResolvedValue(77);
    requestLogFinishRunMock.mockReset().mockResolvedValue(undefined);
    appendStepMock.mockReset().mockResolvedValue(1);
    continueToolRunMock.mockReset().mockResolvedValue(1);
    findActiveByProviderAndNameMock.mockReset();
    grok = {
      generateImages: vi.fn(),
      editImages: vi.fn(),
      startVideo: vi.fn(),
      getVideo: vi.fn(),
      transcribe: vi.fn(),
      speak: vi.fn(),
    };
    Object.assign(QgridDispatcher, { grokDispatcher: grok });
  });

  afterEach(() => {
    Object.assign(QgridDispatcher, { grokDispatcher: null });
  });

  it("generateImages routes grok/* to the Grok dispatcher and returns b64 plus the reported cost", async () => {
    grok.editImages!.mockResolvedValueOnce({
      result: {
        data: [{ b64_json: PNG_B64, mime_type: "image/png", revised_prompt: "a cat" }],
        usage: { cost_in_usd_ticks: 500_000_000 },
      },
      tokenId: 3,
      tokenName: "grok/a",
    });
    findActiveByProviderAndNameMock.mockResolvedValueOnce({ id: 3 });
    const ref = "data:image/png;base64," + PNG_B64;

    const out = await QgridFrame.generateImages({
      model: "grok/grok-imagine-image-quality",
      prompt: "cat",
      n: 1,
      aspectRatio: "1:1",
      referenceImages: [ref],
      tokenName: "grok/a",
      projectName: "proj",
    });

    expect(grok.generateImages).not.toHaveBeenCalled();
    expect(grok.editImages).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-imagine-image-quality",
        prompt: "cat",
        n: 1,
        aspectRatio: "1:1",
        images: [ref],
        preferredTokenId: 3,
        requirePreferredToken: true,
      }),
    );
    expect(out).toEqual({
      model: "grok/grok-imagine-image-quality",
      tokenName: "grok/a",
      images: [{ b64: PNG_B64, mimeType: "image/png", revisedPrompt: "a cat" }],
      usage: { imageCount: 1, costInUsdTicks: 500_000_000 },
      costUsd: 0.05,
      costSource: "provider",
      requestLogId: 77,
    });
    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_model_name: "grok/grok-imagine-image-quality",
        project_name: "proj",
        is_image_generation: true,
      }),
    );
    const step = appendStepMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(step).toMatchObject({ type: "tool_call", tool_name: "image_generation" });
    expect(JSON.parse(step.tool_args as string)).toMatchObject({
      kind: "image",
      imageCount: 1,
      costInUsdTicks: 500_000_000,
      costSource: "provider",
      inputImages: [{ mediaType: "image/png", data: PNG_B64 }],
    });
    expect(requestLogFinishRunMock).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        status: "succeeded",
        token_name: "grok/a",
        model_name: "grok/grok-imagine-image-quality",
        cost_usd: 0,
        cost_source: "provider",
        is_image_generation: true,
        image_cost_usd: 50_000,
        image_cost_method: "reported:grok/grok-imagine-image-quality:ticks=500000000",
      }),
    );
  });

  it("generateImages falls back to the catalog estimate when xAI reports no ticks", async () => {
    grok.generateImages!.mockResolvedValueOnce({
      result: { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }] },
      tokenId: 3,
      tokenName: "grok/a",
    });

    const out = await QgridFrame.generateImages({ model: "grok/grok-imagine-image-quality", prompt: "x", n: 2, logger: false });

    expect(out.costUsd).toBeCloseTo(0.1, 12);
    expect(out.costSource).toBe("pricing_table");
    expect(out.images.map((image) => image.mimeType)).toEqual(["image/png", "image/png"]);
    expect(out.requestLogId).toBeUndefined();
    expect(requestLogCreateRunMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ model: "openai/gpt-image-2", prompt: "x" }, "model"],
    [{ model: "grok/grok-imagine-image", prompt: "x", referenceImages: ["http://example.com/a.png"] }, "https"],
    [{ model: "grok/grok-imagine-image", prompt: "x", referenceImages: ["data:image/gif;base64,R0lG"] }, "image/png"],
    [
      {
        model: "grok/grok-imagine-image",
        prompt: "x",
        referenceImages: ["data:image/png;base64," + "A".repeat(28 * 1024 * 1024)],
      },
      "7 MiB",
    ],
  ])("generateImages rejects invalid input %#", async (input, message) => {
    await expect(QgridFrame.generateImages(input)).rejects.toThrow(message);
    expect(grok.generateImages).not.toHaveBeenCalled();
    expect(grok.editImages).not.toHaveBeenCalled();
  });

  it("caps inline media so every accepted request fits the JSON body limit", () => {
    // Largest base64 string whose decoded size is exactly the inline budget.
    const b64 = (bytes: number) => Buffer.alloc(bytes).toString("base64");
    const atLimit = "data:image/png;base64," + b64(MEDIA_MAX_INLINE_BYTES);
    const overLimit = "data:image/png;base64," + b64(MEDIA_MAX_INLINE_BYTES + 1);
    const half = "data:image/png;base64," + b64(MEDIA_MAX_INLINE_BYTES / 2 + 1);

    const largest = { model: "grok/grok-imagine-image", prompt: "x".repeat(4096), referenceImages: [atLimit] };
    expect(GenerateImagesInput.safeParse(largest).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(largest))).toBeLessThan(REQUEST_BODY_LIMIT_BYTES);
    expect(GenerateImagesInput.safeParse({ ...largest, referenceImages: [overLimit] }).success).toBe(false);
    // The aggregate counts every inline image of the request, not just each one.
    const split = GenerateImagesInput.safeParse({ ...largest, referenceImages: [half, half] });
    expect(split.success).toBe(false);
    expect(split.error?.issues.map((issue) => issue.message)).toContain("inline images exceed 7 MiB in total");
    expect(
      VideoStartInput.safeParse({ model: "grok/grok-imagine-video", prompt: "x", image: half, lastFrame: half }).success,
    ).toBe(false);

    // qgrid has no source-video input, and reference-to-video needs reference images.
    const video = { model: "grok/grok-imagine-video", prompt: "x" };
    for (const mode of ["edit-video", "extend-video"]) {
      expect(VideoStartInput.safeParse({ ...video, mode }).success).toBe(false);
    }
    const noReferences = VideoStartInput.safeParse({ ...video, mode: "reference-to-video" });
    expect(noReferences.error?.issues.map((issue) => issue.path.join("."))).toEqual(["referenceImages"]);
    expect(
      VideoStartInput.safeParse({ ...video, mode: "reference-to-video", referenceImages: ["https://x/r.png"] })
        .success,
    ).toBe(true);

    const audio = { audio: b64(MEDIA_MAX_INLINE_BYTES), mediaType: "audio/wav" };
    expect(TranscribeInput.safeParse(audio).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(audio))).toBeLessThan(REQUEST_BODY_LIMIT_BYTES);
    expect(TranscribeInput.safeParse({ ...audio, audio: b64(MEDIA_MAX_INLINE_BYTES + 1) }).success).toBe(false);
  });

  it("answers an oversize JSON body with a Sonamu 413 instead of a 500", async () => {
    const server = Fastify({ bodyLimit: REQUEST_BODY_LIMIT_BYTES });
    server.setErrorHandler((error, _request, reply) => {
      handleServerError(mapRequestBodyTooLarge(error), reply);
    });
    server.post("/media", async () => ({ ok: true }));
    try {
      const payload = JSON.stringify({ audio: "A".repeat(REQUEST_BODY_LIMIT_BYTES), mediaType: "audio/wav" });
      const tooLarge = await server.inject({
        method: "POST",
        url: "/media",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toEqual({ name: "Error", message: SD("qgrid.requestBodyTooLarge")(10) });

      const ok = await server.inject({ method: "POST", url: "/media", payload: { ok: true } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("videoStart answers GrokZdrVideoUnavailableError as 503 and logs the provider message", async () => {
    const zdr = new GrokZdrVideoUnavailableError(["grok/a"]);
    grok.startVideo!.mockRejectedValueOnce(zdr);

    const error = await QgridFrame.videoStart({ model: "grok/grok-imagine-video-1.5", prompt: "x" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).toMatchObject({ statusCode: 503, message: SD("qgrid.grokZdrVideoUnavailable")("grok/a") });
    expect(requestLogFinishRunMock).toHaveBeenCalledWith(77, { status: "error", error_message: zdr.message });
  });

  it("generateImages records a failed provider call as an error run", async () => {
    grok.generateImages!.mockRejectedValueOnce(new Error("upstream 500"));

    await expect(QgridFrame.generateImages({ model: "grok/grok-imagine-image", prompt: "x" })).rejects.toThrow("upstream 500");

    expect(requestLogFinishRunMock).toHaveBeenCalledWith(77, { status: "error", error_message: "upstream 500" });
  });

  it("videoStart/videoStatus polls the starting token, checks the owner, and passes the URL through", async () => {
    grok.startVideo!.mockResolvedValueOnce({ result: { request_id: "req-1" }, tokenId: 9, tokenName: "grok/b" });
    const url = "https://vidgen.x.ai/abc/video.mp4?sig=opaque";
    grok.getVideo!
      .mockResolvedValueOnce({ result: { status: "pending" }, tokenId: 9, tokenName: "grok/b" })
      .mockResolvedValueOnce({
        result: { status: "done", video: { url, duration: 6 }, usage: { cost_in_usd_ticks: 2_000_000_000 } },
        tokenId: 9,
        tokenName: "grok/b",
      });

    const started = await QgridFrame.videoStart({
      model: "grok/grok-imagine-video-1.5",
      prompt: "waves",
      duration: 6,
      resolution: "720p",
      projectName: "proj",
    });
    expect(started.jobHandle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(started).toMatchObject({ model: "grok/grok-imagine-video-1.5", requestLogId: 77 });
    expect(grok.startVideo).toHaveBeenCalledWith(
      expect.objectContaining({ model: "grok-imagine-video-1.5", duration: 6, resolution: "720p" }),
    );
    expect(appendStepMock).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ type: "tool_call", tool_name: "video_generation", tool_call_id: "video_generation:req-1" }),
    );
    expect(appendStepMock.mock.calls[0]![1]).not.toHaveProperty("tool_result");

    // A different owner, or no owner, sees the same 404 as an unknown handle.
    await expect(QgridFrame.videoStatus({ jobHandle: started.jobHandle, projectName: "other" })).rejects.toThrow(SD("qgrid.videoJobNotFound"));
    await expect(QgridFrame.videoStatus({ jobHandle: started.jobHandle })).rejects.toThrow(SD("qgrid.videoJobNotFound"));
    await expect(QgridFrame.videoStatus({ jobHandle: "A".repeat(22), projectName: "proj" })).rejects.toThrow(SD("qgrid.videoJobNotFound"));
    expect(grok.getVideo).not.toHaveBeenCalled();

    await expect(QgridFrame.videoStatus({ jobHandle: started.jobHandle, projectName: "proj" })).resolves.toEqual({
      status: "pending",
      mimeType: "video/mp4",
      requestLogId: 77,
    });
    const done = await QgridFrame.videoStatus({ jobHandle: started.jobHandle, projectName: "proj" });
    expect(done).toEqual({
      status: "done",
      url,
      mimeType: "video/mp4",
      durationSec: 6,
      costInUsdTicks: 2_000_000_000,
      costUsd: 0.2,
      requestLogId: 77,
    });
    expect(grok.getVideo).toHaveBeenCalledWith(9, "req-1", expect.any(AbortSignal));

    // The terminal result is cached: no further upstream poll, no second log write.
    await expect(QgridFrame.videoStatus({ jobHandle: started.jobHandle, projectName: "proj" })).resolves.toEqual(done);
    expect(grok.getVideo).toHaveBeenCalledTimes(2);
    expect(continueToolRunMock).toHaveBeenCalledTimes(1);
    expect(continueToolRunMock).toHaveBeenCalledWith(77, [
      expect.objectContaining({ toolCallId: "video_generation:req-1", isError: false }),
    ]);
    expect(requestLogFinishRunMock).toHaveBeenCalledTimes(1);
    expect(requestLogFinishRunMock).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        status: "succeeded",
        response: url,
        token_name: "grok/b",
        model_name: "grok/grok-imagine-video-1.5",
        cost_usd: 200_000,
        cost_source: "provider",
      }),
    );
  });

  it("videoStatus logs a terminal result once when polls overlap", async () => {
    grok.startVideo!.mockResolvedValueOnce({ result: { request_id: "req-1" }, tokenId: 9, tokenName: "grok/b" });
    let release!: () => void;
    const upstream = new Promise<void>((resolve) => (release = resolve));
    grok.getVideo!.mockImplementation(async () => {
      await upstream;
      return { result: { status: "done", video: { url: "https://x/v.mp4" } }, tokenId: 9, tokenName: "grok/b" };
    });
    const { jobHandle } = await QgridFrame.videoStart({ model: "grok/grok-imagine-video-1.5", prompt: "x" });

    const polls = [QgridFrame.videoStatus({ jobHandle }), QgridFrame.videoStatus({ jobHandle })];
    release();
    const [first, second] = await Promise.all(polls);

    expect(grok.getVideo).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
    expect(continueToolRunMock).toHaveBeenCalledTimes(1);
    expect(requestLogFinishRunMock).toHaveBeenCalledTimes(1);
  });

  it("videoStatus reports a content-policy block as a failed job", async () => {
    grok.startVideo!.mockResolvedValueOnce({ result: { request_id: "req-2" }, tokenId: 9, tokenName: "grok/b" });
    grok.getVideo!.mockResolvedValueOnce({
      result: { status: "done", video: { url: "https://x/v.mp4", respect_moderation: false } },
      tokenId: 9,
      tokenName: "grok/b",
    });
    const { jobHandle } = await QgridFrame.videoStart({ model: "grok/grok-imagine-video-1.5", prompt: "x" });

    const status = await QgridFrame.videoStatus({ jobHandle });

    expect(status).toMatchObject({ status: "failed", mimeType: "video/mp4" });
    expect(status.url).toBeUndefined();
    expect(requestLogFinishRunMock).toHaveBeenCalledWith(77, expect.objectContaining({ status: "error" }));
  });

  it("transcribe decodes base64 audio and returns the transcript", async () => {
    grok.transcribe!.mockResolvedValueOnce({
      result: { text: "hello there", language: "en", duration: 1.5 },
      tokenId: 3,
      tokenName: "grok/a",
    });
    const audio = Buffer.from("RIFFfakewav").toString("base64");

    const out = await QgridFrame.transcribe({ audio, mediaType: "audio/wav", language: "en" });

    expect(out).toEqual({
      text: "hello there",
      language: "en",
      durationSec: 1.5,
      model: "grok/grok-voice-transcribe-2.0",
      tokenName: "grok/a",
      requestLogId: 77,
    });
    const request = grok.transcribe!.mock.calls[0]![0] as { audio: Uint8Array; mediaType: string; model: string };
    expect(Buffer.from(request.audio).toString()).toBe("RIFFfakewav");
    expect(request).toMatchObject({ mediaType: "audio/wav", model: "grok-voice-transcribe-2.0" });
    expect(requestLogFinishRunMock).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ status: "succeeded", response: "hello there", cost_usd: null, cost_source: null }),
    );
  });

  it("transcribe rejects non-base64 and non-audio input before dispatch", async () => {
    await expect(QgridFrame.transcribe({ audio: "not base64!", mediaType: "audio/wav" })).rejects.toThrow("base64");
    await expect(QgridFrame.transcribe({ audio: "AAAA", mediaType: "video/mp4" })).rejects.toThrow("audio/*");
    expect(grok.transcribe).not.toHaveBeenCalled();
  });

  it("speak applies the /tts defaults and returns base64 audio", async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 1, 2]);
    grok.speak!.mockResolvedValueOnce({ result: { audio: bytes, mediaType: "audio/mpeg" }, tokenId: 3, tokenName: "grok/a" });

    const out = await QgridFrame.speak({ text: "hi" });

    expect(grok.speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hi", voice: "ara", language: "en", format: "mp3" }),
    );
    expect(out).toEqual({
      audio: Buffer.from(bytes).toString("base64"),
      mimeType: "audio/mpeg",
      tokenName: "grok/a",
      requestLogId: 77,
    });
    expect(Buffer.from(out.audio, "base64")).toEqual(Buffer.from(bytes));
    // No ticks reported: the cost is unknown, not a guessed 0.
    expect(requestLogFinishRunMock).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ status: "succeeded", cost_usd: null, cost_source: null }),
    );
  });

  it("media endpoints answer not-ready when no Grok media dispatcher is registered", async () => {
    Object.assign(QgridDispatcher, { grokDispatcher: null });
    await expect(QgridFrame.speak({ text: "hi" })).rejects.toThrow(SD("qgrid.dispatcherStarting")("Grok"));
    expect(requestLogCreateRunMock).not.toHaveBeenCalled();
  });
});

describe("QgridFrame Grok query contract (U11)", () => {
  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 61, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    dispatcherQueryMock.mockReset();
    dispatcherQueryStreamMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards providerOptions.xai and surfaces providerMetadata.xai with the provider cost", async () => {
    const grok = directProvider(grokTurn());
    const routing = new QgridDispatcherClass({ grokDispatcher: grok });
    dispatcherQueryMock.mockImplementationOnce((input: Parameters<typeof routing.query>[0], signal?: AbortSignal) =>
      routing.query(input, signal),
    );

    const out = await QgridFrame.query({
      prompt: "hi",
      model: "grok/grok-4.7",
      providerOptions: { xai: { serviceTier: "priority", parallelToolCalls: false } },
    });

    expect(grok.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-4.7",
        providerOptions: { xai: { serviceTier: "priority", parallelToolCalls: false } },
      }),
    );
    expect(out).toMatchObject({
      requestLogId: 61,
      costUsd: 0.000_338,
      costSource: "provider",
      providerMetadata: { xai: { costInUsdTicks: 3_380_000, contextWindow: 256_000 } },
    });
  });

  it("keeps a reported zero-tick cost authoritative and prices a tickless turn from the catalog", async () => {
    const zero = directProvider(grokTurn({ costUsd: 0, providerMetadata: { xai: { costInUsdTicks: 0 } } }));
    const zeroOut = await new QgridDispatcherClass({ grokDispatcher: zero }).query({ prompt: "hi", model: "grok/grok-4.7" });
    expect(zeroOut).toMatchObject({ costUsd: 0, costSource: "provider" });

    const tickless = directProvider(grokTurn({ costUsd: undefined, costSource: undefined, providerMetadata: undefined }));
    const ticklessOut = await new QgridDispatcherClass({ grokDispatcher: tickless }).query({ prompt: "hi", model: "grok/grok-4.7" });
    // 15 uncached input * $2/M + 5 cached * $0.5/M + 10 output * $6/M
    expect(ticklessOut.costSource).toBe("pricing_table");
    expect(ticklessOut.costUsd).toBeCloseTo((15 * 2 + 5 * 0.5 + 10 * 6) / 1_000_000, 15);
    expect(ticklessOut.providerMetadata).toBeUndefined();
  });

  it("publishes providerMetadata.xai on the stream done event", async () => {
    const grok = directProvider(grokTurn());
    const routing = new QgridDispatcherClass({ grokDispatcher: grok });
    dispatcherQueryStreamMock.mockImplementationOnce(
      (input: Parameters<typeof routing.queryStream>[0], cb: Parameters<typeof routing.queryStream>[1], signal?: AbortSignal) =>
        routing.queryStream(input, cb, signal),
    );
    const sse = { closed: false, publish: vi.fn(), onClose: vi.fn(), end: vi.fn(async () => {}) };
    vi.spyOn(Sonamu, "getContext").mockReturnValue({ createSSE: vi.fn(() => sse) } as never);

    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "grok/grok-4.7",
      providerOptions: { xai: { serviceTier: "default" } },
    });
    await QgridFrame.queryStream(streamId);

    expect(grok.generateStream).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: { xai: { serviceTier: "default" } } }),
      expect.anything(),
    );
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({
        requestLogId: 61,
        costSource: "provider",
        providerMetadata: { xai: { costInUsdTicks: 3_380_000, contextWindow: 256_000 } },
      }),
    );
  });

  it.each([true, false])(
    "answers a Grok caller-validation error as 400, logged run=%s",
    async (logged) => {
      const grok = directProvider(grokTurn());
      const invalid = new GrokInvalidRequestError("Unsupported Grok history item at index 0");
      grok.generate.mockRejectedValueOnce(invalid);
      const routing = new QgridDispatcherClass({ grokDispatcher: grok });
      dispatcherQueryMock.mockImplementationOnce((input: Parameters<typeof routing.query>[0], signal?: AbortSignal) =>
        routing.query(input, signal),
      );

      const error = await QgridFrame.query({
        prompt: "hi",
        model: "grok/grok-4.7",
        history: "[{}]",
        ...(logged ? {} : { logger: false }),
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).toMatchObject({
        statusCode: 400,
        message: SD("qgrid.grokInvalidRequest")(invalid.message),
      });
      if (logged) {
        // The run keeps the provider's own message.
        expect(finishRunWithErrorMock).toHaveBeenCalledWith(61, invalid.message, expect.anything());
      }
    },
  );

  it("keeps Grok upstream failures as server errors", async () => {
    const grok = directProvider(grokTurn());
    const upstream = new Error("grok upstream 502");
    grok.generate.mockRejectedValueOnce(upstream);
    const routing = new QgridDispatcherClass({ grokDispatcher: grok });
    dispatcherQueryMock.mockImplementationOnce((input: Parameters<typeof routing.query>[0], signal?: AbortSignal) =>
      routing.query(input, signal),
    );

    await expect(QgridFrame.query({ prompt: "hi", model: "grok/grok-4.7" })).rejects.toBe(upstream);
  });

  it.each([
    [new GrokOnDemandExcludedError(["grok-a", "grok-b"]), SD("qgrid.grokOnDemandExcluded")("grok-a, grok-b")],
    [new GrokCapacityError(), SD("qgrid.grokCapacity")],
    [new GrokNoWorkersError(), SD("qgrid.grokNoWorkers")("NO_GROK_WORKERS")],
  ])("answers a Grok no-eligible-token error as 503 (%s)", async (excluded, message) => {
    const grok = directProvider(grokTurn());
    grok.generate.mockRejectedValueOnce(excluded);
    const routing = new QgridDispatcherClass({ grokDispatcher: grok });
    dispatcherQueryMock.mockImplementationOnce((input: Parameters<typeof routing.query>[0], signal?: AbortSignal) =>
      routing.query(input, signal),
    );

    const error = await QgridFrame.query({ prompt: "hi", model: "grok/grok-4.7" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).toMatchObject({ statusCode: 503, message });
  });

  it("answers GrokRateLimitedError as 429 with the cooldown in Retry-After", async () => {
    const header = vi.fn();
    const responseRaw = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false });
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      transport: "http",
      request: { raw: Object.assign(new EventEmitter(), { aborted: false }) },
      reply: { raw: responseRaw, header },
    } as never);
    const grok = directProvider(grokTurn());
    grok.generate.mockRejectedValueOnce(new GrokRateLimitedError(42));
    const routing = new QgridDispatcherClass({ grokDispatcher: grok });
    dispatcherQueryMock.mockImplementationOnce((input: Parameters<typeof routing.query>[0], signal?: AbortSignal) =>
      routing.query(input, signal),
    );

    const error = await QgridFrame.query({ prompt: "hi", model: "grok/grok-4.7", logger: false }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ statusCode: 429, message: SD("qgrid.grokRateLimited")(42) });
    expect(header).toHaveBeenCalledWith("Retry-After", "42");

    // The server error handler keeps a Sonamu 429 and does not pin a 503 Retry-After over it.
    const reply = { header: vi.fn(), status: vi.fn(), send: vi.fn() };
    reply.status.mockReturnValue(reply);
    handleServerError(error as Error, reply as never);
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.header).not.toHaveBeenCalled();
  });

  it("runs grok tools through the same structured-output emulation as openai (D8)", async () => {
    const tools = [
      {
        name: "get_weather",
        description: "weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ];
    const envelope = JSON.stringify({
      result: { action: "tool_call", answer: null, toolCalls: [{ toolName: "get_weather", args: '{"city":"Seoul"}' }] },
    });
    const grok = directProvider(grokTurn({ text: envelope }));
    const openai = directProvider(grokTurn({ text: envelope, model: "gpt-6-sol", providerMetadata: undefined }));
    const routing = new QgridDispatcherClass({ grokDispatcher: grok });
    routing.openaiDispatcher = openai as never;

    const grokOut = await routing.query({ prompt: "weather?", model: "grok/grok-4.7", tools });
    const openaiOut = await routing.query({ prompt: "weather?", model: "openai/gpt-6-sol", tools });

    const grokReq = grok.generate.mock.calls[0]![0];
    const openaiReq = openai.generate.mock.calls[0]![0];
    // No native tool plumbing: the envelope schema is the only tool contract on the wire.
    expect(grokReq.tools).toBeUndefined();
    expect(grokReq.outputSchema).toEqual(openaiReq.outputSchema);
    expect(typeof grokReq.stopAfterOutputMessage).toBe("function");
    for (const out of [grokOut, openaiOut]) {
      expect(out.finishReason).toBe("tool-calls");
      expect(out.content).toEqual([
        { type: "tool-call", toolCallId: expect.stringMatching(/^call_/), toolName: "get_weather", input: '{"city":"Seoul"}' },
      ]);
    }

    // Follow-up with tool results continues the existing way and decodes the answer envelope.
    const answer = JSON.stringify({ result: { action: "answer", answer: "Sunny", toolCalls: null } });
    grok.generate.mockResolvedValueOnce(grokTurn({ text: answer }));
    const followUp = await routing.query({
      prompt: "weather?",
      model: "grok/grok-4.7",
      tools,
      toolResults: [{ toolCallId: "call_1", toolName: "get_weather", output: "sunny, 21C" }],
    });
    expect(followUp).toMatchObject({ finishReason: "stop", text: "Sunny" });
    const followReq = grok.generate.mock.calls[1]![0];
    expect(JSON.stringify(followReq.coldInput)).toContain("sunny, 21C");
  });
});
