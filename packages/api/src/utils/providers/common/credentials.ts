import {
  type AnthropicCredentials,
  type OAuthTokenCredentials,
  type OpenAICredentials,
  type TokenCredentials,
} from "../../../application/token/token.types";

export function isAnthropicCredentials(creds: TokenCredentials): creds is AnthropicCredentials {
  return "accountUuid" in creds;
}

export function isOpenAICredentials(creds: TokenCredentials): creds is OpenAICredentials {
  return "accountId" in creds && !("projectId" in creds);
}

export function isOAuthTokenCredentials(creds: TokenCredentials): creds is OAuthTokenCredentials {
  return "accessToken" in creds;
}

export function getAccessToken(creds: TokenCredentials): string {
  if (!isOAuthTokenCredentials(creds)) {
    throw new Error("credentials have no access token (Keychain-backed provider)");
  }
  return creds.accessToken;
}

export function getRefreshToken(creds: TokenCredentials): string | undefined {
  return isOAuthTokenCredentials(creds) ? creds.refreshToken : undefined;
}

export function getExpiresAt(creds: TokenCredentials): number {
  if ("expiresAt" in creds) return creds.expiresAt;
  if ("accessTokenExpiresAt" in creds) return creds.accessTokenExpiresAt;
  throw new Error("credentials have no expiry (Keychain-backed provider)");
}
