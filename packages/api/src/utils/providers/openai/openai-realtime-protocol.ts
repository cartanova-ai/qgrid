import { z } from "zod";

import { CODEX_CLI_ORIGINATOR, codexCliUserAgent, type JsonValue } from "./openai-backend-protocol";

// Wire contract for OpenAI realtime audio on a ChatGPT subscription, mirroring Codex
// (openai/codex main @ 2026-10-17). Each constant names the Codex source it reproduces.
//
// - Transcription (STT): POST {CHATGPT_CODEX_BASE_URL}/realtime/calls with {sdp, session}, then a
//   sideband WebSocket to wss://api.openai.com/v1/realtime?call_id=<rtc_...>.
//   codex-rs/codex-api/src/endpoint/realtime_call.rs:129-209, realtime_websocket/methods.rs:63,
//   1380-1415, core/src/client.rs:740-774.
// - Speech (TTS): the /calls sideband never carries response.output_audio.delta (media stays on
//   RTP), so speech uses the direct wss://api.openai.com/v1/realtime?model=<id> socket with the
//   same session payload. This is the one deliberate deviation from Codex, which treats the
//   direct socket as API-key-only (core/src/realtime_conversation.rs:1931-1955).

/** model-provider-info/src/lib.rs:80 + client.rs:178 */
export const OPENAI_REALTIME_CALLS_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls" as const;

/** realtime_websocket/methods.rs:63 (OPENAI_REALTIME_API_BASE_URL) as a WebSocket URL. */
export const OPENAI_REALTIME_WS_URL = "wss://api.openai.com/v1/realtime" as const;

/** realtime_websocket/methods_common.rs:26 */
export const OPENAI_REALTIME_SAMPLE_RATE = 24_000;

/** realtime_websocket/methods_v2.rs:37 */
export const OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

/** qgrid default; Codex's own default is gpt-realtime-1.5 (core/src/realtime_conversation.rs:112). */
export const OPENAI_REALTIME_DEFAULT_SPEECH_MODEL = "gpt-realtime-2.1-mini";

/** protocol/src/protocol.rs:408 (RealtimeVoicesList::builtin default_v2) */
export const OPENAI_REALTIME_DEFAULT_VOICE = "marin";

/** protocol/src/protocol.rs:368-379 (v2 voice list) */
export const OPENAI_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export type OpenAIRealtimeVoice = (typeof OPENAI_REALTIME_VOICES)[number];

export function isOpenAIRealtimeVoice(value: string): value is OpenAIRealtimeVoice {
  return OPENAI_REALTIME_VOICES.some((voice) => voice === value);
}

/**
 * Speech-to-text ids that passed every row of the live matrix on 2026-10-17
 * (docs/diagnosis/2026-10-17-openai-realtime-audio-probe.md). Dropped there: gpt-live-transcribe
 * and gpt-realtime-whisper (truncate a 60 s clip to about half), whisper-1 (ignores `prompt`).
 */
export const OPENAI_TRANSCRIPTION_MODELS = [
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "gpt-transcribe",
] as const;

/**
 * Text-to-speech (realtime conversational) ids that repeated every matrix text verbatim.
 * gpt-realtime-2.1 paraphrased once and gpt-realtime-1.5 answered instead of repeating; dropped.
 */
export const OPENAI_SPEECH_MODELS = ["gpt-realtime-2.1-mini"] as const;

/**
 * A minimal Opus-only SDP offer. Codex sends a real WebRTC offer; qgrid has no RTP peer and only
 * needs the call id from the response. The server has accepted this offer on every probe
 * (2026-10-17); it is the first thing to re-check if /calls starts answering 4xx.
 */
export const OPENAI_REALTIME_SYNTHETIC_SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:qgrid",
  "a=ice-pwd:qgridqgridqgridqgridqgri",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export interface OpenAIRealtimeCredentials {
  accessToken: string;
  accountId: string;
}

export interface OpenAIRealtimeCorrelation {
  /** Codex "x-session-id" and "thread-id": the conversation/thread id. */
  threadId: string;
  /** Codex "voice-session-id" and "session-id": one per realtime session. */
  sessionId: string;
}

/**
 * The header set Codex sends on the /calls POST and both WebSockets:
 * login/src/auth/default_client.rs:456-470 (originator, User-Agent),
 * core/src/client.rs:528-532 (Authorization, ChatGPT-Account-Id),
 * core/src/realtime_conversation.rs:1957-1998 (x-session-id, voice-session-id),
 * codex-api/src/requests/headers.rs:5-14 (session-id, thread-id).
 * No OpenAI-Beta (the server rejects realtime=v1 with beta_api_shape_disabled) and no
 * openai-alpha (V1/V3 only; V2 sends none).
 */
export type OpenAIRealtimeHeaders = {
  Authorization: string;
  "ChatGPT-Account-Id": string;
  originator: typeof CODEX_CLI_ORIGINATOR;
  "User-Agent": string;
  "x-session-id": string;
  "voice-session-id": string;
  "session-id": string;
  "thread-id": string;
};

export function buildOpenAIRealtimeHeaders(
  credentials: OpenAIRealtimeCredentials,
  correlation: OpenAIRealtimeCorrelation,
): OpenAIRealtimeHeaders {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    "ChatGPT-Account-Id": credentials.accountId,
    originator: CODEX_CLI_ORIGINATOR,
    "User-Agent": codexCliUserAgent(),
    "x-session-id": correlation.threadId,
    "voice-session-id": correlation.sessionId,
    "session-id": correlation.sessionId,
    "thread-id": correlation.threadId,
  };
}

// ---------------------------------------------------------------------------
// Session payloads (codex-api/src/endpoint/realtime_websocket/protocol.rs, methods_v2.rs)
// ---------------------------------------------------------------------------

const pcmFormat = { type: "audio/pcm", rate: OPENAI_REALTIME_SAMPLE_RATE } as const;

type TranscriptionConfig = { model: string; language?: string; prompt?: string };

type TranscriptionInput = {
  format: typeof pcmFormat;
  transcription: TranscriptionConfig;
  turn_detection?: null;
};

export interface OpenAITranscriptionSessionOptions {
  model: string;
  language?: string;
  prompt?: string;
  /**
   * Codex relies on server VAD (no turn_detection key). qgrid transcribes one committed clip, so
   * the sideband session.update sets turn_detection to null. The /calls body keeps Codex's shape.
   */
  manualCommit?: boolean;
}

/**
 * Transcription-mode session, methods_v2.rs:145-167. Serde skip_serializing_if semantics: absent
 * optionals are omitted, never null.
 */
export function buildTranscriptionSession(options: OpenAITranscriptionSessionOptions): JsonValue {
  const transcription: TranscriptionConfig = { model: options.model };

  if (options.language !== undefined) transcription.language = options.language;

  if (options.prompt !== undefined) transcription.prompt = options.prompt;
  const input: TranscriptionInput = { format: pcmFormat, transcription };

  if (options.manualCommit) input.turn_detection = null;

  return { type: "transcription", audio: { input } };
}

export interface OpenAISpeechSessionOptions {
  instructions: string;
  voice: string;
}

/**
 * Conversational session, methods_v2.rs:82-144, minus Codex's tools/tool_choice (background-agent
 * tools have no meaning for one-shot speech). output_modalities ["audio"] and audio.output.format
 * audio/pcm are what Codex sends for voice output.
 */
export function buildSpeechSession(options: OpenAISpeechSessionOptions): JsonValue {
  return {
    type: "realtime",
    instructions: options.instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: pcmFormat,
        noise_reduction: { type: "near_field" },
        transcription: { model: OPENAI_REALTIME_DEFAULT_TRANSCRIPTION_MODEL },
        turn_detection: {
          type: "server_vad",
          interrupt_response: true,
          create_response: true,
          silence_duration_ms: 500,
        },
      },
      output: { format: pcmFormat, voice: options.voice },
    },
  };
}

/** Verbatim-repeat system prompt; the caller's instructions follow as style guidance. */
export function buildSpeechInstructions(callerInstructions: string | undefined): string {
  const base =
    "You are a text-to-speech engine. Speak the user's message exactly as written, in its original language. Do not answer, add, omit, translate, or comment.";

  return callerInstructions ? `${base}\n\nStyle: ${callerInstructions}` : base;
}

// Outbound client events, protocol.rs:53-83 (serde rename values).
export const sessionUpdateEvent = (session: JsonValue): JsonValue => ({
  type: "session.update",
  session,
});

export const audioAppendEvent = (base64Pcm: string): JsonValue => ({
  type: "input_audio_buffer.append",
  audio: base64Pcm,
});

export const audioCommitEvent = (): JsonValue => ({ type: "input_audio_buffer.commit" });

export const userTextItemEvent = (text: string): JsonValue => ({
  type: "conversation.item.create",
  item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});

export const responseCreateEvent = (): JsonValue => ({ type: "response.create" });

// ---------------------------------------------------------------------------
// Inbound server events (only the fields qgrid reads)
// ---------------------------------------------------------------------------

export const realtimeErrorEvent = z.object({
  type: z.literal("error"),
  error: z
    .object({
      type: z.string().optional(),
      code: z.string().nullish(),
      message: z.string().optional(),
    })
    .optional(),
});

export const realtimeServerEvent = z.looseObject({ type: z.string() });

export const transcriptionCompletedEvent = z.looseObject({
  type: z.literal("conversation.item.input_audio_transcription.completed"),
  transcript: z.string(),
});

export const transcriptionFailedEvent = z.looseObject({
  type: z.literal("conversation.item.input_audio_transcription.failed"),
  error: z.looseObject({ message: z.string().optional(), code: z.string().nullish() }).optional(),
});

export const outputAudioDeltaEvent = z.looseObject({
  type: z.literal("response.output_audio.delta"),
  delta: z.string(),
});

export const outputAudioTranscriptDoneEvent = z.looseObject({
  type: z.literal("response.output_audio_transcript.done"),
  transcript: z.string(),
});

export const responseDoneEvent = z.looseObject({
  type: z.literal("response.done"),
  response: z
    .looseObject({
      status: z.string().optional(),
      status_details: z.unknown().optional(),
      usage: z
        .looseObject({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          output_token_details: z
            .looseObject({
              text_tokens: z.number().optional(),
              audio_tokens: z.number().optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// PCM helpers (port of Codex tui convert_pcm16: downmix, then linear resample to 24 kHz)
// ---------------------------------------------------------------------------

export interface PcmAudio {
  /** Little-endian signed 16-bit mono samples. */
  samples: Int16Array;
  sampleRate: number;
}

export class UnsupportedAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAudioError";
  }
}

const RIFF = 0x46464952;
const WAVE = 0x45564157;
const FMT = 0x20746d66;
const DATA = 0x61746164;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Decodes a PCM16 RIFF/WAVE file. Other encodings (float, ADPCM, 8/24-bit) are rejected. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < 12 || view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WAVE)
    throw new UnsupportedAudioError("not a RIFF/WAVE file");
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number } | undefined;

  while (offset + 8 <= bytes.byteLength) {
    const id = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === FMT) {
      if (size < 16 || body + 16 > bytes.byteLength)
        throw new UnsupportedAudioError("truncated fmt chunk");
      const tag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);

      let effectiveTag = tag;

      // WAVE_FORMAT_EXTENSIBLE: the actual format is the first 2 bytes of the SubFormat GUID.
      if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= bytes.byteLength)
        effectiveTag = view.getUint16(body + 24, true);

      if (effectiveTag !== WAVE_FORMAT_PCM || bits !== 16)
        throw new UnsupportedAudioError(`only PCM16 WAV is supported (format ${tag}, ${bits}-bit)`);

      if (channels < 1 || sampleRate < 8000)
        throw new UnsupportedAudioError("invalid WAV channel count or sample rate");
      format = { channels, sampleRate, bits };
    } else if (id === DATA) {
      if (!format) throw new UnsupportedAudioError("WAV data chunk precedes fmt chunk");
      const available = Math.min(size, bytes.byteLength - body);
      const frames = Math.floor(available / (2 * format.channels));

      return {
        samples: downmixInterleaved(
          bytes.subarray(body, body + frames * 2 * format.channels),
          format.channels,
        ),
        sampleRate: format.sampleRate,
      };
    }

    offset = body + size + (size % 2);
  }

  throw new UnsupportedAudioError("WAV file has no data chunk");
}

/** Interleaved little-endian PCM16 → mono by averaging channels. */
export function downmixInterleaved(bytes: Uint8Array, channels: number): Int16Array {
  const frames = Math.floor(bytes.byteLength / (2 * channels));
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2 * channels);
  const mono = new Int16Array(frames);

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;

    for (let channel = 0; channel < channels; channel++)
      sum += view.getInt16((frame * channels + channel) * 2, true);
    mono[frame] = Math.round(sum / channels);
  }

  return mono;
}

/** Linear-interpolation resample, as Codex's convert_pcm16 does for model input. */
export function resampleLinear(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Int16Array(length);
  const step = from / to;

  for (let i = 0; i < length; i++) {
    const position = i * step;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    const a = samples[Math.min(index, samples.length - 1)] ?? 0;
    const b = samples[next] ?? 0;
    out[i] = Math.round(a + (b - a) * fraction);
  }

  return out;
}

/** Mono PCM16 at 24 kHz as little-endian bytes, ready for input_audio_buffer.append. */
export function toRealtimePcm(audio: PcmAudio): Uint8Array {
  const samples = resampleLinear(audio.samples, audio.sampleRate, OPENAI_REALTIME_SAMPLE_RATE);
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);

  return bytes;
}

const PCM_MEDIA_TYPES = new Set(["audio/pcm", "audio/l16"]);
const WAV_MEDIA_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);

function mediaTypeParams(mediaType: string): Map<string, string> {
  const params = new Map<string, string>();

  for (const part of mediaType.split(";").slice(1)) {
    const [key, value] = part.split("=");

    if (key && value) params.set(key.trim().toLowerCase(), value.trim());
  }

  return params;
}

/**
 * Caller audio → 24 kHz mono PCM16. WAV must be PCM16; raw PCM defaults to 24 kHz mono unless
 * ";rate=" / ";channels=" parameters say otherwise. Anything else is unsupported (no decoder).
 */
export function prepareRealtimeInput(bytes: Uint8Array, mediaType: string): Uint8Array {
  const bare = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (WAV_MEDIA_TYPES.has(bare)) return toRealtimePcm(decodeWav(bytes));

  if (PCM_MEDIA_TYPES.has(bare)) {
    const params = mediaTypeParams(mediaType);
    const rate = Number(params.get("rate") ?? OPENAI_REALTIME_SAMPLE_RATE);
    const channels = Number(params.get("channels") ?? 1);

    if (!Number.isInteger(rate) || rate < 8000 || !Number.isInteger(channels) || channels < 1)
      throw new UnsupportedAudioError("invalid PCM rate/channels parameters");

    return toRealtimePcm({ samples: downmixInterleaved(bytes, channels), sampleRate: rate });
  }

  throw new UnsupportedAudioError(
    `${bare || mediaType} is not supported; realtime transcription takes PCM16 WAV or raw PCM`,
  );
}

/** RIFF/WAVE header for mono PCM16 at 24 kHz (speech output). */
export function wrapPcmAsWav(
  pcm: Uint8Array,
  sampleRate = OPENAI_REALTIME_SAMPLE_RATE,
): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);

  return out;
}
