import {
  fetchUsageWithMeta,
  invalidateAnthropicQuotaUsage,
} from "../../../application/qgrid/oauth";
import { isFableFamilyModel } from "./anthropic-constants";

export { invalidateAnthropicQuotaUsage };

export type AnthropicQuotaUsageResult =
  | {
      kind: "ok";
      utilizationPct: number | null;
      weeklyUtilizationPct: number | null;
      cacheAgeMs: number;
    }
  | { kind: "lookup_failed"; reason: string };

export async function readAnthropicQuotaUsage(
  accessToken: string,
  model?: string,
): Promise<AnthropicQuotaUsageResult> {
  try {
    const { data, cachedAt } = await fetchUsageWithMeta(accessToken);

    if (data.error) return { kind: "lookup_failed", reason: data.error };

    const fiveHour = data.five_hour?.utilization ?? null;
    const utilizationPct = fiveHour !== null && Number.isFinite(fiveHour) ? fiveHour : null;
    const weeklyUsages = [data.seven_day?.utilization];

    // Fable 계열(5, 5.1)은 5시간 창과 별개로 usage credits 기반 7일 버킷도 소진될 수 있다.
    if (isFableFamilyModel(model)) {
      weeklyUsages.push(data.seven_day_overage_included?.utilization);
    }

    const weeklyUsage = Math.max(
      ...weeklyUsages.filter(
        (value): value is number => value !== null && value !== undefined && Number.isFinite(value),
      ),
    );

    const weeklyUtilizationPct = Number.isFinite(weeklyUsage) ? weeklyUsage : null;

    if (utilizationPct === null && weeklyUtilizationPct === null) {
      return { kind: "lookup_failed", reason: "quota utilization unavailable" };
    }

    return {
      kind: "ok",
      utilizationPct,
      weeklyUtilizationPct,
      cacheAgeMs: Math.max(Date.now() - cachedAt, 0),
    };
  } catch (e) {
    return { kind: "lookup_failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
