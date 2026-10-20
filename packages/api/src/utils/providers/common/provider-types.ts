import { z } from "zod";

// qgrid provider route prefix (`<provider>/<model>`). 새 provider 는 여기에만 추가한다.
export const PROVIDER_IDS = ["openai", "anthropic", "grok"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string | undefined): value is ProviderId {
  return PROVIDER_IDS.some((id) => id === value);
}

export type JsonValue = number | string | boolean | JsonValue[] | JsonObject | null;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** JsonValue accepted read-only, for callers that pass `as const` or frozen JSON. */
export type ReadonlyJsonValue =
  | number
  | string
  | boolean
  | readonly ReadonlyJsonValue[]
  | ReadonlyJsonObject
  | null;

export interface ReadonlyJsonObject {
  readonly [key: string]: ReadonlyJsonValue | undefined;
}

/** Decodes parsed JSON text (for example `JSON.parse` output) into `JsonValue`. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.json();

// Shallow: accepts any non-null, non-array object, including null-prototype objects.
const anyJsonObject = z.looseObject({});

/** Narrows an already-decoded JSON value to its object member. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return anyJsonObject.safeParse(value).success;
}

/** The string member of a decoded JSON value, or undefined for any other member. */
export function jsonString(value: JsonValue | undefined): string | undefined {
  return z.string().safeParse(value).data;
}

/** The number member of a decoded JSON value, or undefined for any other member. */
export function jsonNumber(value: JsonValue | undefined): number | undefined {
  return z.number().safeParse(value).data;
}

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
