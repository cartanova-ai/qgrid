import { describe, expect, it } from "vitest";

import { unpricedRequestCount, unpricedRequestLabel, unpricedRequestTitle } from "./total-cost";

describe("total cost unpriced indicator", () => {
  it("adds unknown image and unknown media counts", () => {
    const cost = { usd: 1, unknownImageCostCount: 2, unknownCostCount: 3 };
    expect(unpricedRequestCount(cost)).toBe(5);
    expect(unpricedRequestLabel(cost)).toBe("+5 unpriced");
    expect(unpricedRequestTitle(cost)).toBe(
      "Total excludes requests with unknown cost: 2 image, 3 voice/video.",
    );
  });

  it("shows nothing when every request is priced", () => {
    const cost = { usd: 1, unknownImageCostCount: 0, unknownCostCount: 0 };
    expect(unpricedRequestLabel(cost)).toBeNull();
    expect(unpricedRequestTitle(cost)).toBeNull();
  });

  it("tolerates a response without unknownCostCount", () => {
    expect(unpricedRequestLabel({ usd: 0, unknownImageCostCount: 1 })).toBe("+1 unpriced");
  });
});
