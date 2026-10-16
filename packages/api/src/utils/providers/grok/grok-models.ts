import {
  GROK_DEFAULT_MODEL,
  GROK_REASONING_EFFORTS,
  GROK_SEED_MODELS,
  type GrokReasoningEffort,
} from "./grok-constants";
import { grokProxyGet } from "./grok-direct-client";
import { buildGrokProxyGetHeaders } from "./grok-headers";
import { GrokModelsResponse, type GrokCredentials, type GrokProxyModel } from "./grok-types";

export interface GrokResolvedModel {
  id: string;
  /** Undefined for an unlisted id; the response `x-grok-context-window` header may fill it. */
  contextWindow: number | undefined;
  efforts: readonly GrokReasoningEffort[];
  defaultEffort: GrokReasoningEffort;
  /** False when the id is in neither the seed nor the live catalog and is forwarded as-is. */
  known: boolean;
}

function isGrokEffort(value: string): value is GrokReasoningEffort {
  return GROK_REASONING_EFFORTS.some((effort) => effort === value);
}

/** Strips the qgrid route prefix; an empty id means the default model. */
export function canonicalGrokModelId(modelId: string | undefined): string {
  const stripped = (modelId ?? "").startsWith("grok/") ? (modelId ?? "").slice(5) : (modelId ?? "");

  return stripped || GROK_DEFAULT_MODEL;
}

function fromProxyModel(model: GrokProxyModel): GrokResolvedModel | undefined {
  if (model.api_backend !== "responses") return undefined;
  const listed = (model.reasoning_efforts ?? []).map((entry) => entry.value).filter(isGrokEffort);
  const efforts: readonly GrokReasoningEffort[] = listed.length ? listed : GROK_REASONING_EFFORTS;
  const flagged = model.reasoning_efforts?.find((entry) => entry.default)?.value;
  const candidates = [flagged, model.reasoning_effort ?? undefined, "high"];

  const defaultEffort =
    candidates.find(
      (value): value is GrokReasoningEffort =>
        value !== undefined && isGrokEffort(value) && efforts.includes(value),
    ) ?? efforts[0]!;

  return { id: model.id, contextWindow: model.context_window, efforts, defaultEffort, known: true };
}

export type GrokModelRefreshResult =
  | { kind: "ok"; models: string[]; etag: string | undefined }
  | { kind: "lookup_failed"; reason: string };

/**
 * Model catalog seeded from the U0 capture and merged with live `GET {proxy}/models`. Like the
 * OpenAI runtime, it never rejects an id: an unlisted id is forwarded and the upstream decides.
 */
export class GrokModelCatalog {
  readonly models = new Map<string, GrokResolvedModel>();
  etag: string | undefined;
  refreshedAt: number | undefined;
  pendingRefresh: Promise<GrokModelRefreshResult> | undefined;

  constructor() {
    for (const seed of GROK_SEED_MODELS) {
      this.models.set(seed.id, {
        id: seed.id,
        contextWindow: seed.contextWindow,
        efforts: seed.reasoningEfforts,
        defaultEffort: seed.defaultEffort,
        known: true,
      });
    }
  }

  /** True when a response advertised a catalog etag different from the one last merged. */
  isStale(observedEtag: string | undefined): boolean {
    return observedEtag !== undefined && observedEtag !== this.etag;
  }

  /** Single-flight refresh. Live entries replace seeds; seeds absent from the live list stay. */
  async refresh(
    credentials: Pick<GrokCredentials, "accessToken" | "userId">,
    options: { fetch?: typeof fetch; signal?: AbortSignal; baseUrl?: string; now?: number } = {},
  ): Promise<GrokModelRefreshResult> {
    this.pendingRefresh ??= this.refreshNow(credentials, options).finally(() => {
      this.pendingRefresh = undefined;
    });

    return this.pendingRefresh;
  }

  async refreshNow(
    credentials: Pick<GrokCredentials, "accessToken" | "userId">,
    options: { fetch?: typeof fetch; signal?: AbortSignal; baseUrl?: string; now?: number },
  ): Promise<GrokModelRefreshResult> {
    try {
      const { json, headers } = await grokProxyGet("/models", {
        headers: buildGrokProxyGetHeaders({
          bearer: credentials.accessToken,
          userId: credentials.userId,
        }),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      });

      const parsed = GrokModelsResponse.safeParse(json);

      if (!parsed.success) {
        return {
          kind: "lookup_failed",
          reason: `unexpected /models shape: ${parsed.error.message}`,
        };
      }

      const merged: string[] = [];

      for (const entry of parsed.data.data) {
        const model = fromProxyModel(entry);

        if (!model) continue;
        this.models.set(model.id, model);
        merged.push(model.id);
      }

      this.etag = headers.modelsEtag;
      this.refreshedAt = options.now ?? Date.now();

      return { kind: "ok", models: merged, etag: this.etag };
    } catch (error) {
      return {
        kind: "lookup_failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  resolve(modelId: string | undefined): GrokResolvedModel {
    const id = canonicalGrokModelId(modelId);

    return (
      this.models.get(id) ?? {
        id,
        contextWindow: undefined,
        efforts: GROK_REASONING_EFFORTS,
        defaultEffort: "high",
        known: false,
      }
    );
  }

  /** The effort if the model accepts it, otherwise undefined. Unlisted ids accept every effort. */
  validateEffort(modelId: string | undefined, effort: string): GrokReasoningEffort | undefined {
    const model = this.resolve(modelId);

    return isGrokEffort(effort) && model.efforts.includes(effort) ? effort : undefined;
  }
}
