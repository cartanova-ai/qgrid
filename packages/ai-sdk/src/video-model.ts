import {
  type Experimental_VideoModelV3 as VideoModelV3,
  type Experimental_VideoModelV3VideoData as VideoModelV3VideoData,
  type JSONObject,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import { z } from "zod";

import {
  assertGrokModelId,
  assertInlineMediaFits,
  parseGrokQgridOptions,
  parseXaiMediaOptions,
  postMediaEndpoint,
  QgridMediaHttpError,
  type QgridMediaProviderConfig,
  resolveMediaConfig,
  type ResolvedMediaConfig,
  serializeMediaBody,
  toImageRef,
  toImageRefUrl,
} from "./image-model";
import { type QgridVideoModel } from "./index.types";
import { QGRID_PROVIDER_NAME } from "./qgrid.constant";

const LABEL = "qgrid.video";

/** Defaults of grok-build and `@ai-sdk/xai`: poll every 5 s within a 300 s budget. */
export const QGRID_VIDEO_DEFAULT_POLL_INTERVAL_MS = 5_000;
export const QGRID_VIDEO_DEFAULT_POLL_TIMEOUT_MS = 300_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const MAX_REFERENCE_IMAGES = 5;
const LAST_FRAME_MODEL = "grok/grok-imagine-video-1.5";

// Same mapping as @ai-sdk/xai xai-video-model.ts RESOLUTION_MAP.
const RESOLUTION_MAP = new Map<string, "480p" | "720p" | "1080p">([
  ["1920x1080", "1080p"],
  ["1280x720", "720p"],
  ["854x480", "480p"],
  ["640x480", "480p"],
]);

/**
 * `providerOptions.xai` for Grok video. Field names follow `@ai-sdk/xai` `xaiVideoModelOptions`;
 * `lastFrame` is a qgrid extension because AI SDK v3 video calls have no `frameImages`.
 * Edit / extend modes need a source video URL the qgrid server does not accept, so they throw.
 */
const xaiVideoOptionsSchema = z.looseObject({
  mode: z.enum(["edit-video", "extend-video", "reference-to-video"]).optional(),
  videoUrl: z.string().min(1).optional(),
  referenceImageUrls: z.array(z.string().min(1)).min(1).max(7).optional(),
  referenceVoiceIds: z.array(z.string().min(1)).max(3).optional(),
  keyframes: z.array(z.unknown()).optional(),
  storageOptions: z.unknown().optional(),
  user: z.string().optional(),
  pollIntervalMs: z.number().positive().nullish(),
  pollTimeoutMs: z.number().positive().nullish(),
  resolution: z.enum(["480p", "720p", "1080p"]).nullish(),
  lastFrame: z.string().min(1).optional(),
});

/** `providerOptions.xai` accepted by `qgrid.video(...)`. */
export type QgridXaiVideoProviderOptions = {
  mode?: "reference-to-video";
  /** 1 to 5 https or PNG/JPEG/WebP data URLs (the qgrid server caps @ai-sdk/xai's 7 at 5). */
  referenceImageUrls?: string[];
  resolution?: "480p" | "720p" | "1080p";
  /** qgrid extension: pinned last frame (https or data URL); grok-imagine-video-1.5 only. */
  lastFrame?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

const XAI_VIDEO_HONORED = new Set([
  "mode",
  "referenceImageUrls",
  "resolution",
  "lastFrame",
  "pollIntervalMs",
  "pollTimeoutMs",
]);

const videoStartOutputSchema = z.object({
  jobHandle: z.string(),
  model: z.string(),
  requestLogId: z.number().optional(),
});

const videoStatusOutputSchema = z.object({
  status: z.enum(["pending", "done", "failed"]),
  url: z.string().optional(),
  mimeType: z.literal("video/mp4"),
  durationSec: z.number().optional(),
  costInUsdTicks: z.number().optional(),
  costUsd: z.number().optional(),
  error: z.string().optional(),
  requestLogId: z.number().optional(),
});

/**
 * Raised when the poll budget runs out. The job keeps running on xAI; pass `jobHandle` to
 * `resumeQgridVideo` (with the same `projectName`) to keep waiting.
 */
export class QgridVideoTimeoutError extends Error {
  readonly jobHandle: string;

  constructor(jobHandle: string, timeoutMs: number) {
    super(
      `${LABEL}: video job ${jobHandle} did not finish within ${timeoutMs} ms; resume it with resumeQgridVideo("${jobHandle}")`,
    );
    this.name = "QgridVideoTimeoutError";
    this.jobHandle = jobHandle;
  }
}

/** The upstream job finished as failed (including content-policy blocks). */
export class QgridVideoGenerationError extends Error {
  readonly jobHandle: string;

  constructor(jobHandle: string, detail: string | undefined) {
    super(`${LABEL}: video generation failed${detail ? `: ${detail}` : "."}`);
    this.name = "QgridVideoGenerationError";
    this.jobHandle = jobHandle;
  }
}

export type QgridVideoPollOptions = {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
};

export type QgridVideoResult = {
  videos: VideoModelV3VideoData[];
  providerMetadata: SharedV3ProviderMetadata;
  response: { timestamp: Date; modelId: string; headers: Record<string, string> | undefined };
};

function abortedError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortedError());

      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortedError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTransientPollError(cause: unknown): boolean {
  if (cause instanceof QgridMediaHttpError) return cause.status === 429 || cause.status >= 500;

  // Network failures from postMediaEndpoint; aborts and schema errors are not transient.
  return cause instanceof Error && /transport failed/.test(cause.message);
}

/**
 * One signal for the whole poll: aborts with the caller's reason, or with a TimeoutError once
 * `ms` elapse, so a hung status request or sleep cannot outlive the poll budget. Linked by hand
 * rather than with AbortSignal.any, which older runtimes lack.
 */
interface PollDeadline {
  signal: AbortSignal;
  /** True only when `cause` is this deadline's own abort reason. */
  expired: (cause: unknown) => boolean;
  dispose: () => void;
}

function pollDeadline(caller: AbortSignal | undefined, ms: number): PollDeadline {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason ?? abortedError());

  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });
  const deadlineReason = new DOMException("The video poll budget elapsed.", "TimeoutError");
  const timer = setTimeout(() => controller.abort(deadlineReason), Math.max(0, ms));

  return {
    signal: controller.signal,
    // Only the deadline's own reason counts; a caller abort keeps the caller's error.
    expired: (cause) => controller.signal.reason === deadlineReason && cause === deadlineReason,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function pollVideo(
  jobHandle: string,
  modelId: string,
  config: ResolvedMediaConfig,
  options: QgridVideoPollOptions,
  extraMetadata: Record<string, number>,
): Promise<QgridVideoResult> {
  const interval = options.pollIntervalMs ?? QGRID_VIDEO_DEFAULT_POLL_INTERVAL_MS;
  const timeout = options.pollTimeoutMs ?? QGRID_VIDEO_DEFAULT_POLL_TIMEOUT_MS;

  // The server's owner check compares this projectName with the one sent to videoStart.
  const statusParams: JSONObject = { jobHandle };

  if (config.projectName) statusParams.projectName = config.projectName;
  const body = serializeMediaBody(statusParams, LABEL);

  const deadline = pollDeadline(options.abortSignal, timeout);

  try {
    return await pollUntilDone(jobHandle, modelId, config, options, extraMetadata, {
      body,
      interval,
      timeout,
      signal: deadline.signal,
    });
  } catch (error) {
    if (deadline.expired(error)) throw new QgridVideoTimeoutError(jobHandle, timeout);
    throw error;
  } finally {
    deadline.dispose();
  }
}

async function pollUntilDone(
  jobHandle: string,
  modelId: string,
  config: ResolvedMediaConfig,
  options: QgridVideoPollOptions,
  extraMetadata: Record<string, number>,
  poll: { body: string; interval: number; timeout: number; signal: AbortSignal },
): Promise<QgridVideoResult> {
  const { body, interval, timeout, signal } = poll;
  const deadline = Date.now() + timeout;
  let failures = 0;

  for (;;) {
    signal.throwIfAborted();
    let polled;

    try {
      polled = await postMediaEndpoint({
        serverUrl: config.serverUrl,
        endpoint: "videoStatus",
        body,
        schema: videoStatusOutputSchema,
        label: LABEL,
        signal,
        headers: options.headers,
      });
      failures = 0;
    } catch (error) {
      if (!isTransientPollError(error) || ++failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
    }

    if (polled) {
      const status = polled.data;

      if (status.status === "failed") throw new QgridVideoGenerationError(jobHandle, status.error);

      if (status.status === "done") {
        if (!status.url) {
          throw new QgridVideoGenerationError(jobHandle, "completed without a video URL");
        }

        const requestLogId = status.requestLogId ?? extraMetadata.requestLogId;
        const xaiMetadata: JSONObject = { videoUrl: status.url };

        if (status.durationSec !== undefined) xaiMetadata.duration = status.durationSec;

        if (status.costInUsdTicks !== undefined) {
          xaiMetadata.costInUsdTicks = status.costInUsdTicks;
        }

        const qgridMetadata: JSONObject = { jobHandle };

        if (requestLogId !== undefined) qgridMetadata.requestLogId = requestLogId;

        if (status.costUsd !== undefined) qgridMetadata.costUsd = status.costUsd;

        return {
          // D4: the api.x.ai URL exactly as @ai-sdk/xai returns it; qgrid never proxies the bytes.
          videos: [{ type: "url", url: status.url, mediaType: "video/mp4" }],
          providerMetadata: { xai: xaiMetadata, qgrid: qgridMetadata },
          response: { timestamp: new Date(), modelId, headers: polled.headers },
        };
      }
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) throw new QgridVideoTimeoutError(jobHandle, timeout);
    await sleep(Math.min(interval, remaining), signal);
  }
}

/**
 * Keeps polling a video job started by `qgrid.video(...)`, for example after a
 * `QgridVideoTimeoutError`. `config.projectName` must equal the one used to start the job.
 * AI SDK v3 video models expose only `doGenerate` (no `doStart` / `doStatus`), so resuming is
 * a qgrid helper rather than an `experimental_generateVideo` option.
 */
export function resumeQgridVideo(
  jobHandle: string,
  options: QgridVideoPollOptions & QgridMediaProviderConfig & { modelId?: QgridVideoModel } = {},
): Promise<QgridVideoResult> {
  const config = resolveMediaConfig(options);

  return pollVideo(jobHandle, options.modelId ?? "grok/video", config, options, {});
}

export function createQgridVideo(
  modelId: QgridVideoModel,
  config?: QgridMediaProviderConfig,
): VideoModelV3 {
  assertGrokModelId(modelId, LABEL);
  const resolved = resolveMediaConfig(config);

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    maxVideosPerCall: 1,

    async doGenerate(options) {
      if (options.n !== 1) {
        throw new Error(`${LABEL}: one video per call; omit maxVideosPerCall so AI SDK can batch`);
      }

      if (!options.prompt?.trim()) {
        throw new Error(`${LABEL}: a non-empty text prompt is required`);
      }

      if (
        options.duration !== undefined &&
        (!Number.isInteger(options.duration) || options.duration < 1 || options.duration > 15)
      ) {
        throw new Error(`${LABEL}: duration must be an integer from 1 to 15 seconds`);
      }

      const qgridOptions = parseGrokQgridOptions(options.providerOptions.qgrid, LABEL);

      const xai = parseXaiMediaOptions(
        options.providerOptions.xai,
        xaiVideoOptionsSchema,
        XAI_VIDEO_HONORED,
        LABEL,
      );

      const xaiOptions = xai.options;

      if (
        xaiOptions?.mode === "edit-video" ||
        xaiOptions?.mode === "extend-video" ||
        xaiOptions?.videoUrl !== undefined
      ) {
        throw new Error(
          `${LABEL}: video editing and extension (mode edit-video / extend-video, videoUrl) are not supported by qgrid`,
        );
      }

      const referenceImages = (xaiOptions?.referenceImageUrls ?? []).map((url) =>
        toImageRefUrl(url, LABEL),
      );

      if (referenceImages.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`${LABEL}: at most ${MAX_REFERENCE_IMAGES} reference images are supported`);
      }

      if (xaiOptions?.mode === "reference-to-video" && referenceImages.length === 0) {
        throw new Error(
          `${LABEL}: reference-to-video needs providerOptions.xai.referenceImageUrls`,
        );
      }

      const warnings: SharedV3Warning[] = [...xai.warnings];

      if (options.fps !== undefined) warnings.push({ type: "unsupported", feature: "fps" });

      if (options.seed !== undefined) warnings.push({ type: "unsupported", feature: "seed" });

      // AI SDK 7 standard video options that the qgrid Grok route does not map yet.
      if (options.frameImages !== undefined) {
        warnings.push({ type: "unsupported", feature: "frameImages" });
      }

      if (options.inputReferences !== undefined) {
        warnings.push({ type: "unsupported", feature: "inputReferences" });
      }

      if (options.generateAudio !== undefined) {
        warnings.push({ type: "unsupported", feature: "generateAudio" });
      }

      let resolution = xaiOptions?.resolution ?? undefined;

      if (resolution === undefined && options.resolution !== undefined) {
        resolution = RESOLUTION_MAP.get(options.resolution);

        if (resolution === undefined) {
          warnings.push({
            type: "unsupported",
            feature: "resolution",
            details: `Unrecognized resolution "${options.resolution}". Use providerOptions.xai.resolution with "480p", "720p", or "1080p" instead.`,
          });
        }
      }

      let lastFrame: string | undefined;

      if (xaiOptions?.lastFrame !== undefined) {
        if (modelId === LAST_FRAME_MODEL) {
          lastFrame = toImageRefUrl(xaiOptions.lastFrame, LABEL);
        } else {
          warnings.push({
            type: "unsupported",
            feature: "providerOptions.xai.lastFrame",
            details: `xAI only supports last_frame with "${LAST_FRAME_MODEL}". The last frame was ignored.`,
          });
        }
      }

      const image = options.image === undefined ? undefined : toImageRef(options.image, LABEL);
      // Every inline image shares the one request body; the server caps them in total.
      assertInlineMediaFits([image, lastFrame, ...referenceImages], LABEL);

      const params: JSONObject = { model: modelId, prompt: options.prompt };

      if (options.duration !== undefined) params.duration = options.duration;

      if (options.aspectRatio !== undefined) params.aspectRatio = options.aspectRatio;

      if (resolution !== undefined) params.resolution = resolution;

      if (image !== undefined) params.image = image;

      if (lastFrame !== undefined) params.lastFrame = lastFrame;

      if (referenceImages.length) params.referenceImages = referenceImages;

      if (xaiOptions?.mode !== undefined) params.mode = xaiOptions.mode;

      if (resolved.projectName) params.projectName = resolved.projectName;
      const body = serializeMediaBody({ ...params, ...qgridOptions }, LABEL);

      const started = await postMediaEndpoint({
        serverUrl: resolved.serverUrl,
        endpoint: "videoStart",
        body,
        schema: videoStartOutputSchema,
        label: LABEL,
        signal: options.abortSignal,
        headers: options.headers,
      });

      const pollOptions: QgridVideoPollOptions = {};

      if (xaiOptions?.pollIntervalMs) pollOptions.pollIntervalMs = xaiOptions.pollIntervalMs;

      if (xaiOptions?.pollTimeoutMs) pollOptions.pollTimeoutMs = xaiOptions.pollTimeoutMs;

      if (options.abortSignal) pollOptions.abortSignal = options.abortSignal;

      if (options.headers) pollOptions.headers = options.headers;

      const result = await pollVideo(
        started.data.jobHandle,
        started.data.model,
        resolved,
        pollOptions,
        started.data.requestLogId === undefined ? {} : { requestLogId: started.data.requestLogId },
      );

      return { ...result, warnings };
    },
  };
}
