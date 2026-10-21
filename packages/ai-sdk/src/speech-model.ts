import { type JSONObject, type SharedV3Warning, type SpeechModelV3 } from "@ai-sdk/provider";
import { z } from "zod";

import {
  parseGrokQgridOptions,
  parseNamespacedMediaOptions,
  parseOpenAIQgridOptions,
  parseXaiMediaOptions,
  postMediaEndpoint,
  type QgridMediaProviderConfig,
  resolveMediaConfig,
  serializeMediaBody,
  voiceProviderOf,
} from "./image-model";
import { type QgridSpeechModel } from "./index.types";
import { QGRID_PROVIDER_NAME } from "./qgrid.constant";

const LABEL = "qgrid.speech";
const MAX_TEXT_CHARS = 15_000;

/** Codecs of `@ai-sdk/xai` `XaiSpeechCodec`, equal to the qgrid server's `format` enum. */
const SPEECH_FORMATS = ["mp3", "wav", "pcm", "mulaw", "alaw"] as const;

type SpeechFormat = (typeof SPEECH_FORMATS)[number];

function isSpeechFormat(value: string): value is SpeechFormat {
  return SPEECH_FORMATS.some((format) => format === value);
}

/**
 * `providerOptions.xai` for Grok speech, field-for-field from `@ai-sdk/xai`
 * `xaiSpeechModelOptionsSchema`. The qgrid server takes none of them; every set key warns.
 */
const xaiSpeechOptionsSchema = z.object({
  sampleRate: z
    .union([
      z.literal(8000),
      z.literal(16000),
      z.literal(22050),
      z.literal(24000),
      z.literal(44100),
      z.literal(48000),
    ])
    .nullish(),
  bitRate: z
    .union([
      z.literal(32000),
      z.literal(64000),
      z.literal(96000),
      z.literal(128000),
      z.literal(192000),
    ])
    .nullish(),
  optimizeStreamingLatency: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullish(),
  textNormalization: z.boolean().nullish(),
  withTimestamps: z.boolean().nullish(),
  replace: z.record(z.string(), z.string()).nullish(),
});

/**
 * `providerOptions.openai` for OpenAI speech, field-for-field from `@ai-sdk/openai`
 * `openaiSpeechModelOptionsSchema` (vercel/ai fce9210). `instructions` is honored as style
 * guidance for the realtime model; `speed` warns.
 */
const openaiSpeechOptionsSchema = z.object({
  instructions: z.string().nullish(),
  speed: z.number().min(0.25).max(4.0).nullish(),
});

/** `providerOptions.openai` honored by `qgrid.speech("openai/...")`. */
export type QgridOpenAISpeechProviderOptions = { instructions?: string };

const OPENAI_SPEECH_HONORED = new Set(["instructions"]);

/** Realtime speech output: PCM16 24 kHz, as WAV (default) or raw PCM. */
const OPENAI_SPEECH_FORMATS = ["wav", "pcm"] as const;

type OpenAISpeechFormat = (typeof OPENAI_SPEECH_FORMATS)[number];

function isOpenAISpeechFormat(value: string): value is OpenAISpeechFormat {
  return OPENAI_SPEECH_FORMATS.some((format) => format === value);
}

const speakOutputSchema = z.object({
  audio: z.string(),
  mimeType: z.string(),
  tokenName: z.string(),
  requestLogId: z.number().optional(),
});

function base64ToBytes(data: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return bytes;
}

/**
 * Grok text-to-speech through `POST /api/qgrid/speak`. `voice`, `language` and `outputFormat`
 * map to the server's `voice`, `language` and `format`; when omitted the server applies
 * `ara` / `en` / `mp3` (the only combination verified live). The model id only labels the log.
 */
export function createQgridSpeech(
  modelId: QgridSpeechModel,
  config?: QgridMediaProviderConfig,
): SpeechModelV3 {
  const provider = voiceProviderOf(modelId, LABEL);
  const { serverUrl, projectName } = resolveMediaConfig(config);

  if (provider === "openai") return createOpenAISpeech(modelId, serverUrl, projectName);

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,

    async doGenerate(options) {
      if (!options.text.trim()) throw new Error(`${LABEL}: text must not be empty`);

      if (options.text.length > MAX_TEXT_CHARS) {
        throw new Error(`${LABEL}: text is limited to ${MAX_TEXT_CHARS} characters`);
      }

      const qgridOptions = parseGrokQgridOptions(options.providerOptions?.qgrid, LABEL);

      const xai = parseXaiMediaOptions(
        options.providerOptions?.xai,
        xaiSpeechOptionsSchema,
        new Set<string>(),
        LABEL,
      );

      const warnings: SharedV3Warning[] = [];
      // Same fallback as @ai-sdk/xai: an unknown codec becomes mp3 with a warning.
      let format: SpeechFormat | undefined;

      if (options.outputFormat !== undefined) {
        if (isSpeechFormat(options.outputFormat)) {
          format = options.outputFormat;
        } else {
          format = "mp3";
          warnings.push({
            type: "unsupported",
            feature: "outputFormat",
            details: `Unsupported output format: ${options.outputFormat}. Using mp3 instead.`,
          });
        }
      }

      if (options.instructions !== undefined) {
        warnings.push({ type: "unsupported", feature: "instructions" });
      }

      if (options.speed !== undefined) warnings.push({ type: "unsupported", feature: "speed" });
      warnings.push(...xai.warnings);

      const requestParams: JSONObject = { model: modelId, text: options.text };

      if (options.voice !== undefined) requestParams.voice = options.voice;

      if (options.language !== undefined) requestParams.language = options.language;

      if (format !== undefined) requestParams.format = format;

      if (projectName) requestParams.projectName = projectName;
      const params: JSONObject = { ...requestParams, ...qgridOptions };

      const body = serializeMediaBody(params, LABEL);
      const timestamp = new Date();

      const { data, headers } = await postMediaEndpoint({
        serverUrl,
        endpoint: "speak",
        body,
        schema: speakOutputSchema,
        label: LABEL,
        signal: options.abortSignal,
        headers: options.headers,
      });

      const qgridMetadata: JSONObject = { mediaType: data.mimeType, tokenName: data.tokenName };

      if (data.requestLogId !== undefined) qgridMetadata.requestLogId = data.requestLogId;

      return {
        audio: base64ToBytes(data.audio),
        warnings,
        request: { body: params },
        response: { timestamp, modelId, headers },
        providerMetadata: { qgrid: qgridMetadata },
      };
    },
  };
}

/**
 * OpenAI subscription speech: a realtime conversational model repeating the text verbatim (there
 * is no `gpt-4o-mini-tts` on subscription). Follows `@ai-sdk/openai` option names: `voice`
 * (default `marin`, Codex v2 list), `outputFormat` `wav` (default) or `pcm` — other formats
 * warn and fall back to wav, as the official provider falls back to mp3 — `openai.instructions`
 * as style guidance, `openai.speed` and `language` unsupported with the official warning text.
 */
function createOpenAISpeech(
  modelId: QgridSpeechModel,
  serverUrl: string,
  projectName: string | undefined,
): SpeechModelV3 {
  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,

    async doGenerate(options) {
      if (!options.text.trim()) throw new Error(`${LABEL}: text must not be empty`);

      if (options.text.length > MAX_TEXT_CHARS) {
        throw new Error(`${LABEL}: text is limited to ${MAX_TEXT_CHARS} characters`);
      }

      const qgridOptions = parseOpenAIQgridOptions(options.providerOptions?.qgrid, LABEL);

      const openai = parseNamespacedMediaOptions(
        "openai",
        options.providerOptions?.openai,
        openaiSpeechOptionsSchema,
        OPENAI_SPEECH_HONORED,
        LABEL,
      );

      const warnings: SharedV3Warning[] = [];
      let format: OpenAISpeechFormat | undefined;

      if (options.outputFormat !== undefined) {
        if (isOpenAISpeechFormat(options.outputFormat)) {
          format = options.outputFormat;
        } else {
          format = "wav";
          warnings.push({
            type: "unsupported",
            feature: "outputFormat",
            details: `Unsupported output format: ${options.outputFormat}. Using wav instead.`,
          });
        }
      }

      if (options.language !== undefined) {
        warnings.push({
          type: "unsupported",
          feature: "language",
          details: `OpenAI speech models do not support language selection. Language parameter "${options.language}" was ignored.`,
        });
      }

      if (options.speed !== undefined) warnings.push({ type: "unsupported", feature: "speed" });
      warnings.push(...openai.warnings);

      const requestParams: JSONObject = { model: modelId, text: options.text };

      if (options.voice !== undefined) requestParams.voice = options.voice;

      if (format !== undefined) requestParams.format = format;
      const instructions = options.instructions ?? openai.options?.instructions ?? undefined;

      if (instructions !== undefined) requestParams.instructions = instructions;

      if (projectName) requestParams.projectName = projectName;
      const params: JSONObject = { ...requestParams, ...qgridOptions };

      const body = serializeMediaBody(params, LABEL);
      const timestamp = new Date();

      const { data, headers } = await postMediaEndpoint({
        serverUrl,
        endpoint: "speak",
        body,
        schema: speakOutputSchema,
        label: LABEL,
        signal: options.abortSignal,
        headers: options.headers,
      });

      const qgridMetadata: JSONObject = { mediaType: data.mimeType, tokenName: data.tokenName };

      if (data.requestLogId !== undefined) qgridMetadata.requestLogId = data.requestLogId;

      return {
        audio: base64ToBytes(data.audio),
        warnings,
        request: { body: params },
        response: { timestamp, modelId, headers },
        providerMetadata: { qgrid: qgridMetadata },
      };
    },
  };
}
