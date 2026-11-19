import { ANTHROPIC_EFFORTS, OPENAI_EFFORTS } from "../../utils/providers/common/effort";
import {
  getModelCosts,
  openaiFastMultiplier,
  openaiModelMaxEffort,
  sttUsdPerMinute,
} from "../../utils/providers/common/model-cost";
import {
  GROK_REASONING_EFFORTS,
  GROK_STT_DEFAULT_MODEL,
} from "../../utils/providers/grok/grok-constants";
import { OPENAI_TRANSCRIPTION_MODELS } from "../../utils/providers/openai/openai-realtime-protocol";
import {
  type CatalogSpeechModel,
  type CatalogTextModel,
  type ModelCatalog,
  QGRID_MODELS,
} from "./qgrid.types";

// whisper-1 accepts a prompt but the upstream ignores it, so neither steers spelling.
const OPENAI_STT_WITHOUT_PROMPT = new Set(["gpt-realtime-whisper", "whisper-1"]);

// The one model that streams text before a segment is committed (probe 2026-11-18).
const OPENAI_LIVE_DRAFT_MODELS = new Set(["gpt-live-transcribe"]);

const providerOf = (id: string) => id.slice(0, id.indexOf("/"));

function efforts(id: string): string[] {
  const [provider, model] = [providerOf(id), id.slice(id.indexOf("/") + 1)];

  if (provider === "anthropic") return [...ANTHROPIC_EFFORTS];

  if (provider === "grok") return GROK_REASONING_EFFORTS.toReversed();
  const max = OPENAI_EFFORTS.indexOf(openaiModelMaxEffort(model));

  return OPENAI_EFFORTS.slice(0, max + 1);
}

function textModel(id: string, available: boolean): CatalogTextModel {
  const costs = getModelCosts(id);

  return {
    id,
    provider: providerOf(id),
    available,
    pricing: {
      input: costs.inputTokens,
      output: costs.outputTokens,
      cachedInput: costs.cachedInputTokens,
      cacheWrite: costs.cacheCreationInputTokens,
      cacheWrite5m: costs.cacheCreationInputTokens5m,
      cacheWrite1h: costs.cacheCreationInputTokens1h,
      longContext: costs.longContext,
      fastMultiplier: openaiFastMultiplier(id),
    },
    efforts: efforts(id),
    imageInput: providerOf(id) !== "anthropic",
  };
}

function speechModel(id: string, available: boolean): CatalogSpeechModel {
  const model = id.slice(id.indexOf("/") + 1);
  const openai = providerOf(id) === "openai";

  return {
    id,
    provider: providerOf(id),
    available,
    usdPerMinute: sttUsdPerMinute(id),
    prompt: openai && !OPENAI_STT_WITHOUT_PROMPT.has(model),
    liveDraft: openai && OPENAI_LIVE_DRAFT_MODELS.has(model),
  };
}

/** Every model qgrid serves, by task, with prices and whether its provider can take a request now. */
export function buildModelCatalog(isAvailable: (provider: string) => boolean): ModelCatalog {
  const openaiStt = OPENAI_TRANSCRIPTION_MODELS.map((m) => `openai/${m}`);
  const speech = (id: string) => speechModel(id, isAvailable(providerOf(id)));

  return {
    text: QGRID_MODELS.map((id) => textModel(id, isAvailable(providerOf(id)))),
    transcription: [...openaiStt, `grok/${GROK_STT_DEFAULT_MODEL}`].map(speech),
    transcriptionStream: openaiStt.map(speech),
  };
}
