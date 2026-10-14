import { describe, expect, it } from "vitest";

import { formatRequestCost, formatUsd } from "./cost";

describe("request cost display", () => {
  it.each([
    [{ is_image_generation: false, cost_usd: 1000, image_cost_usd: null }, "$0.0010"],
    [{ is_image_generation: true, cost_usd: 1000, image_cost_usd: 2000 }, "$0.0030"],
    [{ is_image_generation: true, cost_usd: 1000, image_cost_usd: 0 }, "$0.0010"],
    [{ is_image_generation: true, cost_usd: 1000, image_cost_usd: null }, "$0.0010"],
    [{ is_image_generation: true, cost_usd: 0, image_cost_usd: null }, "$0.0000"],
    [{ is_image_generation: true, cost_usd: null, image_cost_usd: 2000 }, "$0.0020"],
    [{ is_image_generation: true, cost_usd: null, image_cost_usd: null }, "—"],
    [{ is_image_generation: false, cost_usd: null, image_cost_usd: null }, "—"],
  ])("sums stored costs and shows a dash only when both are absent: %j", (row, expected) => {
    expect(formatRequestCost(row)).toBe(expected);
  });

  it("formats totals as plain USD amounts", () => {
    expect(formatUsd(0.038)).toBe("$0.0380");
  });
});
