/**
 * ProviderDispatcher — provider 별 LLM 요청 실행 인터페이스.
 *
 * Provider 실행 결과와 stream callback의 공통 계약.
 */

import {
  type ImageGenerationMetadata,
  type ImageGenerationOptions,
  type QgridContent,
} from "../../../application/qgrid/qgrid.types";
import {
  type GrokImageEditRequest,
  type GrokImageGenerateRequest,
  type GrokImageResponse,
  type GrokSpeechResult,
  type GrokSttResponse,
  type GrokTranscribeRequest,
  type GrokTtsRequest,
  type GrokVideoStart,
  type GrokVideoStartRequest,
  type GrokVideoStatus,
} from "../grok/grok-types";
import { type JsonValue, type TokenUsageBreakdown, type UserInput } from "./provider-types";

// qgrid provider 내부 표준 usage. provider 전용 cache write 세부 필드는 여기서 확장해 보존한다.
export type ProviderTokenUsageBreakdown = TokenUsageBreakdown & {
  cacheCreationInputTokens?: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
  // Live context size reported by the provider (Grok `usage.context_details`), distinct from
  // the cumulative input token count.
  contextTokens?: number;
};

// Native provider tools. Function tools follow the Responses API shape; built-in tools are
// executed server-side by the provider (Grok `web_search` / `x_search`).
export type ProviderFunctionToolDefinition = {
  type: "function";
  name: string;
  description?: string;
  parameters: JsonValue;
  strict?: boolean;
};
export type ProviderBuiltinToolDefinition = { type: "web_search" } | { type: "x_search" };
export type ToolDefinition = ProviderFunctionToolDefinition | ProviderBuiltinToolDefinition;

// A native function call returned by the provider (not the qgrid tool-emulation envelope).
export interface ProviderToolCall {
  toolCallId: string;
  toolName: string;
  // Raw JSON argument string as returned by the provider.
  input: string;
}

export interface XaiProviderMetadata {
  costInUsdTicks?: number;
  contextWindow?: number;
}

// 공개 thread 좌표의 provider 결과 부분. 이름은 호환성을 위해 유지한다.
export interface ReuseThreadCoord {
  workerId: number;
  threadId: string;
  epoch: number;
}

// provider-무관 이미지 결과. OpenAI 경로에서만 채워지며, 상위(qgrid.dispatcher)가
// content 파트로 전파한다. Anthropic 경로는 이 필드를 채우지 않는다.
export interface GeneratedImage {
  data: string; // base64 image
  mediaType?: Extract<QgridContent, { type: "image" }>["mediaType"];
  revisedPrompt: string | null;
  generation?: ImageGenerationMetadata;
}

// Provider/런타임이 요청 모델 대신 다른 모델로 실제 응답을 생성한 이력.
// 현재 Claude Code 의 Fable refusal → Opus 안전 fallback 을 표현하며, 향후 provider
// fallback 도 같은 계약으로 올릴 수 있다.
export interface ModelFallback {
  trigger: "refusal";
  fromModel: string;
  toModel: string;
  category?: string;
  explanation?: string;
}

export type CostSource = "provider" | "pricing_table" | "mixed";

export interface GenerateRequest {
  // 미지정이면 dispatcher 가 provider 별 default 를 적용한다(Anthropic: ANTHROPIC_DEFAULT_MODEL).
  // OpenAI 경로는 항상 prefix split 후 canonical model 을 넘기므로 영향 없음.
  model?: string;
  systemPrompt?: string;
  outputSchema?: JsonValue;
  // A completed control message can yield to the caller before speculative later text.
  // The transport must still drain to completion for usage, cancellation and errors.
  stopAfterOutputMessage?: (text: string, phase?: string) => boolean;
  effort?: string;
  thinking?: boolean;
  verbosity?: string;
  reasoningSummary?: string;
  serviceTier?: string;
  // provider 실행 제한(ms). Queue selection 이후의 active provider request 전체에 적용한다.
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  // 매 turn에 전달하는 현재 input과 전체 history.
  coldInput: Array<UserInput>;
  coldHistory?: Array<JsonValue>;
  // Provider-neutral cache affinity hints. Direct OpenAI currently receives these while still
  // replaying coldInput + coldHistory on every turn; a dispatcher may use them for token choice
  // and prompt-cache routing without relying on a process-local worker/thread.
  promptCacheKey?: string;
  preferredTokenId?: number;
  // 사람이 지정한 exact target. Cache affinity 선호와 달리 부적격 시 다른 토큰으로 대체하지 않는다.
  requirePreferredToken?: boolean;
  // OpenAI image_generation tool 을 켠다(OpenAI 경로 전용, opt-in).
  // 이 플래그가 있으면 OpenAI prompt-cache affinity 라우팅을 건너뛴다.
  imageGeneration?: boolean | "auto";
  imageGenerationOptions?: ImageGenerationOptions;
  // Opaque provider namespaces (for example `providerOptions.xai`). Each dispatcher validates its
  // own namespace; other providers ignore it.
  providerOptions?: { [key: string]: JsonValue | undefined };
  // Native tools for providers that accept them on the wire (Grok).
  tools?: ToolDefinition[];
}

export interface GenerateResult {
  text: string;
  tokenName: string;
  usage: ProviderTokenUsageBreakdown;
  durationMs: number;
  ttftMs?: number | null;
  // Provider 가 직접 산출한 비용. Anthropic Claude Code 는 total_cost_usd 를 주므로 이 값을
  // 우선 사용하고, 없으면 상위가 모델별 가격표로 계산한다.
  costUsd?: number;
  // model 은 실제 응답을 생성한 serving model. fallback 이 없으면 requestedModel 과 같다.
  model: string;
  requestedModel?: string;
  modelFallbacks?: Array<ModelFallback>;
  // 이번 turn 이 사용한 thread 좌표. 상위가 conv 핸들을 발급/갱신하는 데 쓴다.
  threadCoord: ReuseThreadCoord;
  // 이미지 turn 에서만 채워짐(OpenAI 경로). 완성 이미지가 없으면 undefined.
  images?: GeneratedImage[];
  // Origin of costUsd; "provider" when the provider reported the cost itself.
  costSource?: CostSource;
  providerMetadata?: { xai?: XaiProviderMetadata };
  // Native function calls returned by providers that accept `GenerateRequest.tools`.
  toolCalls?: ProviderToolCall[];
}

// 스트림 콜백 컨테이너. 계층별로 onComplete payload 만 다르고, 스트림 이벤트 shape 는 동일하다.
export interface StreamCallbacks<TComplete> {
  onDelta: (text: string) => void;
  onComplete: (result: TComplete) => void;
  onError: (error: Error) => void;
  onThreadId?: (threadId: string) => void;
  onTurnId?: (turnId: string) => void;
}

// 상위(qgrid.dispatcher)로 가는 스트림 콜백. onComplete 는 non-stream 의 GenerateResult 와
// 동일 shape(tokenName/threadCoord 포함)를 받아, 두 경로가 같은 일급 타입을 공유한다.
export type GenerateStreamCallbacks = StreamCallbacks<GenerateResult>;

export interface ProviderDispatcher {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Token selection hints for media/voice requests. There is no cache affinity; a caller may still
// pin an exact token.
export interface MediaTokenSelection {
  preferredTokenId?: number;
  requirePreferredToken?: boolean;
}

export interface MediaDispatchResult<T> {
  result: T;
  tokenId: number;
  tokenName: string;
}

// Optional capability: image and video generation. Video polling always goes to the token that
// started the job.
export interface MediaDispatcher {
  generateImages(
    request: GrokImageGenerateRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokImageResponse>>;
  editImages(
    request: GrokImageEditRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokImageResponse>>;
  startVideo(
    request: GrokVideoStartRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokVideoStart>>;
  getVideo(
    tokenId: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<MediaDispatchResult<GrokVideoStatus>>;
}

// Optional capability: speech-to-text and text-to-speech.
export interface VoiceDispatcher {
  transcribe(
    request: GrokTranscribeRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokSttResponse>>;
  speak(
    request: GrokTtsRequest & { signal?: AbortSignal } & MediaTokenSelection,
  ): Promise<MediaDispatchResult<GrokSpeechResult>>;
}
