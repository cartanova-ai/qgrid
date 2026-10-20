import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GROK_BUILD_VERSION, GROK_OAUTH_CLIENT_ID, GROK_OAUTH_SCOPES } from "./grok-constants";
import {
  GROK_FALLBACK_AUTHORIZATION_ENDPOINT,
  GROK_FALLBACK_TOKEN_ENDPOINT,
  GrokOAuthError,
  buildGrokAuthorizeUrl,
  completeGrokOAuth,
  getGrokOAuthEndpoints,
  parseGrokCallbackInput,
  pollGrokDeviceCode,
  resetGrokDiscoveryCache,
  startGrokDeviceCode,
  startGrokOAuth,
} from "./grok-oauth";

const USER_ID = "11111111-2222-3333-4444-555555555555";

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function accessToken(
  payload: Record<string, unknown> = {},
  header: Record<string, unknown> = { typ: "at+jwt", alg: "ES256" },
): string {
  return `${segment(header)}.${segment({ iss: "https://auth.x.ai", sub: USER_ID, ...payload })}.c2ln`;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (call: Call) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Responder>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    const call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const key = Object.keys(routes).find((route) => url.startsWith(route));
    if (!key) throw new TypeError(`unexpected fetch ${url}`);
    const responder = routes[key];
    if (!responder) throw new TypeError(`unexpected fetch ${url}`);
    return responder(call);
  };
  return { fetch: impl, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DISCOVERY = "https://auth.x.ai/.well-known/openid-configuration";
const USER = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";

const discoveryOk = (): Response =>
  json(200, {
    authorization_endpoint: "https://auth.x.ai/oauth2/auth",
    token_endpoint: "https://auth.x.ai/oauth2/token",
  });
const userOk = (): Response =>
  json(200, { userId: USER_ID, subscriptionTier: "SuperGrokPlus", hasGrokCodeAccess: true });
const tokensOk = (overrides: Record<string, unknown> = {}): Response =>
  json(200, {
    access_token: accessToken(),
    refresh_token: "rt-1",
    expires_in: 21_600,
    token_type: "Bearer",
    ...overrides,
  });

beforeEach(() => resetGrokDiscoveryCache());
afterEach(() => resetGrokDiscoveryCache());

describe("authorize URL", () => {
  it("emits grok-build's exact query", () => {
    const url = buildGrokAuthorizeUrl({
      authorizationEndpoint: "https://auth.x.ai/oauth2/auth",
      redirectUri: "http://127.0.0.1:54321/callback",
      codeChallenge: "challenge-abc",
      state: "state-1",
      nonce: "nonce-1",
    });
    expect(url).toBe(
      "https://auth.x.ai/oauth2/auth?response_type=code" +
        `&client_id=${GROK_OAUTH_CLIENT_ID}` +
        "&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback" +
        "&scope=openid%20profile%20email%20offline_access%20grok-cli%3Aaccess%20api%3Aaccess" +
        "%20conversations%3Aread%20conversations%3Awrite%20workspaces%3Aread%20workspaces%3Awrite" +
        "&code_challenge=challenge-abc&code_challenge_method=S256&state=state-1&nonce=nonce-1" +
        "&referrer=grok-build",
    );
    expect(new URL(url).searchParams.get("scope")).toBe(GROK_OAUTH_SCOPES.join(" "));
  });

  it("startGrokOAuth binds a loopback redirect, state, and an S256 challenge of the verifier", async () => {
    const { fetch } = fakeFetch({ [DISCOVERY]: discoveryOk });
    const started = await startGrokOAuth({ state: "s-xyz", redirectPort: 40_123, fetch });
    const url = new URL(started.authorizeUrl);
    expect(started.redirectUri).toBe("http://127.0.0.1:40123/callback");
    expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(started.redirectUri);
    expect(url.searchParams.get("state")).toBe("s-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(Buffer.from(started.verifier, "base64url")).toHaveLength(32);
    const { createHash } = await import("node:crypto");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(started.verifier).digest("base64url"),
    );
    expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("discovery", () => {
  it("uses the fallback endpoints when the well-known fetch fails, without caching them", async () => {
    let attempts = 0;
    const { fetch } = fakeFetch({
      [DISCOVERY]: () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
    });
    const endpoints = await getGrokOAuthEndpoints({ fetch });
    expect(endpoints).toEqual({
      authorizationEndpoint: GROK_FALLBACK_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: GROK_FALLBACK_TOKEN_ENDPOINT,
      source: "fallback",
    });
    await getGrokOAuthEndpoints({ fetch });
    expect(attempts).toBe(2);
  });

  it("falls back on HTTP errors and on endpoints outside x.ai", async () => {
    const http = fakeFetch({ [DISCOVERY]: () => json(503, {}) });
    expect((await getGrokOAuthEndpoints({ fetch: http.fetch })).source).toBe("fallback");
    const foreign = fakeFetch({
      [DISCOVERY]: () =>
        json(200, {
          authorization_endpoint: "https://auth.x.ai/oauth2/auth",
          token_endpoint: "https://evil.example/token",
        }),
    });
    expect((await getGrokOAuthEndpoints({ fetch: foreign.fetch })).source).toBe("fallback");
  });

  it("caches a discovered document for 24 h", async () => {
    let now = 1_000;
    const { fetch, calls } = fakeFetch({ [DISCOVERY]: discoveryOk });
    await getGrokOAuthEndpoints({ fetch, now: () => now });
    now += 24 * 60 * 60 * 1000 - 1;
    expect((await getGrokOAuthEndpoints({ fetch, now: () => now })).source).toBe("discovery");
    expect(calls).toHaveLength(1);
    now += 1;
    await getGrokOAuthEndpoints({ fetch, now: () => now });
    expect(calls).toHaveLength(2);
  });
});

describe("callback input", () => {
  it("accepts a full callback URL or a bare code", () => {
    expect(parseGrokCallbackInput(" http://127.0.0.1:5/callback?code=abc&state=s1 ")).toEqual({
      code: "abc",
      state: "s1",
    });
    expect(parseGrokCallbackInput("bare-code_123")).toEqual({ code: "bare-code_123", state: "" });
  });

  it("surfaces IdP errors and rejects empty input", () => {
    expect(() =>
      parseGrokCallbackInput("http://127.0.0.1:5/callback?error=access_denied&state=s"),
    ).toThrow(expect.objectContaining({ code: "authorization_failed", oauthError: "access_denied" }));
    expect(() => parseGrokCallbackInput("   ")).toThrow(GrokOAuthError);
  });
});

describe("completeGrokOAuth", () => {
  const base = {
    verifier: "verifier-1",
    redirectUri: "http://127.0.0.1:40123/callback",
    state: "s1",
  };

  it("exchanges a pasted callback URL and resolves the account through /user", async () => {
    const { fetch, calls } = fakeFetch({
      [DISCOVERY]: discoveryOk,
      "https://auth.x.ai/oauth2/token": () => tokensOk({ scope: "openid grok-cli:access" }),
      [USER]: userOk,
    });
    const credentials = await completeGrokOAuth({
      ...base,
      codeOrUrl: "http://127.0.0.1:40123/callback?code=the-code&state=s1",
      fetch,
      now: () => Date.parse("2026-10-16T00:00:00Z"),
    });

    const exchange = calls.find((call) => call.url === "https://auth.x.ai/oauth2/token");
    expect(exchange?.method).toBe("POST");
    expect(exchange?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(exchange?.headers["x-grok-client-version"]).toBe(GROK_BUILD_VERSION);
    expect(exchange?.headers["user-agent"]).toMatch(/^grok-shell\/1\.0\.60 \(/);
    expect(Object.fromEntries(new URLSearchParams(exchange?.body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: base.redirectUri,
      client_id: GROK_OAUTH_CLIENT_ID,
      code_verifier: "verifier-1",
    });
    const user = calls.find((call) => call.url === USER);
    expect(user?.headers["x-userid"]).toBe(USER_ID);
    expect(user?.headers["x-xai-token-auth"]).toBe("xai-grok-cli");

    expect(credentials).toMatchObject({
      authMode: "oauth",
      refreshToken: "rt-1",
      expiresAt: "2026-10-16T06:00:00.000Z",
      issuer: "https://auth.x.ai",
      clientId: GROK_OAUTH_CLIENT_ID,
      scopes: ["openid", "grok-cli:access"],
      userId: USER_ID,
      subscriptionTier: "SuperGrokPlus",
    });
    expect(credentials.sessionId).not.toBe(credentials.agentId);
  });

  it("accepts a bare code and defaults scopes to the requested set", async () => {
    const { fetch, calls } = fakeFetch({
      [DISCOVERY]: discoveryOk,
      "https://auth.x.ai/oauth2/token": () => tokensOk(),
      [USER]: userOk,
    });
    const credentials = await completeGrokOAuth({ ...base, codeOrUrl: "bare-code", fetch });
    expect(new URLSearchParams(calls[1]?.body).get("code")).toBe("bare-code");
    expect(credentials.scopes).toEqual([...GROK_OAUTH_SCOPES]);
  });

  it("rejects a state mismatch before any token request", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(
      completeGrokOAuth({
        ...base,
        codeOrUrl: "http://127.0.0.1:40123/callback?code=c&state=other",
        fetch,
      }),
    ).rejects.toMatchObject({ code: "state_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("fails registration when the user id cannot be resolved", async () => {
    const noSub = fakeFetch({
      [DISCOVERY]: discoveryOk,
      "https://auth.x.ai/oauth2/token": () =>
        tokensOk({ access_token: accessToken({ sub: undefined }) }),
    });
    await expect(
      completeGrokOAuth({ ...base, codeOrUrl: "c", fetch: noSub.fetch }),
    ).rejects.toMatchObject({ code: "user_id_unresolved" });
    expect(noSub.calls.some((call) => call.url === USER)).toBe(false);

    const badUser = fakeFetch({
      [DISCOVERY]: discoveryOk,
      "https://auth.x.ai/oauth2/token": () => tokensOk(),
      [USER]: () => json(200, { subscriptionTier: "Super" }),
    });
    await expect(
      completeGrokOAuth({ ...base, codeOrUrl: "c", fetch: badUser.fetch }),
    ).rejects.toMatchObject({ code: "user_id_unresolved" });

    const deniedUser = fakeFetch({
      [DISCOVERY]: discoveryOk,
      "https://auth.x.ai/oauth2/token": () => tokensOk(),
      [USER]: () => json(401, {}),
    });
    await expect(
      completeGrokOAuth({ ...base, codeOrUrl: "c", fetch: deniedUser.fetch }),
    ).rejects.toMatchObject({ code: "user_lookup_failed", status: 401 });
  });

  it("rejects tokens that are not an auth.x.ai at+jwt", async () => {
    for (const token of [
      "xai-api-key-123",
      accessToken({}, { typ: "JWT", alg: "ES256" }),
      accessToken({ iss: "https://evil.example" }),
    ]) {
      const { fetch, calls } = fakeFetch({
        [DISCOVERY]: discoveryOk,
        "https://auth.x.ai/oauth2/token": () => tokensOk({ access_token: token }),
        [USER]: userOk,
      });
      await expect(completeGrokOAuth({ ...base, codeOrUrl: "c", fetch })).rejects.toMatchObject({
        code: "invalid_access_token",
      });
      expect(calls.some((call) => call.url === USER)).toBe(false);
    }
  });

  it("does not echo token endpoint bodies in errors", async () => {
    const { fetch } = fakeFetch({
      [DISCOVERY]: discoveryOk,
      "https://auth.x.ai/oauth2/token": () =>
        json(400, { error: "invalid_grant", error_description: "secret-echo" }),
    });
    const error = await completeGrokOAuth({ ...base, codeOrUrl: "c", fetch }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "token_exchange_failed", oauthError: "invalid_grant" });
    expect(error).toBeInstanceOf(GrokOAuthError);
    expect(String(error)).toContain("invalid_grant");
    expect(String(error)).not.toContain("secret-echo");
  });
});

describe("device code", () => {
  it("starts with the frozen scope and validates the response", async () => {
    const { fetch, calls } = fakeFetch({
      "https://auth.x.ai/oauth2/device/code": () =>
        json(200, {
          device_code: "dc",
          user_code: "ABCD-1234",
          verification_uri: "https://accounts.x.ai/device",
          verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-1234",
          expires_in: 900,
        }),
    });
    expect(await startGrokDeviceCode({ fetch })).toEqual({
      deviceCode: "dc",
      userCode: "ABCD-1234",
      verificationUri: "https://accounts.x.ai/device",
      verificationUriComplete: "https://accounts.x.ai/device?user_code=ABCD-1234",
      expiresIn: 900,
      interval: 5,
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      client_id: GROK_OAUTH_CLIENT_ID,
      scope: GROK_OAUTH_SCOPES.join(" "),
      referrer: "grok-build",
    });
    expect(calls[0]?.headers["x-grok-client-version"]).toBe(GROK_BUILD_VERSION);
  });

  it("rejects unsafe verification URIs", async () => {
    const { fetch } = fakeFetch({
      "https://auth.x.ai/oauth2/device/code": () =>
        json(200, {
          device_code: "dc",
          user_code: "ABCD",
          verification_uri: "javascript:alert(1)",
          expires_in: 900,
        }),
    });
    await expect(startGrokDeviceCode({ fetch })).rejects.toMatchObject({
      code: "invalid_device_code_response",
    });
  });

  it("polls once per call and honors authorization_pending and slow_down", async () => {
    const replies = [
      json(400, { error: "authorization_pending" }),
      json(400, { error: "slow_down" }),
      tokensOk(),
    ];
    const { fetch, calls } = fakeFetch({
      "https://auth.x.ai/oauth2/token": () => {
        const reply = replies.shift();
        if (!reply) throw new TypeError("no more replies");
        return reply;
      },
      [USER]: userOk,
    });
    expect(await pollGrokDeviceCode({ deviceCode: "dc", interval: 5, fetch })).toEqual({
      status: "pending",
      interval: 5,
    });
    expect(await pollGrokDeviceCode({ deviceCode: "dc", interval: 5, fetch })).toEqual({
      status: "pending",
      interval: 10,
    });
    const done = await pollGrokDeviceCode({ deviceCode: "dc", interval: 10, fetch });
    expect(done.status).toBe("complete");
    expect(done.status === "complete" ? done.credentials.userId : undefined).toBe(USER_ID);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dc",
      client_id: GROK_OAUTH_CLIENT_ID,
    });
  });

  it("treats expired_token and access_denied as terminal", async () => {
    for (const [error, code] of [
      ["expired_token", "expired_token"],
      ["access_denied", "access_denied"],
    ] as const) {
      const { fetch } = fakeFetch({ "https://auth.x.ai/oauth2/token": () => json(400, { error }) });
      await expect(pollGrokDeviceCode({ deviceCode: "dc", interval: 5, fetch })).rejects.toMatchObject(
        { code, retryable: false },
      );
    }
  });
});
