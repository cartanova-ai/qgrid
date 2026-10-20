import crypto from "node:crypto";

import { z } from "zod";

import { type JsonValue } from "../common/provider-types";
import {
  OPENAI_AUTHORIZE_URL,
  OPENAI_CLIENT_ID,
  OPENAI_ORIGINATOR,
  OPENAI_SCOPES,
  OPENAI_TOKEN_URL,
} from "./openai-constants";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

// Mistyped claims read as absent, matching how the callers treat missing ones.
const openAITokenClaimsSchema = z.looseObject({
  exp: z.number().optional().catch(undefined),
  [OPENAI_AUTH_CLAIM]: z
    .looseObject({
      chatgpt_account_id: z.string().optional().catch(undefined),
      chatgpt_plan_type: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const openAITokenExchangeResponseSchema = z.looseObject({
  id_token: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

export interface OpenAIPKCE {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

export interface OpenAITokenClaims {
  expiresAt?: number;
  accountId?: string;
  planType?: string;
}

export interface OpenAIExchangedCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExpiresAt: number;
  idTokenExpiresAt?: number;
  accountId: string;
  planType?: string;
}

export function generateOpenAIPKCE(): OpenAIPKCE {
  const codeVerifier = crypto.randomBytes(64).toString("base64url");

  return {
    codeVerifier,
    codeChallenge: crypto.createHash("sha256").update(codeVerifier).digest("base64url"),
    state: crypto.randomBytes(32).toString("base64url"),
  };
}

export function buildOpenAIAuthUrl(
  codeChallenge: string,
  state: string,
  redirectUri: string,
): string {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OPENAI_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: OPENAI_ORIGINATOR,
  }).toString();

  return url.toString();
}

export function parseOpenAITokenClaims(jwt: string): OpenAITokenClaims {
  const parts = jwt.split(".");
  const payloadPart = parts[1];

  if (parts.length !== 3 || parts.some((part) => !part) || !payloadPart) {
    throw new Error("invalid OpenAI JWT format");
  }

  let payload: JsonValue;

  try {
    // JSON.parse without a reviver yields only JSON values.
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid OpenAI JWT payload");
  }

  const claims = openAITokenClaimsSchema.safeParse(payload);

  if (!claims.success) throw new Error("invalid OpenAI JWT payload");
  const auth = claims.data[OPENAI_AUTH_CLAIM];

  return {
    expiresAt: claims.data.exp === undefined ? undefined : claims.data.exp * 1000,
    accountId: auth?.chatgpt_account_id,
    planType: auth?.chatgpt_plan_type,
  };
}

export async function exchangeOpenAICode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OpenAIExchangedCredentials> {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    // Token endpoint bodies can echo credentials or provider diagnostics; never expose them.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OPENAI_TOKEN_EXCHANGE_HTTP_${response.status}`);
  }

  const tokens = openAITokenExchangeResponseSchema.parse(await response.json());

  if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
    throw new Error("OpenAI token exchange returned incomplete credentials");
  }

  const idClaims = parseOpenAITokenClaims(tokens.id_token);
  const accessClaims = parseOpenAITokenClaims(tokens.access_token);
  const accountId = idClaims.accountId ?? accessClaims.accountId;

  if (!accountId) throw new Error("OpenAI token did not include a ChatGPT account id");

  const credentials: OpenAIExchangedCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    accessTokenExpiresAt:
      accessClaims.expiresAt ??
      (tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : Date.now()),
    accountId,
  };

  if (idClaims.expiresAt) credentials.idTokenExpiresAt = idClaims.expiresAt;
  const planType = idClaims.planType ?? accessClaims.planType;

  if (planType) credentials.planType = planType;

  return credentials;
}
