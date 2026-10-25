import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { getLogger } from "@logtape/logtape";
import { type FastifyReply, type FastifyRequest } from "fastify";
import {
  api,
  BadRequestException,
  BaseFrameClass,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  SoException,
  Sonamu,
  stream,
} from "sonamu";
import { getCacheManagerRef } from "sonamu/cache";
import { z } from "zod";

import { type LocalizedString, SD } from "../../i18n/sd.generated";
import {
  getAccessToken,
  getExpiresAt,
  getRefreshToken,
} from "../../utils/providers/common/credentials";
import {
  type GrokMediaCost,
  grokImageCost,
  grokReportedCost,
} from "../../utils/providers/common/model-cost";
import {
  type MediaDispatcher,
  type MediaTokenSelection,
  type VoiceDispatcher,
} from "../../utils/providers/common/provider-dispatcher";
import { isProviderId } from "../../utils/providers/common/provider-types";
import { CallerSchemaValidationError } from "../../utils/providers/common/schema-validation";
import {
  GROK_IMAGE_DEFAULT_MODEL,
  GROK_STT_DEFAULT_MODEL,
  GROK_VIDEO_DEFAULT_MODEL,
  GrokCapabilityUnavailableError,
  GrokCapacityError,
  GrokInvalidRequestError,
  GrokNoWorkersError,
  GrokOnDemandExcludedError,
  GrokRateLimitedError,
  GrokZdrVideoUnavailableError,
  completeGrokOAuth,
  GrokCredentials as StrictGrokCredentials,
  GrokOAuthError,
  type GrokRefreshCoordinator,
  type GrokTokenStateSnapshot,
  pollGrokDeviceCode,
  startGrokDeviceCode,
  startGrokOAuth,
} from "../../utils/providers/grok";
import {
  decodeGrokImages,
  GrokContentPolicyError,
  summarizeGrokVideoStatus,
} from "../../utils/providers/grok/grok-media-client";
import {
  GROK_TTS_DEFAULT_FORMAT,
  GROK_TTS_DEFAULT_LANGUAGE,
  GROK_TTS_DEFAULT_VOICE,
} from "../../utils/providers/grok/grok-voice-client";
import {
  OPENAI_CALLBACK_PORTS,
  openAICallbackRedirectUri,
  startOpenAICallbackRelay,
} from "../../utils/providers/openai/openai-callback-relay";
import {
  buildOpenAIAuthUrl,
  exchangeOpenAICode,
  generateOpenAIPKCE,
} from "../../utils/providers/openai/openai-oauth";
import {
  type FinishRunParams,
  MICRO_USD,
  RequestLogModel,
  type RequestLogStepFields,
} from "../request-log/request-log.model";
import { type RequestLogListParams } from "../request-log/request-log.types";
import { type TokenSubsetA } from "../sonamu.generated";

/** Fields token refresh reads; dispatchers pass their pooled view of a token. */
type RefreshableToken = Pick<TokenSubsetA, "id" | "name" | "provider" | "credentials">;

import { TokenModel, type TokenUpdateFields } from "../token/token.model";
import { GrokCredentials as StoredGrokCredentials, TokenCredentials } from "../token/token.types";
import {
  CONSOLE_CALLBACK_URL,
  type AnthropicUsageRaw,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUsage,
  generatePKCE,
  refreshAccessToken,
  RefreshFailedError,
} from "./oauth";
import { CODEX_IMAGE_GENERATION_MODEL } from "./qgrid-image-generation";
import {
  afterQuery,
  beforeQuery,
  finishRunAborted,
  finishRunWithError,
  runProgressRecorder,
} from "./qgrid-run-lifecycle";
import {
  buildAndValidateStrictOutputSchema,
  completedDriverFromImageFailure,
  type InternalQueryInput,
  QgridDispatcher,
} from "./qgrid.dispatcher";
import {
  type QueryInput,
  type AppendStepInput,
  type CreateRunInput,
  type FinishRunInput,
  GenerateImagesInput,
  type GenerateImagesOutput,
  SpeakInput,
  type SpeakOutput,
  TranscribeInput,
  type TranscribeOutput,
  VideoStartInput,
  type VideoStartOutput,
  VideoStatusInput,
  type VideoStatusOutput,
  type GrokDeviceCodeStart,
  type GrokDevicePollResult,
  type HealthResponse,
  type OAuthStartResult,
  type QueryOutput,
  type QgridRunContext,
  type QgridThreadCoord,
  REQUEST_BODY_LIMIT_BYTES,
  StreamEvents,
  type TokenStats,
  type UsageResponse,
} from "./qgrid.types";
import { deactivateAuthDeadToken, notifyTokenAdded } from "./token-death";
import { ToolSchemaCompositionError } from "./tool-emulation-schema";

const pendingStreams = new Map<string, QueryInput>();

const PendingOAuth = z.object({
  codeVerifier: z.string(),
  name: z.string(),
  redirectUri: z.string(),
  provider: z.enum(["anthropic", "openai", "grok"]),
});

type PendingOAuth = z.infer<typeof PendingOAuth>;

const OAUTH_STATE_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL = "5m";
const OAUTH_STATE_TTL_MS = 5 * 60_000;

// A bare pasted Grok code carries no state, so it binds to the newest pending Grok login.
const GROK_LATEST_STATE_KEY = "oauth:grok:latest";
const GROK_DEVICE_PREFIX = "oauth:grok:device:";

const PendingGrokDevice = z.object({
  name: z.string(),
  interval: z.number(),
  expiresAtMs: z.number(),
});

type PendingGrokDevice = z.infer<typeof PendingGrokDevice>;

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  return seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString();
}

async function setOAuthState(state: string, data: PendingOAuth): Promise<void> {
  const cache = getCacheManagerRef();

  if (!cache) throw new Error("CacheManager not initialized");
  await cache.set({
    key: `${OAUTH_STATE_PREFIX}${state}`,
    value: JSON.stringify(data),
    ttl: OAUTH_STATE_TTL,
  });
}

async function getOAuthState(state: string): Promise<PendingOAuth | undefined> {
  const cache = getCacheManagerRef();

  if (!cache) throw new Error("CacheManager not initialized");
  const raw = await cache.get<string>({ key: `${OAUTH_STATE_PREFIX}${state}` });

  if (!raw) return undefined;

  return PendingOAuth.safeParse(JSON.parse(raw)).data;
}

async function deleteOAuthState(state: string): Promise<void> {
  const cache = getCacheManagerRef();

  if (!cache) return;
  await cache.delete({ key: `${OAUTH_STATE_PREFIX}${state}` });
}

async function setGrokLatestState(state: string): Promise<void> {
  const cache = getCacheManagerRef();

  if (!cache) throw new Error("CacheManager not initialized");
  await cache.set({ key: GROK_LATEST_STATE_KEY, value: state, ttl: OAUTH_STATE_TTL });
}

async function getGrokLatestState(): Promise<string | undefined> {
  const cache = getCacheManagerRef();

  if (!cache) throw new Error("CacheManager not initialized");

  return (await cache.get<string>({ key: GROK_LATEST_STATE_KEY })) ?? undefined;
}

async function setGrokDeviceState(deviceCode: string, data: PendingGrokDevice): Promise<void> {
  const cache = getCacheManagerRef();

  if (!cache) throw new Error("CacheManager not initialized");
  const ttlSec = Math.max(1, Math.ceil((data.expiresAtMs - Date.now()) / 1000));
  await cache.set({
    key: `${GROK_DEVICE_PREFIX}${deviceCode}`,
    value: JSON.stringify(data),
    ttl: `${ttlSec}s`,
  });
}

async function getGrokDeviceState(deviceCode: string): Promise<PendingGrokDevice | undefined> {
  const cache = getCacheManagerRef();

  if (!cache) throw new Error("CacheManager not initialized");
  const raw = await cache.get<string>({ key: `${GROK_DEVICE_PREFIX}${deviceCode}` });

  if (!raw) return undefined;
  const data = PendingGrokDevice.safeParse(JSON.parse(raw)).data;

  return data && data.expiresAtMs > Date.now() ? data : undefined;
}

async function deleteGrokDeviceState(deviceCode: string): Promise<void> {
  const cache = getCacheManagerRef();

  if (!cache) return;
  await cache.delete({ key: `${GROK_DEVICE_PREFIX}${deviceCode}` });
}

function grokOAuthBadRequest(cause: unknown): never {
  if (cause instanceof GrokOAuthError) {
    throw new BadRequestException(SD("qgrid.grokLoginFailed")(cause.message));
  }

  throw cause;
}

// The usage view waits this long for a lookup refresh; a slower one still fills the cache.
const GROK_USAGE_REFRESH_WAIT_MS = 3_000;

async function refreshGrokUsage(tokenId: number): Promise<void> {
  const refresh = QgridDispatcher.grokDispatcher?.refreshUsage?.(tokenId);

  if (!refresh) return;

  const settled = (async () => {
    try {
      await refresh;
    } catch (e) {
      logger.warn(
        `grok usage refresh failed for token ${tokenId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  })();

  await Promise.race([settled, sleep(GROK_USAGE_REFRESH_WAIT_MS)]);
}

function grokTokenSnapshot(tokenId: number): GrokTokenStateSnapshot | undefined {
  // Token-state reporting is optional on the routing port; the concrete GrokDispatcher has it.
  return QgridDispatcher.grokDispatcher?.tokenStates?.().find((state) => state.id === tokenId);
}

/** Stores refreshed Grok credentials; the token subscriber pushes the row to the dispatcher. */
export async function persistGrokCredentials(
  tokenId: number,
  next: StrictGrokCredentials,
): Promise<void> {
  const credentials = StrictGrokCredentials.parse(next);
  const row = await TokenModel.findById("A", tokenId);
  await TokenModel.save([
    {
      id: row.id,
      provider: row.provider,
      credentials,
      name: row.name,
      reauth_required: false,
    },
  ]);
}

const trustedLoopbackBase = () => `http://localhost:${process.env.PORT ?? "44900"}`;

function isRemoteOAuthRequest(): boolean {
  try {
    const { headers } = Sonamu.getContext();
    const origin = headers.origin;
    const forwarded = headers["x-forwarded-host"];
    const rawHost = Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? headers.host);

    const host = origin
      ? new URL(origin).hostname
      : new URL(`http://${rawHost ?? "localhost"}`).hostname;

    return !new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(host);
  } catch {}

  return false;
}

// Anthropic's remote/manual flow uses its fixed console callback. Headers may select between two
// allowlisted URIs, but never contribute authority or path bytes to either URI.
interface OAuthRedirect {
  redirectUri: string;
  mode: "redirect" | "code";
}

function resolveOAuthRedirect(): OAuthRedirect {
  if (isRemoteOAuthRequest()) {
    return { redirectUri: CONSOLE_CALLBACK_URL, mode: "code" };
  }

  return { redirectUri: `${trustedLoopbackBase()}/callback`, mode: "redirect" };
}

function parsePastedOAuthResult(input: string): { code: string; state: string } | null {
  const trimmed = input.trim();

  try {
    const callback = new URL(trimmed);
    const code = callback.searchParams.get("code")?.trim() ?? "";
    const state = callback.searchParams.get("state")?.trim() ?? "";

    if (code && state) return { code, state };
  } catch {}

  const separatorAt = trimmed.indexOf("#");
  const code = separatorAt > 0 ? trimmed.slice(0, separatorAt).trim() : "";
  const state = separatorAt > 0 ? trimmed.slice(separatorAt + 1).trim() : "";

  return code && state ? { code, state } : null;
}

function rejectImageGenerationStream(args: QueryInput): void {
  if (!args.imageGeneration && args.model !== `openai/${CODEX_IMAGE_GENERATION_MODEL}`) return;
  throw new BadRequestException(
    SD("error.detail")(
      "qgrid: imageGeneration is not supported with streaming; use query or generateImage with qgrid.image() instead.",
    ),
  );
}

function rejectInvalidImageQuery(args: QueryInput): void {
  const standalone = args.model === `openai/${CODEX_IMAGE_GENERATION_MODEL}`;

  if (!standalone && args.imageGeneration !== "auto") return;

  if (standalone && args.imageGeneration !== true) {
    throw new BadRequestException(
      SD("error.detail")(
        "qgrid: the image model requires imageGeneration: true; use qgrid.image() with generateImage.",
      ),
    );
  }

  if (args.tools?.length || args.jsonSchema !== undefined) {
    throw new BadRequestException(
      SD("error.detail")(
        "qgrid: automatic and standalone image generation do not support caller tools or structured output.",
      ),
    );
  }

  if (
    args.imageGenerationOptions?.outputFormat &&
    args.imageGenerationOptions.outputFormat !== "png"
  ) {
    throw new BadRequestException(
      SD("error.detail")(
        "qgrid: automatic and standalone image generation only support PNG output.",
      ),
    );
  }
}

// anthropic 은 --json-schema 를 쓰지 않으므로(SON-532) strict 변환·argv 제한 없이 원형의
// 구문·복잡도만 검증된다 — provider 분기는 buildAndValidateStrictOutputSchema 가 소유한다.
function rejectInvalidCallerSchemas(args: QueryInput): void {
  if (args.jsonSchema === undefined && !args.tools?.length) return;

  try {
    buildAndValidateStrictOutputSchema(args);
  } catch (error) {
    if (
      error instanceof CallerSchemaValidationError ||
      error instanceof ToolSchemaCompositionError
    ) {
      throw new BadRequestException(SD("error.detail")(error.message));
    }

    // 잘못된 keyword 형태(anyOf 를 객체로 보내는 등)는 파이프라인에서 untyped 오류로 나오므로,
    // 타입 좁히기 대신 Error 전체를 caller-fault 400 으로 매핑한다(계약 테스트로 고정됨).
    if (error instanceof Error) {
      throw new BadRequestException(
        SD("error.detail")(`qgrid: caller schema cannot be normalized: ${error.message}`),
      );
    }

    throw error;
  }
}

async function resolveTokenName(args: QueryInput): Promise<InternalQueryInput> {
  if (!args.tokenName) return args;

  const tokenProvider = args.tokenName.split("/", 1)[0];
  const modelProvider = args.model?.split("/", 1)[0];

  if (!isProviderId(tokenProvider)) {
    throw new BadRequestException(SD("error.detail")(`Invalid token name: ${args.tokenName}`));
  }

  if (modelProvider !== tokenProvider) {
    throw new BadRequestException(
      SD("error.detail")("Token provider does not match model provider"),
    );
  }

  const token = await TokenModel.findActiveByProviderAndName("A", tokenProvider, args.tokenName);

  if (!token) {
    throw new BadRequestException(SD("error.detail")(`Active token not found: ${args.tokenName}`));
  }

  return { ...args, preferredTokenId: token.id, requirePreferredToken: true };
}

interface HttpDisconnectHandle {
  signal: AbortSignal;
  dispose: () => void;
}

function createHttpDisconnectHandle(): HttpDisconnectHandle {
  const abortController = new AbortController();
  let requestRaw: FastifyRequest["raw"] | undefined;
  let responseRaw: FastifyReply["raw"] | undefined;

  try {
    const ctx = Sonamu.getContext();
    requestRaw = ctx.request?.raw;

    if (ctx.transport === "http") responseRaw = ctx.reply.raw;
  } catch {
    // Direct frame calls (for example unit tests) do not have an HTTP context.
  }

  const abort = () => abortController.abort();

  const abortOnIncompleteResponseClose = () => {
    if (!responseRaw?.writableEnded) abort();
  };

  requestRaw?.once("aborted", abort);
  responseRaw?.once("close", abortOnIncompleteResponseClose);

  if (requestRaw?.aborted || (responseRaw?.destroyed && !responseRaw.writableEnded)) {
    abort();
  }

  return {
    signal: abortController.signal,
    dispose: () => {
      requestRaw?.removeListener("aborted", abort);
      responseRaw?.removeListener("close", abortOnIncompleteResponseClose);
    },
  };
}

const logger = getLogger(["qgrid"]);
const oauthLogger = getLogger(["qgrid", "oauth"]);

// per-token refresh dedup — 회전 겹침으로 인한 사망 오판을 막는다.
const inflightAnthropicRefresh = new Map<number, Promise<string>>();

// --- Grok media and voice ---

const mediaLogger = getLogger(["qgrid", "media"]);

type MediaKind = "image" | "video" | "stt" | "tts";

const MEDIA_TOOL_NAMES: Record<MediaKind, string> = {
  image: "image_generation",
  video: "video_generation",
  stt: "transcription",
  tts: "speech",
};

function grokNotReady(): Error {
  return QgridDispatcher.startupState.grok === "failed"
    ? new InternalServerErrorException(SD("qgrid.dispatcherFailed")("Grok"))
    : new ServiceUnavailableException(SD("qgrid.dispatcherStarting")("Grok"));
}

function grokMedia(): MediaDispatcher {
  const dispatcher = QgridDispatcher.grokDispatcher;
  const generateImages = dispatcher?.generateImages;
  const editImages = dispatcher?.editImages;
  const startVideo = dispatcher?.startVideo;
  const getVideo = dispatcher?.getVideo;

  if (!dispatcher || !generateImages || !editImages || !startVideo || !getVideo) {
    throw grokNotReady();
  }

  return {
    generateImages: generateImages.bind(dispatcher),
    editImages: editImages.bind(dispatcher),
    startVideo: startVideo.bind(dispatcher),
    getVideo: getVideo.bind(dispatcher),
  };
}

function grokVoice(): VoiceDispatcher {
  const dispatcher = QgridDispatcher.grokDispatcher;
  const transcribe = dispatcher?.transcribe;
  const speak = dispatcher?.speak;

  if (!dispatcher || !transcribe || !speak) throw grokNotReady();

  return { transcribe: transcribe.bind(dispatcher), speak: speak.bind(dispatcher) };
}

class TooManyRequestsException extends SoException {
  constructor(message: LocalizedString) {
    super(429, message);
  }
}

/**
 * Every Grok token is cooling down. A 429 rather than a 503: the server error handler pins 503's
 * Retry-After to its startup interval, while this delay comes from the upstream cooldown.
 */
function grokRateLimited(error: GrokRateLimitedError): TooManyRequestsException {
  let reply: FastifyReply | undefined;

  try {
    const ctx = Sonamu.getContext();

    if (ctx.transport === "http") reply = ctx.reply;
  } catch {
    // Direct frame calls (for example unit tests) have no HTTP context and no header to set.
  }

  // An SSE stream has already sent its headers; the error event then carries the delay alone.
  if (reply && !reply.raw.headersSent) reply.header("Retry-After", String(error.retryAfterSec));

  return new TooManyRequestsException(SD("qgrid.grokRateLimited")(error.retryAfterSec));
}

/**
 * Caller-fault Grok errors become 400/429/503 at the chat and media boundaries; upstream and
 * provider failures propagate unchanged (500 by the server error handler). "No eligible token for
 * this request class" (no workers, in-flight cap, on-demand D6, ZDR video) is a 503, not a server
 * fault; every token cooling down is a 429 with the soonest retry delay.
 */
function throwGrokCallerError(cause: unknown): never {
  if (cause instanceof GrokInvalidRequestError) {
    throw new BadRequestException(SD("qgrid.grokInvalidRequest")(cause.message));
  }

  if (cause instanceof GrokContentPolicyError) {
    throw new BadRequestException(SD("qgrid.grokContentPolicy")(cause.message));
  }

  if (cause instanceof GrokCapabilityUnavailableError) {
    throw new ServiceUnavailableException(SD("qgrid.grokCapabilityUnavailable")(cause.message));
  }

  if (cause instanceof GrokOnDemandExcludedError) {
    throw new ServiceUnavailableException(
      SD("qgrid.grokOnDemandExcluded")(cause.tokenNames.join(", ")),
    );
  }

  if (cause instanceof GrokZdrVideoUnavailableError) {
    throw new ServiceUnavailableException(
      SD("qgrid.grokZdrVideoUnavailable")(cause.tokenNames.join(", ")),
    );
  }

  if (cause instanceof GrokCapacityError) {
    throw new ServiceUnavailableException(SD("qgrid.grokCapacity"));
  }

  if (cause instanceof GrokRateLimitedError) throw grokRateLimited(cause);

  if (cause instanceof GrokNoWorkersError) {
    throw new ServiceUnavailableException(SD("qgrid.grokNoWorkers")(cause.message));
  }

  throw cause;
}

class PayloadTooLargeException extends SoException {
  constructor(message: LocalizedString) {
    super(413, message);
  }
}

const MiB = 1024 * 1024;

/**
 * Fastify rejects a body over `bodyLimit` before routing with FST_ERR_CTP_BODY_TOO_LARGE, which is
 * not a Sonamu exception and would otherwise answer 500. The server error handler applies this
 * first so the caller gets a Sonamu 413.
 */
export function mapRequestBodyTooLarge(error: Error): Error {
  if ("code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new PayloadTooLargeException(
      SD("qgrid.requestBodyTooLarge")(REQUEST_BODY_LIMIT_BYTES / MiB),
    );
  }

  return error;
}

// Sonamu's generated validator does not carry zod refinements (size, https, base64), so media
// endpoints re-validate with the full schema.
function parseMediaInput<S extends z.ZodType>(schema: S, value: z.input<S>): z.infer<S> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");

    throw new BadRequestException(SD("qgrid.invalidInput")(detail));
  }

  return parsed.data;
}

async function resolveGrokTokenSelection(
  tokenName: string | undefined,
): Promise<MediaTokenSelection> {
  if (!tokenName) return {};

  if (!tokenName.startsWith("grok/")) {
    throw new BadRequestException(
      SD("error.detail")("Token provider does not match model provider"),
    );
  }

  const token = await TokenModel.findActiveByProviderAndName("A", "grok", tokenName);

  if (!token) {
    throw new BadRequestException(SD("error.detail")(`Active token not found: ${tokenName}`));
  }

  return { preferredTokenId: token.id, requirePreferredToken: true };
}

interface RoutedModelId {
  id: string;
  route: string;
}

function routeModelId(model: string | undefined, fallback: string): RoutedModelId {
  const id = model ? model.slice("grok/".length) : fallback;

  return { id, route: `grok/${id}` };
}

type GeneratedImage = GenerateImagesOutput["images"][number];

/** Adds the provider thread coordinate to the lifecycle run context without dropping either. */
function mergeRunContext(
  lifecycle: QgridRunContext | undefined,
  threadCoord: QgridThreadCoord | undefined,
): QgridRunContext | undefined {
  if (!lifecycle && !threadCoord) return undefined;
  const runContext: QgridRunContext = { ...lifecycle };

  if (threadCoord) runContext.threadCoord = threadCoord;

  return runContext;
}

function microUsd(usd: number | undefined): number | undefined {
  return usd === undefined ? undefined : Math.round(usd * MICRO_USD);
}

/** Reference-image log metadata: a URL, or a data URL's media type and size (plus bytes). */
type ImageRefLog = { url: string } | { mediaType: string; data?: string; byteSize: number };

/** Reference-image log metadata. Data URLs keep their bytes only when `withData` (images). */
function describeImageRefs(refs: string[], withData: boolean): ImageRefLog[] {
  return refs.map((ref) => {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(ref);

    if (!match) return { url: ref };
    const [, mediaType = "", data = ""] = match;
    const byteSize = Buffer.byteLength(data, "base64");

    return withData ? { mediaType, data, byteSize } : { mediaType, byteSize };
  });
}

function imageTagForLog(b64: string, mimeType: string, alt: string | undefined): string {
  const safeAlt = (alt ?? "generated image").replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);

  return `<img src="data:${mimeType};base64,${b64}" alt="${safeAlt}" />`;
}

type MediaLogStart = { kind: MediaKind; model: string; prompt: string; projectName?: string };

// Creating the running row is a precondition of a logged provider call, as for query.
async function startMediaRun(
  loggerEnabled: boolean | undefined,
  start: MediaLogStart,
): Promise<number | undefined> {
  if (loggerEnabled === false) return undefined;

  return RequestLogModel.createRun({
    user_prompt: start.prompt,
    requested_model_name: start.model,
    project_name: start.projectName,
    is_image_generation: start.kind === "image",
  });
}

/** JSON-serializable log arguments; `undefined` members are dropped by JSON.stringify. */
type MediaLogArg = string | number | boolean | null | undefined | MediaLogArg[] | MediaLogArgs;

type MediaLogArgs = { [key: string]: MediaLogArg };

/** Image step arguments; cost and reference images are recorded only when known. */
type ImageStepArgs = {
  kind: "image";
  prompt: string;
  model: string;
  requestedOptions: MediaLogArgs;
  imageCount: number;
  costSource?: string;
  costInUsdTicks?: number;
  inputImages?: ImageRefLog[];
};

/** Video step arguments; reference images are recorded only when supplied. */
type VideoStepArgs = {
  kind: "video";
  prompt: string;
  model: string;
  requestedOptions: MediaLogArgs;
  inputImages?: ImageRefLog[];
};

type MediaLogSteps = Array<{ toolCallId: string; args: MediaLogArgs; result?: string }>;

type MediaLogSuccess = {
  kind: MediaKind;
  model: string;
  tokenName: string;
  durationMs: number;
  response: string;
  steps: MediaLogSteps;
  cost?: GrokMediaCost;
};

function mediaToolSteps(
  kind: MediaKind,
  steps: MediaLogSteps,
  durationMs: number,
): RequestLogStepFields[] {
  return steps.map((step, index) => {
    const fields: RequestLogStepFields = {
      step_index: 0,
      type: "tool_call",
      tool_call_index: index,
      tool_call_id: step.toolCallId,
      tool_name: MEDIA_TOOL_NAMES[kind],
      tool_args: JSON.stringify(step.args),
    };

    if (step.result !== undefined) fields.tool_result = step.result;
    fields.tool_duration_ms = durationMs;

    return fields;
  });
}

// Image cost follows the image-generation columns (driver cost 0); video and voice cost is the
// row's own cost. An unknown cost stays NULL rather than a guessed 0.
type MediaCostFields = Pick<FinishRunParams, "cost_usd" | "cost_source"> &
  Partial<Pick<FinishRunParams, "is_image_generation" | "image_cost_usd" | "image_cost_method">>;

function mediaCostFields(
  kind: MediaKind,
  model: string,
  cost: GrokMediaCost | undefined,
): MediaCostFields {
  if (kind === "image") {
    return {
      cost_usd: 0,
      cost_source: cost?.costSource ?? null,
      is_image_generation: true,
      image_cost_usd: microUsd(cost?.costUsd) ?? null,
      image_cost_method: cost
        ? `${cost.costSource === "provider" ? "reported" : "catalog"}:${model}:ticks=${cost.ticks}`
        : null,
    };
  }

  return { cost_usd: microUsd(cost?.costUsd) ?? null, cost_source: cost?.costSource ?? null };
}

function mediaFinishFields(success: Omit<MediaLogSuccess, "steps">): FinishRunParams {
  return {
    status: "succeeded",
    response: success.response,
    token_name: success.tokenName,
    requested_model_name: success.model,
    model_name: success.model,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    duration_ms: success.durationMs,
    ...mediaCostFields(success.kind, success.model, success.cost),
  };
}

// Logging after a successful provider call is best-effort and never replaces the result.
async function finishMediaRun(
  requestLogId: number | undefined,
  success: MediaLogSuccess,
): Promise<void> {
  if (requestLogId === undefined) return;

  try {
    for (const step of mediaToolSteps(success.kind, success.steps, success.durationMs)) {
      await RequestLogModel.appendStep(requestLogId, step);
    }

    await RequestLogModel.finishRun(requestLogId, mediaFinishFields(success));
  } catch (e) {
    mediaLogger.error(
      `${success.kind} request log failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function failMediaRun(
  requestLogId: number | undefined,
  cause: unknown,
  aborted: boolean,
): Promise<void> {
  if (requestLogId === undefined) return;

  try {
    await RequestLogModel.finishRun(requestLogId, {
      status: aborted ? "aborted" : "error",
      error_message: aborted
        ? "client disconnected"
        : cause instanceof Error
          ? cause.message
          : String(cause),
    });
  } catch (e) {
    mediaLogger.error(`media request log failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * One provider call against an open media run. A failure closes the run as error (or aborted on
 * client disconnect) and surfaces as the caller-facing Grok error; success leaves the run open.
 */
async function dispatchMediaCall<T>(
  requestLogId: number | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const disconnect = createHttpDisconnectHandle();
  let result: T;

  try {
    result = await call(disconnect.signal);
  } catch (e) {
    await failMediaRun(requestLogId, e, disconnect.signal.aborted);
    throwGrokCallerError(e);
  } finally {
    disconnect.dispose();
  }

  return result;
}

type MediaRunLog = Omit<MediaLogSuccess, "kind" | "model" | "durationMs">;

/**
 * A one-shot media endpoint: open the run, make the provider call, then log the result. `dispatch`
 * returns the endpoint output and what the run records about it.
 */
async function runMediaEndpoint<T>(
  start: MediaLogStart & { logger: boolean | undefined },
  dispatch: (
    signal: AbortSignal,
    requestLogId: number | undefined,
  ) => Promise<{ output: T; log: MediaRunLog }>,
): Promise<T> {
  const requestLogId = await startMediaRun(start.logger, start);
  const startedAt = Date.now();

  const { output, log } = await dispatchMediaCall(requestLogId, (signal) =>
    dispatch(signal, requestLogId),
  );

  await finishMediaRun(requestLogId, {
    ...log,
    kind: start.kind,
    model: start.model,
    durationMs: Date.now() - startedAt,
  });

  return output;
}

// Video jobs (plan 5.7): an unguessable handle maps to the token that started the job. Polls go
// only to that token. The owner is the caller identity request logs already carry (projectName);
// qgrid has no authenticated caller id, so the 128-bit handle is the actual capability.
const VIDEO_JOB_TTL_MS = 24 * 60 * 60_000;
const VIDEO_JOB_MAX = 10_000;

type VideoJob = {
  tokenId: number;
  tokenName: string;
  requestId: string;
  owner: string | null;
  model: string;
  createdAt: number;
  requestLogId?: number;
  final?: VideoStatusOutput;
};

const videoJobs = new Map<string, VideoJob>();

function pruneVideoJobs(now: number): void {
  for (const [handle, job] of videoJobs) {
    if (now - job.createdAt < VIDEO_JOB_TTL_MS && videoJobs.size <= VIDEO_JOB_MAX) break;
    videoJobs.delete(handle);
  }
}

function videoToolCallId(job: Pick<VideoJob, "requestId">): string {
  return `video_generation:${job.requestId}`;
}

// Resolves the pending video step and finishes the run. Best-effort: a run already expired by
// stale cleanup only loses its late result.
async function finishVideoRun(
  job: VideoJob,
  final: VideoStatusOutput,
  cost: GrokMediaCost | undefined,
): Promise<void> {
  if (job.requestLogId === undefined) return;

  try {
    await RequestLogModel.continueToolRun(job.requestLogId, [
      {
        toolCallId: videoToolCallId(job),
        output: JSON.stringify({
          status: final.status,
          url: final.url,
          durationSec: final.durationSec,
          costInUsdTicks: final.costInUsdTicks,
          error: final.error,
        }),
        isError: final.status === "failed",
      },
    ]);

    const fields = mediaFinishFields({
      kind: "video",
      model: job.model,
      tokenName: job.tokenName,
      durationMs: Date.now() - job.createdAt,
      response: final.url ?? "",
      cost,
    });

    await RequestLogModel.finishRun(
      job.requestLogId,
      final.status === "done"
        ? fields
        : { ...fields, status: "error", error_message: final.error ?? "video generation failed" },
    );
  } catch (e) {
    mediaLogger.error(`video request log failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const GROK_TTS_LOG_MODEL = "grok/tts";

class QgridFrameClass extends BaseFrameClass {
  constructor() {
    super("Qgrid");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(args: QueryInput): Promise<QueryOutput> {
    rejectInvalidImageQuery(args);
    rejectInvalidCallerSchemas(args);
    const resolvedArgs = await resolveTokenName(args);
    const disconnect = createHttpDisconnectHandle();

    try {
      if (resolvedArgs.logger === false) {
        try {
          return await QgridDispatcher.query(resolvedArgs, disconnect.signal);
        } catch (e) {
          throwGrokCallerError(e);
        }
      }

      const { requestLogId, stepIndex } = await beforeQuery(resolvedArgs);
      let result: QueryOutput;

      try {
        result = await QgridDispatcher.query(
          {
            ...resolvedArgs,
            onProgress: runProgressRecorder(requestLogId, stepIndex, resolvedArgs),
          },
          disconnect.signal,
        );
      } catch (e) {
        const completedDriver = completedDriverFromImageFailure(e, resolvedArgs.serviceTier);

        const completedStep = completedDriver
          ? ([{ stepIndex, result: completedDriver }] as const)
          : ([] as const);

        if (disconnect.signal.aborted) {
          await finishRunAborted(requestLogId, resolvedArgs, ...completedStep);
        } else {
          await finishRunWithError(
            requestLogId,
            e instanceof Error ? e.message : String(e),
            resolvedArgs,
            ...completedStep,
          );
        }

        throwGrokCallerError(e);
      }

      try {
        const lifecycle = await afterQuery(requestLogId, stepIndex, resolvedArgs, result);

        if (disconnect.signal.aborted) {
          await finishRunAborted(requestLogId, resolvedArgs);
        }

        // tool-call requestLogId와 provider threadCoord는 서로 독립적으로 유지한다.
        const threadCoord = result.runContext?.threadCoord;

        const runContext = mergeRunContext(lifecycle.runContext, threadCoord);

        return { ...result, requestLogId, runContext };
      } catch (e) {
        logger.error(`query afterQuery failed: ${e instanceof Error ? e.message : String(e)}`);

        if (disconnect.signal.aborted) {
          await finishRunAborted(requestLogId, resolvedArgs);
        } else {
          await finishRunWithError(
            requestLogId,
            e instanceof Error ? e.message : String(e),
            resolvedArgs,
          );
        }

        // provider 응답은 성공했으므로 로깅 장애가 생성 결과를 덮어쓰지 않는다.
        return { ...result, requestLogId };
      }
    } finally {
      disconnect.dispose();
    }
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async prepareStream(args: QueryInput): Promise<{ streamId: string }> {
    rejectImageGenerationStream(args);
    rejectInvalidCallerSchemas(args);
    const resolvedArgs = await resolveTokenName(args);
    const streamId = crypto.randomUUID();
    pendingStreams.set(streamId, resolvedArgs);
    const expiry = setTimeout(() => pendingStreams.delete(streamId), 30_000);
    expiry.unref?.();

    return { streamId };
  }

  @stream({ type: "sse", events: StreamEvents })
  async queryStream(streamId: string): Promise<void> {
    const args = pendingStreams.get(streamId);
    pendingStreams.delete(streamId);

    if (!args) throw new Error("invalid or expired streamId");
    rejectImageGenerationStream(args);

    const ctx = Sonamu.getContext();
    const sse = ctx.createSSE(StreamEvents);
    let streamResult: QueryOutput | undefined;
    let streamError: Error | undefined;
    let clientClosed = false;
    const abortController = new AbortController();

    sse.onClose(() => {
      clientClosed = true;
      abortController.abort();
    });

    let runInfo: { requestLogId: number; stepIndex: number } | undefined;

    if (args.logger !== false) {
      // provider 실행 전 running row 생성에 실패하면 logged 요청으로 진행하지 않는다.
      runInfo = await beforeQuery(args);
    }

    // beforeQuery DB 작업 중 close를 놓치지 않고 provider 실행 전에 마감한다.
    if (clientClosed || sse.closed) {
      if (runInfo) await finishRunAborted(runInfo.requestLogId, args);
      await sse.end();

      return;
    }

    try {
      await QgridDispatcher.queryStream(
        runInfo
          ? {
              ...args,
              onProgress: runProgressRecorder(runInfo.requestLogId, runInfo.stepIndex, args),
            }
          : args,
        {
          onDelta: (text) => {
            if (!clientClosed && !sse.closed) sse.publish("delta", { text });
          },
          onComplete: (result) => {
            streamResult = result;
          },
          onError: (err) => {
            streamError = err;
          },
        },
        abortController.signal,
      );
    } catch (e) {
      streamError = e instanceof Error ? e : new Error(String(e));
    }

    // provider 결과가 없는 close는 즉시 aborted로 마감한다.
    if (clientClosed && !streamResult) {
      if (runInfo) await finishRunAborted(runInfo.requestLogId, args);
      await sse.end();

      return;
    }

    // dispatcher 완료 후 lifecycle 처리 (await 안전)
    if (streamResult) {
      // dispatcher 가 실은 thread 재사용 좌표는 logger 설정과 무관하게 회송한다.
      const threadCoord = streamResult.runContext?.threadCoord;

      let runContext: QgridRunContext | undefined =
        threadCoord === undefined ? undefined : { threadCoord };

      if (runInfo) {
        try {
          // close 후 도착한 결과도 step/usage는 남기되, 아래에서 최종 status를 aborted로 덮어쓴다.
          const lifecycle = await afterQuery(
            runInfo.requestLogId,
            runInfo.stepIndex,
            args,
            streamResult,
          );

          runContext = mergeRunContext(lifecycle.runContext, threadCoord);

          // afterQuery가 진행되는 사이 client가 닫힌 경우 완료 상태를 aborted로 되돌린다.
          if (clientClosed) {
            await finishRunAborted(runInfo.requestLogId, args);
            await sse.end();

            return;
          }
        } catch (e) {
          logger.error(`stream afterQuery failed: ${e instanceof Error ? e.message : String(e)}`);
          await finishRunWithError(
            runInfo.requestLogId,
            e instanceof Error ? e.message : String(e),
            args,
          );

          if (clientClosed) {
            await finishRunAborted(runInfo.requestLogId, args);
            await sse.end();

            return;
          }
        }
      }

      if (!clientClosed && !sse.closed) {
        const done: QueryOutput = { ...streamResult };

        if (runInfo) done.requestLogId = runInfo.requestLogId;
        done.runContext = runContext;
        sse.publish("done", done);
      }
    } else if (streamError) {
      if (runInfo) await finishRunWithError(runInfo.requestLogId, streamError.message, args);

      if (!clientClosed && !sse.closed) sse.publish("error", { message: streamError.message });
    } else if ((clientClosed || sse.closed) && runInfo) {
      await finishRunAborted(runInfo.requestLogId, args);
    }

    await sse.end();
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async createRun(input: CreateRunInput): Promise<{ requestLogId: number }> {
    const requestLogId = await RequestLogModel.createRun({
      user_prompt: input.userPrompt,
      requested_model_name: input.modelName,
      effort: input.effort,
      project_name: input.projectName,
      system_prompt: input.systemPrompt,
      history: input.history ? JSON.parse(input.history) : undefined,
      is_structured: input.isStructured,
      json_schema: input.jsonSchema,
    });

    return { requestLogId };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async appendStep(input: AppendStepInput): Promise<{ stepId: number }> {
    const stepId = await RequestLogModel.appendStep(input.requestLogId, {
      step_index: input.stepIndex,
      type: input.type,
      model_name: input.modelName,
      requested_model_name: input.requestedModelName,
      fallback_count: input.fallbackCount,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cache_read_tokens: input.cacheReadTokens,
      cache_creation_tokens: input.cacheCreationTokens,
      cache_creation_5m_tokens: input.cacheCreation5mTokens,
      cache_creation_1h_tokens: input.cacheCreation1hTokens,
      cost_usd: input.costUsd === undefined ? undefined : Math.round(input.costUsd * MICRO_USD),
      cost_source: input.costSource,
      duration_ms: input.durationMs,
      ttft_ms: input.ttftMs ?? null,
      finish_reason: input.finishReason,
      reasoning_text: input.reasoningText,
      reasoning_tokens: input.reasoningTokens,
      tool_call_index: input.toolCallIndex,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      tool_args: input.toolArgs,
      tool_result: input.toolResult,
      tool_duration_ms: input.toolDurationMs,
      error: input.error,
    });

    return { stepId };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async finishRun(input: FinishRunInput): Promise<{ ok: boolean }> {
    await RequestLogModel.finishRun(input.requestLogId, {
      status: input.status,
      response: input.response,
      token_name: input.tokenName,
      model_name: input.modelName,
      requested_model_name: input.requestedModelName,
      fallback_count: input.fallbackCount,
      input_tokens: input.totalInputTokens,
      output_tokens: input.totalOutputTokens,
      cache_read_tokens: input.totalCacheReadTokens,
      cache_creation_tokens: input.totalCacheCreationTokens,
      cache_creation_5m_tokens: input.totalCacheCreation5mTokens,
      cache_creation_1h_tokens: input.totalCacheCreation1hTokens,
      cost_usd: input.costUsd === undefined ? undefined : Math.round(input.costUsd * MICRO_USD),
      cost_source: input.costSource,
      duration_ms: input.totalDurationMs,
      history: input.history ? JSON.parse(input.history) : undefined,
      error_message: input.errorMessage,
      response_json_ok: input.responseJsonOk,
    });

    return { ok: true };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    return QgridDispatcher.getStats();
  }

  // 화면의 목록 필터를 그대로 받아 같은 조건의 합계를 돌려준다 — 목록과 비용이
  // 서로 다른 모수를 보면 사용자에게는 숫자가 어긋난 것으로 읽힌다.
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async totalCost(
    params?: RequestLogListParams,
  ): Promise<{ usd: number; unknownImageCostCount: number; unknownCostCount: number }> {
    return RequestLogModel.totalCost(params);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async projectNames(): Promise<{ names: string[] }> {
    return { names: await RequestLogModel.distinctProjectNames() };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async modelNames(): Promise<{ names: string[] }> {
    return { names: await RequestLogModel.distinctModelNames() };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(
    provider: string,
    credentials: TokenCredentials,
    name: string,
  ): Promise<{ added: boolean }> {
    await TokenModel.save([
      {
        provider,
        credentials,
        name,
      },
    ]);

    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios"] })
  async updateToken(
    id: number,
    name?: string,
    quotaThreshold?: number | null,
    weight?: number,
    keepaliveEnabled?: boolean,
  ): Promise<{ updated: boolean }> {
    if (
      quotaThreshold !== undefined &&
      quotaThreshold !== null &&
      (!Number.isInteger(quotaThreshold) || quotaThreshold < 1 || quotaThreshold > 100)
    ) {
      throw new BadRequestException(
        SD("error.detail")("quotaThreshold must be an integer between 1 and 100, or null"),
      );
    }

    if (weight !== undefined && (!Number.isInteger(weight) || weight < 1 || weight > 100)) {
      throw new BadRequestException(
        SD("error.detail")("weight must be an integer between 1 and 100"),
      );
    }

    const patch: TokenUpdateFields = {};

    if (name !== undefined) patch.name = name;

    if (quotaThreshold !== undefined) patch.quota_threshold = quotaThreshold;

    if (weight !== undefined) patch.weight = weight;

    if (keepaliveEnabled !== undefined) patch.keepalive_enabled = keepaliveEnabled;

    if (Object.keys(patch).length === 0) return { updated: false };

    const updated = await TokenModel.updateFields(id, patch);

    return { updated: updated > 0 };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(id: number): Promise<{ removed: boolean }> {
    const entry = await TokenModel.findOne("A", { id });

    if (!entry) return { removed: false };
    await TokenModel.del([entry.id]);

    return { removed: true };
  }

  /**
   * 토큰 활성화/비활성화 토글 DB의 active 필드 업데이트
   */
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async toggleToken(id: number): Promise<{ active: boolean }> {
    const result = await TokenModel.toggleActive(id);

    if (!result) return { active: false };

    if (result.reauthRequired) {
      throw new BadRequestException(SD("error.detail")("Re-login required"));
    }

    return { active: result.active };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStart(name: string): Promise<OAuthStartResult> {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    const { redirectUri, mode } = resolveOAuthRedirect();
    const authUrl = buildAuthUrl(codeChallenge, state, redirectUri);

    await setOAuthState(state, { codeVerifier, name, redirectUri, provider: "anthropic" });

    return { authUrl, mode };
  }

  // 원격 접속의 수동 완료: Anthropic `code#state` 또는 OpenAI callback URL을 받아 교환한다.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthComplete(pastedCode: string): Promise<{ added: boolean; name: string }> {
    const result = parsePastedOAuthResult(pastedCode);

    if (!result) {
      // Grok accepts a bare authorization code, which carries no state (grok-build login.rs).
      const grokState = await getGrokLatestState();
      const grokPending = grokState ? await getOAuthState(grokState) : undefined;

      if (grokState && grokPending?.provider === "grok" && pastedCode.trim()) {
        await deleteOAuthState(grokState);
        await this.completeGrokLogin(pastedCode, grokState, grokPending);

        return { added: true, name: grokPending.name };
      }

      throw new BadRequestException(
        SD("error.detail")(
          "expected the callback URL or code shown after login, in code#state form",
        ),
      );
    }

    const { code, state } = result;

    const pending = await getOAuthState(state);

    if (!pending) {
      throw new BadRequestException(
        SD("error.detail")("login session not found or expired — start the login again"),
      );
    }

    await deleteOAuthState(state);

    if (pending.provider === "openai") {
      await this.completeOpenAILogin(code, pending);
    } else if (pending.provider === "grok") {
      // completeGrokOAuth re-checks the pasted URL's state against the stored one.
      await this.completeGrokLogin(pastedCode, state, pending);
    } else {
      await this.completeAnthropicLogin(code, state, pending);
    }

    return { added: true, name: pending.name };
  }

  // 교환 + 계정 중복 제거 + 저장 — redirect 콜백과 코드 붙여넣기 플로우가 공유한다.
  async completeAnthropicLogin(code: string, state: string, pending: PendingOAuth): Promise<void> {
    const tokens = await exchangeCodeForTokens(
      code,
      pending.codeVerifier,
      state,
      pending.redirectUri,
    );

    await TokenModel.replaceByAccount("anthropic", tokens.accountUuid, {
      provider: "anthropic",
      credentials: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt ?? 0,
        accountUuid: tokens.accountUuid ?? "",
      },
      name: pending.name,
    });

    notifyTokenAdded(pending.name, "anthropic");
  }

  async completeOpenAILogin(code: string, pending: PendingOAuth): Promise<void> {
    const creds = await exchangeOpenAICode(code, pending.codeVerifier, pending.redirectUri);
    await TokenModel.replaceByAccount("openai", creds.accountId, {
      provider: "openai",
      credentials: creds,
      name: pending.name,
    });
    logger.info(`OpenAI token saved for ${pending.name}`);
    notifyTokenAdded(pending.name, "openai");
  }

  async completeGrokLogin(codeOrUrl: string, state: string, pending: PendingOAuth): Promise<void> {
    let credentials: StrictGrokCredentials;

    try {
      credentials = await completeGrokOAuth({
        codeOrUrl,
        verifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        state,
      });
    } catch (error) {
      grokOAuthBadRequest(error);
    }

    await this.saveGrokToken(credentials, pending.name);
  }

  // Registration rejects anything that is not an xAI OAuth at+jwt (API keys, opaque tokens).
  async saveGrokToken(candidate: StrictGrokCredentials, name: string): Promise<void> {
    const parsed = StrictGrokCredentials.safeParse(candidate);

    if (!parsed.success) {
      throw new BadRequestException(SD("qgrid.grokNotOAuthToken"));
    }

    await TokenModel.replaceByAccount("grok", parsed.data.userId, {
      provider: "grok",
      credentials: parsed.data,
      name,
    });
    logger.info(`Grok token saved for ${name}`);
    notifyTokenAdded(name, "grok");
  }

  async handleOAuthCallback(code: string, state: string, reply: FastifyReply): Promise<void> {
    const pending = await getOAuthState(state);

    if (!pending) {
      logger.warn("oauth callback: invalid_state");

      return reply.redirect("/?oauth=error&reason=invalid_state");
    }

    await deleteOAuthState(state);

    try {
      if (pending.provider === "openai") {
        await this.completeOpenAILogin(code, pending);
      } else if (pending.provider === "grok") {
        await this.completeGrokLogin(code, state, pending);
      } else {
        await this.completeAnthropicLogin(code, state, pending);
      }

      return reply.redirect(`/?oauth=success&name=${encodeURIComponent(pending.name)}`);
    } catch {
      logger.warn("oauth callback failed", {
        provider: pending.provider,
        reason: "exchange_failed",
      });

      return reply.redirect("/?oauth=error&reason=exchange_failed");
    }
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStartOpenAI(name: string): Promise<OAuthStartResult> {
    const { codeVerifier, codeChallenge, state } = generateOpenAIPKCE();
    const mode = isRemoteOAuthRequest() ? "code" : "redirect";
    let redirectUri: string;

    if (mode === "code") {
      // OpenAI accepts only the Codex CLI's registered loopback URI. On a remote dashboard the
      // browser cannot reach the server's loopback, so the user pastes the resulting callback URL.
      redirectUri = openAICallbackRedirectUri(OPENAI_CALLBACK_PORTS[0]);
    } else {
      try {
        redirectUri = await startOpenAICallbackRelay(trustedLoopbackBase(), OAUTH_STATE_TTL_MS);
      } catch {
        throw new BadRequestException(
          SD("error.detail")(
            `OpenAI login needs local port ${OPENAI_CALLBACK_PORTS.join(" or ")} — close any running \`codex login\` and retry`,
          ),
        );
      }
    }

    const authUrl = buildOpenAIAuthUrl(codeChallenge, state, redirectUri);
    await setOAuthState(state, { codeVerifier, name, redirectUri, provider: "openai" });

    return { authUrl, mode };
  }

  // Grok's registered redirect is a random 127.0.0.1 loopback port that qgrid does not serve, so
  // the user always pastes the resulting callback URL (or the bare code) into oauthComplete.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStartGrok(name: string): Promise<OAuthStartResult> {
    const state = crypto.randomBytes(32).toString("base64url");
    let started;

    try {
      started = await startGrokOAuth({ state });
    } catch (error) {
      grokOAuthBadRequest(error);
    }

    await setOAuthState(state, {
      codeVerifier: started.verifier,
      name,
      redirectUri: started.redirectUri,
      provider: "grok",
    });
    await setGrokLatestState(state);

    return { authUrl: started.authorizeUrl, mode: "code" };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStartGrokDevice(name: string): Promise<GrokDeviceCodeStart> {
    let device;

    try {
      device = await startGrokDeviceCode();
    } catch (error) {
      grokOAuthBadRequest(error);
    }

    await setGrokDeviceState(device.deviceCode, {
      name,
      interval: device.interval,
      expiresAtMs: Date.now() + device.expiresIn * 1000,
    });

    return device;
  }

  // One poll per call; the web waits intervalSec between calls.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthPollGrokDevice(deviceCode: string): Promise<GrokDevicePollResult> {
    const pending = await getGrokDeviceState(deviceCode);

    if (!pending) {
      throw new BadRequestException(
        SD("error.detail")("login session not found or expired — start the login again"),
      );
    }

    let result;

    try {
      result = await pollGrokDeviceCode({ deviceCode, interval: pending.interval });
    } catch (error) {
      if (error instanceof GrokOAuthError && !error.options.retryable) {
        await deleteGrokDeviceState(deviceCode);
      }

      grokOAuthBadRequest(error);
    }

    if (result.status === "pending") {
      const slowDown = result.interval > pending.interval;

      if (slowDown) await setGrokDeviceState(deviceCode, { ...pending, interval: result.interval });

      return { status: slowDown ? "slow_down" : "pending", intervalSec: result.interval };
    }

    await deleteGrokDeviceState(deviceCode);
    await this.saveGrokToken(result.credentials, pending.name);

    return { status: "added", name: pending.name };
  }

  // Grok image generation (grok/* only; OpenAI images stay on query/qgrid.image()). With
  // referenceImages the request goes to /images/edits.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async generateImages(params: GenerateImagesInput): Promise<GenerateImagesOutput> {
    const input = parseMediaInput(GenerateImagesInput, params);
    const media = grokMedia();
    const selection = await resolveGrokTokenSelection(input.tokenName);
    const { id, route } = routeModelId(input.model, GROK_IMAGE_DEFAULT_MODEL);
    const refs = input.referenceImages ?? [];

    const start = {
      kind: "image",
      model: route,
      prompt: input.prompt,
      projectName: input.projectName,
      logger: input.logger,
    } as const;

    return runMediaEndpoint(start, async (signal, requestLogId) => {
      const request = {
        model: id,
        prompt: input.prompt,
        n: input.n,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        quality: input.quality,
        outputFormat: input.outputFormat,
        signal,
        ...selection,
      };

      const dispatched = refs.length
        ? await media.editImages({ ...request, images: refs })
        : await media.generateImages(request);

      const decoded = decodeGrokImages(dispatched.result);

      const cost = grokImageCost(id, decoded.images.length, decoded.costInUsdTicks, {
        resolution: input.resolution,
        quality: input.quality,
        inputImageCount: refs.length,
      });

      const output: GenerateImagesOutput = {
        model: route,
        tokenName: dispatched.tokenName,
        images: decoded.images.map((image) => {
          const generated: GeneratedImage = {
            b64: Buffer.from(image.bytes).toString("base64"),
            mimeType: image.mediaType,
          };

          if (image.revisedPrompt) generated.revisedPrompt = image.revisedPrompt;

          return generated;
        }),
        usage: { imageCount: decoded.images.length },
      };

      if (decoded.costInUsdTicks !== undefined) {
        output.usage.costInUsdTicks = decoded.costInUsdTicks;
      }

      if (cost) {
        output.costUsd = cost.costUsd;
        output.costSource = cost.costSource;
      }

      if (requestLogId !== undefined) output.requestLogId = requestLogId;

      const log: MediaRunLog = {
        tokenName: output.tokenName,
        cost,
        response: output.images
          .map((image) => imageTagForLog(image.b64, image.mimeType, image.revisedPrompt))
          .join("\n"),
        steps: output.images.map((image, index) => {
          const args: ImageStepArgs = {
            kind: "image",
            prompt: input.prompt,
            model: route,
            requestedOptions: {
              n: input.n,
              aspectRatio: input.aspectRatio,
              resolution: input.resolution,
              quality: input.quality,
              outputFormat: input.outputFormat,
            },
            imageCount: output.usage.imageCount,
          };

          if (cost) {
            args.costSource = cost.costSource;
            args.costInUsdTicks = cost.ticks;
          }

          // Reference images are stored once, on the first output step.
          if (index === 0 && refs.length) args.inputImages = describeImageRefs(refs, true);

          return {
            toolCallId: `image_generation:0:${index}`,
            args,
            result: imageTagForLog(image.b64, image.mimeType, image.revisedPrompt),
          };
        }),
      };

      return { output, log };
    });
  }

  // Starts a Grok video job. Poll videoStatus with the returned handle and the same projectName.
  // The run stays open after a successful start (a pending tool step), so only the provider call
  // goes through dispatchMediaCall; videoStatus finishes the run on a terminal status.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async videoStart(params: VideoStartInput): Promise<VideoStartOutput> {
    const input = parseMediaInput(VideoStartInput, params);
    const media = grokMedia();
    const selection = await resolveGrokTokenSelection(input.tokenName);
    const { id, route } = routeModelId(input.model, GROK_VIDEO_DEFAULT_MODEL);

    const requestLogId = await startMediaRun(input.logger, {
      kind: "video",
      model: route,
      prompt: input.prompt,
      projectName: input.projectName,
    });

    const startedAt = Date.now();

    const started = await dispatchMediaCall(requestLogId, (signal) =>
      media.startVideo({
        model: id,
        prompt: input.prompt,
        duration: input.duration,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        image: input.image,
        lastFrame: input.lastFrame,
        referenceImages: input.referenceImages,
        mode: input.mode,
        signal,
        ...selection,
      }),
    );

    const now = Date.now();
    pruneVideoJobs(now);
    const jobHandle = crypto.randomBytes(16).toString("base64url");

    const job: VideoJob = {
      tokenId: started.tokenId,
      tokenName: started.tokenName,
      requestId: started.result.request_id,
      owner: input.projectName ?? null,
      model: route,
      createdAt: now,
    };

    if (requestLogId !== undefined) job.requestLogId = requestLogId;

    videoJobs.set(jobHandle, job);

    if (requestLogId !== undefined) {
      // The pending tool step keeps the run open; an abandoned job is expired by stale cleanup.
      const refs = [
        ...(input.image ? [input.image] : []),
        ...(input.lastFrame ? [input.lastFrame] : []),
        ...(input.referenceImages ?? []),
      ];

      const args: VideoStepArgs = {
        kind: "video",
        prompt: input.prompt,
        model: route,
        requestedOptions: {
          duration: input.duration,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          mode: input.mode,
        },
      };

      if (refs.length) args.inputImages = describeImageRefs(refs, false);

      const [step] = mediaToolSteps(
        "video",
        [{ toolCallId: videoToolCallId(job), args }],
        now - startedAt,
      );

      try {
        await RequestLogModel.appendStep(requestLogId, step!);
      } catch (e) {
        mediaLogger.error(
          `video request log failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const output: VideoStartOutput = { jobHandle, model: route };

    if (requestLogId !== undefined) output.requestLogId = requestLogId;

    return output;
  }

  // Polls the token that started the job. A terminal status is cached so the run is logged once.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async videoStatus(params: VideoStatusInput): Promise<VideoStatusOutput> {
    const input = parseMediaInput(VideoStatusInput, params);
    pruneVideoJobs(Date.now());
    const job = videoJobs.get(input.jobHandle);

    // A foreign owner gets the same 404 as an unknown handle, so handles cannot be probed.
    if (!job || job.owner !== (input.projectName ?? null)) {
      throw new NotFoundException(SD("qgrid.videoJobNotFound"));
    }

    if (job.final) return job.final;

    const media = grokMedia();
    const disconnect = createHttpDisconnectHandle();
    let summary: ReturnType<typeof summarizeGrokVideoStatus>;
    let durationSec: number | undefined;

    try {
      const polled = await media.getVideo(job.tokenId, job.requestId, disconnect.signal);
      summary = summarizeGrokVideoStatus(polled.result);
      durationSec = polled.result.video?.duration ?? undefined;
    } catch (e) {
      if (!(e instanceof GrokContentPolicyError)) throwGrokCallerError(e);
      summary = { status: "failed", mimeType: "video/mp4", error: e.message };
    } finally {
      disconnect.dispose();
    }

    // An overlapping poll may have finished the job while this one awaited upstream.
    if (job.final) return job.final;

    const status: VideoStatusOutput = { status: summary.status, mimeType: "video/mp4" };

    if (job.requestLogId !== undefined) status.requestLogId = job.requestLogId;

    if (summary.status === "pending") return status;

    const cost = grokReportedCost(summary.usageTicks);
    const final = status;

    if (summary.url) final.url = summary.url;

    if (durationSec !== undefined) final.durationSec = durationSec;

    if (cost) {
      final.costInUsdTicks = cost.ticks;
      final.costUsd = cost.costUsd;
    }

    if (summary.error) final.error = summary.error;

    // Set before finishVideoRun's await: overlapping polls return this result instead of logging again.
    job.final = final;
    await finishVideoRun(job, final, cost);

    return final;
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async transcribe(params: TranscribeInput): Promise<TranscribeOutput> {
    const input = parseMediaInput(TranscribeInput, params);
    const voice = grokVoice();
    const selection = await resolveGrokTokenSelection(input.tokenName);
    const { id, route } = routeModelId(input.model, GROK_STT_DEFAULT_MODEL);
    const audio = new Uint8Array(Buffer.from(input.audio, "base64"));

    const start = {
      kind: "stt",
      model: route,
      prompt: `[audio ${input.mediaType} ${audio.byteLength} bytes]`,
      projectName: input.projectName,
      logger: input.logger,
    } as const;

    return runMediaEndpoint(start, async (signal, requestLogId) => {
      const dispatched = await voice.transcribe({
        audio,
        mediaType: input.mediaType,
        model: id,
        language: input.language,
        signal,
        ...selection,
      });

      const { text, language, duration } = dispatched.result;

      const output: TranscribeOutput = { text, model: route, tokenName: dispatched.tokenName };

      if (language) output.language = language;

      if (duration !== undefined) output.durationSec = duration;

      if (requestLogId !== undefined) output.requestLogId = requestLogId;

      const log: MediaRunLog = {
        tokenName: output.tokenName,
        response: output.text,
        steps: [
          {
            toolCallId: "transcription:0",
            args: {
              kind: "stt",
              model: route,
              mediaType: input.mediaType,
              audioBytes: audio.byteLength,
              language: input.language,
              durationSec: output.durationSec,
            },
            result: JSON.stringify({
              text: output.text,
              language: output.language,
              durationSec: output.durationSec,
            }),
          },
        ],
      };

      return { output, log };
    });
  }

  // /tts takes no model; `model` only labels the request log.
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async speak(params: SpeakInput): Promise<SpeakOutput> {
    const input = parseMediaInput(SpeakInput, params);
    const voice = grokVoice();
    const selection = await resolveGrokTokenSelection(input.tokenName);
    const route = input.model ?? GROK_TTS_LOG_MODEL;

    const request = {
      text: input.text,
      voice: input.voice ?? GROK_TTS_DEFAULT_VOICE,
      language: input.language ?? GROK_TTS_DEFAULT_LANGUAGE,
      format: input.format ?? GROK_TTS_DEFAULT_FORMAT,
    };

    const start = {
      kind: "tts",
      model: route,
      prompt: input.text,
      projectName: input.projectName,
      logger: input.logger,
    } as const;

    return runMediaEndpoint(start, async (signal, requestLogId) => {
      const dispatched = await voice.speak({ ...request, signal, ...selection });
      const audioBytes = dispatched.result.audio.byteLength;

      const output: SpeakOutput = {
        audio: Buffer.from(dispatched.result.audio).toString("base64"),
        mimeType: dispatched.result.mediaType,
        tokenName: dispatched.tokenName,
      };

      if (requestLogId !== undefined) output.requestLogId = requestLogId;

      const log: MediaRunLog = {
        tokenName: output.tokenName,
        response: `[audio ${output.mimeType} ${audioBytes} bytes]`,
        steps: [
          {
            toolCallId: "speech:0",
            args: {
              kind: "tts",
              model: route,
              voice: request.voice,
              language: request.language,
              format: request.format,
              characters: input.text.length,
            },
            result: JSON.stringify({ mimeType: output.mimeType, audioBytes }),
          },
        ],
      };

      return { output, log };
    });
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async usage(tokenId?: number): Promise<UsageResponse> {
    const { rows: allTokens } = await TokenModel.findMany("A");

    const entry = tokenId
      ? allTokens.find((e) => e.id === tokenId)
      : allTokens.findLast((e) => e.active && e.provider === "anthropic");

    if (!entry) return { error: "NOT_FOUND" };

    if (entry.reauth_required) return { error: "re-login required" };

    if (entry.provider === "openai") {
      if (!entry.active) {
        return { provider: "openai", fiveHour: null, sevenDay: null };
      }

      try {
        const raw = await QgridDispatcher.openaiDispatcher?.getRateLimitsByTokenId(entry.id);
        const rl = raw?.data.rateLimits;

        return {
          provider: "openai",
          fiveHour: rl?.primary
            ? {
                utilization: rl.primary.usedPercent,
                resetsAt: unixSecondsToIso(rl.primary.resetsAt),
                windowDurationMins: rl.primary.windowDurationMins,
              }
            : null,
          sevenDay: rl?.secondary
            ? {
                utilization: rl.secondary.usedPercent,
                resetsAt: unixSecondsToIso(rl.secondary.resetsAt),
                windowDurationMins: rl.secondary.windowDurationMins,
              }
            : null,
        };
      } catch (e) {
        return { error: `OpenAI usage failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    if (entry.provider === "grok") {
      // Refresh stale lookups (60 s cache) so a token without traffic still reports usage.
      if (entry.active) await refreshGrokUsage(entry.id);

      const snapshot = entry.active ? grokTokenSnapshot(entry.id) : undefined;
      const billing = snapshot?.lastBilling;
      const storedTier = StoredGrokCredentials.safeParse(entry.credentials).data?.subscriptionTier;

      return {
        provider: "grok",
        fiveHour: null,
        sevenDay: billing
          ? { utilization: billing.utilizationPct, resetsAt: billing.periodEnd }
          : null,
        periodType: billing?.periodType ?? null,
        tier: snapshot?.lastTier ?? storedTier ?? null,
        onDemandExcluded: snapshot?.onDemandExcluded ?? false,
        zdrVideoExcluded: snapshot?.zdrVideoExcluded ?? false,
        keepaliveApplicable: false,
      };
    }

    if (entry.provider !== "anthropic") {
      return { error: `usage API not supported for provider: ${entry.provider}` };
    }

    let accessToken = getAccessToken(entry.credentials);
    const isExpired = getExpiresAt(entry.credentials) < Date.now();

    if (isExpired && getRefreshToken(entry.credentials)) {
      try {
        accessToken = await this.refreshToken(entry);
      } catch (e) {
        oauthLogger.warn(
          `refresh failed for ${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
        );

        return { error: "Token refresh failed; usage is unavailable" };
      }
    }

    const raw = await fetchUsage(accessToken);

    if (raw.error && getRefreshToken(entry.credentials)) {
      try {
        accessToken = await this.refreshToken(entry);
        const retried = await fetchUsage(accessToken);

        if (retried.error) return { error: retried.error };

        return convertAnthropicUsage(retried);
      } catch (e) {
        oauthLogger.warn(
          `refresh failed for ${entry.name}: ${e instanceof Error ? e.message : String(e)}`,
        );

        return { error: "Token refresh failed; usage is unavailable" };
      }
    }

    if (raw.error) return { error: raw.error };

    return convertAnthropicUsage(raw);
  }

  // 동시 refresh 가 회전을 겹치면 뒤늦은 호출이 이미 폐기된 refresh token 을 쓰게 되어
  // 멀쩡한 토큰이 사망으로 오판된다. openai-refresh.ts 와 같은 per-token dedup 을 둔다.
  async refreshToken(token: RefreshableToken): Promise<string> {
    if (token.provider === "grok") return this.refreshGrokToken(token);
    const inflight = inflightAnthropicRefresh.get(token.id);

    if (inflight) return inflight;

    const promise = this.doRefreshToken(token);
    inflightAnthropicRefresh.set(token.id, promise);

    try {
      return await promise;
    } finally {
      inflightAnthropicRefresh.delete(token.id);
    }
  }

  // Set by bootstrap; the same coordinator the GrokDispatcher uses, so refreshes are single-flight.
  grokRefresher: GrokRefreshCoordinator | null = null;

  async refreshGrokToken(token: RefreshableToken): Promise<string> {
    if (!this.grokRefresher) throw new Error("Grok refresher not initialized");
    const current = StrictGrokCredentials.parse(token.credentials);

    const next = await this.grokRefresher.refresh(token.id, current, (creds) =>
      persistGrokCredentials(token.id, creds),
    );

    return next.accessToken;
  }

  async doRefreshToken(token: RefreshableToken): Promise<string> {
    const creds = token.credentials;
    const rt = getRefreshToken(creds);

    if (!rt) throw new Error("No refresh token");

    let refreshed;

    try {
      refreshed = await refreshAccessToken(rt);
    } catch (e) {
      if (e instanceof RefreshFailedError && e.isAuthDead()) {
        await deactivateAuthDeadToken(token, `anthropic:${e.status}`);
      }

      throw e;
    }

    const updated = TokenCredentials.parse({
      ...creds,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
    });

    await TokenModel.save([
      {
        id: token.id,
        provider: token.provider,
        credentials: updated,
        name: token.name,
        reauth_required: false,
      },
    ]);

    return refreshed.accessToken;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async health(): Promise<HealthResponse> {
    const providers = { ...QgridDispatcher.startupState };

    return {
      status: "ok",
      activeTokens: QgridDispatcher.tokens.size,
      subscriber: QgridDispatcher.subscriber?.status() ?? null,
      // provider 별 라우팅이라 하나만 준비돼도 그 provider 요청은 처리된다.
      ready: Object.values(providers).includes("ready"),
      providers,
    };
  }
}

export const QgridFrame = new QgridFrameClass();

function convertAnthropicUsage(raw: AnthropicUsageRaw): UsageResponse {
  return {
    provider: "anthropic",
    fiveHour: raw.five_hour
      ? { utilization: raw.five_hour.utilization, resetsAt: raw.five_hour.resets_at }
      : null,
    sevenDay: raw.seven_day
      ? { utilization: raw.seven_day.utilization, resetsAt: raw.seven_day.resets_at }
      : null,
  };
}
