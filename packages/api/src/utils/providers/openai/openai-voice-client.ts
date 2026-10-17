import crypto from "node:crypto";
import { type ClientRequest } from "node:http";

import WsClient, { type RawData } from "ws";
import { z } from "zod";

import { type JsonValue, OpenAIProtocolError } from "./openai-backend-protocol";
import { type OpenAIWebSocketFactory, type OpenAIWebSocketLike } from "./openai-direct-client";
import {
  audioAppendEvent,
  audioCommitEvent,
  buildOpenAIRealtimeHeaders,
  buildSpeechInstructions,
  buildSpeechSession,
  buildTranscriptionSession,
  isOpenAIRealtimeVoice,
  OPENAI_REALTIME_CALLS_URL,
  OPENAI_REALTIME_DEFAULT_SPEECH_MODEL,
  OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_DEFAULT_VOICE,
  OPENAI_REALTIME_SAMPLE_RATE,
  OPENAI_REALTIME_SYNTHETIC_SDP,
  OPENAI_REALTIME_WS_URL,
  OPENAI_TRANSCRIPTION_MODELS_WITHOUT_PROMPT,
  type OpenAIRealtimeCredentials,
  type OpenAIRealtimeHeaders,
  outputAudioDeltaEvent,
  outputAudioTranscriptDoneEvent,
  prepareRealtimeInput,
  realtimeErrorEvent,
  realtimeServerEvent,
  responseCreateEvent,
  responseDoneEvent,
  sessionUpdateEvent,
  transcriptionCompletedEvent,
  transcriptionFailedEvent,
  UnsupportedAudioError,
  userTextItemEvent,
  wrapPcmAsWav,
} from "./openai-realtime-protocol";

// One-shot speech-to-text and text-to-speech over OpenAI realtime sessions with a ChatGPT
// subscription token. Transport shapes and their Codex sources are documented in
// openai-realtime-protocol.ts. Nothing here is retried: a realtime session that failed may
// already have consumed audio tokens.

/**
 * A /realtime/calls session with no ICE connection is torn down about 30 s after creation
 * (observed 2026-10-17: 25 s idle fine, 31 s gone). The sideband must open, stream, and
 * receive the transcript inside that window; 25 s leaves margin for the POST itself.
 */
export const OPENAI_STT_DEADLINE_MS = 25_000;

/** The direct transcription socket has no observed teardown; this bounds a hung fallback. */
export const OPENAI_STT_FALLBACK_TIMEOUT_MS = 60_000;
export const OPENAI_TTS_TIMEOUT_MS = 60_000;

/** One second of 24 kHz mono PCM16 per input_audio_buffer.append. */
const APPEND_CHUNK_BYTES = OPENAI_REALTIME_SAMPLE_RATE * 2;
const MAX_BUFFERED_EVENTS = 4096;

export interface OpenAIVoiceClientOptions {
  fetch?: typeof fetch;
  webSocketFactory?: OpenAIWebSocketFactory;
  callsUrl?: string;
  realtimeWsUrl?: string;
  sttDeadlineMs?: number;
  /** Retry once on the direct transcription socket when the /calls session is torn down. */
  sttDirectFallback?: boolean;
  sttFallbackTimeoutMs?: number;
  ttsTimeoutMs?: number;
}

export interface OpenAITranscribeRequest {
  audio: Uint8Array;
  mediaType: string;
  model?: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export type OpenAITranscriptionTransport = "realtime-calls" | "realtime-ws";

export interface OpenAITranscription {
  text: string;
  /** Computed from the PCM sent, not reported by the server. */
  durationSec: number;
  /** Set on the Codex /calls path; undefined after the direct-socket fallback. */
  callId: string | undefined;
  /** x-codex-* quota headers from the /calls response; empty after the fallback. */
  quotaHeaders: CodexQuotaHeaders;
  transport: OpenAITranscriptionTransport;
  /** Why the /calls attempt was abandoned, when the fallback ran. */
  fallbackReason: string | undefined;
}

export interface OpenAISpeakRequest {
  text: string;
  model?: string;
  voice?: string;
  instructions?: string;
  format?: "wav" | "pcm";
  signal?: AbortSignal;
}

export interface OpenAISpeechResult {
  audio: Uint8Array;
  mediaType: string;
  /** What the model said, from response.output_audio_transcript.done; compare with the input. */
  transcript: string;
  usage: { textTokens: number; audioTokens: number; inputTokens: number; outputTokens: number };
}

export class OpenAIVoiceInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenAIVoiceInputError";
  }
}

type SocketRecord =
  | { kind: "open" }
  | { kind: "event"; event: JsonValue }
  | { kind: "close"; code: number; reason: string }
  | { kind: "error"; error: Error }
  | { kind: "rejected"; status?: number };

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();

  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();

  return Buffer.from(data).toString();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/** Buffers socket records so the caller can await them in order; cleanup drops the listeners. */
function socketRecords(socket: OpenAIWebSocketLike, signal: AbortSignal) {
  const records: SocketRecord[] = [];
  const waiters: Array<(record: SocketRecord) => void> = [];
  let active = true;

  const push = (record: SocketRecord) => {
    if (!active) return;
    const waiter = waiters.shift();

    if (waiter) waiter(record);
    else if (records.length < MAX_BUFFERED_EVENTS) records.push(record);
    else {
      active = false;
      socket.terminate();
      records.length = 0;
      records.push({
        kind: "error",
        error: new OpenAIProtocolError("realtime socket exceeded the receive buffer"),
      });
    }
  };

  const onOpen = () => push({ kind: "open" });

  const onMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      push({ kind: "error", error: new OpenAIProtocolError("realtime socket sent binary data") });

      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(rawDataText(data));
    } catch {
      push({ kind: "error", error: new OpenAIProtocolError("realtime socket sent invalid JSON") });

      return;
    }

    const event = jsonValueSchema.safeParse(parsed);

    if (event.success) push({ kind: "event", event: event.data });
    else push({ kind: "error", error: new OpenAIProtocolError("realtime event is not JSON") });
  };

  const onClose = (code: number, reason: Buffer) =>
    push({ kind: "close", code, reason: reason.toString() });

  const onError = (error: Error) => push({ kind: "error", error });

  const onUnexpectedResponse = (_request: ClientRequest, response: { statusCode?: number }) =>
    push({ kind: "rejected", status: response.statusCode });

  const onAbort = () => {
    socket.terminate();
    push({ kind: "error", error: abortError(signal) });
  };

  socket.on("open", onOpen);
  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", onError);
  socket.on("unexpected-response", onUnexpectedResponse);
  signal.addEventListener("abort", onAbort, { once: true });

  return {
    next: (): Promise<SocketRecord> => {
      const buffered = records.shift();

      return buffered
        ? Promise.resolve(buffered)
        : new Promise<SocketRecord>((resolve) => waiters.push(resolve));
    },
    cleanup: () => {
      active = false;
      signal.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      // The error listener stays: terminate() on a connecting socket emits "error" next tick.
      socket.off("unexpected-response", onUnexpectedResponse);
      records.length = 0;

      const closed: SocketRecord = {
        kind: "error",
        error: new OpenAIProtocolError("realtime socket record stream was closed"),
      };

      for (const waiter of waiters.splice(0)) waiter(closed);
    },
  };
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function serverErrorFromEvent(event: JsonValue): OpenAIProtocolError | undefined {
  const parsed = realtimeErrorEvent.safeParse(event);

  if (!parsed.success) return undefined;
  const detail = parsed.data.error;

  return new OpenAIProtocolError(
    detail?.message ?? "realtime server error",
    detail?.code ?? detail?.type ?? undefined,
  );
}

function sendJson(socket: OpenAIWebSocketLike, event: JsonValue): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(JSON.stringify(event), (error) => (error ? reject(error) : resolve()));
  });
}

/** x-codex-* response headers, lower-cased, as the dispatcher's quota tracker reads them. */
export type CodexQuotaHeaders = ReadonlyMap<string, string>;

function codexQuotaHeaders(headers: Headers): CodexQuotaHeaders {
  const out = new Map<string, string>();

  headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-codex-")) out.set(key.toLowerCase(), value);
  });

  return out;
}

// chatgpt.com answers errors as {"detail": "..."} or {"detail": {"message": "..."}}.
const callErrorBody = z.object({
  detail: z.union([
    z.string().transform((message) => ({ message })),
    z.looseObject({ message: z.string().optional() }),
  ]),
});

function parseCallErrorMessage(text: string): string | undefined {
  let json: JsonValue;

  try {
    json = jsonValueSchema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }

  const parsed = callErrorBody.safeParse(json);

  return parsed.success ? parsed.data.detail.message : undefined;
}

async function callErrorFromResponse(response: Response): Promise<OpenAIProtocolError> {
  const text = await response.text().catch(() => "");

  const message =
    parseCallErrorMessage(text) ?? text ?? response.statusText ?? `HTTP ${response.status}`;

  return new OpenAIProtocolError(`realtime call rejected: ${message}`, undefined, response.status);
}

export class OpenAIVoiceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: OpenAIWebSocketFactory;
  private readonly callsUrl: string;
  private readonly realtimeWsUrl: string;
  private readonly sttDeadlineMs: number;
  private readonly sttDirectFallback: boolean;
  private readonly sttFallbackTimeoutMs: number;
  private readonly ttsTimeoutMs: number;

  constructor(options: OpenAIVoiceClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, wsOptions) => new WsClient(url, wsOptions));
    this.callsUrl = options.callsUrl ?? OPENAI_REALTIME_CALLS_URL;
    this.realtimeWsUrl = options.realtimeWsUrl ?? OPENAI_REALTIME_WS_URL;
    this.sttDeadlineMs = options.sttDeadlineMs ?? OPENAI_STT_DEADLINE_MS;
    this.sttDirectFallback = options.sttDirectFallback ?? true;
    this.sttFallbackTimeoutMs = options.sttFallbackTimeoutMs ?? OPENAI_STT_FALLBACK_TIMEOUT_MS;
    this.ttsTimeoutMs = options.ttsTimeoutMs ?? OPENAI_TTS_TIMEOUT_MS;
  }

  /**
   * STT, Codex /calls shape: POST {sdp, session} → 201 + Location rtc_…, sideband WebSocket,
   * session.update (language/prompt, manual commit), append PCM, commit, await the transcript.
   */
  async transcribe(
    credentials: OpenAIRealtimeCredentials,
    request: OpenAITranscribeRequest,
  ): Promise<OpenAITranscription> {
    if (request.audio.byteLength === 0) throw new OpenAIVoiceInputError("audio must not be empty");
    let pcm: Uint8Array;

    try {
      pcm = prepareRealtimeInput(request.audio, request.mediaType);
    } catch (error) {
      if (error instanceof UnsupportedAudioError) throw new OpenAIVoiceInputError(error.message);
      throw error;
    }

    if (pcm.byteLength === 0) throw new OpenAIVoiceInputError("audio contains no samples");
    const model = request.model ?? OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL;

    if (request.prompt !== undefined && OPENAI_TRANSCRIPTION_MODELS_WITHOUT_PROMPT.has(model))
      throw new OpenAIVoiceInputError(`${model} does not accept a prompt`);
    const correlation = { threadId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const headers = buildOpenAIRealtimeHeaders(credentials, correlation);

    const session = buildTranscriptionSession({
      model,
      language: request.language,
      prompt: request.prompt,
      manualCommit: true,
    });

    const durationSec = pcm.byteLength / (OPENAI_REALTIME_SAMPLE_RATE * 2);

    try {
      const viaCalls = await this.transcribeViaCalls(headers, model, session, pcm, request.signal);

      return { ...viaCalls, durationSec, transport: "realtime-calls", fallbackReason: undefined };
    } catch (error) {
      if (!(error instanceof Error) || !this.sttDirectFallback || !isSidebandTeardownError(error))
        throw error;
      // The /calls session was reclaimed before the transcript arrived (about 30 s after creation
      // with no RTP). Retry once on the direct transcription socket, which has no such window.
      const fallbackReason = error.message;
      const viaDirect = await this.transcribeViaDirectSocket(headers, session, pcm, request.signal);

      return {
        ...viaDirect,
        durationSec,
        callId: undefined,
        quotaHeaders: new Map(),
        transport: "realtime-ws",
        fallbackReason,
      };
    }
  }

  /** Codex subscription path: POST /realtime/calls, then the sideband socket for that call. */
  private async transcribeViaCalls(
    headers: OpenAIRealtimeHeaders,
    model: string,
    session: JsonValue,
    pcm: Uint8Array,
    callerSignal: AbortSignal | undefined,
  ): Promise<{ text: string; callId: string; quotaHeaders: CodexQuotaHeaders }> {
    const { signal, dispose } = this.deadline(callerSignal, this.sttDeadlineMs);

    try {
      // The /calls body is Codex's exact transcription session; per-request fields follow on
      // the sideband so the create request stays byte-compatible with Codex.
      const callBody = {
        sdp: OPENAI_REALTIME_SYNTHETIC_SDP,
        session: buildTranscriptionSession({ model }),
      };

      const response = await this.fetchImpl(this.callsUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(callBody),
        signal,
      });

      if (response.status !== 201) {
        if (response.ok) await response.body?.cancel();
        throw await callErrorFromResponse(response);
      }

      const location = response.headers.get("location") ?? "";
      const callId = location.split("/").pop() ?? "";
      await response.body?.cancel();

      if (!/^rtc_[A-Za-z0-9_-]+$/.test(callId))
        throw new OpenAIProtocolError(`realtime call returned no call id (Location: ${location})`);
      const quotaHeaders = codexQuotaHeaders(response.headers);

      const text = await this.runTranscriptionSocket(
        `${this.realtimeWsUrl}?call_id=${encodeURIComponent(callId)}`,
        headers,
        session,
        pcm,
        signal,
        callerSignal,
      );

      return { text, callId, quotaHeaders };
    } catch (error) {
      throw signal.aborted ? this.abortReason(callerSignal, signal, error) : error;
    } finally {
      dispose();
    }
  }

  /**
   * Direct transcription socket (wss://api.openai.com/v1/realtime?intent=transcription). Not a
   * Codex path: Codex treats this socket as API-key-only, so it is used only as the fallback.
   */
  private async transcribeViaDirectSocket(
    headers: OpenAIRealtimeHeaders,
    session: JsonValue,
    pcm: Uint8Array,
    callerSignal: AbortSignal | undefined,
  ): Promise<{ text: string }> {
    const { signal, dispose } = this.deadline(callerSignal, this.sttFallbackTimeoutMs);

    try {
      const text = await this.runTranscriptionSocket(
        `${this.realtimeWsUrl}?intent=transcription`,
        headers,
        session,
        pcm,
        signal,
        callerSignal,
      );

      return { text };
    } catch (error) {
      throw signal.aborted ? this.abortReason(callerSignal, signal, error) : error;
    } finally {
      dispose();
    }
  }

  /** session.update → append PCM → commit → await the completed transcript. */
  private async runTranscriptionSocket(
    url: string,
    headers: OpenAIRealtimeHeaders,
    session: JsonValue,
    pcm: Uint8Array,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<string> {
    const socket = this.webSocketFactory(url, { headers });
    const records = socketRecords(socket, signal);

    try {
      await this.awaitOpen(records.next);
      await sendJson(socket, sessionUpdateEvent(session));
      await this.streamPcm(socket, pcm);
      await sendJson(socket, audioCommitEvent());
      const text = await this.awaitTranscript(records.next);
      socket.close(1000, "done");

      return text;
    } catch (error) {
      socket.terminate();
      throw signal.aborted ? this.abortReason(callerSignal, signal, error) : error;
    } finally {
      records.cleanup();
    }
  }

  /**
   * TTS over the direct realtime socket: Codex's conversational session (minus tools), one user
   * text item, response.create, then the concatenated response.output_audio.delta payload.
   */
  async speak(
    credentials: OpenAIRealtimeCredentials,
    request: OpenAISpeakRequest,
  ): Promise<OpenAISpeechResult> {
    if (!request.text.trim()) throw new OpenAIVoiceInputError("text must not be empty");
    const voice = request.voice ?? OPENAI_REALTIME_DEFAULT_VOICE;

    if (!isOpenAIRealtimeVoice(voice))
      throw new OpenAIVoiceInputError(`unsupported voice "${voice}"`);
    const model = request.model ?? OPENAI_REALTIME_DEFAULT_SPEECH_MODEL;
    const format = request.format ?? "wav";
    const correlation = { threadId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const headers = buildOpenAIRealtimeHeaders(credentials, correlation);
    const { signal, dispose } = this.deadline(request.signal, this.ttsTimeoutMs);

    const socket = this.webSocketFactory(
      `${this.realtimeWsUrl}?model=${encodeURIComponent(model)}`,
      { headers },
    );

    const records = socketRecords(socket, signal);

    try {
      await this.awaitOpen(records.next);

      const session = buildSpeechSession({
        instructions: buildSpeechInstructions(request.instructions),
        voice,
      });

      await sendJson(socket, sessionUpdateEvent(session));
      await sendJson(socket, userTextItemEvent(request.text));
      await sendJson(socket, responseCreateEvent());
      const result = await this.awaitSpeech(records.next);
      socket.close(1000, "done");

      const pcm = result.audio;

      return {
        audio: format === "wav" ? wrapPcmAsWav(pcm) : pcm,
        mediaType: format === "wav" ? "audio/wav" : `audio/pcm;rate=${OPENAI_REALTIME_SAMPLE_RATE}`,
        transcript: result.transcript,
        usage: result.usage,
      };
    } catch (error) {
      socket.terminate();
      throw signal.aborted ? this.abortReason(request.signal, signal, error) : error;
    } finally {
      records.cleanup();
      dispose();
    }
  }

  private deadline(caller: AbortSignal | undefined, ms: number) {
    const timeout = AbortSignal.timeout(ms);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;

    return { signal, dispose: () => undefined };
  }

  private abortReason(
    caller: AbortSignal | undefined,
    combined: AbortSignal,
    cause: unknown,
  ): Error {
    if (caller?.aborted) return abortError(caller);

    if (combined.aborted)
      return new OpenAIProtocolError(
        "realtime session timed out",
        "realtime_timeout",
        undefined,
        undefined,
      );

    return cause instanceof Error ? cause : new Error(String(cause));
  }

  private async awaitOpen(next: () => Promise<SocketRecord>): Promise<void> {
    const record = await next();

    switch (record.kind) {
      case "open":
        return;
      case "rejected":
        throw new OpenAIProtocolError(
          `realtime socket handshake rejected${record.status ? ` with HTTP ${record.status}` : ""}`,
          undefined,
          record.status,
        );
      case "error":
        throw record.error;
      case "close":
        throw new OpenAIProtocolError(
          `realtime socket closed before open (${record.code}${record.reason ? `: ${record.reason}` : ""})`,
        );
      case "event":
        throw new OpenAIProtocolError("realtime socket emitted an event before opening");
      default:
        throw new OpenAIProtocolError("realtime socket emitted an unknown record");
    }
  }

  private async streamPcm(socket: OpenAIWebSocketLike, pcm: Uint8Array): Promise<void> {
    for (let offset = 0; offset < pcm.byteLength; offset += APPEND_CHUNK_BYTES) {
      const chunk = pcm.subarray(offset, Math.min(offset + APPEND_CHUNK_BYTES, pcm.byteLength));
      await sendJson(socket, audioAppendEvent(Buffer.from(chunk).toString("base64")));
    }
  }

  private async awaitTranscript(next: () => Promise<SocketRecord>): Promise<string> {
    for (;;) {
      const record = await next();

      if (record.kind === "error") throw record.error;

      if (record.kind === "rejected")
        throw new OpenAIProtocolError("realtime socket rejected", undefined, record.status);

      if (record.kind === "close")
        throw new OpenAIProtocolError(
          `realtime socket closed before the transcript (${record.code}${record.reason ? `: ${record.reason}` : ""})`,
        );

      if (record.kind !== "event") continue;
      const serverError = serverErrorFromEvent(record.event);

      if (serverError) throw serverError;
      const completed = transcriptionCompletedEvent.safeParse(record.event);

      if (completed.success) return completed.data.transcript;
      const failed = transcriptionFailedEvent.safeParse(record.event);

      if (failed.success)
        throw new OpenAIProtocolError(
          failed.data.error?.message ?? "transcription failed",
          failed.data.error?.code ?? undefined,
        );
    }
  }

  private async awaitSpeech(next: () => Promise<SocketRecord>) {
    const chunks: Buffer[] = [];
    let transcript = "";

    for (;;) {
      const record = await next();

      if (record.kind === "error") throw record.error;

      if (record.kind === "rejected")
        throw new OpenAIProtocolError("realtime socket rejected", undefined, record.status);

      if (record.kind === "close")
        throw new OpenAIProtocolError(
          `realtime socket closed before response.done (${record.code}${record.reason ? `: ${record.reason}` : ""})`,
        );

      if (record.kind !== "event") continue;
      const serverError = serverErrorFromEvent(record.event);

      if (serverError) throw serverError;
      const delta = outputAudioDeltaEvent.safeParse(record.event);

      if (delta.success) {
        chunks.push(Buffer.from(delta.data.delta, "base64"));
        continue;
      }

      const transcriptDone = outputAudioTranscriptDoneEvent.safeParse(record.event);

      if (transcriptDone.success) {
        transcript = transcriptDone.data.transcript;
        continue;
      }

      const done = responseDoneEvent.safeParse(record.event);

      if (!done.success) continue;
      const status = done.data.response?.status;

      if (status !== undefined && status !== "completed")
        throw new OpenAIProtocolError(
          `realtime response ${status}: ${JSON.stringify(done.data.response?.status_details ?? null)}`,
          `realtime_response_${status}`,
        );
      const audio = new Uint8Array(Buffer.concat(chunks));

      if (audio.byteLength === 0)
        throw new OpenAIProtocolError("realtime response carried no audio");
      const usage = done.data.response?.usage;

      return {
        audio,
        transcript,
        usage: {
          textTokens: usage?.output_token_details?.text_tokens ?? 0,
          audioTokens: usage?.output_token_details?.audio_tokens ?? 0,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        },
      };
    }
  }
}

/**
 * Failures that mean the /calls session was reclaimed (or never reachable) rather than that the
 * request was wrong: the 25 s deadline, the sideband closing or erroring before the transcript, a
 * rejected sideband handshake. Server `error` events and /calls 4xx are not teardown and never
 * trigger the fallback.
 */
export function isSidebandTeardownError(error: Error): boolean {
  if (!(error instanceof OpenAIProtocolError)) return false;

  if (error.code === "realtime_timeout") return true;

  if (error.code !== undefined) return false;

  return /closed before|handshake rejected|closed before open|record stream was closed/.test(
    error.message,
  );
}

/** Used by the dispatcher's single 401 → refresh → retry step. */
export function isUnauthorizedRealtimeError(error: Error): boolean {
  return error instanceof OpenAIProtocolError && error.status === 401;
}

/** Event schema export for tests that replay captured server traffic. */
export { realtimeServerEvent };
