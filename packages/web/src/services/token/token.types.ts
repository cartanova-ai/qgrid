/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { z } from "zod";

import { TokenBaseListParams, TokenBaseSchema } from "../sonamu.generated";

// ── Credentials JSONB schema (Sonamu json prop 의 id: "TokenCredentials" 가 참조) ──

export const AnthropicCredentials = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  accountUuid: z.string(),
});

export type AnthropicCredentials = z.infer<typeof AnthropicCredentials>;

export const OpenAICredentials = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string().optional(),
  accessTokenExpiresAt: z.number(),
  idTokenExpiresAt: z.number().optional(),
  accountId: z.string(),
  planType: z.string().optional(),
});

export type OpenAICredentials = z.infer<typeof OpenAICredentials>;

// Web-safe storage shape only. Registration and refresh validate with the strict schema in
// utils/providers/grok/grok-types.ts (at+jwt from auth.x.ai, GUID ids).
export const GrokCredentials = z.object({
  authMode: z.literal("oauth"),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
  issuer: z.literal("https://auth.x.ai"),
  clientId: z.string(),
  scopes: z.array(z.string()),
  userId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  subscriptionTier: z.string().optional(),
});

export type GrokCredentials = z.infer<typeof GrokCredentials>;

export const TokenCredentials = z.union([AnthropicCredentials, OpenAICredentials, GrokCredentials]);

export type TokenCredentials = z.infer<typeof TokenCredentials>;

// Token - ListParams
export const TokenListParams = TokenBaseListParams;

export type TokenListParams = z.infer<typeof TokenListParams>;

const TokenQuotaThreshold = z.int().min(1).max(100).nullable();
const TokenWeight = z.int().min(1).max(100);

// Token - SaveParams
export const TokenSaveParams = TokenBaseSchema.partial({
  id: true,
  created_at: true,
  active: true,
  reauth_required: true,
  ord: true,
  quota_threshold: true,
  weight: true,
  keepalive_enabled: true,
}).extend({
  quota_threshold: TokenQuotaThreshold.optional(),
  weight: TokenWeight.optional(),
});

export type TokenSaveParams = z.infer<typeof TokenSaveParams>;
