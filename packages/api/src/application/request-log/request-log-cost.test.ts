import { describe, expect, it } from "vitest";

import { pricingTableCostMicroUsd, resolvePricingCost } from "./request-log-cost";

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

describe("pricingTableCostMicroUsd", () => {
  it("prices 5m and 1h cache writes at their own TTL rates", () => {
    // Sonnet 4.6: 100K input × $3 + 30K 5m write × $3.75 + 50K 1h write × $6 = $0.4725.
    expect(
      pricingTableCostMicroUsd({
        ...usage,
        input_tokens: 100_000,
        output_tokens: 0,
        cache_creation_tokens: 80_000,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
      }),
    ).toBe(472_500);
  });
});
