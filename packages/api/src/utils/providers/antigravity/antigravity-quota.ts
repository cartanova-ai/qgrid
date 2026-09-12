import { record } from "./antigravity-http";

type QuotaWindow = { utilization: number; resetsAt: string | null; windowDurationMins: number };
export type AntigravityQuotaWindows = {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
};

/** Explicit upstream window names, never an estimate based on time until reset. */
export function parseAntigravityQuotaSummary(value: unknown): AntigravityQuotaWindows {
  const windows: AntigravityQuotaWindows = { fiveHour: null, sevenDay: null };
  const groups = record(value).groups;
  if (!Array.isArray(groups)) return windows;
  for (const groupValue of groups) {
    const group = record(groupValue);
    if (!Array.isArray(group.buckets)) continue;
    for (const raw of group.buckets) {
      const bucket = record(raw);
      if (typeof bucket.bucketId !== "string" || !bucket.bucketId.startsWith("gemini-")) continue;
      if (
        typeof bucket.remainingFraction !== "number" ||
        !Number.isFinite(bucket.remainingFraction)
      )
        continue;
      const window = typeof bucket.window === "string" ? bucket.window.toLowerCase() : "";
      const key =
        window === "weekly"
          ? "sevenDay"
          : /^(5h|five[-_ ]?hour|five[-_ ]?hours)$/.test(window)
            ? "fiveHour"
            : null;
      if (!key) continue;
      const utilization = Math.max(0, Math.min(100, (1 - bucket.remainingFraction) * 100));
      if (windows[key] && windows[key].utilization >= utilization) continue;
      windows[key] = {
        utilization,
        resetsAt: typeof bucket.resetTime === "string" ? bucket.resetTime : null,
        windowDurationMins: key === "sevenDay" ? 10080 : 300,
      };
    }
  }
  return windows;
}
