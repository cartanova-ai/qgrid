import { z } from "zod";

// ─── Query ───

export const Effort = z.enum(["low", "medium", "high"]);

export type Effort = z.infer<typeof Effort>;

export const QgridTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown(),
});

export type QgridTool = z.infer<typeof QgridTool>;

// Observed image response values, distinct from requested generation hints.
export const ImageGenerationMetadata = z.object({
  route: z.enum(["codex-images", "codex-responses"]),
  model: z.string().optional(),
  background: z.string().optional(),
  quality: z.string().optional(),
  size: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
      total_tokens: z.number().nonnegative(),
      input_tokens_details: z
        .object({
          image_tokens: z.number().nonnegative(),
          text_tokens: z.number().nonnegative(),
          cached_tokens: z.number().nonnegative().optional(),
        })
        .optional(),
      output_tokens_details: z
        .object({
          image_tokens: z.number().nonnegative(),
          text_tokens: z.number().nonnegative(),
        })
        .optional(),
    })
    .optional(),
});

export type ImageGenerationMetadata = z.infer<typeof ImageGenerationMetadata>;

export const QgridContent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    // Base64 image bytes; older responses without mediaType are PNG.
    data: z.string(),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
    revisedPrompt: z.string().nullish(),
    generation: ImageGenerationMetadata.optional(),
  }),
]);

export type QgridContent = z.infer<typeof QgridContent>;

export const FinishReason = z.enum(["stop", "tool-calls"]);

export type FinishReason = z.infer<typeof FinishReason>;

export const Verbosity = z.enum(["low", "medium", "high"]);

export type Verbosity = z.infer<typeof Verbosity>;

export const ReasoningSummary = z.enum(["auto", "concise", "detailed", "none"]);

export type ReasoningSummary = z.infer<typeof ReasoningSummary>;

export const ServiceTier = z.enum(["fast", "flex"]);

export type ServiceTier = z.infer<typeof ServiceTier>;

export const ImageGenerationQuality = z.enum(["low", "medium", "high"]);

export type ImageGenerationQuality = z.infer<typeof ImageGenerationQuality>;

// Subscription-backend hints, not public Images API resolution guarantees.
export const ImageGenerationSize = z.union([
  z.literal("auto"),
  z
    .string()
    .regex(/^[1-9]\d*x[1-9]\d*$/)
    .refine(
      (size) => size.split("x").every((edge) => Number.isSafeInteger(Number(edge))),
      "Image dimensions must be positive safe integers",
    ),
]);

export type ImageGenerationSize = z.infer<typeof ImageGenerationSize>;

export const ImageGenerationOptions = z
  .object({
    quality: ImageGenerationQuality.optional(),
    size: ImageGenerationSize.optional(),
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  })
  .refine(
    (options) =>
      options.background !== "transparent" ||
      !options.outputFormat ||
      options.outputFormat === "png",
    { message: "Transparent image generation only supports PNG output", path: ["outputFormat"] },
  );

export type ImageGenerationOptions = z.infer<typeof ImageGenerationOptions>;

export const QgridInputPart = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    text_elements: z.array(z.never()).default([]),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
  }),
]);

export type QgridInputPart = z.infer<typeof QgridInputPart>;

export const MAX_QUERY_TIMEOUT_MS = 30 * 60_000;
export const QueryTimeoutMs = z.number().int().positive().max(MAX_QUERY_TIMEOUT_MS);

// ─── Run Lifecycle Context (SDK ↔ Server contract) ───

// OpenAI cache affinity 좌표(구 codex thread 좌표). prompt_cache_key 를 고정해
// OpenAI prompt caching 을 살리기 위한 핸들. 서버가 발급하고 클라가 다음 요청에 그대로 회송한다.
// 핸들 미전송 시 기존 "매 turn 새 thread + history inject" 동작으로 폴백(QgridRunContext 참조).
export const QgridThreadCoord = z.object({
  workerId: z.number(), // 고정 라우팅 (thread 는 worker 프로세스 메모리에만 존재)
  threadId: z.string(), // opaque cache affinity key = prompt_cache_key
  epoch: z.number(), // worker spawn 카운터. restart 로 thread 증발 감지
  systemHash: z.string(), // system_prompt 해시. 다른 대화 오접속 방지
});

export type QgridThreadCoord = z.infer<typeof QgridThreadCoord>;

export const QgridRunContext = z.object({
  // tool-call run을 계속할 때만 발급. 일반 대화는 threadCoord 만 왕복.
  requestLogId: z.number().optional(),
  threadCoord: QgridThreadCoord.optional(),
});

export type QgridRunContext = z.infer<typeof QgridRunContext>;

export const QgridToolResultInput = z.object({
  toolCallId: z.string(),
  toolName: z.string().optional(),
  output: z.string(),
  isError: z.boolean().optional(),
});

export type QgridToolResultInput = z.infer<typeof QgridToolResultInput>;

// Opaque per-provider namespaces forwarded to the dispatcher. Only grok/* models read `xai`;
// other providers ignore it (the AI SDK already warns and drops it for non-grok ids).
export const XaiQueryProviderOptions = z.object({
  serviceTier: z.enum(["default", "priority"]).optional(),
  parallelToolCalls: z.boolean().optional(),
});

export type XaiQueryProviderOptions = z.infer<typeof XaiQueryProviderOptions>;

export const QueryProviderOptions = z.object({
  xai: XaiQueryProviderOptions.optional(),
});

export type QueryProviderOptions = z.infer<typeof QueryProviderOptions>;

export const XaiProviderMetadata = z.object({
  costInUsdTicks: z.number().optional(),
  contextWindow: z.number().optional(),
});

export type XaiProviderMetadata = z.infer<typeof XaiProviderMetadata>;

export const QueryProviderMetadata = z.object({
  xai: XaiProviderMetadata.optional(),
});

export type QueryProviderMetadata = z.infer<typeof QueryProviderMetadata>;

export const QueryInput = z.looseObject({
  system: z.string().optional(),
  prompt: z.string(),
  input: z.array(QgridInputPart).optional(),
  model: z.string().optional(),
  timeout: QueryTimeoutMs.optional(),
  jsonSchema: z.string().optional(),
  tools: z.array(QgridTool).optional(),
  // Boolean literals keep Sonamu's HTTP caster from accepting "true"/"false" strings.
  thinking: z.union([z.literal(true), z.literal(false)]).optional(),
  effort: z.string().optional(),
  verbosity: Verbosity.optional(),
  reasoningSummary: ReasoningSummary.optional(),
  serviceTier: ServiceTier.optional(),
  history: z.string().optional(),
  projectName: z.string().optional(),
  // raw/dashboard와 공개 AI SDK providerOptions.qgrid.tokenName이 공유하는 지정 주소.
  tokenName: z.string().optional(),
  // SDK-derived opaque affinity. It is intentionally distinct from the caller's sessionKey.
  cacheAffinityKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  // 생략하면 로깅한다. false는 request log 쓰기만 끄고 dispatch/thread는 유지한다.
  logger: z.boolean().optional(),
  runContext: QgridRunContext.optional(),
  toolResults: z.array(QgridToolResultInput).optional(),
  // OpenAI only, non-stream: true requires an image; auto permits text or native image tools.
  imageGeneration: z.union([z.boolean(), z.literal("auto")]).optional(),
  // qgrid 가격 추정 및 Codex 이미지 요청 힌트. 이미지 모델은 gpt-image-2 로 고정 가정한다.
  imageGenerationOptions: ImageGenerationOptions.optional(),
  providerOptions: QueryProviderOptions.optional(),
});

export type QueryInput = z.infer<typeof QueryInput>;

export const ModelFallback = z.object({
  trigger: z.literal("refusal"),
  fromModel: z.string(),
  toModel: z.string(),
  category: z.string().optional(),
  explanation: z.string().optional(),
});

export type ModelFallback = z.infer<typeof ModelFallback>;

export const CostSource = z.enum(["provider", "pricing_table", "mixed"]);

export type CostSource = z.infer<typeof CostSource>;

export const QueryOutput = z.object({
  requestLogId: z.number().optional(),
  text: z.string(),
  content: z.array(QgridContent),
  finishReason: FinishReason,
  tokenName: z.string().optional(),
  model: z.string().optional(),
  requestedModel: z.string().optional(),
  modelFallbacks: z.array(ModelFallback).optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    reasoning_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
    cache_creation_5m_input_tokens: z.number().optional(),
    cache_creation_1h_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number(),
  }),
  durationMs: z.number(),
  ttftMs: z.number(),
  costUsd: z.number(),
  costSource: CostSource,
  providerMetadata: QueryProviderMetadata.optional(),
  runContext: QgridRunContext.optional(),
});

export type QueryOutput = z.infer<typeof QueryOutput>;

// ─── Stream Events ───

export const StreamEvents = z.object({
  delta: z.object({ text: z.string() }),
  toolCall: z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.string(),
  }),
  done: z.object({
    requestLogId: z.number().optional(),
    text: z.string(),
    model: z.string().optional(),
    requestedModel: z.string().optional(),
    modelFallbacks: z.array(ModelFallback).optional(),
    tokenName: z.string().optional(),
    finishReason: FinishReason,
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      reasoning_tokens: z.number(),
      cache_creation_input_tokens: z.number(),
      cache_creation_5m_input_tokens: z.number().optional(),
      cache_creation_1h_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number(),
    }),
    durationMs: z.number(),
    ttftMs: z.number(),
    costUsd: z.number(),
    costSource: CostSource,
    providerMetadata: QueryProviderMetadata.optional(),
    content: z.array(QgridContent),
    runContext: QgridRunContext.optional(),
  }),
  error: z.object({ message: z.string() }),
});

export type StreamEvents = z.infer<typeof StreamEvents>;

// --- Grok media and voice ---

const MiB = 1024 * 1024;

// Fastify bodyLimit for every JSON request; sonamu.config.ts reads it from here.
export const REQUEST_BODY_LIMIT_BYTES = 10 * MiB;

// Media rides inside that JSON body as base64 (4 chars per 3 bytes), so a 10 MiB body carries at
// most 10 MiB x 3/4 = 7.5 MiB of decoded bytes; 0.5 MiB is left for the prompt, options and JSON
// framing. The same budget bounds the audio clip, each inline image, and the sum of a request's
// inline images, so every request the schema accepts also fits the transport.
export const MEDIA_MAX_INLINE_BYTES = 7 * MiB;
const MEDIA_MAX_INLINE_LABEL = `${MEDIA_MAX_INLINE_BYTES / MiB} MiB`;
export const MEDIA_MAX_REFERENCE_IMAGES = 5;

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function base64DecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return Math.floor((data.length * 3) / 4) - padding;
}

/** Decoded bytes of the inline (data URL) images among `refs`; https URLs cost nothing here. */
function inlineImageBytes(refs: ReadonlyArray<string | undefined>): number {
  let total = 0;

  for (const ref of refs) {
    const match = ref === undefined ? null : IMAGE_DATA_URL.exec(ref);

    if (match) total += base64DecodedBytes(match[2]!);
  }

  return total;
}

const INLINE_IMAGES_TOTAL_MESSAGE = `inline images exceed ${MEDIA_MAX_INLINE_LABEL} in total`;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// An https URL (fetched by xAI, never by qgrid) or a base64 image data URL within
// MEDIA_MAX_INLINE_BYTES.
export const MediaImageRef = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (value.startsWith("data:")) {
      const match = IMAGE_DATA_URL.exec(value);

      if (!match || match[2]!.length % 4 !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "image data URLs must be base64 image/png, image/jpeg or image/webp",
        });
      } else if (base64DecodedBytes(match[2]!) > MEDIA_MAX_INLINE_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: `image data URL exceeds ${MEDIA_MAX_INLINE_LABEL}`,
        });
      }

      return;
    }

    if (!isHttpsUrl(value)) {
      ctx.addIssue({ code: "custom", message: "image URLs must use https or a data URL" });
    }
  });

const GrokModelId = z.string().regex(/^grok\/[A-Za-z0-9._-]+$/, "model must be grok/<id>");

const MediaCallOptions = {
  // Exact token address (grok/<name>), same contract as QueryInput.tokenName.
  tokenName: z.string().optional(),
  projectName: z.string().optional(),
  // false writes no request log, as for query.
  logger: z.boolean().optional(),
};

export const GenerateImagesInput = z
  .object({
    model: GrokModelId,
    prompt: z.string().min(1),
    n: z.number().int().min(1).max(3).optional(),
    aspectRatio: z.string().min(1).max(16).optional(),
    resolution: z.string().min(1).max(16).optional(),
    quality: z.string().min(1).max(16).optional(),
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
    // Present: /images/edits with these references; absent: /images/generations.
    referenceImages: z.array(MediaImageRef).min(1).max(MEDIA_MAX_REFERENCE_IMAGES).optional(),
    ...MediaCallOptions,
  })
  .refine((input) => inlineImageBytes(input.referenceImages ?? []) <= MEDIA_MAX_INLINE_BYTES, {
    message: INLINE_IMAGES_TOTAL_MESSAGE,
    path: ["referenceImages"],
  });

export type GenerateImagesInput = z.infer<typeof GenerateImagesInput>;

export const MediaCostSource = z.enum(["provider", "pricing_table"]);

export type MediaCostSource = z.infer<typeof MediaCostSource>;

export const GenerateImagesOutput = z.object({
  requestLogId: z.number().optional(),
  model: z.string(),
  tokenName: z.string(),
  images: z.array(
    z.object({
      b64: z.string(),
      mimeType: z.string(),
      revisedPrompt: z.string().optional(),
    }),
  ),
  usage: z.object({
    imageCount: z.number(),
    costInUsdTicks: z.number().optional(),
  }),
  // Absent when xAI reported no cost and the model has no catalog price.
  costUsd: z.number().optional(),
  costSource: MediaCostSource.optional(),
});

export type GenerateImagesOutput = z.infer<typeof GenerateImagesOutput>;

export const VideoStartInput = z
  .object({
    model: GrokModelId,
    prompt: z.string().min(1),
    duration: z.number().int().min(1).max(15).optional(),
    aspectRatio: z.string().min(1).max(16).optional(),
    resolution: z.enum(["480p", "720p", "1080p"]).optional(),
    image: MediaImageRef.optional(),
    lastFrame: MediaImageRef.optional(),
    referenceImages: z.array(MediaImageRef).min(1).max(MEDIA_MAX_REFERENCE_IMAGES).optional(),
    // edit-video and extend-video need a source video, which qgrid does not accept.
    mode: z.enum(["reference-to-video"]).optional(),
    ...MediaCallOptions,
  })
  .refine((input) => input.mode !== "reference-to-video" || input.referenceImages !== undefined, {
    message: "reference-to-video needs at least one referenceImages entry",
    path: ["referenceImages"],
  })
  // Every inline image shares the one request body.
  .refine(
    (input) =>
      inlineImageBytes([input.image, input.lastFrame, ...(input.referenceImages ?? [])]) <=
      MEDIA_MAX_INLINE_BYTES,
    { message: INLINE_IMAGES_TOTAL_MESSAGE, path: ["referenceImages"] },
  );

export type VideoStartInput = z.infer<typeof VideoStartInput>;

export const VideoStartOutput = z.object({
  // Unguessable server-side handle; polling must present the same projectName as the start.
  jobHandle: z.string(),
  model: z.string(),
  requestLogId: z.number().optional(),
});

export type VideoStartOutput = z.infer<typeof VideoStartOutput>;

export const VideoStatusInput = z.object({
  jobHandle: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  projectName: z.string().optional(),
});

export type VideoStatusInput = z.infer<typeof VideoStatusInput>;

export const VideoStatusOutput = z.object({
  status: z.enum(["pending", "done", "failed"]),
  // The upstream api.x.ai URL, returned unchanged; qgrid never fetches or stores the video.
  url: z.string().optional(),
  mimeType: z.literal("video/mp4"),
  durationSec: z.number().optional(),
  costInUsdTicks: z.number().optional(),
  costUsd: z.number().optional(),
  error: z.string().optional(),
  requestLogId: z.number().optional(),
});

export type VideoStatusOutput = z.infer<typeof VideoStatusOutput>;

// Voice endpoints accept Grok and OpenAI ids; the frame routes by prefix.
const VoiceModelId = z
  .string()
  .regex(/^(grok|openai)\/[A-Za-z0-9._-]+$/, "model must be grok/<id> or openai/<id>");

export const TranscribeInput = z.object({
  model: VoiceModelId.optional(),
  // Base64 audio bytes (no data: prefix), at most MEDIA_MAX_INLINE_BYTES decoded.
  audio: z
    .string()
    .min(1)
    .refine((value) => value.length % 4 === 0 && BASE64.test(value), "audio must be base64")
    .refine(
      (value) => base64DecodedBytes(value) <= MEDIA_MAX_INLINE_BYTES,
      `audio exceeds ${MEDIA_MAX_INLINE_LABEL}`,
    ),
  mediaType: z.string().regex(/^audio\/[A-Za-z0-9.+-]+$/, "mediaType must be audio/*"),
  language: z.string().min(1).max(16).optional(),
  // OpenAI realtime transcription only: domain vocabulary or style hint for the model.
  prompt: z.string().min(1).max(2_000).optional(),
  ...MediaCallOptions,
});

export type TranscribeInput = z.infer<typeof TranscribeInput>;

export const TranscribeOutput = z.object({
  text: z.string(),
  language: z.string().optional(),
  durationSec: z.number().optional(),
  model: z.string(),
  tokenName: z.string(),
  requestLogId: z.number().optional(),
});

export type TranscribeOutput = z.infer<typeof TranscribeOutput>;

export const SpeakInput = z.object({
  model: VoiceModelId.optional(),
  text: z.string().min(1).max(15_000),
  voice: z.string().min(1).max(64).optional(),
  language: z.string().min(1).max(16).optional(),
  format: z.enum(["mp3", "wav", "pcm", "mulaw", "alaw"]).optional(),
  // OpenAI realtime speech only: style guidance appended to the verbatim-repeat instruction.
  instructions: z.string().min(1).max(2_000).optional(),
  ...MediaCallOptions,
});

export type SpeakInput = z.infer<typeof SpeakInput>;

export const SpeakOutput = z.object({
  // Base64 audio bytes.
  audio: z.string(),
  mimeType: z.string(),
  tokenName: z.string(),
  requestLogId: z.number().optional(),
});

export type SpeakOutput = z.infer<typeof SpeakOutput>;

// ─── Run Lifecycle ───

export const CreateRunInput = z.object({
  userPrompt: z.string(),
  systemPrompt: z.string().optional(),
  modelName: z.string().optional(),
  effort: z.string().optional(),
  projectName: z.string().optional(),
  history: z.string().optional(),
  isStructured: z.boolean().optional(),
  jsonSchema: z.string().nullable().optional(),
});

export type CreateRunInput = z.infer<typeof CreateRunInput>;

export const AppendStepInput = z.object({
  requestLogId: z.number(),
  stepIndex: z.number(),
  type: z.enum(["generate", "tool_call"]),
  modelName: z.string().optional(),
  requestedModelName: z.string().optional(),
  fallbackCount: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  cacheCreation5mTokens: z.number().optional(),
  cacheCreation1hTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: CostSource.optional(),
  durationMs: z.number().optional(),
  ttftMs: z.number().nullable().optional(),
  finishReason: z.string().optional(),
  reasoningText: z.string().optional(),
  reasoningTokens: z.number().optional(),
  toolCallIndex: z.number().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  toolArgs: z.string().optional(),
  toolResult: z.string().optional(),
  toolDurationMs: z.number().optional(),
  error: z.string().optional(),
});

export type AppendStepInput = z.infer<typeof AppendStepInput>;

export const FinishRunInput = z.object({
  requestLogId: z.number(),
  status: z.enum(["succeeded", "error", "aborted"]),
  response: z.string().optional(),
  tokenName: z.string().optional(),
  modelName: z.string().optional(),
  requestedModelName: z.string().optional(),
  fallbackCount: z.number().optional(),
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalCacheReadTokens: z.number().optional(),
  totalCacheCreationTokens: z.number().optional(),
  totalCacheCreation5mTokens: z.number().optional(),
  totalCacheCreation1hTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: CostSource.optional(),
  totalDurationMs: z.number().optional(),
  history: z.string().optional(),
  errorMessage: z.string().optional(),
  responseJsonOk: z.boolean().optional(),
});

export type FinishRunInput = z.infer<typeof FinishRunInput>;

// ─── Token Management ───

export const TokenStats = z.object({
  token: z.string(),
  name: z.string(),
  provider: z.string(),
  requests: z.number(),
});

export type TokenStats = z.infer<typeof TokenStats>;

// ─── OAuth ───

export const OAuthStartResult = z.object({
  authUrl: z.string(),
  // redirect: 브라우저 자동 복귀(루프백 접속). code: 콘솔 콜백 + 코드 붙여넣기(원격 접속).
  // OpenAI 원격 경로는 등록된 loopback callback URL 전체를 붙여넣는 code 모드를 쓴다.
  mode: z.enum(["redirect", "code"]),
});

export type OAuthStartResult = z.infer<typeof OAuthStartResult>;

// Grok device-code login (RFC 8628). The web shows userCode/verificationUri and polls
// oauthPollGrokDevice every `interval` seconds until `added` or an error.
export const GrokDeviceCodeStart = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string().optional(),
  expiresIn: z.number(),
  interval: z.number(),
});

export type GrokDeviceCodeStart = z.infer<typeof GrokDeviceCodeStart>;

export const GrokDevicePollResult = z.object({
  status: z.enum(["pending", "slow_down", "added"]),
  name: z.string().optional(),
  // Seconds to wait before the next poll; grows on slow_down.
  intervalSec: z.number().optional(),
});

export type GrokDevicePollResult = z.infer<typeof GrokDevicePollResult>;

const RateWindow = z
  .object({
    utilization: z.number().nullable(),
    resetsAt: z.string().nullable(),
    windowDurationMins: z.number().nullable().optional(),
  })
  .nullable();

export const UsageResponse = z.object({
  error: z.string().optional(),
  provider: z.string().optional(),
  fiveHour: RateWindow.optional(),
  sevenDay: RateWindow.optional(),
  // Grok: billing period label (USAGE_PERIOD_TYPE_WEEKLY|MONTHLY); the window itself is in sevenDay.
  periodType: z.string().nullable().optional(),
  tier: z.string().nullable().optional(),
  // Grok D6: on-demand billing enabled at xAI excludes the token from routing.
  onDemandExcluded: z.boolean().optional(),
  // Grok: Zero Data Retention at xAI excludes the token from video only (plan §11).
  zdrVideoExcluded: z.boolean().optional(),
  // Grok: token-window keepalive does not apply; the UI says so.
  keepaliveApplicable: z.boolean().optional(),
});

export type UsageResponse = z.infer<typeof UsageResponse>;

// ─── Health ───

export const SubscriberStatus = z.object({
  connected: z.boolean(),
  connectedAt: z.date().nullable(),
  lastReconcileAt: z.date().nullable(),
  attempt: z.number(),
});

export type SubscriberStatus = z.infer<typeof SubscriberStatus>;

export const ProviderStartupState = z.enum(["starting", "ready", "failed"]);

export type ProviderStartupState = z.infer<typeof ProviderStartupState>;

export const HealthResponse = z.object({
  status: z.string(),
  activeTokens: z.number(),
  subscriber: SubscriberStatus.nullable(),
  // HTTP 리스닝은 dispatcher 기동보다 먼저 열린다. 200 응답만으로는 요청을 처리할 수
  // 있는지 알 수 없어 provider 별 준비 상태를 함께 노출한다.
  ready: z.boolean(),
  providers: z.object({
    openai: ProviderStartupState,
    anthropic: ProviderStartupState,
    grok: ProviderStartupState.optional(),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

// ─── Errors ───

export class QuotaError extends Error {
  readonly code = "QUOTA_EXHAUSTED" as const;
}

export class QuotaThresholdExceededError extends Error {
  readonly code = "QUOTA_THRESHOLD_EXCEEDED" as const;
}

export class TimeoutError extends Error {
  readonly code = "TIMEOUT" as const;
}

export class ProcessError extends Error {
  readonly code = "PROCESS_ERROR" as const;
}

// ─── Utils ───

export function maskToken(token: string): string {
  return token.length > 4 ? `...${token.slice(-4)}` : token;
}
