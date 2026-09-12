import { setTimeout as delay } from "node:timers/promises";

import { type AntigravityCredentials } from "../../../application/token/token.types";
import { antigravityControl, checkedJson, record, type HttpDeps } from "./antigravity-http";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "cloud-platform",
  "userinfo.email",
  "userinfo.profile",
  "cclog",
  "experimentsandconfigs",
];

function clientSecret(): string {
  const secret = process.env.QGRID_ANTIGRAVITY_CLIENT_SECRET;
  if (!secret) throw new Error("QGRID_ANTIGRAVITY_CLIENT_SECRET is required for Antigravity OAuth");
  return secret;
}

export function buildAntigravityAuthUrl(state: string): string {
  clientSecret();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    state,
    scope: SCOPES.map((scope) => `https://www.googleapis.com/auth/${scope}`).join(" "),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchange(body: Record<string, string>, deps: HttpDeps) {
  const data = await checkedJson(
    await (deps.fetch ?? fetch)(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, client_id: CLIENT_ID, client_secret: clientSecret() }),
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (typeof data.access_token !== "string" || !data.access_token)
    throw new Error("Antigravity OAuth returned no access token");
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt: Date.now() + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
  };
}

function projectId(data: Record<string, unknown>): string | undefined {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = typeof data[key] === "string" ? data[key] : record(data[key]).id;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export async function exchangeAntigravityCode(
  code: string,
  deps: HttpDeps = {},
): Promise<AntigravityCredentials> {
  const tokens = await exchange(
    { grant_type: "authorization_code", code, redirect_uri: ANTIGRAVITY_REDIRECT_URI },
    deps,
  );
  if (!tokens.refreshToken)
    throw new Error("Antigravity OAuth returned no refresh token; grant offline access again");
  const user = await checkedJson(
    await (deps.fetch ?? fetch)("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    }),
  );
  if (typeof user.id !== "string" || typeof user.email !== "string")
    throw new Error("Antigravity OAuth returned no account identity");
  const signal = AbortSignal.timeout(60_000);
  const info = await antigravityControl(
    "loadCodeAssist",
    tokens.accessToken,
    { metadata: { ideType: "ANTIGRAVITY" } },
    signal,
    deps,
  );
  let project = projectId(info);
  if (!project) {
    const tiers = Array.isArray(info.allowedTiers) ? info.allowedTiers.map(record) : [];
    const tier = tiers.find((item) => item.isDefault === true)?.id;
    if (typeof tier !== "string")
      throw new Error("Antigravity account has no default eligible tier");
    for (let attempt = 0; attempt < 5 && !project; attempt++) {
      if (attempt) await delay(1000, undefined, { signal });
      const result = await antigravityControl(
        "onboardUser",
        tokens.accessToken,
        {
          tier_id: tier,
          metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity" },
        },
        signal,
        deps,
      );
      if (result.done) project = projectId(record(result.response));
    }
  }
  if (!project) throw new Error("Antigravity project setup is incomplete; retry login later");
  return {
    ...tokens,
    refreshToken: tokens.refreshToken,
    accountId: user.id,
    accountEmail: user.email,
    projectId: project,
  };
}

export async function refreshAntigravityCredentials(
  credentials: AntigravityCredentials,
  deps: HttpDeps = {},
): Promise<AntigravityCredentials> {
  const tokens = await exchange(
    { grant_type: "refresh_token", refresh_token: credentials.refreshToken },
    deps,
  );
  return {
    ...credentials,
    ...tokens,
    refreshToken: tokens.refreshToken ?? credentials.refreshToken,
  };
}
