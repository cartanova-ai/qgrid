import { describe, expect, it } from "vitest";

import { formatRequestCost, formatUsd } from "./cost";

describe("request cost display", () => {
  it.each([
    [{ is_image_generation: false, cost_usd: 1000, image_cost_usd: null }, "$0.0010"],
    [{ is_image_generation: true, cost_usd: 1000, image_cost_usd: 2000 }, "$0.0030"],
    [{ is_image_generation: true, cost_usd: 1000, image_cost_usd: 0 }, "$0.0010"],
    [{ is_image_generation: true, cost_usd: 1000, image_cost_usd: null }, "Known $0.0010"],
    [{ is_image_generation: true, cost_usd: 0, image_cost_usd: null }, "Known $0.0000"],
    [{ is_image_generation: true, cost_usd: null, image_cost_usd: null }, "Unknown"],
    [{ is_image_generation: false, cost_usd: null, image_cost_usd: null }, "—"],
  ])("distinguishes known and incomplete row costs: %j", (row, expected) => {
    expect(formatRequestCost(row)).toBe(expected);
  });

  it("labels filtered totals as known subtotals only when image costs are missing", () => {
    expect(formatUsd(0.038, true)).toBe("Known $0.0380");
    expect(formatUsd(0.038, false)).toBe("$0.0380");
  });
});
