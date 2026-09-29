export function maskAccessToken(credentials: unknown): string {
  if (!credentials || typeof credentials !== "object") return "—";
  if ("authSource" in credentials && credentials.authSource === "system-keychain") {
    return "System Keychain";
  }
  const token = "accessToken" in credentials ? credentials.accessToken : undefined;
  if (typeof token !== "string" || !token) return "—";
  return token.length <= 12 ? token : `${token.slice(0, 8)}...${token.slice(-4)}`;
}
