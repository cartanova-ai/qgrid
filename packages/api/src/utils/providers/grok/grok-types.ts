import { z } from "zod";

import { type JsonValue } from "../common/provider-types";
import { GROK_AUTH_ISSUER } from "./grok-constants";

// External data (stored credentials, proxy and api.x.ai JSON) is validated with these schemas,
// never cast. Response schemas are loose: unknown keys pass through so the proxy can add
// fields without breaking qgrid.

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const JwtHeader = z.looseObject({ typ: z.string(), alg: z.string().optional() });

const JwtPayload = z.looseObject({
  iss: z.string(),
  sub: z.string().optional(),
  exp: z.number().optional(),
});

export interface DecodedGrokJwt {
  header: z.infer<typeof JwtHeader>;
  payload: z.infer<typeof JwtPayload>;
}

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string): JsonValue | undefined {
  if (!BASE64URL_SEGMENT.test(segment)) return undefined;

  try {
    // JSON.parse without a reviver yields only JSON values.
    const decoded: JsonValue = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

    return decoded;
  } catch {
    return undefined;
  }
}

/** Decodes a compact JWT's header and payload. The signature is never verified. */
export function decodeGrokJwt(token: string): DecodedGrokJwt | undefined {
  const parts = token.split(".");

  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
  const header = JwtHeader.safeParse(decodeSegment(parts[0]));
  const payload = JwtPayload.safeParse(decodeSegment(parts[1]));

  if (!header.success || !payload.success) return undefined;

  return { header: header.data, payload: payload.data };
}

/** An RFC 9068 access token (`typ: at+jwt`) issued by auth.x.ai. API keys are rejected. */
export function isGrokAccessToken(token: string): boolean {
  const decoded = decodeGrokJwt(token);

  if (!decoded) return false;
  const typ = decoded.header.typ.toLowerCase();

  return (
    (typ === "at+jwt" || typ === "application/at+jwt") && decoded.payload.iss === GROK_AUTH_ISSUER
  );
}

// xAI ids do not always carry RFC 9562 version/variant bits (observed x-request-id
// `19bfa1b2-a163-9e0c-...`), so ids are checked for the 8-4-4-4-12 hex shape only.
const GrokId = z.guid();

export const GrokCredentials = z.object({
  authMode: z.literal("oauth"),
  accessToken: z.string().refine(isGrokAccessToken, {
    message: "accessToken must be an at+jwt access token issued by https://auth.x.ai",
  }),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  issuer: z.literal(GROK_AUTH_ISSUER),
  clientId: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  userId: GrokId,
  sessionId: GrokId,
  agentId: GrokId,
  subscriptionTier: z.string().optional(),
});

export type GrokCredentials = z.infer<typeof GrokCredentials>;

// ---------------------------------------------------------------------------
// Chat proxy JSON (cli-chat-proxy.grok.com/v1)
// ---------------------------------------------------------------------------

/** `GET /billing?format=credits` (camelCase, no on-demand field; U0 item 3). */
export const GrokBillingConfig = z.looseObject({
  config: z.looseObject({
    // Protobuf JSON omits zero-valued scalars: a period with no usage arrives without this field.
    creditUsagePercent: z.number().default(0),
    currentPeriod: z.looseObject({
      type: z.string(),
      start: z.string(),
      end: z.string(),
    }),
    prepaidBalance: z.looseObject({ val: z.union([z.number(), z.string()]) }).optional(),
    isUnifiedBillingUser: z.boolean().optional(),
    productUsage: z
      .array(z.looseObject({ product: z.string(), usagePercent: z.number() }))
      .optional(),
  }),
});

export type GrokBillingConfig = z.infer<typeof GrokBillingConfig>;

/** `GET /settings`. `on_demand_enabled: true` excludes the token (D6); null/absent allows. */
export const GrokSettings = z.looseObject({
  min_client_version: z.string().optional(),
  force_update: z.boolean().nullish(),
  default_model: z.string().nullish(),
  subscription_tier_display: z.string().nullish(),
  on_demand_enabled: z.boolean().nullish(),
  image_gen_enabled: z.boolean().nullish(),
  video_gen_enabled: z.boolean().nullish(),
  voice_mode_enabled: z.boolean().nullish(),
  accept_request_encodings: z.array(z.string()).nullish(),
});

export type GrokSettings = z.infer<typeof GrokSettings>;

/** `GET /user?include=subscription`. `userId` is the account identity key. */
export const GrokUserSubscription = z.looseObject({
  userId: GrokId,
  email: z.string().optional(),
  subscriptionTier: z.string().nullish(),
  hasGrokCodeAccess: z.boolean().optional(),
  /** Zero Data Retention opt-out; `true` was observed while ZDR was on (plan §11). */
  codingDataRetentionOptOut: z.boolean().nullish(),
});

export type GrokUserSubscription = z.infer<typeof GrokUserSubscription>;

export const GrokModelReasoningEffort = z.looseObject({
  id: z.string(),
  value: z.string(),
  label: z.string().optional(),
  default: z.boolean().optional(),
});

export const GrokProxyModel = z.looseObject({
  id: z.string(),
  context_window: z.number().int().positive(),
  context_windows: z.array(z.number().int().positive()).optional(),
  api_backend: z.string(),
  reasoning_effort: z.string().nullish(),
  reasoning_efforts: z.array(GrokModelReasoningEffort).optional(),
  supports_reasoning_effort: z.boolean().optional(),
});

export type GrokProxyModel = z.infer<typeof GrokProxyModel>;

/** `GET /models` on the proxy (`{object: "list", data: [...]}`). */
export const GrokModelsResponse = z.looseObject({
  object: z.string().optional(),
  data: z.array(GrokProxyModel),
});

export type GrokModelsResponse = z.infer<typeof GrokModelsResponse>;

// ---------------------------------------------------------------------------
// Public API JSON (api.x.ai/v1). Prices are ticks (1e-10 USD) per token or per image.
// ---------------------------------------------------------------------------

const ticks = z.number().nonnegative();

export const GrokApiLanguageModel = z.looseObject({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  context_length: z.number().int().positive().optional(),
  prompt_text_token_price: ticks,
  cached_prompt_text_token_price: ticks.optional(),
  completion_text_token_price: ticks,
  prompt_image_token_price: ticks.optional(),
  prompt_text_token_price_long_context: ticks.optional(),
  cached_prompt_text_token_price_long_context: ticks.optional(),
  completion_text_token_price_long_context: ticks.optional(),
  long_context_threshold: z.number().int().positive().optional(),
});

export type GrokApiLanguageModel = z.infer<typeof GrokApiLanguageModel>;

// The live envelope of /language-models was not captured; accept either list key.
export const GrokApiLanguageModelCatalog = z.union([
  z.looseObject({ models: z.array(GrokApiLanguageModel) }),
  z.looseObject({ data: z.array(GrokApiLanguageModel) }),
]);

export type GrokApiLanguageModelCatalog = z.infer<typeof GrokApiLanguageModelCatalog>;

export const GrokApiImageModel = z.looseObject({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  image_price: ticks.optional(),
  pricing: z
    .array(
      z.looseObject({
        quality: z.string().optional(),
        resolution: z.string().optional(),
        price_per_image: ticks,
      }),
    )
    .optional(),
});

export type GrokApiImageModel = z.infer<typeof GrokApiImageModel>;

export const GrokApiImageModelCatalog = z.union([
  z.looseObject({ models: z.array(GrokApiImageModel) }),
  z.looseObject({ data: z.array(GrokApiImageModel) }),
]);

export type GrokApiImageModelCatalog = z.infer<typeof GrokApiImageModelCatalog>;

/** Model list of either catalog, whichever envelope key the API used. */
export function grokCatalogModels<T>(catalog: { models: T[] } | { data: T[] }): T[] {
  return "models" in catalog ? catalog.models : catalog.data;
}

const ticksUsage = z.looseObject({ cost_in_usd_ticks: z.number().int().nonnegative().optional() });

/** `POST /images/generations` and `/images/edits` with `response_format: "b64_json"`. */
export const GrokImageResponse = z.looseObject({
  data: z
    .array(
      z.looseObject({
        b64_json: z.string().min(1),
        mime_type: z.string().optional(),
        revised_prompt: z.string().nullish(),
        respect_moderation: z.boolean().optional(),
      }),
    )
    .min(1),
  usage: ticksUsage.optional(),
});

export type GrokImageResponse = z.infer<typeof GrokImageResponse>;

/** `POST /videos/generations`. */
export const GrokVideoStart = z.looseObject({ request_id: z.string().min(1) });

export type GrokVideoStart = z.infer<typeof GrokVideoStart>;

/**
 * `GET /videos/{request_id}`. The result is a URL: `video.url`, else
 * `video.file_output.public_url` (@ai-sdk/xai xai-video-model.ts:693-694, 782-799).
 */
export const GrokVideoStatus = z.looseObject({
  status: z.string(),
  video: z
    .looseObject({
      url: z.string().nullish(),
      duration: z.number().nullish(),
      file_output: z.looseObject({ public_url: z.string().nullish() }).nullish(),
    })
    .nullish(),
  usage: ticksUsage.nullish(),
});

export type GrokVideoStatus = z.infer<typeof GrokVideoStatus>;

export function grokVideoUrl(status: GrokVideoStatus): string | undefined {
  return status.video?.url ?? status.video?.file_output?.public_url ?? undefined;
}

/** `POST /stt` (multipart). */
export const GrokSttResponse = z.looseObject({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().nonnegative().optional(),
});

export type GrokSttResponse = z.infer<typeof GrokSttResponse>;

/** `POST /tts` body; the API answers 422 without `language` (U0). */
export const GrokTtsRequest = z.object({
  text: z.string().min(1),
  voice: z.string().min(1),
  language: z.string().min(1),
  format: z.string().min(1),
});

export type GrokTtsRequest = z.infer<typeof GrokTtsRequest>;

// ---------------------------------------------------------------------------
// Ports (implemented by grok-refresh, grok-media-client, grok-voice-client)
// ---------------------------------------------------------------------------

export interface GrokTokenRef {
  tokenId: number;
  credentials: GrokCredentials;
}

export type GrokRefreshResult =
  | { status: "refreshed"; credentials: GrokCredentials }
  | { status: "reauth_required"; reason: string };

export interface GrokRefresher {
  /** Single-flight per token; returns credentials still valid for at least the refresh margin. */
  ensureFresh(token: GrokTokenRef, signal?: AbortSignal): Promise<GrokCredentials>;
  /** Forced refresh after a 401; never reuses the rejected access token. */
  refreshAfterUnauthorized(token: GrokTokenRef, signal?: AbortSignal): Promise<GrokRefreshResult>;
}

export interface GrokImageGenerateRequest {
  model: string;
  prompt: string;
  n?: number;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  outputFormat?: string;
  signal?: AbortSignal;
}

export interface GrokImageEditRequest extends GrokImageGenerateRequest {
  /** Data URLs or https URLs of the reference images. */
  images: string[];
}

export interface GrokVideoStartRequest {
  model: string;
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: "480p" | "720p" | "1080p";
  image?: string;
  lastFrame?: string;
  referenceImages?: string[];
  mode?: "reference-to-video";
  signal?: AbortSignal;
}

/** Per-request identity for api.x.ai Imagine calls: the bearer and the `x-grok-session-id`. */
export interface GrokMediaAuth {
  bearer: string;
  sessionId: string;
}

export interface GrokMediaPort {
  generateImages(
    auth: GrokMediaAuth,
    request: GrokImageGenerateRequest,
  ): Promise<GrokImageResponse>;
  editImages(auth: GrokMediaAuth, request: GrokImageEditRequest): Promise<GrokImageResponse>;
  startVideo(auth: GrokMediaAuth, request: GrokVideoStartRequest): Promise<GrokVideoStart>;
  getVideo(auth: GrokMediaAuth, requestId: string, signal?: AbortSignal): Promise<GrokVideoStatus>;
}

export interface GrokTranscribeRequest {
  audio: Uint8Array;
  mediaType: string;
  model?: string;
  language?: string;
  signal?: AbortSignal;
}

export interface GrokSpeechResult {
  audio: Uint8Array;
  mediaType: string;
}

export interface GrokVoicePort {
  transcribe(bearer: string, request: GrokTranscribeRequest): Promise<GrokSttResponse>;
  speak(
    bearer: string,
    request: GrokTtsRequest & { signal?: AbortSignal },
  ): Promise<GrokSpeechResult>;
}
