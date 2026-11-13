import {
  type Experimental_DecisionModelV4 as DecisionModelV4,
  type Experimental_DecisionModelV4Answer as DecisionAnswer,
  type Experimental_DecisionModelV4CallOptions as DecisionCallOptions,
  type Experimental_DecisionModelV4Question as DecisionQuestion,
  type JSONObject,
  type SharedV4Warning,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import { z } from "zod";

import {
  assertInlineMediaFits,
  parseNamespacedMediaOptions,
  parseOpenAIQgridOptions,
  postMediaEndpoint,
  type QgridMediaProviderConfig,
  resolveMediaConfig,
  serializeMediaBody,
} from "./image-model";
import { type QgridDecisionModel } from "./index.types";
import { QGRID_PROVIDER_NAME } from "./qgrid.constant";
import { bytesToBase64 } from "./utils";

const LABEL = "qgrid.decision";
const DECISION_MODELS: readonly string[] = ["openai/gpt-6-luna"] satisfies QgridDecisionModel[];
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** `providerOptions.openai`, field-for-field from `@ai-sdk/openai` decision options (4.0.116). */
const openaiDecisionOptionsSchema = z.object({
  safetyIdentifier: z.string().max(128).optional(),
  promptCacheKey: z.string().max(64).optional(),
});

/** `providerOptions.openai` honored by `qgrid.decision("openai/gpt-6-luna")`. */
export type QgridOpenAIDecisionProviderOptions = z.infer<typeof openaiDecisionOptionsSchema>;

const OPENAI_DECISION_HONORED = new Set(["safetyIdentifier", "promptCacheKey"]);

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);

const decideOutputSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        probabilities: probabilities.optional(),
        confidence: probability.optional(),
      }),
      z.object({
        type: z.literal("score"),
        score: z.number(),
        probabilities: probabilities.optional(),
        confidence: probability.optional(),
      }),
      z.object({ type: z.literal("boolean"), probability }),
      z.object({ type: z.literal("refusal") }),
    ]),
  ),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
  tokenName: z.string(),
  requestLogId: z.number().optional(),
});

/** AI SDK state parts to qgrid's JSON state: images become an https URL or a data URL. */
function stateParts(state: DecisionCallOptions["state"]): JSONObject[] {
  return state.map((part): JSONObject => {
    if (part.type === "text") return { type: "text", text: part.text };

    if (part.type === "json") return { type: "json", value: part.value };

    if (part.data.type === "url" && /^https?:$/.test(part.data.url.protocol)) {
      return { type: "image", url: part.data.url.href };
    }

    if (part.data.type === "data" && IMAGE_MEDIA_TYPES.has(part.mediaType)) {
      const base64 =
        part.data.data instanceof Uint8Array ? bytesToBase64(part.data.data) : part.data.data;

      return { type: "image", url: `data:${part.mediaType};base64,${base64}` };
    }

    throw new UnsupportedFunctionalityError({
      functionality: `${LABEL} file input: ${part.mediaType} (${part.data.type}); use a PNG/JPEG/WebP/GIF image as bytes or an http(s) URL`,
    });
  });
}

/** AI SDK questions as qgrid JSON; `box` never gets here (not in `supportedQuestionTypes`). */
function questionJson(question: DecisionQuestion): JSONObject {
  const instructions = question.instructions ?? null;

  switch (question.type) {
    case "choice":
      return { type: "choice", instructions, criteria: { ...question.criteria } };
    case "score":
      return { type: "score", instructions, criteria: [...question.criteria] };
    case "boolean":
      return {
        type: "boolean",
        instructions,
        criteria: question.criteria
          ? { true: question.criteria.true ?? null, false: question.criteria.false ?? null }
          : null,
      };
    case "box":
      throw new UnsupportedFunctionalityError({ functionality: `${LABEL} box questions` });
  }
}

/**
 * Native OpenAI Decisions through the qgrid server's subscription token. The server converts the
 * provider-neutral request to OpenAI's wire format; there is no prompt-emulation fallback.
 */
export function createQgridDecision(
  modelId: QgridDecisionModel,
  config?: QgridMediaProviderConfig,
): DecisionModelV4 {
  if (!DECISION_MODELS.includes(modelId)) {
    throw new Error(`${LABEL}: unsupported model ${String(modelId)}; expected openai/gpt-6-luna`);
  }

  const { serverUrl, projectName } = resolveMediaConfig(config);

  return {
    specificationVersion: "v4",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    supportedQuestionTypes: ["choice", "score", "boolean"],

    async doDecide(options) {
      const qgridOptions = parseOpenAIQgridOptions(options.providerOptions?.qgrid, LABEL);

      const openai = parseNamespacedMediaOptions(
        "openai",
        options.providerOptions?.openai,
        openaiDecisionOptionsSchema,
        OPENAI_DECISION_HONORED,
        LABEL,
      );

      const warnings: SharedV4Warning[] = [...openai.warnings];

      if (options.maxOutputTokens !== undefined) {
        warnings.push({ type: "unsupported", feature: "maxOutputTokens" });
      }

      if (options.reasoning !== undefined) {
        warnings.push({ type: "unsupported", feature: "reasoning" });
      }

      const state = stateParts(options.state);
      assertInlineMediaFits(
        state.map((part) => (part.type === "image" ? String(part.url) : undefined)),
        LABEL,
      );

      const params: JSONObject = {
        model: modelId,
        state,
        questions: Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => [id, questionJson(question)]),
        ),
      };

      if (openai.options?.promptCacheKey !== undefined) {
        params.promptCacheKey = openai.options.promptCacheKey;
      }

      if (openai.options?.safetyIdentifier !== undefined) {
        params.safetyIdentifier = openai.options.safetyIdentifier;
      }

      if (projectName) params.projectName = projectName;

      const timestamp = new Date();

      const { data, headers } = await postMediaEndpoint({
        serverUrl,
        endpoint: "decide",
        body: serializeMediaBody({ ...params, ...qgridOptions }, LABEL),
        schema: decideOutputSchema,
        label: LABEL,
        signal: options.abortSignal,
        headers: options.headers,
      });

      const answers: Record<string, DecisionAnswer> = {};
      const confidence: JSONObject = {};

      for (const [id, answer] of Object.entries(data.answers)) {
        if (answer.type === "choice" || answer.type === "score") {
          const { confidence: value, ...rest } = answer;

          if (value !== undefined) confidence[id] = value;
          answers[id] = rest;
        } else {
          answers[id] = answer;
        }
      }

      const qgridMetadata = {
        tokenName: data.tokenName,
        confidence,
        cachedInputTokens: data.usage.cachedInputTokens,
        cacheWriteTokens: data.usage.cacheWriteTokens,
        ...(data.requestLogId !== undefined && { requestLogId: data.requestLogId }),
      } satisfies JSONObject;

      return {
        answers,
        usage: { inputTokens: data.usage.inputTokens, outputTokens: data.usage.outputTokens },
        // OpenAI rounds probabilities and scores to two decimals, as @ai-sdk/openai declares.
        rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
        warnings,
        providerMetadata: { qgrid: qgridMetadata },
        response: { timestamp, modelId: data.model, headers },
      };
    },
  };
}
