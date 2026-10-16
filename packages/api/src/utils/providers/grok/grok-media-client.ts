import { z } from "zod";

import {
  classifyGrokHttpError,
  GrokProtocolError,
  readGrokResponseHeaders,
} from "./grok-backend-protocol";
import {
  GROK_IMAGE_DEFAULT_MODEL,
  GROK_PUBLIC_API_URL,
  GROK_VIDEO_DEFAULT_MODEL,
} from "./grok-constants";
import { GrokHttpError } from "./grok-direct-client";
import { buildGrokMediaHeaders } from "./grok-headers";
import {
  GrokImageResponse,
  GrokVideoStart,
  GrokVideoStatus,
  grokVideoUrl,
  type GrokImageEditRequest,
  type GrokImageGenerateRequest,
  type GrokMediaAuth,
  type GrokMediaPort,
  type GrokVideoStartRequest,
} from "./grok-types";

// api.x.ai Imagine client (images + video). Bodies are plain JSON: grok-build sends them with
// reqwest `.json(payload)` and no content-encoding (1.0.45 xai-grok-tools image_gen/mod.rs:199-214,
// image_edit/mod.rs:398, video_gen/mod.rs:364-367). Every request carries `content-type:
// application/json` because grok-build installs it as a client default header, GET included
// (image_gen/mod.rs:104-105, video_gen/mod.rs:185-186).
//
// Retry safety (plan §5.5): this client never retries. A POST that may have reached upstream
// fails with GrokMediaDeliveryError or GrokMediaTimeoutError, which the dispatcher cannot
// classify and therefore never replays. Only a connect failure that provably happened before
// the request was written becomes a transient GrokHttpError (status 0); the dispatcher fails
// over on exactly that error once. GETs (video polls) also map every transport failure to
// status 0: they are idempotent, and the dispatcher pins polls to their token.

// image_gen/mod.rs:37-38 (the proxy buffers the whole image before the first byte)
export const GROK_IMAGE_TOTAL_TIMEOUT_MS = 300_000;
export const GROK_IMAGE_READ_TIMEOUT_MS = 240_000;
// video_gen/mod.rs:37,40
export const GROK_VIDEO_START_TIMEOUT_MS = 60_000;
export const GROK_VIDEO_POLL_TIMEOUT_MS = 30_000;
// @ai-sdk/xai xai-image-model.ts maxImagesPerCall
export const GROK_IMAGE_MAX_PER_CALL = 3;
// grok-build image_gen/mod.rs:236 and image_edit/mod.rs:367 always send "1k"
const GROK_IMAGE_DEFAULT_RESOLUTION = "1k";
// image_edit/mod.rs:28 (XAI_IMAGINE_EDIT_MODEL equals the generation default)
const GROK_IMAGE_EDIT_DEFAULT_MODEL = GROK_IMAGE_DEFAULT_MODEL;
// @ai-sdk/xai video duration range 1-15 s (plan §3.6)
const GROK_VIDEO_MAX_DURATION_SEC = 15;

const MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface GrokMediaTimeouts {
  imageTotalMs: number;
  imageReadMs: number;
  videoStartMs: number;
  videoPollMs: number;
}

const DEFAULT_TIMEOUTS: GrokMediaTimeouts = {
  imageTotalMs: GROK_IMAGE_TOTAL_TIMEOUT_MS,
  imageReadMs: GROK_IMAGE_READ_TIMEOUT_MS,
  videoStartMs: GROK_VIDEO_START_TIMEOUT_MS,
  videoPollMs: GROK_VIDEO_POLL_TIMEOUT_MS,
};

/** Upstream flagged the output with `respect_moderation: false`. Never retried. */
export class GrokContentPolicyError extends Error {
  constructor(kind: "image" | "video") {
    super(
      `${kind === "image" ? "Image" : "Video"} generation was blocked due to a content policy violation.`,
    );
    this.name = "GrokContentPolicyError";
  }
}

/** A total or read timeout fired. For a POST, upstream may already be executing the job. */
export class GrokMediaTimeoutError extends Error {
  readonly phase: "total" | "read";
  readonly timeoutMs: number;

  constructor(phase: "total" | "read", timeoutMs: number) {
    super(
      `Grok media request ${phase === "total" ? "timed out" : "stalled"} after ${timeoutMs} ms`,
    );
    this.name = "GrokMediaTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/** A POST failed after it may have been written; replaying it could run the job twice. */
export class GrokMediaDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Grok media request failed after it may have been sent: ${message}`, options);
    this.name = "GrokMediaDeliveryError";
  }
}

export interface GrokMediaClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeouts?: Partial<GrokMediaTimeouts>;
}

// Error codes raised while resolving or connecting, i.e. before any request byte was written.
const PRE_SEND_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const ErrorWithCode = z.looseObject({ code: z.string() });
const ErrorWithCause = z.looseObject({ cause: z.unknown() });

/** The first `code` along the `cause` chain (undici wraps socket errors in `TypeError`). */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const withCode = ErrorWithCode.safeParse(current);
    if (withCode.success) return withCode.data.code;
    const withCause = ErrorWithCause.safeParse(current);
    current = withCause.success ? withCause.data.cause : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function connectFailure(error: unknown): GrokHttpError {
  const code = errorCode(error);
  const message = `${errorMessage(error)}${code ? ` (${code})` : ""}`;
  return new GrokHttpError(
    { ...classifyGrokHttpError(0, "", {}), message },
    "",
    {},
    { cause: error },
  );
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function sniffImageMediaType(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export interface GrokDecodedImage {
  bytes: Uint8Array;
  mediaType: string;
  revisedPrompt?: string;
  respectModeration?: boolean;
}

export interface GrokDecodedImages {
  images: GrokDecodedImage[];
  costInUsdTicks?: number;
}

function assertImagesAllowed(response: GrokImageResponse): void {
  if (response.data.some((image) => image.respect_moderation === false))
    throw new GrokContentPolicyError("image");
  for (const image of response.data) {
    if (image.b64_json.length % 4 !== 0 || !BASE64.test(image.b64_json))
      throw new GrokProtocolError("Grok image response carried invalid base64 data");
  }
}

/** Decodes a validated image response. `mime_type` wins; otherwise the bytes are sniffed. */
export function decodeGrokImages(response: GrokImageResponse): GrokDecodedImages {
  assertImagesAllowed(response);
  const images = response.data.map((image): GrokDecodedImage => {
    const bytes = new Uint8Array(Buffer.from(image.b64_json, "base64"));
    const mediaType = image.mime_type?.startsWith("image/")
      ? image.mime_type
      : (sniffImageMediaType(bytes) ?? "image/jpeg");
    return {
      bytes,
      mediaType,
      ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
      ...(image.respect_moderation === undefined
        ? {}
        : { respectModeration: image.respect_moderation }),
    };
  });
  const ticks = response.usage?.cost_in_usd_ticks;
  return { images, ...(ticks === undefined ? {} : { costInUsdTicks: ticks }) };
}

// Fields @ai-sdk/xai reads that grok-types' GrokVideoStatus leaves loose
// (xai-video-model.ts:782-812): `respect_moderation` nests under `video`.
const VideoStatusExtras = z.looseObject({
  video: z.looseObject({ respect_moderation: z.boolean().nullish() }).nullish(),
  error: z.looseObject({ code: z.string().nullish(), message: z.string().nullish() }).nullish(),
});

export interface GrokVideoSummary {
  status: "pending" | "done" | "failed";
  url?: string;
  mimeType: "video/mp4";
  usageTicks?: number;
  error?: string;
}

/**
 * Collapses a poll response to the SDK's three outcomes. The URL is returned unchanged (D4);
 * `expired` and a `done` without a URL are failures (xai-video-model.ts:643-705).
 */
export function summarizeGrokVideoStatus(status: GrokVideoStatus): GrokVideoSummary {
  const extras = VideoStatusExtras.parse(status);
  if (extras.video?.respect_moderation === false) throw new GrokContentPolicyError("video");
  const ticks = status.usage?.cost_in_usd_ticks;
  const base = {
    mimeType: "video/mp4" as const,
    ...(ticks === undefined ? {} : { usageTicks: ticks }),
  };
  if (status.status === "expired")
    return { ...base, status: "failed", error: "Video generation request expired." };
  if (status.status === "failed") {
    const error = extras.error?.message ?? extras.error?.code ?? "Video generation failed.";
    return { ...base, status: "failed", error };
  }
  if (status.status === "done") {
    const url = grokVideoUrl(status);
    if (!url)
      return {
        ...base,
        status: "failed",
        error: "Video generation completed but no video URL was returned.",
      };
    return { ...base, status: "done", url };
  }
  return { ...base, status: "pending" };
}

interface MediaCall {
  method: "GET" | "POST";
  path: string;
  auth: GrokMediaAuth;
  body?: Record<string, unknown>;
  totalMs: number;
  readMs: number;
  maxBytes: number;
  signal: AbortSignal | undefined;
}

interface MediaReply {
  response: Response;
  text: string;
}

class BodyLimitError extends Error {}

export class GrokMediaClient implements GrokMediaPort {
  readonly fetchImpl: typeof fetch;
  readonly baseUrl: string;
  readonly timeouts: GrokMediaTimeouts;

  constructor(options: GrokMediaClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? GROK_PUBLIC_API_URL).replace(/\/+$/, "");
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  async generateImages(
    auth: GrokMediaAuth,
    request: GrokImageGenerateRequest,
  ): Promise<GrokImageResponse> {
    const body = imageBody(request, request.model.trim() || GROK_IMAGE_DEFAULT_MODEL);
    return this.postImages("/images/generations", auth, body, request.signal);
  }

  async editImages(auth: GrokMediaAuth, request: GrokImageEditRequest): Promise<GrokImageResponse> {
    if (request.images.length === 0)
      throw new TypeError("Grok image edit needs at least one reference image");
    const urls = request.images.map((url) => {
      if (!url.trim()) throw new TypeError("Grok image edit reference must be a non-empty URL");
      return { url };
    });
    const body = imageBody(request, request.model.trim() || GROK_IMAGE_EDIT_DEFAULT_MODEL);
    // image_edit/mod.rs:371-396: one reference is `image: {url}`, several are `images: [{url}]`.
    if (urls.length === 1) body.image = urls[0];
    else body.images = urls;
    return this.postImages("/images/edits", auth, body, request.signal);
  }

  async startVideo(auth: GrokMediaAuth, request: GrokVideoStartRequest): Promise<GrokVideoStart> {
    const body = videoBody(request);
    const { text } = await this.call({
      method: "POST",
      path: "/videos/generations",
      auth,
      body,
      totalMs: this.timeouts.videoStartMs,
      readMs: this.timeouts.videoStartMs,
      maxBytes: MAX_JSON_RESPONSE_BYTES,
      signal: request.signal,
    });
    return parseJson(GrokVideoStart, text, "video start");
  }

  async getVideo(
    auth: GrokMediaAuth,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<GrokVideoStatus> {
    if (!requestId.trim()) throw new TypeError("Grok video request id must be non-empty");
    const { response, text } = await this.call({
      method: "GET",
      path: `/videos/${encodeURIComponent(requestId)}`,
      auth,
      totalMs: this.timeouts.videoPollMs,
      readMs: this.timeouts.videoPollMs,
      maxBytes: MAX_JSON_RESPONSE_BYTES,
      signal,
    });
    const status = parseVideoStatus(response.status, text);
    if (VideoStatusExtras.parse(status).video?.respect_moderation === false)
      throw new GrokContentPolicyError("video");
    return status;
  }

  async postImages(
    path: string,
    auth: GrokMediaAuth,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<GrokImageResponse> {
    const { text } = await this.call({
      method: "POST",
      path,
      auth,
      body,
      totalMs: this.timeouts.imageTotalMs,
      readMs: this.timeouts.imageReadMs,
      maxBytes: MAX_IMAGE_RESPONSE_BYTES,
      signal,
    });
    const response = parseJson(GrokImageResponse, text, "image");
    assertImagesAllowed(response);
    return response;
  }

  /** One HTTP exchange with total and read timeouts composed with the caller's signal. */
  async call(call: MediaCall): Promise<MediaReply> {
    const { signal } = call;
    if (signal?.aborted) throw abortReason(signal);
    const headers = {
      "content-type": "application/json",
      ...buildGrokMediaHeaders({ bearer: call.auth.bearer, sessionId: call.auth.sessionId }),
    };
    const controller = new AbortController();
    let timeout: GrokMediaTimeoutError | undefined;
    const fire = (error: GrokMediaTimeoutError) => {
      if (timeout || controller.signal.aborted) return;
      timeout = error;
      controller.abort(error);
    };
    const totalTimer = setTimeout(
      () => fire(new GrokMediaTimeoutError("total", call.totalMs)),
      call.totalMs,
    );
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const armRead = () => {
      clearTimeout(readTimer);
      readTimer = setTimeout(
        () => fire(new GrokMediaTimeoutError("read", call.readMs)),
        call.readMs,
      );
    };
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    // Called for every failure: a caller abort or a timeout wins over the transport error.
    const settle = (error: unknown, responded: boolean): Error => {
      if (signal?.aborted) return abortReason(signal);
      if (timeout) return timeout;
      if (error instanceof GrokProtocolError || error instanceof GrokHttpError) return error;
      if (call.method === "GET") return connectFailure(error);
      if (!responded && PRE_SEND_ERROR_CODES.has(errorCode(error) ?? ""))
        return connectFailure(error);
      return new GrokMediaDeliveryError(errorMessage(error), { cause: error });
    };

    try {
      armRead();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${call.path}`, {
          method: call.method,
          headers,
          ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
          signal: controller.signal,
        });
      } catch (error) {
        throw settle(error, false);
      }
      armRead();
      try {
        if (!response.ok) {
          const bodyText = await readBody(response, MAX_ERROR_BODY_BYTES, armRead, true);
          throw new GrokHttpError(
            classifyGrokHttpError(response.status, bodyText, response.headers),
            bodyText,
            readGrokResponseHeaders(response.headers),
          );
        }
        const text = await readBody(response, call.maxBytes, armRead, false);
        return { response, text };
      } catch (error) {
        if (error instanceof BodyLimitError) throw new GrokProtocolError(error.message);
        throw settle(error, true);
      }
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(readTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function imageBody(request: GrokImageGenerateRequest, model: string): Record<string, unknown> {
  const n = request.n ?? 1;
  if (!Number.isSafeInteger(n) || n < 1 || n > GROK_IMAGE_MAX_PER_CALL)
    throw new RangeError(
      `Grok image count must be an integer from 1 to ${GROK_IMAGE_MAX_PER_CALL}`,
    );
  // Key order of the U0-verified request (image_gen/mod.rs:231-238); SDK options follow.
  return {
    model,
    prompt: request.prompt,
    n,
    ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    resolution: request.resolution ?? GROK_IMAGE_DEFAULT_RESOLUTION,
    response_format: "b64_json",
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(request.outputFormat === undefined ? {} : { output_format: request.outputFormat }),
  };
}

function videoBody(request: GrokVideoStartRequest): Record<string, unknown> {
  // `edit-video` / `extend-video` post to /videos/edits and /videos/extensions with a source
  // `video: {url}` (xai-video-model.ts:586-593, 391-396); the port request carries no video URL.
  if (request.mode === "edit-video" || request.mode === "extend-video")
    throw new TypeError(`Grok video mode "${request.mode}" is not supported: no source video URL`);
  const references = request.referenceImages ?? [];
  if (request.mode === "reference-to-video" && references.length === 0)
    throw new TypeError("Grok reference-to-video needs at least one reference image");
  const { duration } = request;
  if (
    duration !== undefined &&
    (!Number.isSafeInteger(duration) || duration < 1 || duration > GROK_VIDEO_MAX_DURATION_SEC)
  )
    throw new RangeError(
      `Grok video duration must be an integer from 1 to ${GROK_VIDEO_MAX_DURATION_SEC}`,
    );
  // Field order of grok-build GenerateVideoPayload (video_gen/mod.rs:811-827). `mode` selects the
  // endpoint in @ai-sdk/xai and is never a body field; reference-to-video is inferred upstream
  // from `reference_images` (xai-video-model.ts:169-194).
  return {
    model: request.model.trim() || GROK_VIDEO_DEFAULT_MODEL,
    prompt: request.prompt,
    ...(request.image === undefined ? {} : { image: { url: request.image } }),
    ...(duration === undefined ? {} : { duration }),
    ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    ...(references.length === 0 ? {} : { reference_images: references.map((url) => ({ url })) }),
    ...(request.lastFrame === undefined ? {} : { last_frame: { url: request.lastFrame } }),
  };
}

function parseJsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GrokProtocolError(`Grok ${what} response is not JSON`);
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string, what: string): T {
  const parsed = schema.safeParse(parseJsonText(text, what));
  if (!parsed.success) throw new GrokProtocolError(`Grok ${what} response has an unexpected shape`);
  return parsed.data;
}

const JsonObject = z.record(z.string(), z.unknown());
const LooseVideoStatus = z.looseObject({
  status: z.string().nullish(),
  video: z.looseObject({ url: z.string().nullish() }).nullish(),
});

/**
 * 202 means pending, possibly with an empty or partial body (xai-video-model.ts:876-894;
 * grok-build video_gen/mod.rs:442 accepts it too). A 200 without `status` but with a video URL
 * is done (xai-video-model.ts:673-676).
 */
function parseVideoStatus(httpStatus: number, text: string): GrokVideoStatus {
  if (httpStatus === 202) {
    if (!text.trim()) return { status: "pending" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: "pending" };
    }
    const object = JsonObject.safeParse(json);
    const loose = LooseVideoStatus.safeParse(json);
    if (!object.success || !loose.success) return { status: "pending" };
    const parsed = GrokVideoStatus.safeParse({
      ...object.data,
      status: loose.data.status ?? "pending",
    });
    return parsed.success ? parsed.data : { status: "pending" };
  }
  const json = parseJsonText(text, "video status");
  const object = JsonObject.safeParse(json);
  const loose = LooseVideoStatus.safeParse(json);
  if (!object.success || !loose.success)
    throw new GrokProtocolError("Grok video status response has an unexpected shape");
  const status = loose.data.status ?? (loose.data.video?.url ? "done" : "pending");
  const parsed = GrokVideoStatus.safeParse({ ...object.data, status });
  if (!parsed.success)
    throw new GrokProtocolError("Grok video status response has an unexpected shape");
  return parsed.data;
}

/** Reads the body, re-arming the read timer per chunk. `truncate` caps instead of failing. */
async function readBody(
  response: Response,
  maxBytes: number,
  onChunk: () => void,
  truncate: boolean,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (truncate)
        return text + decoder.decode(value.subarray(0, maxBytes - (total - value.byteLength)));
      throw new BodyLimitError(`Grok media response exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
