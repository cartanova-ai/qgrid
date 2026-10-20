import { type TokenCredentials } from "@/services/token/token.types";

export function maskAccessToken(credentials: TokenCredentials): string {
  const token = credentials.accessToken;

  if (!token) return "—";

  return token.length <= 12 ? token : `${token.slice(0, 8)}...${token.slice(-4)}`;
}
