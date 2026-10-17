import { z } from "zod";

/**
 * OpenAI 경로(ChatGPT 구독 Codex 백엔드)의 reasoning effort. 백엔드 모델 카탈로그의
 * supported_reasoning_levels 합집합이다. `none`/`minimal`은 공개 effort 값이 아니며,
 * 지원 모델의 thinking 비활성화에는 `thinking: false`를 사용한다.
 * GPT-6 Astra와 GPT-5.6 Sol/Terra는 `ultra`, Luna는 `max`까지 지원한다.
 * 모델이 지원하지 않는 값은 서버가 조용히 무시한다.
 */
export type QgridOpenAIEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/**
 * Anthropic 경로(Claude Code `--effort`)의 reasoning effort. 모델별 상한(예: Sonnet 4.6 은 `xhigh`
 * 없음)은 Claude Code 가 처리하고, 이 집합 밖의 값은 서버가 조용히 무시한다.
 */
export type QgridAnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type QgridOpenAIModel = Extract<QgridSupportedModel, `openai/${string}`>;

export type QgridAnthropicModel = Extract<QgridSupportedModel, `anthropic/${string}`>;

type QgridCommonProviderConfig = {
  serverUrl?: string;
  /** request_logs.project_name. default: process.env.QGRID_PROJECT_NAME */
  projectName?: string;
};

/** Codex Images request ID, not a guaranteed serving version; does not select a chat model. */
export type QgridImageModel =
  | "openai/gpt-image-2"
  | "grok/grok-imagine-image"
  | "grok/grok-imagine-image-2.0"
  | "grok/grok-imagine-image-quality";

/** Grok video generation model ids (xAI subscription; not yet wired to a provider factory). */
export type QgridVideoModel =
  | "grok/grok-imagine-video"
  | "grok/grok-imagine-video-1.5"
  | "grok/grok-imagine-video-1.5-lite";

/** Grok speech-to-text model ids. */
export type QgridTranscriptionModel = "grok/grok-voice-transcribe-2.0";

/**
 * Grok text-to-speech model id. Placeholder: the live probe verified the `/tts` endpoint with the
 * subscription JWT, but no TTS model id was observed (`/speech-models` returned 404).
 */
export type QgridSpeechModel = "grok/grok-tts";

export type QgridImageProviderConfig = QgridCommonProviderConfig;

/** `providerOptions.qgrid` for `generateImage({ model: qgrid.image(...) })`. */
export type QgridImageProviderOptions = {
  /** Requested hint only; the subscription backend may choose another quality. */
  quality?: "low" | "medium" | "high";
  background?: "auto" | "opaque" | "transparent";
  /** The standalone subscription Images endpoint currently supports PNG only. */
  outputFormat?: "png";
  /** Strict active OpenAI token selection, including the `openai/` prefix. */
  tokenName?: string;
  /** Defaults to true. Set false to omit qgrid request logs. */
  logger?: boolean;
};

export type QgridOpenAIProviderConfig = QgridCommonProviderConfig & {
  defaultEffort?: QgridOpenAIEffort;
};

export type QgridAnthropicProviderConfig = QgridCommonProviderConfig & {
  defaultEffort?: QgridAnthropicEffort;
};

/** `qgrid()` 는 모델 ID prefix 로 오버로드되므로 보통 provider 별 타입이 추론된다. */
export type QgridProviderConfig = QgridOpenAIProviderConfig | QgridAnthropicProviderConfig;

type QgridCommonProviderOptions = {
  /**
   * 답변 전 thinking 활성화 여부. 생략하면 기존 모델별 동작을 유지한다.
   * false는 effort/defaultEffort를 무시하며, 모델·실행 경로가 지원하지 않으면 서버가 거부한다.
   * true는 effort로 깊이를 조절하지만 매 응답의 thinking 토큰을 보장하지 않는다.
   * 서버와 SDK를 함께 업데이트해야 한다. 구버전 서버는 이 옵션을 무시할 수 있다.
   */
  thinking?: boolean;
  /**
   * 이 요청을 처리할 활성 qgrid 토큰 이름. provider prefix를 포함해야 하며 다른 토큰으로 fallback하지 않는다.
   */
  tokenName?: string;
  /**
   * qgrid request log 저장 여부. 기본값은 true.
   * false여도 client tool 실행과 multi-step 연결은 계속 동작한다.
   */
  logger?: boolean;
  /**
   * @deprecated Ignored: qgrid does not implement caller-configured model fallback routing.
   * Retained for source compatibility. Claude Code's safety fallback is independent.
   */
  fallbackModels?: string[];
};

/** `providerOptions.qgrid` — OpenAI(Codex) 모델용. */
export type QgridOpenAIProviderOptions = QgridCommonProviderOptions & {
  /**
   * 멀티턴 프롬프트 캐시 어피니티용 대화 식별자, 호출자가 자기 도메인 ID(예: 게임 세션 ID) 하나만 넘기면
   * provider가 model+sessionKey에서 opaque cache affinity를 결정적으로 파생해 회송한다.
   * 원문 sessionKey는 서버에 전송하지 않으며 좌표는 model+sessionKey 별로 격리된다.
   */
  sessionKey?: string;
  /** reasoning 깊이. 기본값은 qgrid config의 defaultEffort. 모델이 지원하지 않는 값은 서버가 무시한다. */
  effort?: QgridOpenAIEffort;
  /** 응답 텍스트의 상세도. */
  verbosity?: "low" | "medium" | "high";
  /** reasoning 요약 출력 방식. */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  /** Codex service tier. */
  serviceTier?: string;
};

/** `providerOptions.qgrid` — Anthropic(Claude Code) 모델용. */
export type QgridAnthropicProviderOptions = QgridCommonProviderOptions & {
  /** reasoning 깊이. 기본값은 qgrid config의 defaultEffort. 집합 밖의 값은 서버가 무시한다. */
  effort?: QgridAnthropicEffort;
  /**
   * qgrid 서버의 provider 실행 제한(ms). Claude Code 프로세스 타이머로 사용되며, SDK의 non-stream
   * 요청별 HTTP headers/body timeout은 이 값보다 60초 길게 설정된다. AI SDK 표준 timeout은
   * provider에 숫자를 전달하지 않고 abortSignal로 변환되므로, 서버 측 제한을 바꾸려면 이 옵션을
   * 사용한다. 양의 정수만 허용하며 최대 30분, 기본 240초다.
   */
  timeoutMs?: number;
};

/**
 * `providerOptions.qgrid` 의 공용 타입. AI SDK 의 providerOptions 는 모델과 연결되지 않은 JSON
 * 레코드라 여기서는 두 provider 타입의 union 이다. provider 를 아는 호출자는
 * `QgridOpenAIProviderOptions` / `QgridAnthropicProviderOptions` 를 직접 쓰는 편이 정확하다.
 */
export type QgridProviderOptions = QgridOpenAIProviderOptions | QgridAnthropicProviderOptions;

/** SDK 내부용: 어느 provider 옵션이든 읽을 수 있게 합친 형태. 패키지 밖으로 내보내지 않는다. */
export type QgridResolvedProviderOptions = Omit<QgridOpenAIProviderOptions, "effort"> &
  Omit<QgridAnthropicProviderOptions, "effort"> & { effort?: string };

/**
 * OpenAI cache affinity 좌표(구 codex thread 좌표)
 * epoch=-1은 direct provider cache affinity 좌표다. workerId는 preferred token ID이고,
 * threadId는 opaque cache key다. epoch>=0은 이전 서버와의 wire compatibility를 위해 유지한다.
 */
export type QgridThreadCoord = {
  workerId: number;
  threadId: string;
  epoch: number;
  /** Absent from servers older than the system-prompt hash guard; echoed back unchanged. */
  systemHash?: string;
};

export type QgridInputPart =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };

/**
 * Grok(xAI subscription) language model ids. The literals are the four ids the subscription
 * `/models` catalog returned at GROK_BUILD_VERSION 1.0.60 (`grok-4.7` is the default); any other
 * `grok/<id>` is accepted so newly cataloged models need no SDK release.
 */
export type QgridGrokModel =
  | "grok/grok-4.7"
  | "grok/grok-4.7-build-fast"
  | "grok/grok-4.6"
  | "grok/grok-4.5"
  | (`grok/${string}` & {});

/**
 * `providerOptions.xai` for Grok models, cloned field-for-field from `@ai-sdk/xai`
 * (`xai-responses-language-model-options.ts`) so code written for `@ai-sdk/xai` keeps parsing.
 * Parsing only proves the shape; `mapXaiProviderOptions` decides which keys qgrid honors.
 */
export const qgridXaiProviderOptionsSchema = z.object({
  /**
   * Constrains how hard a reasoning model thinks before responding. qgrid validates the value
   * against the model's catalog effort set; `none` is rejected because the proxy always reasons.
   */
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  /** Maximum number of agentic tool-calling turns. Rejected by qgrid. */
  maxTurns: z.number().int().optional(),
  /** Whether the model may call tools in parallel. @default true */
  parallelToolCalls: z.boolean().optional(),
  /** Cache key used to route requests with shared prompt prefixes. */
  promptCacheKey: z.string().optional(),
  /** Stable identifier used to attribute policy violations to an end user. Rejected by qgrid. */
  safetyIdentifier: z.string().optional(),
  serviceTier: z.enum(["default", "priority"]).optional(),
  /** Rejected by qgrid: it always sends `store: false`. */
  store: z.boolean().optional(),
  /** Rejected by qgrid: it replays history itself. */
  previousResponseId: z.string().optional(),
  /** A unique identifier for the end user, used for abuse monitoring. Rejected by qgrid. */
  user: z.string().optional(),
  /** Rejected by qgrid: it fixes `include` itself. */
  include: z
    .array(
      z.enum([
        "file_search_call.results",
        "web_search_call.action.sources",
        "code_interpreter_call.outputs",
        "reasoning.encrypted_content",
        "no_inline_citations",
      ]),
    )
    .nullish(),
});

export type QgridXaiProviderOptions = z.infer<typeof qgridXaiProviderOptionsSchema>;

export type QgridSupportedModel =
  | "openai/gpt-6-astra"
  | "openai/gpt-6.1-sol"
  | "openai/gpt-6-sol"
  | "openai/gpt-6-luna"
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  | "anthropic/claude-fable-5-1"
  | "anthropic/claude-fable-5"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7"
  | "anthropic/claude-opus-4-8"
  | "anthropic/claude-opus-5"
  | "anthropic/claude-opus-5-5"
  | "anthropic/claude-sonnet-5-5"
  | "anthropic/claude-haiku-5-5"
  | QgridGrokModel;

/** Observed image response values. Usage is response-level and appears on the first image only. */
export type QgridImageGenerationMetadata = {
  route: "codex-images" | "codex-responses";
  /** Present only when reported or known from the standalone route. */
  model?: string;
  background?: string;
  quality?: string;
  size?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: { image_tokens: number; text_tokens: number; cached_tokens?: number };
    output_tokens_details?: { image_tokens: number; text_tokens: number };
  };
};

// 아래 타입들은 Qgrid에서 생성된 type을 그대로 가져와서 사용합니다.
export type QueryOutput = {
  requestLogId?: number;
  text: string;
  content?: QueryContentPart[];
  finishReason?: "stop" | "tool-calls";
  /** Older servers may omit the fields below that the SDK only forwards as metadata. */
  model?: string;
  requestedModel?: string;
  modelFallbacks?: Array<{
    trigger: "refusal";
    fromModel: string;
    toModel: string;
    category?: string;
    explanation?: string;
  }>;
  tokenName?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    cache_creation_input_tokens: number;
    cache_creation_5m_input_tokens?: number;
    cache_creation_1h_input_tokens?: number;
    cache_read_input_tokens: number;
  };
  durationMs?: number;
  costUsd?: number;
  costSource?: "provider" | "pricing_table" | "mixed";
  runContext?: { requestLogId?: number; threadCoord?: QgridThreadCoord };
};

export type QueryContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | {
      type: "image";
      data: string;
      mediaType?: "image/png" | "image/jpeg" | "image/webp";
      revisedPrompt?: string | null;
      generation?: QgridImageGenerationMetadata;
    };

// Extra keys the server adds to generation metadata are forwarded to callers unchanged.
const imageGenerationMetadataSchema: z.ZodType<QgridImageGenerationMetadata> = z.looseObject({
  route: z.enum(["codex-images", "codex-responses"]),
  model: z.string().optional(),
  background: z.string().optional(),
  quality: z.string().optional(),
  size: z.string().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number(),
      output_tokens: z.number(),
      total_tokens: z.number(),
      input_tokens_details: z
        .looseObject({
          image_tokens: z.number(),
          text_tokens: z.number(),
          cached_tokens: z.number().optional(),
        })
        .optional(),
      output_tokens_details: z
        .looseObject({ image_tokens: z.number(), text_tokens: z.number() })
        .optional(),
    })
    .optional(),
});

const queryContentPartSchema: z.ZodType<QueryContentPart> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
    revisedPrompt: z.string().nullable().optional(),
    generation: imageGenerationMetadataSchema.optional(),
  }),
]);

// The SDK only stores and echoes thread coordinates, so unknown fields pass through untouched.
const threadCoordSchema = z.looseObject({
  workerId: z.number(),
  threadId: z.string(),
  epoch: z.number(),
  systemHash: z.string().optional(),
});

/**
 * Response of `/api/qgrid/query` and the stream `done` event. Content variants this SDK does not
 * know are skipped rather than rejected, so a newer server can add variants. The object stays
 * loose because `providerMetadata` is read by a separate schema.
 */
export const queryOutputSchema: z.ZodType<QueryOutput> = z.looseObject({
  requestLogId: z.number().optional(),
  text: z.string(),
  content: z
    .array(z.looseObject({ type: z.string() }))
    .optional()
    .transform((items) =>
      items?.flatMap((item) => {
        const part = queryContentPartSchema.safeParse(item);

        return part.success ? [part.data] : [];
      }),
    ),
  finishReason: z.enum(["stop", "tool-calls"]).optional(),
  model: z.string().optional(),
  requestedModel: z.string().optional(),
  modelFallbacks: z
    .array(
      z.object({
        trigger: z.literal("refusal"),
        fromModel: z.string(),
        toModel: z.string(),
        category: z.string().optional(),
        explanation: z.string().optional(),
      }),
    )
    .optional(),
  tokenName: z.string().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    reasoning_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number(),
    cache_creation_5m_input_tokens: z.number().optional(),
    cache_creation_1h_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number(),
  }),
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: z.enum(["provider", "pricing_table", "mixed"]).optional(),
  runContext: z
    .object({ requestLogId: z.number().optional(), threadCoord: threadCoordSchema.optional() })
    .optional(),
});

export type CreateRunInput = {
  userPrompt: string;
  systemPrompt?: string;
  modelName?: string;
  effort?: string;
  projectName?: string;
  history?: string;
  isStructured?: boolean;
  jsonSchema?: string | null;
};

export type AppendStepInput = {
  requestLogId: number;
  stepIndex: number;
  type: "generate" | "tool_call";
  modelName?: string;
  requestedModelName?: string;
  fallbackCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  costUsd?: number;
  costSource?: "provider" | "pricing_table" | "mixed";
  durationMs?: number;
  finishReason?: string;
  reasoningText?: string;
  reasoningTokens?: number;
  toolCallIndex?: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolDurationMs?: number;
  error?: string;
};

export type QgridLoggerConfig = {
  /** qgrid 서버 주소. default: process.env.QGRID_URL, 없으면 기본값은 "http://localhost:44900" */
  serverUrl?: string;
  /**
   * 프로젝트 이름. default: process.env.QGRID_PROJECT_NAME, 없으면 기본값은 ""
   */
  projectName?: string;
  /**
   * 토큰 이름. 외부에서 호출할경우 기본값은 "external"
   */
  tokenName?: string;
  /**
   * Fallback timeout for runs that receive onStart but never receive onFinish.
   * AI SDK TelemetryIntegration does not expose an error hook, so provider
   * failures before a final step can otherwise leave request logs running.
   *
   * Set to 0 to disable. Defaults to 30 minutes, or the AI SDK total timeout
   * plus a short grace period when one is provided.
   */
  staleRunTimeoutMs?: number;
  /**
   * Receives qgrid logging failures. When reusing one logger integration across
   * overlapping AI SDK calls, pass a unique `metadata.qgridRunId` per call so
   * lifecycle events can be attributed to the correct run.
   */
  onLogError?: (error: Error) => void;
};

export type FinishRunInput = {
  requestLogId: number;
  status: "succeeded" | "error" | "aborted";
  response?: string;
  tokenName?: string;
  modelName?: string;
  requestedModelName?: string;
  fallbackCount?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheCreation5mTokens?: number;
  totalCacheCreation1hTokens?: number;
  costUsd?: number;
  costSource?: "provider" | "pricing_table" | "mixed";
  totalDurationMs?: number;
  history?: string;
  errorMessage?: string;
  responseJsonOk?: boolean;
};
