import { type JSONObject, type SharedV3Warning, type TranscriptionModelV3 } from "@ai-sdk/provider";
import { z } from "zod";

import {
  assertGrokModelId,
  assertInlineMediaFits,
  parseGrokQgridOptions,
  parseXaiMediaOptions,
  postMediaEndpoint,
  type QgridMediaProviderConfig,
  resolveMediaConfig,
  serializeMediaBody,
} from "./image-model";
import { type QgridTranscriptionModel } from "./index.types";
import { QGRID_PROVIDER_NAME } from "./qgrid.constant";
import { bytesToBase64 } from "./utils";

const LABEL = "qgrid.transcription";
const AUDIO_MEDIA_TYPE = /^audio\/[A-Za-z0-9.+-]+$/;

/**
 * `providerOptions.xai` for Grok transcription, field-for-field from `@ai-sdk/xai`
 * `xaiTranscriptionModelOptionsSchema`. Only `language` reaches the qgrid server.
 */
const xaiTranscriptionOptionsSchema = z.object({
  audioFormat: z.enum(["pcm", "mulaw", "alaw", "opus"]).nullish(),
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
  language: z.string().min(1).max(16).nullish(),
  format: z.boolean().nullish(),
  multichannel: z.boolean().nullish(),
  channels: z.number().int().min(2).max(8).nullish(),
  diarize: z.boolean().nullish(),
  keyterm: z.union([z.string(), z.array(z.string())]).nullish(),
  fillerWords: z.boolean().nullish(),
  vadThreshold: z.number().min(0).max(1).optional(),
  streaming: z.object({}).loose().optional(),
});

/** `providerOptions.xai` honored by `qgrid.transcription(...)`. */
export type QgridXaiTranscriptionProviderOptions = { language?: string };

const XAI_TRANSCRIPTION_HONORED = new Set(["language"]);

const transcribeOutputSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  durationSec: z.number().optional(),
  model: z.string(),
  tokenName: z.string(),
  requestLogId: z.number().optional(),
});

// "audio/webm;codecs=opus" → "audio/webm": the server accepts the bare type only.
function normalizeMediaType(mediaType: string): string {
  const bare = mediaType.split(";")[0].trim().toLowerCase();

  if (!AUDIO_MEDIA_TYPE.test(bare)) {
    throw new Error(`${LABEL}: mediaType must be audio/*, got "${mediaType}"`);
  }

  return bare;
}

export function createQgridTranscription(
  modelId: QgridTranscriptionModel,
  config?: QgridMediaProviderConfig,
): TranscriptionModelV3 {
  assertGrokModelId(modelId, LABEL);
  const { serverUrl, projectName } = resolveMediaConfig(config);

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,

    async doGenerate(options) {
      const mediaType = normalizeMediaType(options.mediaType);

      const audio =
        options.audio instanceof Uint8Array ? bytesToBase64(options.audio) : options.audio;

      if (audio.length === 0) throw new Error(`${LABEL}: audio is empty`);
      assertInlineMediaFits([audio], LABEL);
      const qgridOptions = parseGrokQgridOptions(options.providerOptions?.qgrid, LABEL);

      const xai = parseXaiMediaOptions(
        options.providerOptions?.xai,
        xaiTranscriptionOptionsSchema,
        XAI_TRANSCRIPTION_HONORED,
        LABEL,
      );

      const warnings: SharedV3Warning[] = [...xai.warnings];
      const language = xai.options?.language ?? undefined;

      // Also throws before transport when the JSON body would exceed the 10 MiB body limit.
      const params: JSONObject = { model: modelId, audio, mediaType };

      if (language !== undefined) params.language = language;

      if (projectName) params.projectName = projectName;
      const body = serializeMediaBody({ ...params, ...qgridOptions }, LABEL);

      const timestamp = new Date();

      const { data, headers } = await postMediaEndpoint({
        serverUrl,
        endpoint: "transcribe",
        body,
        schema: transcribeOutputSchema,
        label: LABEL,
        signal: options.abortSignal,
        headers: options.headers,
      });

      const qgridMetadata: JSONObject = { tokenName: data.tokenName };

      if (data.requestLogId !== undefined) qgridMetadata.requestLogId = data.requestLogId;

      return {
        text: data.text,
        // The qgrid server returns no word or segment timings.
        segments: [],
        language: data.language,
        durationInSeconds: data.durationSec,
        warnings,
        response: { timestamp, modelId: data.model, headers },
        providerMetadata: { qgrid: qgridMetadata },
      };
    },
  };
}
