import { type JSONObject, type JSONValue } from "@ai-sdk/provider";

import { qgridXaiProviderOptionsSchema, type QgridXaiProviderOptions } from "./index.types";

/** Effort values qgrid forwards to the Grok subscription backend (`reasoning.effort`). */
export type QgridGrokEffort = "low" | "medium" | "high" | "xhigh";

type XaiOptionKey = keyof QgridXaiProviderOptions;

export type XaiOptionClassification =
  | { kind: "faithful"; target: "promptCacheKey" }
  | { kind: "transformed"; target: "effort" }
  | { kind: "rejected"; reason: string };

/**
 * How each documented `providerOptions.xai` key reaches the qgrid request.
 * faithful: same meaning, same name. transformed: renamed and validated. rejected: dropped with a warning.
 */
export const XAI_PROVIDER_OPTION_CLASSIFICATION = {
  reasoningEffort: { kind: "transformed", target: "effort" },
  promptCacheKey: { kind: "faithful", target: "promptCacheKey" },
  serviceTier: {
    kind: "rejected",
    reason: "the Grok subscription proxy's handling of serviceTier is unverified",
  },
  parallelToolCalls: {
    kind: "rejected",
    reason: "the Grok subscription proxy's handling of parallelToolCalls is unverified",
  },
  store: { kind: "rejected", reason: "qgrid always sends store: false" },
  previousResponseId: { kind: "rejected", reason: "qgrid replays conversation history itself" },
  include: { kind: "rejected", reason: "qgrid fixes the include list itself" },
  maxTurns: { kind: "rejected", reason: "qgrid does not run server-side agentic turns" },
  user: { kind: "rejected", reason: "qgrid does not forward end-user identifiers" },
  safetyIdentifier: { kind: "rejected", reason: "qgrid does not forward end-user identifiers" },
} as const satisfies Record<XaiOptionKey, XaiOptionClassification>;

/** Catalog effort set (`/models` `reasoning_efforts`) observed at GROK_BUILD_VERSION 1.0.60. */
export const DEFAULT_GROK_EFFORTS: readonly QgridGrokEffort[] = ["xhigh", "high", "medium", "low"];

/** Per-model overrides of `DEFAULT_GROK_EFFORTS`, keyed by the backend id without the `grok/` prefix. */
export const GROK_MODEL_EFFORTS: ReadonlyMap<string, readonly QgridGrokEffort[]> = new Map([
  ["grok-4.7", DEFAULT_GROK_EFFORTS],
  ["grok-4.7-build-fast", DEFAULT_GROK_EFFORTS],
  ["grok-4.6", DEFAULT_GROK_EFFORTS],
  ["grok-4.5", DEFAULT_GROK_EFFORTS],
]);

export type XaiOptionsWarning = { key: string; reason: string };

export type MappedXaiProviderOptions = {
  request: {
    effort?: QgridGrokEffort;
    promptCacheKey?: string;
  };
  warnings: XaiOptionsWarning[];
  rejected: string[];
};

export type XaiOptionsIssue = { path: string; message: string };

/** Thrown when `providerOptions.xai` has an invalid shape or value type. */
export class QgridXaiOptionsError extends Error {
  readonly issues: XaiOptionsIssue[];

  constructor(issues: XaiOptionsIssue[]) {
    const detail = issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");
    super(`qgrid: invalid providerOptions.xai: ${detail}`);
    this.name = "QgridXaiOptionsError";
    this.issues = issues;
  }
}

/** Object.getPrototypeOf boxes primitives, so only plain and null-prototype objects pass. */
function isPlainJsonObject(value: JSONValue): value is JSONObject {
  if (value === null || Array.isArray(value)) return false;
  const proto: object | null = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

function isClassifiedKey(key: string): key is XaiOptionKey {
  return Object.hasOwn(XAI_PROVIDER_OPTION_CLASSIFICATION, key);
}

function isGrokEffort(value: string): value is QgridGrokEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

export function grokEffortsForModel(modelId: string): readonly QgridGrokEffort[] {
  const backendId = modelId.startsWith("grok/") ? modelId.slice("grok/".length) : modelId;

  return GROK_MODEL_EFFORTS.get(backendId) ?? DEFAULT_GROK_EFFORTS;
}

/**
 * Validates `providerOptions.xai` (the `@ai-sdk/xai` option shape) and maps the keys qgrid honors
 * onto its request fields. Unsupported keys and values become warnings; malformed values throw
 * `QgridXaiOptionsError`.
 */
export function mapXaiProviderOptions(
  options: JSONValue | undefined,
  modelId: string,
): MappedXaiProviderOptions {
  const result: MappedXaiProviderOptions = { request: {}, warnings: [], rejected: [] };

  if (options === undefined || options === null) {
    return result;
  }

  if (!isPlainJsonObject(options)) {
    throw new QgridXaiOptionsError([{ path: "", message: "expected an object" }]);
  }

  const parsed = qgridXaiProviderOptionsSchema.safeParse(options);

  if (!parsed.success) {
    throw new QgridXaiOptionsError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }

  const values = parsed.data;

  for (const key of Object.keys(options)) {
    if (!isClassifiedKey(key)) {
      result.warnings.push({ key, reason: "unknown providerOptions.xai key; ignored by qgrid" });
      continue;
    }

    const value = values[key];

    if (value === undefined || value === null) {
      continue;
    }

    const classification: XaiOptionClassification = XAI_PROVIDER_OPTION_CLASSIFICATION[key];

    if (classification.kind === "rejected") {
      result.warnings.push({ key, reason: classification.reason });
      result.rejected.push(key);
    }
  }

  const effort = values.reasoningEffort;

  if (effort !== undefined) {
    if (effort === "none") {
      result.warnings.push({
        key: "reasoningEffort",
        reason: 'reasoningEffort "none" is not supported; the qgrid Grok route always reasons',
      });
      result.rejected.push("reasoningEffort");
    } else if (isGrokEffort(effort) && grokEffortsForModel(modelId).includes(effort)) {
      result.request.effort = effort;
    } else {
      result.warnings.push({
        key: "reasoningEffort",
        reason: `reasoningEffort "${effort}" is not supported by ${modelId}`,
      });
      result.rejected.push("reasoningEffort");
    }
  }

  if (values.promptCacheKey !== undefined) {
    result.request.promptCacheKey = values.promptCacheKey;
  }

  return result;
}
