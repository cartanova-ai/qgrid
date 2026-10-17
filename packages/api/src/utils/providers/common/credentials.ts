import {
  type AnthropicCredentials,
  type OpenAICredentials,
  type TokenCredentials,
} from "../../../application/token/token.types";

export function getAccessToken(creds: TokenCredentials): string {
  return creds.accessToken;
}

export function getRefreshToken(creds: TokenCredentials): string | undefined {
  return creds.refreshToken;
}

export function getExpiresAt(creds: TokenCredentials): number {
  // Grok credentials (authMode "oauth") store RFC 3339; an unparseable value reads as expired.
  if ("authMode" in creds) {
    const parsed = Date.parse(creds.expiresAt);

    return Number.isNaN(parsed) ? 0 : parsed;
  }

  if ("expiresAt" in creds) return creds.expiresAt;

  return creds.accessTokenExpiresAt;
}

export function isAnthropicCredentials(creds: TokenCredentials): creds is AnthropicCredentials {
  return "accountUuid" in creds;
}

export function isOpenAICredentials(creds: TokenCredentials): creds is OpenAICredentials {
  return "accountId" in creds;
}
