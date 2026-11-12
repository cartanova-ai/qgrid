import { describe, expect, it, vi } from "vitest";

import { AgentCredentialStores, AgentTokenError, findAgentTokenError } from "./credential-store";

function jwt(expiresAtMs: number) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expiresAtMs / 1000) })}.sig`;
}

function fixture(expiresInMs = 60 * 60_000) {
  const metadata = {
    name: "fixture", active: true, generation: 1, weight: 1,
    credentials: {
      accessToken: jwt(Date.now() + expiresInMs), refreshToken: "refresh-1",
      accessTokenExpiresAt: Date.now() + expiresInMs, accountId: "account-1",
    },
  };
  const dispatcher = {
    tokenMetadata: new Map([[7, metadata]]),
    isQuotaEligible: vi.fn().mockResolvedValue(true),
    refreshCredentials: vi.fn(async () => {
      metadata.credentials = { ...metadata.credentials, accessToken: jwt(Date.now() + 3_600_000), refreshToken: "refresh-2" };

      return { accessToken: metadata.credentials.accessToken, accountId: "account-1" };
    }),
  };
  // SAFETY: the test only exercises the three dispatcher members the store reads.
  const stores = new AgentCredentialStores(dispatcher as never);

  return { metadata, dispatcher, stores, store: stores.get(7) };
}

describe("AgentCredentialStores", () => {
  it("returns the pool token as a Pi oauth credential with the JWT expiry", async () => {
    const { store, metadata } = fixture();
    const credential = await store.read("openai-codex");

    expect(credential).toMatchObject({ type: "oauth", access: metadata.credentials.accessToken, refresh: "refresh-1", accountId: "account-1" });
    expect(Math.abs((credential as { expires: number }).expires - metadata.credentials.accessTokenExpiresAt)).toBeLessThan(1_000);
    expect(await store.read("anthropic")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("refuses inactive and quota-exceeded tokens with mappable codes", async () => {
    const { store, metadata, dispatcher } = fixture();
    dispatcher.isQuotaEligible.mockResolvedValueOnce(false);
    await expect(store.read("openai-codex")).rejects.toMatchObject({ code: "quota_exceeded" });

    metadata.active = false;
    await expect(store.read("openai-codex")).rejects.toMatchObject({ code: "token_unavailable" });
    expect(await store.list()).toEqual([]);

    const wrapped = new Error("Credential store read failed", { cause: new Error("x", { cause: new AgentTokenError("quota_exceeded") }) });
    expect(findAgentTokenError(wrapped)?.code).toBe("quota_exceeded");
    expect(findAgentTokenError(new Error("plain"))).toBeUndefined();
  });

  it("refreshes through qgrid once for concurrent modify calls and skips when still valid", async () => {
    const { store, dispatcher, stores } = fixture(60_000);
    const mutation = vi.fn();

    const [first, second] = await Promise.all([
      store.modify("openai-codex", mutation),
      stores.get(7).modify("openai-codex", mutation),
    ]);

    expect(dispatcher.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
    expect(first).toMatchObject({ type: "oauth", refresh: "refresh-2" });
    expect(second).toEqual(first);

    // Now far from expiry: no refresh.
    await store.modify("openai-codex", mutation);
    expect(dispatcher.refreshCredentials).toHaveBeenCalledTimes(1);
    expect(await store.modify("google", mutation)).toBeUndefined();
  });

  it("maps a failed refresh to token_unavailable", async () => {
    const { store, dispatcher } = fixture(60_000);
    dispatcher.refreshCredentials.mockRejectedValueOnce(new Error("no longer active"));

    await expect(store.modify("openai-codex", vi.fn())).rejects.toMatchObject({ code: "token_unavailable" });
  });
});
