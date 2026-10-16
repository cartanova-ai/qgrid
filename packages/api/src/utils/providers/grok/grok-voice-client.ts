import { classifyGrokHttpError, readGrokResponseHeaders } from "./grok-backend-protocol";
import { GROK_PUBLIC_API_URL, GROK_STT_DEFAULT_MODEL } from "./grok-constants";
import { GrokHttpError, grokHttpErrorFromResponse } from "./grok-direct-client";
import { buildGrokVoiceHeaders, type GrokPlatform } from "./grok-headers";
import {
  GrokSttResponse,
  GrokTtsRequest,
  type GrokSpeechResult,
  type GrokTranscribeRequest,
  type GrokVoicePort,
} from "./grok-types";

// HTTP client for api.x.ai speech-to-text (multipart `POST /stt`) and text-to-speech (JSON
// `POST /tts`), both accepted with the subscription JWT (U0). grok-build only ships a WebSocket
// STT client, so there is no grok-build precedent for an HTTP timeout; 120 s total covers
// upload, server processing and the body download of long audio. Requests are never re-issued:
// once the body may have been sent, upstream may already be executing (and billing) it.

export const GROK_VOICE_TIMEOUT_MS = 120_000;
export const GROK_TTS_DEFAULT_VOICE = "ara";
export const GROK_TTS_DEFAULT_LANGUAGE = "en";
export const GROK_TTS_DEFAULT_FORMAT = "mp3";

// Undici / Node error codes that prove no connection existed, so no request byte left qgrid.
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// Same subtype mapping as @ai-sdk/provider-utils mediaTypeToExtension.
const EXTENSION_BY_SUBTYPE: Readonly<Record<string, string>> = {
  mpeg: "mp3",
  "x-wav": "wav",
  opus: "ogg",
  mp4: "m4a",
  "x-m4a": "m4a",
};

const MEDIA_TYPE_BY_FORMAT: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
  mulaw: "audio/basic",
  alaw: "audio/x-alaw-basic",
};

export interface GrokVoiceClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  platform?: GrokPlatform;
}

/** `speak` input: the port's request with `voice`, `language` and `format` defaulted. */
export type GrokSpeakInput = Pick<GrokTtsRequest, "text"> &
  Partial<Omit<GrokTtsRequest, "text">> & { signal?: AbortSignal };

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") codes.push(current.code);

    if ("errors" in current && Array.isArray(current.errors)) {
      for (const inner of current.errors)
        if (typeof inner === "object" && inner !== null && "code" in inner)
          if (typeof inner.code === "string") codes.push(inner.code);
    }

    current = "cause" in current ? current.cause : undefined;
  }

  return codes;
}

function isConnectFailure(error: unknown): boolean {
  const codes = errorCodes(error);

  return codes.length > 0 && codes.every((code) => CONNECT_FAILURE_CODES.has(code));
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;

  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

/**
 * Status-0 transient error. `afterSend` failures carry `shouldRetry: false` so no layer replays a
 * POST whose body may have been executed upstream.
 */
function transportError(message: string, afterSend: boolean, cause: unknown): GrokHttpError {
  return new GrokHttpError(
    {
      ...classifyGrokHttpError(0, "", {}),
      message,
      ...(afterSend ? { shouldRetry: false } : {}),
    },
    "",
    {},
    { cause },
  );
}

function invalidBodyError(response: Response, message: string, cause?: unknown): GrokHttpError {
  return new GrokHttpError(
    { ...classifyGrokHttpError(502, "", response.headers), message, shouldRetry: false },
    "",
    readGrokResponseHeaders(response.headers),
    cause === undefined ? undefined : { cause },
  );
}

function audioExtension(mediaType: string): string {
  const subtype = mediaType.toLowerCase().split(";")[0]?.split("/")[1]?.trim() ?? "";

  return EXTENSION_BY_SUBTYPE[subtype] ?? (/^[a-z0-9.+-]+$/.test(subtype) ? subtype : "bin");
}

function contentMediaType(response: Response): string | undefined {
  const value = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

  return value ? value : undefined;
}

export class GrokVoiceClient implements GrokVoicePort {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly platform: GrokPlatform | undefined;

  constructor(options: GrokVoiceClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? GROK_PUBLIC_API_URL;
    this.timeoutMs = options.timeoutMs ?? GROK_VOICE_TIMEOUT_MS;
    this.platform = options.platform;
  }

  /** Multipart `POST /stt`: `model` first, optional `language`, `file` last (xAI requirement). */
  async transcribe(bearer: string, request: GrokTranscribeRequest): Promise<GrokSttResponse> {
    if (request.audio.byteLength === 0) throw new TypeError("audio must not be empty");

    if (!/^[\w.+-]+\/[\w.+-]+/.test(request.mediaType))
      throw new TypeError("mediaType must be a type/subtype media type");
    const form = new FormData();
    form.append("model", request.model ?? GROK_STT_DEFAULT_MODEL);

    if (request.language) form.append("language", request.language);
    const filename = `audio.${audioExtension(request.mediaType)}`;
    form.append(
      "file",
      new File([new Uint8Array(request.audio)], filename, { type: request.mediaType }),
      filename,
    );
    // fetch sets the multipart content-type with its boundary.
    const headers = buildGrokVoiceHeaders({ bearer, platform: this.platform });

    return this.post("/stt", headers, form, request.signal, async (response) => {
      let json: unknown;

      try {
        json = await response.json();
      } catch (error) {
        throw invalidBodyError(response, "invalid JSON body", error);
      }

      // The SDK schema allows null language/duration; treat null as absent.
      const normalized =
        typeof json === "object" && json !== null
          ? Object.fromEntries(Object.entries(json).filter(([, value]) => value !== null))
          : json;

      const parsed = GrokSttResponse.safeParse(normalized);

      if (!parsed.success) throw invalidBodyError(response, "invalid STT response", parsed.error);
      const { language, ...rest } = parsed.data;

      return language ? { ...rest, language } : rest;
    });
  }

  /** JSON `POST /tts` returning the raw audio bytes. `language` is required upstream (U0). */
  async speak(bearer: string, request: GrokSpeakInput): Promise<GrokSpeechResult> {
    const body = GrokTtsRequest.parse({
      text: request.text,
      voice: request.voice ?? GROK_TTS_DEFAULT_VOICE,
      language: request.language ?? GROK_TTS_DEFAULT_LANGUAGE,
      format: request.format ?? GROK_TTS_DEFAULT_FORMAT,
    });

    const headers = {
      ...buildGrokVoiceHeaders({ bearer, platform: this.platform }),
      "content-type": "application/json",
    };

    return this.post("/tts", headers, JSON.stringify(body), request.signal, async (response) => {
      const mediaType = contentMediaType(response);

      if (mediaType === "application/json" || mediaType?.startsWith("text/"))
        throw invalidBodyError(response, `expected audio, got ${mediaType}`);
      let audio: Uint8Array;

      try {
        audio = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw invalidBodyError(response, "failed to read audio body", error);
      }

      if (audio.byteLength === 0) throw invalidBodyError(response, "empty audio body");

      return {
        audio,
        mediaType: mediaType ?? MEDIA_TYPE_BY_FORMAT[body.format] ?? "application/octet-stream",
      };
    });
  }

  /**
   * One POST, never retried. The total timeout covers the response body too; a caller abort
   * rethrows the caller's reason.
   */
  private async post<T>(
    path: string,
    headers: Record<string, string>,
    body: FormData | string,
    callerSignal: AbortSignal | undefined,
    readBody: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (callerSignal?.aborted) throw abortReason(callerSignal);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

    const interrupted = (error: unknown): Error | undefined => {
      if (callerSignal?.aborted) return abortReason(callerSignal);

      if (timeout.aborted)
        return transportError(`timed out after ${this.timeoutMs} ms`, true, error);

      return undefined;
    };

    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body,
        signal,
      });
    } catch (error) {
      const stop = interrupted(error);

      if (stop) throw stop;
      const message = error instanceof Error ? error.message : String(error);
      throw transportError(message, !isConnectFailure(error), error);
    }

    try {
      if (!response.ok) throw await grokHttpErrorFromResponse(response);

      return await readBody(response);
    } catch (error) {
      throw interrupted(error) ?? error;
    }
  }
}
