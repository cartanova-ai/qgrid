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
  contextWindow: number;
  efforts: readonly GrokReasoningEffort[];
  defaultEffort: GrokReasoningEffort;
}

export class GrokUnknownModelError extends Error {
  readonly code = "GROK_UNKNOWN_MODEL" as const;
  readonly modelId: string;
  readonly knownModels: string[];

  constructor(modelId: string, knownModels: string[]) {
    super(`Unknown Grok model "${modelId}". Known models: ${knownModels.join(", ")}`);
    this.name = "GrokUnknownModelError";
    this.modelId = modelId;
    this.knownModels = knownModels;
  }
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
  return { id: model.id, contextWindow: model.context_window, efforts, defaultEffort };
}

export type GrokModelRefreshResult =
  | { kind: "ok"; models: string[]; etag: string | undefined }
  | { kind: "lookup_failed"; reason: string };

/** Model catalog seeded from the U0 capture and merged with live `GET {proxy}/models`. */
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
    const model = this.models.get(id);
    if (!model) throw new GrokUnknownModelError(id, [...this.models.keys()]);
    return model;
  }

  /** The effort if the model accepts it, otherwise undefined. Throws for unknown models. */
  validateEffort(modelId: string | undefined, effort: string): GrokReasoningEffort | undefined {
    const model = this.resolve(modelId);
    return isGrokEffort(effort) && model.efforts.includes(effort) ? effort : undefined;
  }
}
