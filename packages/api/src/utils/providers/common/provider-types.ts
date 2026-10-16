import { z } from "zod";

// qgrid provider route prefix (`<provider>/<model>`). 새 provider 는 여기에만 추가한다.
export const PROVIDER_IDS = ["openai", "anthropic", "grok"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string | undefined): value is ProviderId {
  return PROVIDER_IDS.some((id) => id === value);
}

export type JsonValue =
  | number
  | string
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
  | null;

/** Decodes parsed JSON text (for example `JSON.parse` output) into `JsonValue`. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.json();

export type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type TextElement = {
  byteRange: { start: number; end: number };
  placeholder: string | null;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type QuotaRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type QuotaRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: QuotaRateLimitWindow | null;
  secondary: QuotaRateLimitWindow | null;
  credits: JsonValue;
  planType: string | null;
  rateLimitReachedType: string | null;
};

export type QuotaRateLimits = {
  rateLimits: QuotaRateLimitSnapshot;
  rateLimitsByLimitId: { [key: string]: QuotaRateLimitSnapshot | undefined } | null;
};
