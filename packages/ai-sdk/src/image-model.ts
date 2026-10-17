import {
  type ImageModelV3,
  type ImageModelV3File,
  type JSONObject,
  type JSONValue,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import { z } from "zod";

import { qgridFetch } from "./http-transport";
import {
  type QgridImageModel,
  type QgridImageProviderConfig,
  type QgridInputPart,
  queryOutputSchema,
} from "./index.types";
import { DEFAULT_QGRID_SERVER_URL, QGRID_PROVIDER_NAME } from "./qgrid.constant";
import { assertImageInputFitsJsonTransport, bytesToBase64 } from "./utils";

function imageInputUrl(file: ImageModelV3File): string {
  if (file.type === "url") {
    if (!/^https:\/\//i.test(file.url)) {
      throw new Error("qgrid.image: reference image URLs must use HTTPS");
    }

    return file.url;
  }

  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mediaType)) {
    throw new Error("qgrid.image: reference images must be PNG, JPEG, or WebP");
  }

  const data = file.data instanceof Uint8Array ? bytesToBase64(file.data) : file.data;

  return `data:${file.mediaType};base64,${data}`;
}

// --- Shared Grok media transport (image, video, transcription, speech) ---

/** Server-side Fastify body limit (`sonamu.config.ts` `bodyLimit`). Larger bodies get a 413. */
export const QGRID_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/** `config` for `qgrid.image/video/transcription/speech`; same fields as the language model. */
export type QgridMediaProviderConfig = QgridImageProviderConfig;

export type ResolvedMediaConfig = { serverUrl: string; projectName: string | undefined };

export function resolveMediaConfig(config?: QgridMediaProviderConfig): ResolvedMediaConfig {
  return {
    serverUrl: config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL,
    projectName: config?.projectName ?? process.env.QGRID_PROJECT_NAME,
  };
}

const GROK_MODEL_ID = /^grok\/[A-Za-z0-9._-]+$/;

export function assertGrokModelId(modelId: string, label: string): void {
  if (!GROK_MODEL_ID.test(modelId)) {
    throw new Error(`${label}: unsupported model ${modelId}; expected grok/<id>`);
  }
}

export type VoiceProvider = "grok" | "openai";

/** Voice factories accept `grok/<id>` and `openai/<id>`; everything else throws at creation. */
export function voiceProviderOf(modelId: string, label: string): VoiceProvider {
  if (GROK_MODEL_ID.test(modelId)) return "grok";

  if (/^openai\/[A-Za-z0-9._-]+$/.test(modelId)) return "openai";
  throw new Error(`${label}: unsupported model ${modelId}; expected grok/<id> or openai/<id>`);
}

const openaiQgridOptionsSchema = z.object({
  tokenName: z
    .string()
    .refine((value) => /^openai\/.+/.test(value.trim()), {
      message: "tokenName must be a non-empty OpenAI token name with the openai/ prefix",
    })
    .optional(),
  logger: z.boolean({ message: "logger must be a boolean" }).optional(),
});

/** `providerOptions.qgrid` accepted by OpenAI voice models. */
export type QgridOpenAIMediaProviderOptions = z.infer<typeof openaiQgridOptionsSchema>;

/** `providerOptions.qgrid` for an `openai/` voice model: tokenName must carry the openai/ prefix. */
export function parseOpenAIQgridOptions(
  raw: JSONValue | undefined,
  label: string,
): GrokQgridRequestOptions {
  if (raw === undefined) return {};

  if (!providerOptionsObjectSchema.safeParse(raw).success) {
    throw new Error(`${label}: providerOptions.qgrid must be an object`);
  }

  const parsed = openaiQgridOptionsSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`${label}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  const request: GrokQgridRequestOptions = {};

  if (parsed.data.tokenName !== undefined) request.tokenName = parsed.data.tokenName;

  if (parsed.data.logger === false) request.logger = false;

  return request;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Server `MEDIA_MAX_INLINE_BYTES` (qgrid.types.ts): decoded inline audio, each inline image, and all
 * inline images of one request together. Derived from the 10 MiB body limit: base64 grows bytes by
 * 4/3, so 7 MiB decoded is about 9.3 MiB encoded, leaving room for the rest of the JSON body.
 */
export const QGRID_MAX_INLINE_MEDIA_BYTES = 7 * 1024 * 1024;

function base64DecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Rejects inline media above the server's decoded-size cap before transport. Accepts base64
 * strings and data URLs; https URLs cost nothing because xAI fetches them.
 */
export function assertInlineMediaFits(items: Array<string | undefined>, label: string): void {
  let total = 0;

  for (const item of items) {
    if (item === undefined || /^https:\/\//i.test(item)) continue;
    const comma = item.startsWith("data:") ? item.indexOf(",") : -1;
    total += base64DecodedBytes(comma >= 0 ? item.slice(comma + 1) : item);
  }

  if (total > QGRID_MAX_INLINE_MEDIA_BYTES) {
    throw new Error(
      `${label}: inline media is ${formatMiB(total)}, above the qgrid server limit of ${formatMiB(QGRID_MAX_INLINE_MEDIA_BYTES)} per request; compress it or pass an https URL where supported.`,
    );
  }
}

/**
 * Serializes a Sonamu `params` body and rejects it before transport when it would exceed the
 * server body limit, so callers get a clear error instead of an opaque 413.
 */
export function serializeMediaBody(params: JSONObject, label: string): string {
  const body = JSON.stringify({ params });
  const bytes = new TextEncoder().encode(body).byteLength;

  if (bytes > QGRID_MAX_REQUEST_BODY_BYTES) {
    throw new Error(
      `${label}: request body is ${formatMiB(bytes)}, above the qgrid server limit of ${formatMiB(QGRID_MAX_REQUEST_BODY_BYTES)}; compress inline media or pass an https URL where supported.`,
    );
  }

  return body;
}

const ERROR_BODY_PREVIEW_CHARS = 2_000;

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

/**
 * Rethrows `cause` when it is an abort. When `signal` fired, its own reason is thrown so callers
 * that compare reasons (the video poll deadline) can tell which abort it was.
 */
function rethrowAbort(cause: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? cause;

  if (isAbortError(cause)) throw cause;
}

/** Non-2xx response from a qgrid media endpoint. */
export class QgridMediaHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "QgridMediaHttpError";
    this.status = status;
  }
}

export type MediaPostResult<T> = { data: T; headers: Record<string, string> };

/** POSTs one Sonamu media endpoint and validates the JSON response with `schema`. */
export async function postMediaEndpoint<T>(args: {
  serverUrl: string;
  endpoint: string;
  body: string;
  schema: z.ZodType<T>;
  label: string;
  signal?: AbortSignal;
  headers?: Record<string, string | undefined>;
}): Promise<MediaPostResult<T>> {
  const headers = new Headers();

  for (const [key, value] of Object.entries(args.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }

  headers.set("Content-Type", "application/json");
  const init: RequestInit = { method: "POST", headers, body: args.body };

  if (args.signal) init.signal = args.signal;
  let response: Response;

  try {
    response = await fetch(`${args.serverUrl}/api/qgrid/${args.endpoint}`, init);
  } catch (error) {
    rethrowAbort(error, args.signal);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${args.label}: ${args.endpoint} transport failed: ${detail}`, {
      cause: error,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch((cause: unknown) => {
      rethrowAbort(cause, args.signal);

      return "";
    });

    if (response.status === 413) {
      throw new QgridMediaHttpError(
        `${args.label}: the qgrid server rejected the request as too large (413); inline media is limited to ${formatMiB(QGRID_MAX_INLINE_MEDIA_BYTES)} decoded per request. ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
        413,
      );
    }

    throw new QgridMediaHttpError(
      `qgrid ${args.endpoint} ${response.status}: ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
      response.status,
    );
  }

  // Only a body that is not JSON becomes the schema error below; an abort mid-body propagates.
  const json: unknown = await response.json().catch((cause: unknown) => {
    rethrowAbort(cause, args.signal);

    return undefined;
  });

  const parsed = args.schema.safeParse(json);

  if (!parsed.success) {
    throw new Error(
      `${args.label}: unexpected ${args.endpoint} response; update the qgrid server and SDK together (${formatIssues(parsed.error)})`,
    );
  }

  return { data: parsed.data, headers: Object.fromEntries(response.headers) };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

const grokQgridOptionsSchema = z.object({
  tokenName: z
    .string()
    .refine((value) => /^grok\/.+/.test(value.trim()), {
      message: "tokenName must be a non-empty Grok token name with the grok/ prefix",
    })
    .optional(),
  logger: z.boolean({ message: "logger must be a boolean" }).optional(),
});

/** `providerOptions.qgrid` accepted by every Grok media model. */
export type QgridGrokMediaProviderOptions = z.infer<typeof grokQgridOptionsSchema>;

/** Any non-null, non-array object; field validation happens in the option schemas. */
const providerOptionsObjectSchema = z.looseObject({});

export interface GrokQgridRequestOptions {
  tokenName?: string;
  logger?: false;
}

export function parseGrokQgridOptions(
  raw: JSONValue | undefined,
  label: string,
): GrokQgridRequestOptions {
  if (raw === undefined) return {};

  if (!providerOptionsObjectSchema.safeParse(raw).success) {
    throw new Error(`${label}: providerOptions.qgrid must be an object`);
  }

  const parsed = grokQgridOptionsSchema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(`${label}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  const request: GrokQgridRequestOptions = {};

  if (parsed.data.tokenName !== undefined) request.tokenName = parsed.data.tokenName;

  if (parsed.data.logger === false) request.logger = false;

  return request;
}

export interface ParsedXaiMediaOptions<T> {
  options: T | undefined;
  warnings: SharedV3Warning[];
}

/**
 * Validates `providerOptions.xai` against `schema` and warns about every set key outside
 * `honored`. Malformed values throw; documented-but-unsupported keys become warnings.
 */
export function parseXaiMediaOptions<T>(
  raw: JSONValue | undefined,
  schema: z.ZodType<T>,
  honored: ReadonlySet<string>,
  label: string,
): ParsedXaiMediaOptions<T> {
  return parseNamespacedMediaOptions("xai", raw, schema, honored, label);
}

/**
 * Validates `providerOptions.<namespace>` against the official provider's schema and warns for
 * every set key qgrid does not honor, so code written for `@ai-sdk/xai` or `@ai-sdk/openai`
 * keeps parsing and learns what was dropped.
 */
export function parseNamespacedMediaOptions<T>(
  namespace: "xai" | "openai",
  raw: JSONValue | undefined,
  schema: z.ZodType<T>,
  honored: ReadonlySet<string>,
  label: string,
): ParsedXaiMediaOptions<T> {
  if (raw === undefined) return { options: undefined, warnings: [] };
  const record = providerOptionsObjectSchema.safeParse(raw);

  if (!record.success) throw new Error(`${label}: providerOptions.${namespace} must be an object`);
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    throw new Error(
      `${label}: invalid providerOptions.${namespace}: ${formatIssues(parsed.error)}`,
    );
  }

  const warnings: SharedV3Warning[] = [];

  for (const [key, value] of Object.entries(record.data)) {
    if (value === undefined || value === null || honored.has(key)) continue;
    warnings.push({
      type: "unsupported",
      feature: `providerOptions.${namespace}.${key}`,
      details: `qgrid does not support providerOptions.${namespace}.${key} for this model; it was ignored.`,
    });
  }

  return { options: parsed.data, warnings };
}

const IMAGE_REF_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"];

type MediaFile =
  | { type: "file"; mediaType: string; data: string | Uint8Array }
  | { type: "url"; url: string };

/** An AI SDK file as the server's image reference: an https URL or a base64 image data URL. */
export function toImageRef(file: MediaFile, label: string): string {
  if (file.type === "url") return toImageRefUrl(file.url, label);
  const mediaType = file.mediaType.toLowerCase();

  if (!IMAGE_REF_MEDIA_TYPES.includes(mediaType)) {
    throw new Error(`${label}: reference images must be PNG, JPEG, or WebP`);
  }

  const data = file.data instanceof Uint8Array ? bytesToBase64(file.data) : file.data;

  return `data:${mediaType};base64,${data}`;
}

/** Accepts an https URL or a base64 PNG/JPEG/WebP data URL string. */
export function toImageRefUrl(url: string, label: string): string {
  if (/^https:\/\//i.test(url)) return url;

  if (/^data:image\/(png|jpeg|webp);base64,/i.test(url)) return url;
  throw new Error(`${label}: image references must be https URLs or PNG/JPEG/WebP data URLs`);
}

// --- Image models ---

const OPENAI_IMAGE_TOKEN_NAME_MESSAGE =
  "tokenName must be a non-empty OpenAI token name with the openai/ prefix";

/** `providerOptions.qgrid` for `qgrid.image("openai/gpt-image-2")`; issues keep this field order. */
const openAIImageQgridOptionsSchema = z.object({
  tokenName: z
    .string({ message: OPENAI_IMAGE_TOKEN_NAME_MESSAGE })
    .refine((value) => /^openai\/.+/.test(value.trim()), {
      message: OPENAI_IMAGE_TOKEN_NAME_MESSAGE,
    })
    .optional(),
  logger: z.boolean({ message: "logger must be a boolean" }).optional(),
  outputFormat: z
    .literal("png", { message: "the subscription Images endpoint supports PNG output only" })
    .optional(),
  quality: z
    .enum(["low", "medium", "high"], { message: "quality must be low, medium, or high" })
    .optional(),
  background: z
    .enum(["auto", "opaque", "transparent"], {
      message: "background must be auto, opaque, or transparent",
    })
    .optional(),
});

type ImageGenerateResult = Awaited<ReturnType<ImageModelV3["doGenerate"]>>;

export function createQgridImage(
  modelId: QgridImageModel,
  config?: QgridImageProviderConfig,
): ImageModelV3 {
  if (modelId.startsWith("grok/")) return createGrokImage(modelId, config);

  if (modelId !== "openai/gpt-image-2") {
    throw new Error(`qgrid.image: unsupported image model ${modelId}`);
  }

  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL;
  const projectName = config?.projectName ?? process.env.QGRID_PROJECT_NAME;

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    maxImagesPerCall: 1,

    async doGenerate(options) {
      if (options.mask !== undefined) {
        throw new Error("qgrid.image: masks are not supported by the subscription Images endpoint");
      }

      if (options.n !== 1) {
        throw new Error(
          "qgrid.image: only one image per call is supported; omit maxImagesPerCall so AI SDK can batch n images",
        );
      }

      if (!options.prompt?.trim()) {
        throw new Error("qgrid.image: a non-empty text prompt is required");
      }

      if ((options.files?.length ?? 0) > 5) {
        throw new Error("qgrid.image: at most five reference images are supported");
      }

      const parsedQgridOptions = openAIImageQgridOptionsSchema.safeParse(
        options.providerOptions.qgrid ?? {},
      );

      if (!parsedQgridOptions.success) {
        throw new Error(`qgrid.image: ${parsedQgridOptions.error.issues[0]?.message}`);
      }

      const qgridOptions = parsedQgridOptions.data;

      if (options.size !== undefined && !/^[1-9]\d*x[1-9]\d*$/.test(options.size)) {
        throw new Error("qgrid.image: size must be positive integer WIDTHxHEIGHT");
      }

      const imageUrls = (options.files ?? []).map(imageInputUrl);
      assertImageInputFitsJsonTransport(imageUrls);

      const input: QgridInputPart[] = [
        { type: "text", text: options.prompt, text_elements: [] },
        ...imageUrls.map((url) => ({ type: "image" as const, url })),
      ];

      const warnings: Awaited<ReturnType<ImageModelV3["doGenerate"]>>["warnings"] = [];

      for (const feature of ["seed", "aspectRatio"] as const) {
        if (options[feature] !== undefined) {
          warnings.push({
            type: "unsupported",
            feature,
            details:
              "The subscription Images endpoint does not support this setting. Describe the desired result in the prompt.",
          });
        }
      }

      for (const feature of [
        ...(options.size === undefined ? [] : ["size"]),
        ...(qgridOptions.quality === undefined ? [] : ["providerOptions.qgrid.quality"]),
      ]) {
        warnings.push({
          type: "compatibility",
          feature,
          details:
            "This is a hint only. The subscription backend may choose a different size or quality; inspect the returned generation metadata.",
        });
      }

      const timestamp = new Date();
      const headers = new Headers();

      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (value !== undefined) headers.set(key, value);
      }

      headers.set("Content-Type", "application/json");

      const imageGenerationOptions: JSONObject = {};

      if (options.size !== undefined) imageGenerationOptions.size = options.size;

      if (qgridOptions.quality !== undefined) imageGenerationOptions.quality = qgridOptions.quality;

      if (qgridOptions.background !== undefined) {
        imageGenerationOptions.background = qgridOptions.background;
      }

      if (qgridOptions.outputFormat !== undefined) {
        imageGenerationOptions.outputFormat = qgridOptions.outputFormat;
      }

      const args: JSONObject = {
        prompt: options.prompt,
        model: modelId,
        imageGeneration: true,
        imageGenerationOptions,
      };

      if (imageUrls.length) args.input = input;

      if (projectName) args.projectName = projectName;

      if (qgridOptions.tokenName !== undefined) args.tokenName = qgridOptions.tokenName;

      if (qgridOptions.logger === false) args.logger = false;

      const response = await qgridFetch(
        `${serverUrl}/api/qgrid/query`,
        {
          method: "POST",
          headers,
          signal: options.abortSignal,
          body: JSON.stringify({ args }),
        },
        { operation: "query", serverUrl },
      );

      if (!response.ok) {
        throw new Error(`qgrid ${response.status}: ${await response.text().catch(() => "")}`);
      }

      const data = queryOutputSchema.parse(await response.json());
      const images = data.content?.filter((item) => item.type === "image") ?? [];
      const image = images[0];

      if (images.length !== 1 || !image?.data || image.generation?.route !== "codex-images") {
        throw new Error(
          "qgrid.image: expected one image from the direct subscription Images route; update the qgrid server and SDK together",
        );
      }

      const usage = image.generation.usage;
      const imageMetadata: JSONObject = {};

      if (data.requestLogId !== undefined) imageMetadata.requestLogId = data.requestLogId;
      imageMetadata.generation = image.generation;

      if (image.revisedPrompt !== null && image.revisedPrompt !== undefined) {
        imageMetadata.revisedPrompt = image.revisedPrompt;
      }

      const result: ImageGenerateResult = {
        images: [image.data],
        warnings,
        response: {
          timestamp,
          modelId: image.generation.model ?? data.model ?? modelId,
          headers: Object.fromEntries(response.headers),
        },
        providerMetadata: { qgrid: { images: [imageMetadata] } },
      };

      if (usage) {
        result.usage = {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
        };
      }

      return result;
    },
  };
}

// --- Grok images (POST /api/qgrid/generateImages) ---

const GROK_MAX_IMAGES_PER_CALL = 3;

/** `providerOptions.xai` for Grok images, field-for-field from `@ai-sdk/xai` `xaiImageModelOptions`. */
const xaiImageOptionsSchema = z.object({
  aspect_ratio: z.string().optional(),
  output_format: z.string().optional(),
  sync_mode: z.boolean().optional(),
  resolution: z.enum(["1k", "1.5k", "2k"]).optional(),
  quality: z.enum(["low", "medium", "high", "auto"]).optional(),
  user: z.string().optional(),
});

/** `providerOptions.xai` accepted by `qgrid.image("grok/...")` (the `@ai-sdk/xai` image option shape). */
export type QgridXaiImageProviderOptions = z.infer<typeof xaiImageOptionsSchema>;

const XAI_IMAGE_HONORED = new Set(["aspect_ratio", "output_format", "resolution", "quality"]);
const GROK_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;

function isGrokOutputFormat(value: string): value is (typeof GROK_OUTPUT_FORMATS)[number] {
  return GROK_OUTPUT_FORMATS.some((format) => format === value);
}

const generateImagesOutputSchema = z.object({
  requestLogId: z.number().optional(),
  model: z.string(),
  tokenName: z.string(),
  images: z.array(
    z.object({ b64: z.string(), mimeType: z.string(), revisedPrompt: z.string().optional() }),
  ),
  usage: z.object({ imageCount: z.number(), costInUsdTicks: z.number().optional() }),
  costUsd: z.number().optional(),
  costSource: z.enum(["provider", "pricing_table"]).optional(),
});

function createGrokImage(modelId: string, config?: QgridImageProviderConfig): ImageModelV3 {
  const label = "qgrid.image";
  assertGrokModelId(modelId, label);
  const { serverUrl, projectName } = resolveMediaConfig(config);

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    maxImagesPerCall: GROK_MAX_IMAGES_PER_CALL,

    async doGenerate(options) {
      if (!options.prompt?.trim()) {
        throw new Error(`${label}: a non-empty text prompt is required`);
      }

      if (!Number.isInteger(options.n) || options.n < 1 || options.n > GROK_MAX_IMAGES_PER_CALL) {
        throw new Error(
          `${label}: Grok returns 1 to ${GROK_MAX_IMAGES_PER_CALL} images per call; omit maxImagesPerCall so AI SDK can batch`,
        );
      }

      const files = options.files ?? [];

      if (files.length > 5) {
        throw new Error(`${label}: at most five reference images are supported`);
      }

      const qgridOptions = parseGrokQgridOptions(options.providerOptions.qgrid, label);

      const xai = parseXaiMediaOptions(
        options.providerOptions.xai,
        xaiImageOptionsSchema,
        XAI_IMAGE_HONORED,
        label,
      );

      const outputFormat = xai.options?.output_format;

      if (outputFormat !== undefined && !isGrokOutputFormat(outputFormat)) {
        throw new Error(`${label}: providerOptions.xai.output_format must be png, jpeg, or webp`);
      }

      const warnings: SharedV3Warning[] = [];

      if (options.size !== undefined) {
        warnings.push({
          type: "unsupported",
          feature: "size",
          details: "This model does not support the `size` option. Use `aspectRatio` instead.",
        });
      }

      if (options.seed !== undefined) warnings.push({ type: "unsupported", feature: "seed" });

      if (options.mask !== undefined) warnings.push({ type: "unsupported", feature: "mask" });
      warnings.push(...xai.warnings);

      const referenceImages = files.map((file) => toImageRef(file, label));
      assertInlineMediaFits(referenceImages, label);
      const aspectRatio = options.aspectRatio ?? xai.options?.aspect_ratio;

      const params: JSONObject = { model: modelId, prompt: options.prompt, n: options.n };

      if (aspectRatio !== undefined) params.aspectRatio = aspectRatio;

      if (xai.options?.resolution !== undefined) params.resolution = xai.options.resolution;

      if (xai.options?.quality !== undefined) params.quality = xai.options.quality;

      if (outputFormat !== undefined) params.outputFormat = outputFormat;

      if (referenceImages.length) params.referenceImages = referenceImages;

      if (projectName) params.projectName = projectName;
      const body = serializeMediaBody({ ...params, ...qgridOptions }, label);

      const timestamp = new Date();

      const { data, headers } = await postMediaEndpoint({
        serverUrl,
        endpoint: "generateImages",
        body,
        schema: generateImagesOutputSchema,
        label,
        signal: options.abortSignal,
        headers: options.headers,
      });

      if (data.images.length === 0) {
        throw new Error(`${label}: the Grok backend returned no images`);
      }

      const costInUsdTicks = data.usage.costInUsdTicks;

      // generateImage() keeps only `providerMetadata.<provider>.images` when it merges batched
      // calls, so per-call cost and log ids also ride on the image entries (first image of the call).
      const callCost: JSONObject = {};

      if (data.costUsd !== undefined) callCost.costUsd = data.costUsd;

      if (data.costSource !== undefined) callCost.costSource = data.costSource;

      const xaiImages = data.images.map((image, index) => {
        const entry: JSONObject = {};

        if (image.revisedPrompt) entry.revisedPrompt = image.revisedPrompt;

        if (index === 0 && costInUsdTicks !== undefined) entry.costInUsdTicks = costInUsdTicks;

        return entry;
      });

      const xaiCallCost: JSONObject = {};

      if (costInUsdTicks !== undefined) xaiCallCost.costInUsdTicks = costInUsdTicks;

      const qgridImages = data.images.map((image, index) => {
        const entry: JSONObject = { mediaType: image.mimeType, tokenName: data.tokenName };

        if (data.requestLogId !== undefined) entry.requestLogId = data.requestLogId;

        return index === 0 ? { ...entry, ...callCost } : entry;
      });

      const qgridCallInfo: JSONObject = {};

      if (data.requestLogId !== undefined) qgridCallInfo.requestLogId = data.requestLogId;
      qgridCallInfo.tokenName = data.tokenName;

      return {
        images: data.images.map((image) => image.b64),
        warnings,
        response: { timestamp, modelId: data.model, headers },
        providerMetadata: {
          xai: { images: xaiImages, ...xaiCallCost },
          qgrid: { images: qgridImages, ...qgridCallInfo, ...callCost },
        },
      };
    },
  };
}
