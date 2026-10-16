import { describe, expect, it } from "vitest";

import {
  QgridXaiOptionsError,
  XAI_PROVIDER_OPTION_CLASSIFICATION,
  grokEffortsForModel,
  mapXaiProviderOptions,
} from "./grok-options";
import { qgridXaiProviderOptionsSchema, type QgridXaiProviderOptions } from "./index.types";

const everyKey = {
  reasoningEffort: "high",
  promptCacheKey: "conv-1",
  store: false,
  previousResponseId: "resp_1",
  include: ["reasoning.encrypted_content", "no_inline_citations"],
  serviceTier: "priority",
  maxTurns: 3,
  parallelToolCalls: false,
  user: "user-1",
  safetyIdentifier: "safety-1",
} satisfies Required<QgridXaiProviderOptions>;

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("qgridXaiProviderOptionsSchema", () => {
  it("parses every documented key", () => {
    expect(qgridXaiProviderOptionsSchema.parse(everyKey)).toEqual(everyKey);
  });

  it("accepts every reasoningEffort value of @ai-sdk/xai", () => {
    for (const reasoningEffort of ["none", "low", "medium", "high", "xhigh"]) {
      expect(qgridXaiProviderOptionsSchema.safeParse({ reasoningEffort }).success).toBe(true);
    }
  });

  it("accepts include: null", () => {
    expect(qgridXaiProviderOptionsSchema.safeParse({ include: null }).success).toBe(true);
  });

  it("documents a classification for every schema key and nothing else", () => {
    expect(Object.keys(XAI_PROVIDER_OPTION_CLASSIFICATION).sort()).toEqual(
      Object.keys(qgridXaiProviderOptionsSchema.shape).sort(),
    );
  });
});

describe("mapXaiProviderOptions", () => {
  it("returns an empty mapping for absent options", () => {
    expect(mapXaiProviderOptions(undefined, "grok/grok-4.7")).toEqual({
      request: {},
      warnings: [],
      rejected: [],
    });
    expect(mapXaiProviderOptions(null, "grok/grok-4.7").rejected).toEqual([]);
  });

  it("follows the classification table for every key", () => {
    const mapped = mapXaiProviderOptions(everyKey, "grok/grok-4.7");
    const expectedRejected = Object.entries(XAI_PROVIDER_OPTION_CLASSIFICATION)
      .filter(([, c]) => c.kind === "rejected")
      .map(([key]) => key)
      .sort();
    expect([...mapped.rejected].sort()).toEqual(expectedRejected);
    expect(mapped.warnings.map((w) => w.key).sort()).toEqual(expectedRejected);
    for (const [key, classification] of Object.entries(XAI_PROVIDER_OPTION_CLASSIFICATION)) {
      if (classification.kind === "rejected") {
        expect(mapped.warnings).toContainEqual({ key, reason: classification.reason });
      }
    }
    expect(mapped.request).toEqual({
      effort: "high",
      promptCacheKey: "conv-1",
      serviceTier: "priority",
      parallelToolCalls: false,
    });
    const faithfulTargets = Object.values(XAI_PROVIDER_OPTION_CLASSIFICATION)
      .filter((c) => c.kind !== "rejected")
      .map((c) => c.target)
      .sort();
    expect(Object.keys(mapped.request).sort()).toEqual(faithfulTargets);
  });

  it("does not warn for rejected keys that are explicitly undefined or null", () => {
    const mapped = mapXaiProviderOptions({ store: undefined, include: null }, "grok/grok-4.7");
    expect(mapped.warnings).toEqual([]);
    expect(mapped.rejected).toEqual([]);
  });

  it("accepts xhigh for grok/grok-4.5", () => {
    const mapped = mapXaiProviderOptions({ reasoningEffort: "xhigh" }, "grok/grok-4.5");
    expect(mapped.request.effort).toBe("xhigh");
    expect(mapped.warnings).toEqual([]);
  });

  it("uses the default effort set for seeded and unknown models", () => {
    expect(grokEffortsForModel("grok/grok-4.5")).toEqual(["xhigh", "high", "medium", "low"]);
    expect(grokEffortsForModel("grok-4.7")).toEqual(["xhigh", "high", "medium", "low"]);
    expect(grokEffortsForModel("grok/grok-9")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it('rejects reasoningEffort "none" with a warning', () => {
    const mapped = mapXaiProviderOptions({ reasoningEffort: "none" }, "grok/grok-4.7");
    expect(mapped.request.effort).toBeUndefined();
    expect(mapped.rejected).toEqual(["reasoningEffort"]);
    expect(mapped.warnings).toHaveLength(1);
    expect(mapped.warnings[0]?.key).toBe("reasoningEffort");
  });

  it("warns on unknown keys without failing", () => {
    const mapped = mapXaiProviderOptions(
      { promptCacheKey: "k", reasoningSummary: "detailed", logprobs: true },
      "grok/grok-4.7",
    );
    expect(mapped.request).toEqual({ promptCacheKey: "k" });
    expect(mapped.rejected).toEqual([]);
    expect(mapped.warnings.map((w) => w.key)).toEqual(["reasoningSummary", "logprobs"]);
  });

  it("throws a typed error for invalid value types", () => {
    const error = captureError(() =>
      mapXaiProviderOptions({ reasoningEffort: "max", maxTurns: "3" }, "grok/grok-4.7"),
    );
    expect(error).toBeInstanceOf(QgridXaiOptionsError);
    if (!(error instanceof QgridXaiOptionsError)) {
      return;
    }
    expect(error.issues.map((issue) => issue.path).sort()).toEqual(["maxTurns", "reasoningEffort"]);
    expect(error.message).toContain("providerOptions.xai");
  });

  it("throws a typed error when options is not an object", () => {
    for (const bad of ["x", 1, [], true]) {
      expect(captureError(() => mapXaiProviderOptions(bad, "grok/grok-4.7"))).toBeInstanceOf(
        QgridXaiOptionsError,
      );
    }
  });
});
