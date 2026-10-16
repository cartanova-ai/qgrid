import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GROK_OAUTH_CLIENT_ID } from "./grok-constants";
import { resetGrokDiscoveryCache } from "./grok-oauth";
import {
  GROK_REFRESH_MARGIN_MS,
  GrokReauthRequiredError,
  GrokRefreshCoordinator,
  GrokRefreshTransientError,
  grokNeedsRefresh,
  grokRefreshJitterMs,
} from "./grok-refresh";
import type { GrokCredentials } from "./grok-types";

const USER_ID = "11111111-2222-3333-4444-555555555555";

function accessToken(tag: string): string {
  const header = Buffer.from(JSON.stringify({ typ: "at+jwt", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: "https://auth.x.ai", sub: USER_ID, jti: tag }),
  ).toString("base64url");
  return `${header}.${payload}.c2ln`;
}

function credentials(overrides: Partial<GrokCredentials> = {}): GrokCredentials {
  return {
    authMode: "oauth",
    accessToken: accessToken("old"),
    refreshToken: "rt-old",
    expiresAt: "2026-10-16T06:00:00.000Z",
    issuer: "https://auth.x.ai",
    clientId: GROK_OAUTH_CLIENT_ID,
    scopes: ["openid"],
    userId: USER_ID,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const NOW = Date.parse("2026-10-16T05:00:00Z");

function tokenFetch(reply: () => Response | Promise<Response>): {
  fetch: typeof fetch;
  bodies: URLSearchParams[];
} {
  const bodies: URLSearchParams[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/.well-known/openid-configuration"))
      return json(200, {
        authorization_endpoint: "https://auth.x.ai/oauth2/auth",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      });
    if (url !== "https://auth.x.ai/oauth2/token") throw new TypeError(`unexpected ${url}`);
    bodies.push(new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : ""));
    return reply();
  };
  return { fetch: impl, bodies };
}

beforeEach(() => resetGrokDiscoveryCache());
afterEach(() => resetGrokDiscoveryCache());

describe("refresh timing", () => {
  it("is stable per account and bounded to 0..60 s", () => {
    const jitter = grokRefreshJitterMs(USER_ID);
    expect(grokRefreshJitterMs(USER_ID)).toBe(jitter);
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(60_000);
  });

  it("flips exactly at expiresAt - 300 s - jitter", () => {
    const creds = credentials();
    const boundary =
      Date.parse(creds.expiresAt) - GROK_REFRESH_MARGIN_MS - grokRefreshJitterMs(USER_ID);
    expect(grokNeedsRefresh(creds, boundary - 1)).toBe(false);
    expect(grokNeedsRefresh(creds, boundary)).toBe(true);
    expect(new GrokRefreshCoordinator().needsRefresh(creds, boundary + 1)).toBe(true);
  });
});

describe("GrokRefreshCoordinator.refresh", () => {
  it("keeps the old refresh token when not rotated and persists before resolving", async () => {
    const { fetch, bodies } = tokenFetch(() =>
      json(200, { access_token: accessToken("new"), expires_in: 21_600 }),
    );
    const persisted: GrokCredentials[] = [];
    const coordinator = new GrokRefreshCoordinator({ fetch, now: () => NOW });
    const next = await coordinator.refresh(7, credentials(), async (value) => {
      persisted.push(value);
    });

    expect(Object.fromEntries(bodies[0] ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-old",
      client_id: GROK_OAUTH_CLIENT_ID,
    });
    expect(next.refreshToken).toBe("rt-old");
    expect(next.accessToken).toBe(accessToken("new"));
    expect(next.expiresAt).toBe(new Date(NOW + 21_600_000).toISOString());
    expect(next.sessionId).toBe(credentials().sessionId);
    expect(persisted).toEqual([next]);
  });

  it("stores a rotated refresh token", async () => {
    const { fetch } = tokenFetch(() =>
      json(200, { access_token: accessToken("new"), refresh_token: "rt-new", expires_in: 60 }),
    );
    const next = await new GrokRefreshCoordinator({ fetch, now: () => NOW }).refresh(
      7,
      credentials(),
      async () => undefined,
    );
    expect(next.refreshToken).toBe("rt-new");
  });

  it("classifies invalid_grant/invalid_client as terminal and 503/network as transient", async () => {
    for (const error of ["invalid_grant", "invalid_client"]) {
      const { fetch } = tokenFetch(() => json(400, { error }));
      await expect(
        new GrokRefreshCoordinator({ fetch }).refresh(1, credentials(), async () => undefined),
      ).rejects.toBeInstanceOf(GrokReauthRequiredError);
    }
    const unavailable = tokenFetch(() => json(503, { error: "invalid_grant" }));
    await expect(
      new GrokRefreshCoordinator({ fetch: unavailable.fetch }).refresh(
        1,
        credentials(),
        async () => undefined,
      ),
    ).rejects.toMatchObject({ name: "GrokRefreshTransientError", status: 503 });
    const offline = tokenFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      new GrokRefreshCoordinator({ fetch: offline.fetch }).refresh(
        1,
        credentials(),
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(GrokRefreshTransientError);
  });

  it("coalesces concurrent refreshes of one token into one HTTP call", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetch, bodies } = tokenFetch(async () => {
      await gate;
      return json(200, { access_token: accessToken("new"), expires_in: 60 });
    });
    let persists = 0;
    const persist = async (): Promise<void> => {
      persists += 1;
    };
    const coordinator = new GrokRefreshCoordinator({ fetch, now: () => NOW });
    const first = coordinator.refresh(9, credentials(), persist);
    const second = coordinator.refresh(9, credentials(), persist);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(bodies).toHaveLength(1);
    expect(persists).toBe(1);

    // After settling, a new call makes a new request.
    await coordinator.refresh(9, a, persist);
    expect(bodies).toHaveLength(2);
  });

  it("rejects when persistence fails", async () => {
    const { fetch } = tokenFetch(() => json(200, { access_token: accessToken("new"), expires_in: 60 }));
    await expect(
      new GrokRefreshCoordinator({ fetch }).refresh(1, credentials(), async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
  });

  it("rejects a non-at+jwt access token in the refresh response", async () => {
    const { fetch } = tokenFetch(() => json(200, { access_token: "xai-key", expires_in: 60 }));
    await expect(
      new GrokRefreshCoordinator({ fetch }).refresh(1, credentials(), async () => undefined),
    ).rejects.toBeInstanceOf(GrokRefreshTransientError);
  });
});

describe("GrokRefresher port", () => {
  it("ensureFresh skips fresh tokens and refreshes stale ones", async () => {
    const { fetch, bodies } = tokenFetch(() =>
      json(200, { access_token: accessToken("new"), expires_in: 21_600 }),
    );
    const stored: number[] = [];
    const coordinator = new GrokRefreshCoordinator({
      fetch,
      now: () => NOW,
      persist: async (tokenId) => {
        stored.push(tokenId);
      },
    });
    const fresh = credentials({ expiresAt: new Date(NOW + 3_600_000).toISOString() });
    expect(await coordinator.ensureFresh({ tokenId: 3, credentials: fresh })).toBe(fresh);
    expect(bodies).toHaveLength(0);

    const stale = credentials({ expiresAt: new Date(NOW + 60_000).toISOString() });
    const next = await coordinator.ensureFresh({ tokenId: 3, credentials: stale });
    expect(next.accessToken).toBe(accessToken("new"));
    expect(stored).toEqual([3]);
  });

  it("refreshAfterUnauthorized reuses an already-replaced token and maps invalid_grant", async () => {
    let reply = (): Response => json(200, { access_token: accessToken("new"), expires_in: 21_600 });
    const { fetch, bodies } = tokenFetch(() => reply());
    const coordinator = new GrokRefreshCoordinator({
      fetch,
      now: () => NOW,
      persist: async () => undefined,
    });
    const first = await coordinator.refreshAfterUnauthorized({ tokenId: 4, credentials: credentials() });
    expect(first.status).toBe("refreshed");
    const second = await coordinator.refreshAfterUnauthorized({
      tokenId: 4,
      credentials: credentials(),
    });
    expect(second).toEqual(first);
    expect(bodies).toHaveLength(1);

    reply = () => json(400, { error: "invalid_grant" });
    const fresh = first.status === "refreshed" ? first.credentials : credentials();
    expect(
      await coordinator.refreshAfterUnauthorized({ tokenId: 4, credentials: fresh }),
    ).toEqual({ status: "reauth_required", reason: "invalid_grant" });
  });
});
