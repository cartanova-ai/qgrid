/**
 * request log 비용 계산 규칙. Sonamu 에 의존하지 않아 모델과 운영 백필 스크립트가 같이 쓴다.
 */
import { calculateCostUsd } from "../../utils/providers/common/model-cost";

// cost_usd는 정수 micro-USD로 저장. 실제 USD = cost_usd / MICRO_USD.
export const MICRO_USD = 1_000_000;

export type RequestLogUsageRow = {
  token_name?: string | null;
  model_name?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens?: number | null;
  cache_creation_1h_tokens?: number | null;
  cost_usd?: number | null;
  cost_source?: string | null;
};

function isAnthropicUsageRow(row: Pick<RequestLogUsageRow, "token_name" | "model_name">): boolean {
  return (
    row.token_name?.startsWith("anthropic/") === true ||
    row.model_name?.startsWith("claude-") === true ||
    row.model_name?.startsWith("anthropic/claude-") === true
  );
}

export function canonicalModelName(modelName: string): string {
  return modelName.includes("/") ? modelName.split("/").pop()! : modelName;
}

interface UsageForCost {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
}

export function normalizedUsageForCost(row: RequestLogUsageRow): UsageForCost {
  const cacheRead = row.cache_read_tokens;
  const cacheCreation = row.cache_creation_tokens;
  const storedInput = row.input_tokens;

  const legacyAnthropicSplitInput =
    isAnthropicUsageRow(row) && storedInput < cacheRead + cacheCreation;

  const usage: UsageForCost = {
    model: row.model_name ? canonicalModelName(row.model_name) : null,
    inputTokens: legacyAnthropicSplitInput ? storedInput + cacheRead + cacheCreation : storedInput,
    outputTokens: row.output_tokens,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };

  if (row.cache_creation_5m_tokens !== null && row.cache_creation_5m_tokens !== undefined) {
    usage.cacheCreationInputTokens5m = row.cache_creation_5m_tokens;
  }

  if (row.cache_creation_1h_tokens !== null && row.cache_creation_1h_tokens !== undefined) {
    usage.cacheCreationInputTokens1h = row.cache_creation_1h_tokens;
  }

  return usage;
}

/** 현재 가격표로 계산한 driver 비용(micro-USD). 모델을 모르면 undefined. */
export function pricingTableCostMicroUsd(row: RequestLogUsageRow): number | undefined {
  const usage = normalizedUsageForCost(row);

  if (!usage.model) return undefined;

  return Math.round(
    calculateCostUsd(usage.model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheCreationInputTokens5m: usage.cacheCreationInputTokens5m,
      cacheCreationInputTokens1h: usage.cacheCreationInputTokens1h,
    }) * MICRO_USD,
  );
}

/**
 * 출처 없는 비용을 쓰기 시점에 가격표로 확정한다. 읽기 경로는 저장값만 더하므로, 이 규칙을
 * 거친 row 는 재계산 보정이 0 이다. 출처가 있으면 그대로 두고, 모델을 모르거나 저장값이 없는데
 * 계산값도 0 이면(미확정 media 등) 바꾸지 않는다.
 */
export function resolvePricingCost(
  row: RequestLogUsageRow,
): { cost_usd: number; cost_source: "pricing_table" } | undefined {
  if (row.cost_source) return undefined;
  const cost = pricingTableCostMicroUsd(row);

  if (cost === undefined || (cost === 0 && (row.cost_usd ?? null) === null)) return undefined;

  return { cost_usd: cost, cost_source: "pricing_table" };
}
