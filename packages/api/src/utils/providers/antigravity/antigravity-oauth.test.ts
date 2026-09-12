import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAntigravityAuthUrl, exchangeAntigravityCode, refreshAntigravityCredentials } from "./antigravity-oauth";

afterEach(() => vi.unstubAllEnvs());
describe("Antigravity OAuth", () => {
  it("binds the caller state and requests offline access", () => {
    vi.stubEnv("QGRID_ANTIGRAVITY_CLIENT_SECRET", "test-client-secret");
    const url = new URL(buildAntigravityAuthUrl("state-1"));
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
    expect(url.href).not.toContain("test-client-secret");
  });

  it("discovers account identity and project after exchanging the code", async () => {
    vi.stubEnv("QGRID_ANTIGRAVITY_CLIENT_SECRET", "test-client-secret");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 60 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "account", email: "a@example.test" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cloudaicompanionProject: { id: "project" } })));
    const result = await exchangeAntigravityCode("test-code", { fetch: fetchMock });
    expect(result).toMatchObject({ accountId: "account", projectId: "project", refreshToken: "refresh" });
    expect(fetchMock.mock.calls[0]?.[1].body.get("grant_type")).toBe("authorization_code");
  });

  it("keeps the refresh token when Google does not rotate it", async () => {
    vi.stubEnv("QGRID_ANTIGRAVITY_CLIENT_SECRET", "test-client-secret");
    const old = { accessToken: "old", refreshToken: "refresh", expiresAt: 1, accountId: "account", accountEmail: "a@example.test", projectId: "project" };
    const result = await refreshAntigravityCredentials(old, { fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "new", expires_in: 60 }))) });
    expect(result.refreshToken).toBe("refresh");
    expect(result.accessToken).toBe("new");
  });
});
