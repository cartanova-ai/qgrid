import { type SharedV3Warning, type SpeechModelV3 } from "@ai-sdk/provider";
import { z } from "zod";

import {
  assertGrokModelId,
  parseGrokQgridOptions,
  parseXaiMediaOptions,
  postMediaEndpoint,
  type QgridMediaProviderConfig,
  resolveMediaConfig,
  serializeMediaBody,
} from "./image-model";
import { type QgridSpeechModel } from "./index.types";
import { QGRID_PROVIDER_NAME } from "./qgrid.constant";

const LABEL = "qgrid.speech";
const MAX_TEXT_CHARS = 15_000;

/** Codecs of `@ai-sdk/xai` `XaiSpeechCodec`, equal to the qgrid server's `format` enum. */
const SPEECH_FORMATS = ["mp3", "wav", "pcm", "mulaw", "alaw"] as const;

type SpeechFormat = (typeof SPEECH_FORMATS)[number];

function isSpeechFormat(value: string): value is SpeechFormat {
  return (SPEECH_FORMATS as readonly string[]).includes(value);
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
  assertGrokModelId(modelId, LABEL);
  const { serverUrl, projectName } = resolveMediaConfig(config);

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

      const params = {
        model: modelId,
        text: options.text,
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.language === undefined ? {} : { language: options.language }),
        ...(format === undefined ? {} : { format }),
        ...(projectName ? { projectName } : {}),
        ...qgridOptions,
      };

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

      return {
        audio: base64ToBytes(data.audio),
        warnings,
        request: { body: params },
        response: { timestamp, modelId, headers },
        providerMetadata: {
          qgrid: {
            mediaType: data.mimeType,
            tokenName: data.tokenName,
            ...(data.requestLogId === undefined ? {} : { requestLogId: data.requestLogId }),
          },
        },
      };
    },
  };
}
