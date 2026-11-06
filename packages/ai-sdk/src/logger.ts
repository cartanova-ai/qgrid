import {
  type GenerateTextAbortEvent,
  type GenerateTextEndEvent,
  type GenerateTextStartEvent,
  type GenerateTextStepEndEvent,
  type InferTelemetryEvent,
  type Telemetry,
  type TelemetryOptions,
  type ToolExecutionEndEvent,
} from "ai";
import { z } from "zod";

import { type FinishRunInput, type QgridLoggerConfig } from "./index.types";
import { DEFAULT_QGRID_SERVER_URL, QGRID_PROVIDER_NAME } from "./qgrid.constant";
import {
  appendStep,
  createRun,
  extractSystemPrompt,
  extractUserPrompt,
  finishRun,
  getErrorMessage,
  loggedPayloadText,
  serializeHistory,
} from "./utils";

type PendingToolCall = {
  stepIndex: number;
  toolCallIndex: number;
  toolCallId: string;
  toolName: string;
  toolArgs: string;
  modelName?: string;
  requestedModelName: string;
};

type RunState = {
  requestLogId: number;
  requestedModelName: string;
  isStructured: boolean;
  pendingSteps: Promise<unknown>[];
  pendingToolCalls: PendingToolCall[];
  startTime: number;
  toolDurations: Map<string, number>;
  watchdog?: ReturnType<typeof setTimeout>;
  finishing: boolean;
};

type RunResult = {
  status: "succeeded" | "error" | "aborted";
  response?: string;
  errorMessage?: string;
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  modelName?: string;
  requestedModelName?: string;
};

type OperationStartEvent = Parameters<NonNullable<Telemetry["onStart"]>>[0];

type OperationEndEvent = Parameters<NonNullable<Telemetry["onEnd"]>>[0];

type TextStartEvent = InferTelemetryEvent<GenerateTextStartEvent>;

type TextEndEvent = InferTelemetryEvent<GenerateTextEndEvent>;

const DEFAULT_STALE_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_RUN_GRACE_MS = 5000;

const STALE_RUN_ERROR =
  "AI SDK generation reported no end, error, or abort before the stale-run timeout";

const TEXT_OPERATIONS = new Set(["ai.generateText", "ai.streamText"]);

// AI SDK types the onError event as unknown; text generations report { callId, error }.
const errorEventSchema = z.object({ callId: z.string(), error: z.unknown() });

// abort() without a reason rejects with AbortError, and the generateText `timeout` with TimeoutError.
// Telemetry events carry no abortSignal, so abort(customReason) surfaces as that reason and stays an error.
const abortErrorSchema = z.object({ name: z.enum(["AbortError", "TimeoutError"]) });

function isTextStart(event: OperationStartEvent): event is TextStartEvent {
  return TEXT_OPERATIONS.has(event.operationId);
}

// Only text generations open runs, so an end event for a known run carries a final step.
function isTextEnd(event: OperationEndEvent): event is TextEndEvent {
  return "finalStep" in event;
}

function isParseableJson(value: string | undefined): boolean {
  try {
    JSON.parse(value ?? "");

    return true;
  } catch {
    return false;
  }
}

function fullModelName(provider: string | undefined, modelId: string | undefined) {
  if (!provider || !modelId) return undefined;
  const baseProvider = provider.split(".", 1)[0] ?? provider;
  const prefix = `${baseProvider}/`;

  return modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`;
}

function staleRunTimeout(config: QgridLoggerConfig, timeout: TextStartEvent["timeout"]): number {
  if (config.staleRunTimeoutMs !== undefined) return config.staleRunTimeoutMs;

  // TimeoutConfiguration is a number or an object; only the object is an Object instance.
  if (timeout instanceof Object) {
    const totalMs = timeout.totalMs;

    return totalMs !== undefined && totalMs > 0
      ? totalMs + STALE_RUN_GRACE_MS
      : DEFAULT_STALE_RUN_TIMEOUT_MS;
  }

  return timeout !== undefined && timeout > 0
    ? timeout + STALE_RUN_GRACE_MS
    : DEFAULT_STALE_RUN_TIMEOUT_MS;
}

export function createQgridLogger(config: QgridLoggerConfig = {}): TelemetryOptions {
  const serverUrl = config.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL;
  const projectName = config.projectName ?? process.env.QGRID_PROJECT_NAME;

  const onLogError =
    config.onLogError ?? ((e: Error) => console.warn(`[qgrid-logger] ${e.message}`));

  // Keyed by the AI SDK callId, which identifies one generateText/streamText call.
  const runs = new Map<string, RunState>();

  const finalizeRun = async (callId: string, result: RunResult) => {
    const run = runs.get(callId);

    if (!run || run.finishing) return;
    run.finishing = true;
    runs.delete(callId);

    if (run.watchdog) clearTimeout(run.watchdog);

    for (const pending of run.pendingToolCalls) {
      run.pendingSteps.push(
        appendStep(serverUrl, {
          requestLogId: run.requestLogId,
          stepIndex: pending.stepIndex,
          type: "tool_call",
          toolCallIndex: pending.toolCallIndex,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          toolArgs: pending.toolArgs,
          modelName: pending.modelName,
          requestedModelName: pending.requestedModelName,
          toolDurationMs: run.toolDurations.get(pending.toolCallId),
        }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
      );
    }

    run.pendingToolCalls = [];

    await Promise.allSettled(run.pendingSteps);

    const finishInput: FinishRunInput = {
      requestLogId: run.requestLogId,
      status: result.status,
      response: result.response,
      tokenName: config.tokenName ?? "external",
      modelName: result.modelName,
      requestedModelName: result.requestedModelName ?? run.requestedModelName,
      totalInputTokens: result.totalUsage?.inputTokens ?? 0,
      totalOutputTokens: result.totalUsage?.outputTokens ?? 0,
      totalCacheReadTokens: result.totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
      totalCacheCreationTokens: result.totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      totalDurationMs: Date.now() - run.startTime,
    };

    if (run.isStructured && result.status === "succeeded") {
      finishInput.responseJsonOk = isParseableJson(result.response);
    }

    if (result.errorMessage) finishInput.errorMessage = result.errorMessage;
    await finishRun(serverUrl, finishInput).catch((e) =>
      onLogError(e instanceof Error ? e : new Error(String(e))),
    );
  };

  const integration: Telemetry = {
    async onStart(event) {
      if (!isTextStart(event)) return;

      // qgrid provider requests own their server-side logging lifecycle.
      if (event.provider === QGRID_PROVIDER_NAME) return;

      if (event.providerOptions?.qgrid?.logger === false) return;

      const requestedModelName = fullModelName(event.provider, event.modelId) ?? event.modelId;
      const startTime = Date.now();

      try {
        const responseFormat = event.output ? await event.output.responseFormat : undefined;
        const isStructured = responseFormat?.type === "json";

        const jsonSchema =
          isStructured && responseFormat.schema !== undefined
            ? (JSON.stringify(responseFormat.schema) ?? null)
            : null;

        const result = await createRun(serverUrl, {
          userPrompt: extractUserPrompt(event.messages),
          systemPrompt: extractSystemPrompt(event.instructions),
          modelName: requestedModelName,
          projectName,
          history: serializeHistory(event.messages),
          isStructured,
          jsonSchema,
        });

        const watchdogTimeout = staleRunTimeout(config, event.timeout);
        let watchdog: ReturnType<typeof setTimeout> | undefined;

        // Safety net for generations that never report a terminal event, such as a
        // streamText result whose stream is never consumed.
        if (watchdogTimeout > 0) {
          watchdog = setTimeout(() => {
            void finalizeRun(event.callId, { status: "error", errorMessage: STALE_RUN_ERROR });
          }, watchdogTimeout);
          watchdog.unref?.();
        }

        runs.set(event.callId, {
          requestLogId: result.requestLogId,
          requestedModelName,
          isStructured,
          pendingSteps: [],
          pendingToolCalls: [],
          startTime,
          toolDurations: new Map(),
          watchdog,
          finishing: false,
        });
      } catch (e) {
        onLogError(e instanceof Error ? e : new Error(String(e)));
      }
    },

    onToolExecutionEnd(event: InferTelemetryEvent<ToolExecutionEndEvent>) {
      runs
        .get(event.callId)
        ?.toolDurations.set(event.toolCall.toolCallId, Math.round(event.toolExecutionMs));
    },

    onStepEnd(event: InferTelemetryEvent<GenerateTextStepEndEvent>) {
      const run = runs.get(event.callId);

      if (!run) return;

      const { content, usage, reasoningText, finishReason, stepNumber } = event;

      const requestedModelName =
        fullModelName(event.model.provider, event.model.modelId) ?? run.requestedModelName;

      const modelName = fullModelName(event.model.provider, event.response.modelId);

      // 이전 step의 pending tool-call 매칭
      const remainingPending: PendingToolCall[] = [];

      for (const pending of run.pendingToolCalls) {
        const tr = content.find(
          (p) => p.type === "tool-result" && p.toolCallId === pending.toolCallId,
        );

        const te = content.find(
          (p) => p.type === "tool-error" && p.toolCallId === pending.toolCallId,
        );

        // tool call 에러도 step으로 간주
        if (tr || te) {
          run.pendingSteps.push(
            appendStep(serverUrl, {
              requestLogId: run.requestLogId,
              stepIndex: pending.stepIndex,
              type: "tool_call",
              toolCallIndex: pending.toolCallIndex,
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              toolArgs: pending.toolArgs,
              modelName: pending.modelName,
              requestedModelName: pending.requestedModelName,
              toolResult: tr && "output" in tr ? loggedPayloadText.parse(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(pending.toolCallId),
              error: te && "error" in te ? getErrorMessage(te.error) : undefined,
            }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
          );
          run.toolDurations.delete(pending.toolCallId);
        } else {
          remainingPending.push(pending);
        }
      }

      run.pendingToolCalls = remainingPending;

      // generate step
      run.pendingSteps.push(
        appendStep(serverUrl, {
          requestLogId: run.requestLogId,
          stepIndex: stepNumber,
          type: "generate",
          modelName,
          requestedModelName,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          finishReason,
          reasoningText:
            reasoningText !== undefined && reasoningText.length > 0 ? reasoningText : undefined,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
      );

      // 이번 step의 새 tool-call
      const toolCalls = content.filter(
        (p): p is Extract<(typeof content)[number], { type: "tool-call" }> =>
          p.type === "tool-call",
      );

      for (const [i, tc] of toolCalls.entries()) {
        const tr = content.find((p) => p.type === "tool-result" && p.toolCallId === tc.toolCallId);
        const te = content.find((p) => p.type === "tool-error" && p.toolCallId === tc.toolCallId);

        if (tr || te) {
          run.pendingSteps.push(
            appendStep(serverUrl, {
              requestLogId: run.requestLogId,
              stepIndex: stepNumber,
              type: "tool_call",
              toolCallIndex: i,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              toolArgs: loggedPayloadText.parse(tc.input),
              modelName,
              requestedModelName,
              toolResult: tr && "output" in tr ? loggedPayloadText.parse(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(tc.toolCallId),
              error: te && "error" in te ? getErrorMessage(te.error) : undefined,
            }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
          );
          run.toolDurations.delete(tc.toolCallId);
        } else {
          run.pendingToolCalls.push({
            stepIndex: stepNumber,
            toolCallIndex: i,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            toolArgs: loggedPayloadText.parse(tc.input),
            modelName,
            requestedModelName,
          });
        }
      }
    },

    async onEnd(event) {
      const run = runs.get(event.callId);

      if (!run || !isTextEnd(event)) return;

      await finalizeRun(event.callId, {
        // A stream error part ends the generation with finishReason "error" and no error value.
        status: event.finishReason === "error" ? "error" : "succeeded",
        response: event.text,
        totalUsage: event.usage,
        modelName: fullModelName(event.model.provider, event.finalStep.response.modelId),
        requestedModelName:
          fullModelName(event.model.provider, event.model.modelId) ?? run.requestedModelName,
      });
    },

    // generateText reports cancellation here as an AbortError; streamText reports it via onAbort.
    async onError(event) {
      const parsed = errorEventSchema.safeParse(event);

      if (!parsed.success) return;
      const { callId, error } = parsed.data;

      await finalizeRun(callId, {
        status: abortErrorSchema.safeParse(error).success ? "aborted" : "error",
        errorMessage: getErrorMessage(error),
      });
    },

    async onAbort(event: InferTelemetryEvent<GenerateTextAbortEvent>) {
      await finalizeRun(event.callId, {
        status: "aborted",
        errorMessage: getErrorMessage(event.reason),
      });
    },
  };

  return { isEnabled: true, integrations: [integration] };
}
