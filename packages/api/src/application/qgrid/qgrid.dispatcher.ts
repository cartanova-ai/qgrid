// provider 라우팅과 토큰 캐시·통계. 캐시는 TokenSubscriber가 갱신한다.

import { InternalServerErrorException, ServiceUnavailableException } from "sonamu";

import { SD } from "../../i18n/sd.generated";
import { type AnthropicDispatcher } from "../../utils/providers/anthropic/anthropic-dispatcher";
import { createFenceStripTransform } from "../../utils/providers/anthropic/fence-strip";
import { getAccessToken } from "../../utils/providers/common/credentials";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
  type StreamCallbacks,
} from "../../utils/providers/common/provider-dispatcher";
import {
  isProviderId,
  type JsonValue,
  type ProviderId,
} from "../../utils/providers/common/provider-types";
import {
  parseAndValidateCallerSchemas,
  serializeAndValidateDispatchSchema,
} from "../../utils/providers/common/schema-validation";
import { strictify } from "../../utils/providers/common/strictifier";
import {
  ImageGenerationError,
  type OpenAIDispatcher,
} from "../../utils/providers/openai/openai-dispatcher";
import { type TokenSubsetA } from "../sonamu.generated";
import { decideConvRouting, issueConvContext } from "./conv-routing";
import {
  maskToken,
  ProcessError,
  type ProviderStartupState,
  type QueryInput,
  type QueryOutput,
  type TokenStats,
} from "./qgrid.types";
import { composeSystemWithSchemaContract } from "./schema-prompt";
import { type TokenSubscriber } from "./token-subscriber";
import { applyToolCallEmulation, isToolCallEnvelope } from "./tool-emulation";
import { buildToolCallSchema } from "./tool-emulation-schema";

export type InternalQueryInput = QueryInput & {
  preferredTokenId?: number;
  requirePreferredToken?: boolean;
};

// qgrid 상위가 provider 에 요구하는 실행 계약. 스트리밍은 공통 ProviderDispatcher 에 아직 없어서
// 여기서 합친다.
export type StreamingProviderDispatcher = ProviderDispatcher & {
  generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void>;
};

// TokenSubscriber 가 grok row 를 전달하는 계약. credentials 는 DB JSONB 원본이며 dispatcher 가
// 자체 스키마로 검증한다.
export type GrokTokenRow = {
  id: number;
  name: string;
  credentials: unknown;
  quotaThreshold: number | null;
  weight: number;
};

export interface GrokTokenSink {
  onTokenAdded(
    id: number,
    name: string,
    credentials: unknown,
    quotaThreshold: number | null,
    weight: number,
  ): void | Promise<void>;
  onTokenUpdated(
    id: number,
    name: string,
    credentials: unknown,
    quotaThreshold: number | null,
    weight: number,
  ): void | Promise<void>;
  onTokenRemoved(id: number): void | Promise<void>;
  replaceTokens(rows: GrokTokenRow[]): void | Promise<void>;
}

export type GrokProviderDispatcher = StreamingProviderDispatcher & GrokTokenSink;

export type QgridDispatcherOptions = {
  grokDispatcher?: GrokProviderDispatcher | null;
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  grok: "Grok",
};

export class QgridDispatcherClass {
  tokens = new Map<number, TokenSubsetA>();

  // 프로세스 시작 이후 완료된 provider generation 수. 실패/중간 시도는 제외하며,
  // 후속 tool turn도 한 generation으로 센다. 동명 토큰은 provider별로 분리한다.
  requestCounts = new Map<string, number>();

  subscriber: TokenSubscriber | null = null;

  // provider route prefix → 실행 dispatcher. 등록되지 않은 provider 는 not-ready 로 응답한다.
  readonly dispatchers = new Map<ProviderId, StreamingProviderDispatcher>();
  #openaiDispatcher: OpenAIDispatcher | null = null;
  #anthropicDispatcher: AnthropicDispatcher | null = null;
  #grokDispatcher: GrokProviderDispatcher | null = null;

  // HTTP가 dispatcher보다 먼저 열리므로 초기화 중과 초기화 실패를 구분한다.
  // grok 은 bootstrap 이 붙기 전까지 상태가 없으며, 없으면 기동 중으로 본다.
  startupState: Record<"openai" | "anthropic", ProviderStartupState> &
    Partial<Record<"grok", ProviderStartupState>> = {
    openai: "starting",
    anthropic: "starting",
  };

  constructor(options: QgridDispatcherOptions = {}) {
    if (options.grokDispatcher) this.grokDispatcher = options.grokDispatcher;
  }

  get openaiDispatcher(): OpenAIDispatcher | null {
    return this.#openaiDispatcher;
  }

  set openaiDispatcher(dispatcher: OpenAIDispatcher | null) {
    this.#openaiDispatcher = dispatcher;
    this.register("openai", dispatcher);
  }

  get anthropicDispatcher(): AnthropicDispatcher | null {
    return this.#anthropicDispatcher;
  }

  set anthropicDispatcher(dispatcher: AnthropicDispatcher | null) {
    this.#anthropicDispatcher = dispatcher;
    this.register("anthropic", dispatcher);
  }

  get grokDispatcher(): GrokProviderDispatcher | null {
    return this.#grokDispatcher;
  }

  set grokDispatcher(dispatcher: GrokProviderDispatcher | null) {
    this.#grokDispatcher = dispatcher;
    this.register("grok", dispatcher);
  }

  register(provider: ProviderId, dispatcher: StreamingProviderDispatcher | null): void {
    if (dispatcher) this.dispatchers.set(provider, dispatcher);
    else this.dispatchers.delete(provider);
  }

  // 초기화 중에는 503 + Retry-After, 초기화 실패에는 500을 반환한다.
  notReadyError(provider: ProviderId): Error {
    const label = PROVIDER_LABELS[provider];
    return this.startupState[provider] === "failed"
      ? new InternalServerErrorException(SD("qgrid.dispatcherFailed")(label))
      : new ServiceUnavailableException(SD("qgrid.dispatcherStarting")(label));
  }

  // prefix 없는/미지원 prefix 는 기존대로 ProcessError, 지원 provider 의 미등록은 not-ready.
  resolveDispatcher(
    input: QueryInput,
    provider: string | undefined,
  ): { provider: ProviderId; dispatcher: StreamingProviderDispatcher } {
    if (!isProviderId(provider)) throw directLlmApiFallbackNotImplemented(input);
    const dispatcher = this.dispatchers.get(provider);
    if (!dispatcher) throw this.notReadyError(provider);
    return { provider, dispatcher };
  }

  recordCompleted(provider: string, tokenName: string): void {
    const key = `${provider}\0${tokenName}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
  }

  replaceCache(rows: TokenSubsetA[]): void {
    this.tokens = new Map(rows.map((r) => [r.id, r]));
  }

  getStats(): TokenStats[] {
    return [...this.tokens.values()].map((r) => ({
      token: maskToken(getAccessToken(r.credentials)),
      name: r.name,
      provider: r.provider,
      requests: this.requestCounts.get(`${r.provider}\0${r.name}`) ?? 0,
    }));
  }

  async query(input: InternalQueryInput, abortSignal?: AbortSignal): Promise<QueryOutput> {
    const route = parseProviderRoute(input.model);
    const outputSchema = buildAndValidateStrictOutputSchema(input, route.provider);
    const answerKind = input.jsonSchema ? ("json" as const) : ("text" as const);
    const { provider, dispatcher } = this.resolveDispatcher(input, route.provider);

    if (provider === "anthropic") {
      const decision = decideConvRouting(input);
      const result = await dispatcher.generate({
        model: input.model,
        systemPrompt: composeSystemWithSchemaContract(input.system, input),
        thinking: input.thinking,
        effort: input.thinking === false ? undefined : input.effort,
        timeoutMs: input.timeout,
        abortSignal,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        preferredTokenId: input.preferredTokenId,
        imageGeneration: input.imageGeneration,
        imageGenerationOptions: input.imageGenerationOptions,
      });
      this.recordCompleted(provider, result.tokenName);

      return applyToolCallEmulation(toEmulationResult(result), input.tools, {
        threadCoord: issueConvContext(result.threadCoord, decision),
        answerKind,
      });
    }

    const decision = decideConvRouting(input, {
      directProvider: provider,
      modelNamespace: `${provider}/${route.model}`,
    });
    const result = await dispatcher.generate({
      ...buildDirectRequest(input, route.model, outputSchema, answerKind, abortSignal),
      promptCacheKey: input.imageGeneration ? undefined : decision.promptCacheKey,
      preferredTokenId:
        input.preferredTokenId ?? (input.imageGeneration ? undefined : decision.preferredTokenId),
      coldInput: decision.coldInput,
      coldHistory: decision.coldHistory,
    });
    this.recordCompleted(provider, result.tokenName);

    // 이미지 요청은 cold-only(R8)라 재사용 좌표를 발급하지 않는다. 좌표를 실으면
    // sessionKey 소비자의 warm 좌표를 죽은 좌표로 덮어써 다음 텍스트 turn 이 cold 로 떨어진다.
    const coord = input.imageGeneration
      ? undefined
      : issueConvContext(result.threadCoord, decision, result.threadCoord.workerId);

    return applyToolCallEmulation(toEmulationResult(result, input.serviceTier), input.tools, {
      threadCoord: coord,
      images: result.images,
      answerKind,
    });
  }

  async queryStream(
    input: InternalQueryInput,
    cb: StreamCallbacks<QueryOutput>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const route = parseProviderRoute(input.model);
    const outputSchema = buildAndValidateStrictOutputSchema(input, route.provider);
    const answerKind = input.jsonSchema ? ("json" as const) : ("text" as const);
    const { provider, dispatcher } = this.resolveDispatcher(input, route.provider);

    if (provider === "anthropic") {
      // 구조화 응답은 최종 텍스트와 델타 모두 코드펜스를 제거한다.
      const hasSchemaContract = input.jsonSchema !== undefined || Boolean(input.tools?.length);
      const fenceStrip = hasSchemaContract ? createFenceStripTransform() : undefined;
      const emitDelta = fenceStrip
        ? (text: string) => {
            const safe = fenceStrip.push(text);
            if (safe) cb.onDelta(safe);
          }
        : cb.onDelta;

      const decision = decideConvRouting(input);
      await dispatcher.generateStream(
        {
          model: input.model,
          systemPrompt: composeSystemWithSchemaContract(input.system, input),
          thinking: input.thinking,
          effort: input.thinking === false ? undefined : input.effort,
          coldInput: decision.coldInput,
          coldHistory: decision.coldHistory,
          preferredTokenId: input.preferredTokenId,
          timeoutMs: input.timeout,
          abortSignal,
          imageGeneration: input.imageGeneration,
          imageGenerationOptions: input.imageGenerationOptions,
        },
        {
          onDelta: emitDelta,
          onThreadId: cb.onThreadId,
          onComplete: (turnResult) => {
            this.recordCompleted(provider, turnResult.tokenName);
            // 닫는 펜스 판정 때문에 보류한 텍스트를 완료 전에 방출한다.
            const rest = fenceStrip?.flush();
            if (rest) cb.onDelta(rest);

            const issuedCoord = issueConvContext(turnResult.threadCoord, decision);
            cb.onComplete(
              applyToolCallEmulation(toEmulationResult(turnResult), input.tools, {
                threadCoord: issuedCoord,
                answerKind,
              }),
            );
          },
          onError: cb.onError,
        },
      );
      return;
    }

    const decision = decideConvRouting(input, {
      directProvider: provider,
      modelNamespace: `${provider}/${route.model}`,
    });
    await dispatcher.generateStream(
      {
        ...buildDirectRequest(input, route.model, outputSchema, answerKind, abortSignal),
        promptCacheKey: decision.promptCacheKey,
        preferredTokenId: input.preferredTokenId ?? decision.preferredTokenId,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
      },
      {
        onDelta: cb.onDelta,
        onThreadId: cb.onThreadId,
        onTurnId: cb.onTurnId,
        onComplete: (turnResult) => {
          this.recordCompleted(provider, turnResult.tokenName);
          cb.onComplete(
            applyToolCallEmulation(toEmulationResult(turnResult, input.serviceTier), input.tools, {
              threadCoord: issueConvContext(
                turnResult.threadCoord,
                decision,
                turnResult.threadCoord.workerId,
              ),
              answerKind,
            }),
          );
        },
        onError: cb.onError,
      },
    );
  }
}

// Direct provider(OpenAI, Grok) 공통 요청 필드. cache affinity 필드는 stream 여부에 따라 호출부가 채운다.
function buildDirectRequest(
  input: InternalQueryInput,
  model: string,
  outputSchema: JsonValue | undefined,
  answerKind: "json" | "text",
  abortSignal: AbortSignal | undefined,
): Omit<GenerateRequest, "coldInput" | "coldHistory" | "promptCacheKey" | "preferredTokenId"> {
  return {
    model,
    systemPrompt: input.system,
    outputSchema,
    stopAfterOutputMessage: input.tools?.length
      ? (text, phase) => isToolCallEnvelope(text, input.tools!, answerKind, phase)
      : undefined,
    thinking: input.thinking,
    effort: input.thinking === false ? undefined : input.effort,
    verbosity: input.verbosity,
    reasoningSummary: input.reasoningSummary,
    serviceTier: input.serviceTier,
    timeoutMs: input.timeout,
    requirePreferredToken: input.requirePreferredToken,
    abortSignal,
    imageGeneration: input.imageGeneration,
    imageGenerationOptions: input.imageGenerationOptions,
    // Opaque namespaces; the Grok dispatcher reads `xai`, OpenAI ignores it.
    ...(input.providerOptions?.xai
      ? { providerOptions: { xai: { ...input.providerOptions.xai } } }
      : {}),
  };
}

function parseProviderRoute(model: string | undefined): { provider?: string; model: string } {
  if (!model?.includes("/")) {
    return { model: model ?? "" };
  }

  const [provider, routedModel] = model.split("/", 2);
  if (!provider || !routedModel) throw new ProcessError("unknown model");
  return { provider, model: routedModel };
}

function directLlmApiFallbackNotImplemented(input: QueryInput): ProcessError {
  return new ProcessError(
    `Direct LLM API fallback not implemented for model: ${input.model ?? "<default>"}`,
  );
}

export function buildStrictOutputSchema(
  input: Pick<QueryInput, "tools" | "jsonSchema">,
  provider?: string,
): JsonValue | undefined {
  const outputSchema = buildRawOutputSchema(input);

  return outputSchema
    ? (strictify(outputSchema as Parameters<typeof strictify>[0], { provider }) as JsonValue)
    : undefined;
}

export function buildAndValidateStrictOutputSchema(
  input: Pick<QueryInput, "model" | "tools" | "jsonSchema">,
  provider = parseProviderRoute(input.model).provider,
): JsonValue | undefined {
  // Claude Code의 --json-schema는 불필요한 내부 재시도를 유발한다.
  // Anthropic은 원본 스키마를 검증한 뒤 프롬프트로 전달하고, 응답 검증은 소비자에 맡긴다.
  if (provider === "anthropic") {
    parseAndValidateCallerSchemas(input);
    return undefined;
  }

  const outputSchema = buildStrictOutputSchema(input, provider);
  serializeAndValidateDispatchSchema(outputSchema, provider);
  return outputSchema;
}

function buildRawOutputSchema(
  input: Pick<QueryInput, "tools" | "jsonSchema">,
): JsonValue | undefined {
  const callerOutputSchema = parseAndValidateCallerSchemas(input);

  return input.tools?.length
    ? buildToolCallSchema(input.tools, callerOutputSchema)
    : callerOutputSchema;
}

export function completedDriverFromImageFailure(
  error: unknown,
  serviceTier?: string,
): QueryOutput | undefined {
  if (!(error instanceof ImageGenerationError) || !error.completedDriver) return undefined;
  return applyToolCallEmulation(toEmulationResult(error.completedDriver, serviceTier), undefined, {
    answerKind: "text",
  });
}

// Anthropic adapter 는 cache creation 을 inputTokens 에 포함해 표준화하고, 별도 필드에도 보존한다.
function toEmulationResult(
  result: GenerateResult,
  serviceTier?: string,
): Omit<QueryOutput, "content" | "finishReason" | "runContext"> {
  // A provider that labels its own cost (Grok ticks) is authoritative even at 0; otherwise only a
  // positive provider cost (Claude Code total_cost_usd) wins over the price table.
  const hasProviderCost =
    result.costUsd !== undefined && (result.costSource === "provider" || result.costUsd > 0);
  return {
    text: result.text,
    tokenName: result.tokenName,
    model: result.model,
    requestedModel: result.requestedModel,
    modelFallbacks: result.modelFallbacks,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      reasoning_tokens: result.usage.reasoningOutputTokens,
      cache_creation_input_tokens: result.usage.cacheCreationInputTokens ?? 0,
      cache_creation_5m_input_tokens: result.usage.cacheCreationInputTokens5m,
      cache_creation_1h_input_tokens: result.usage.cacheCreationInputTokens1h,
      cache_read_input_tokens: result.usage.cachedInputTokens,
    },
    durationMs: result.durationMs,
    ttftMs: result.ttftMs ?? 0,
    costUsd: hasProviderCost
      ? result.costUsd!
      : calculateCostUsd(
          result.model,
          {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            cacheCreationInputTokens: result.usage.cacheCreationInputTokens ?? 0,
            cacheCreationInputTokens5m: result.usage.cacheCreationInputTokens5m,
            cacheCreationInputTokens1h: result.usage.cacheCreationInputTokens1h,
          },
          serviceTier,
        ),
    costSource: hasProviderCost ? (result.costSource ?? "provider") : "pricing_table",
    ...(result.providerMetadata?.xai
      ? { providerMetadata: { xai: result.providerMetadata.xai } }
      : {}),
  };
}

export const QgridDispatcher = new QgridDispatcherClass();
