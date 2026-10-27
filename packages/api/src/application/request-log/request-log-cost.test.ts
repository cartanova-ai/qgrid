import { describe, expect, it } from "vitest";

import { resolvePricingCost } from "./request-log-cost";

const usage = {
  token_name: "anthropic/test",
  model_name: "claude-sonnet-4-6",
  input_tokens: 1_000,
  output_tokens: 1_000,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

describe("resolvePricingCost", () => {
  it("prices source-less rows, including a caller cost without a source", () => {
    expect(resolvePricingCost({ ...usage, cost_usd: 1 })).toEqual({ cost_usd: 18_000, cost_source: "pricing_table" });
  });

  it("keeps sourced rows, unknown models, and zero-cost rows without a stored cost", () => {
    expect(resolvePricingCost({ ...usage, cost_source: "provider" })).toBeUndefined();
    expect(resolvePricingCost({ ...usage, model_name: null })).toBeUndefined();
    expect(resolvePricingCost({ ...usage, input_tokens: 0, output_tokens: 0, cost_usd: null })).toBeUndefined();
  });
});
