import { describe, expect, it } from "vitest";

import { parseAntigravityQuotaSummary } from "./antigravity-quota";

describe("Antigravity quota windows", () => {
  it("labels weekly as 7d even when only two hours remain", () => {
    const resetsAt = new Date(Date.now() + 2 * 3600000).toISOString();
    const result = parseAntigravityQuotaSummary({ groups: [{ buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, resetTime: resetsAt }] }] });
    expect(result.sevenDay?.windowDurationMins).toBe(10080);
    expect(result.sevenDay?.resetsAt).toBe(resetsAt);
    expect(result.fiveHour).toBeNull();
  });
  it("keeps 5h/7d separate and excludes other model providers", () => {
    const result = parseAntigravityQuotaSummary({ groups: [{ buckets: [
      { bucketId: "gemini-five-hour", window: "five_hour", remainingFraction: 0.5 },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9 },
      { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0 },
    ] }] });
    expect(result.fiveHour).toMatchObject({ utilization: 50, windowDurationMins: 300 });
    expect(result.sevenDay?.utilization).toBeCloseTo(10);
  });
  it("does not invent a window for unknown or malformed buckets", () => {
    expect(parseAntigravityQuotaSummary({ groups: [{ buckets: [{ bucketId: "gemini-other", remainingFraction: 0.5, resetTime: "2026-09-19T00:00:00Z" }] }] })).toEqual({ fiveHour: null, sevenDay: null });
  });
});
