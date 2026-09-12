import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ find: vi.fn(), save: vi.fn(), dead: vi.fn(), control: vi.fn(), generate: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../application/token/token.model", () => ({ TokenModel: { findOne: mocks.find, updateCredentialsIfCurrent: mocks.save } }));
vi.mock("../../../application/qgrid/token-death", () => ({ deactivateAuthDeadToken: mocks.dead }));
vi.mock("./antigravity-http", async (original) => ({ ...await original<typeof import("./antigravity-http")>(), antigravityControl: mocks.control, generateAntigravityHttp: mocks.generate }));
vi.mock("./antigravity-oauth", () => ({ refreshAntigravityCredentials: mocks.refresh }));

import { AntigravityDispatcher } from "./antigravity-dispatcher";
import { AntigravityHttpError } from "./antigravity-http";

const row = (id: number, weight = 1) => ({ id, name: `antigravity/account-${id}`, credentials: { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3_600_000, accountId: `account-${id}`, accountEmail: `${id}@example.test`, projectId: `project-${id}` }, weight, quotaThreshold: 80 });
const req = { model: "gemini-3.1-flash-lite", coldInput: [{ type: "text" as const, text: "hi", text_elements: [] }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.control.mockImplementation(async () => ({ models: { "gemini-3.1-flash-lite": { quotaInfo: { remainingFraction: 1 } } } }));
  mocks.generate.mockResolvedValue({ text: "ok", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0 }, durationMs: 1 });
  mocks.save.mockResolvedValue(true);
});

describe("Antigravity account pool", () => {
  it.each(["fetchAvailableModels", "retrieveUserQuotaSummary"] as const)(
    "%s refreshes once on 401 and caches under the new credential",
    async (method) => {
      const dispatcher = new AntigravityDispatcher();
      const account = row(1);
      dispatcher.replaceTokens([account]);
      mocks.find.mockResolvedValueOnce({ ...account, active: true, reauth_required: false });
      mocks.refresh.mockResolvedValueOnce({ ...account.credentials, accessToken: "refreshed" });
      mocks.control.mockRejectedValueOnce(new AntigravityHttpError(401, "UNAUTHENTICATED"))
        .mockResolvedValueOnce(method === "fetchAvailableModels"
          ? { models: { "gemini-3.1-flash-lite": { quotaInfo: { remainingFraction: 1 } } } }
          : { groups: [{ buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1 }] }] });
      const read = () => method === "fetchAvailableModels" ? dispatcher.generate(req) : dispatcher.usageForToken(1);
      await read();
      await read();
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.control).toHaveBeenCalledTimes(2);
      expect(mocks.control.mock.calls[1]?.slice(0, 3)).toEqual([method, "refreshed", { project: "project-1" }]);
    },
  );
  it("keeps a valid account when NOTIFY replaces its object during catalog lookup", async () => {
    const dispatcher = new AntigravityDispatcher();
    const account = row(1);
    dispatcher.replaceTokens([account]);
    mocks.control.mockImplementationOnce(async () => {
      dispatcher.onTokenUpdated({ ...account, weight: 2 });
      return { models: { "gemini-3.1-flash-lite": { quotaInfo: { remainingFraction: 1 } } } };
    });
    await expect(dispatcher.generate(req)).resolves.toMatchObject({ tokenName: account.name });
  });
  it("routes different accounts by weight, using distinct credentials", async () => {
    const dispatcher = new AntigravityDispatcher();
    dispatcher.replaceTokens([row(1, 2), row(2)]);
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await dispatcher.generate(req)).tokenName);
    expect(results.filter((name) => name.endsWith("1"))).toHaveLength(4);
    expect(results.filter((name) => name.endsWith("2"))).toHaveLength(2);
    expect(new Set(mocks.generate.mock.calls.map((call) => call[1].projectId))).toEqual(new Set(["project-1", "project-2"]));
    expect(mocks.control).toHaveBeenCalledTimes(2);
  });

  it("does not fallback from an exact account when its quota is exceeded", async () => {
    const dispatcher = new AntigravityDispatcher();
    dispatcher.replaceTokens([row(1), row(2)]);
    mocks.control.mockResolvedValue({ models: { "gemini-3.1-flash-lite": { quotaInfo: { remainingFraction: 0.1 } } } });
    await expect(dispatcher.generate({ ...req, preferredTokenId: 1 })).rejects.toThrow("quota threshold");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.control).toHaveBeenCalledTimes(1);
  });

  it("removes inactive accounts and keeps account names independent", async () => {
    const dispatcher = new AntigravityDispatcher();
    dispatcher.replaceTokens([row(1), row(2)]);
    dispatcher.onTokenDeactivated(1);
    expect(dispatcher.tokenNames).toEqual(["antigravity/account-2"]);
    await expect(dispatcher.generate({ ...req, preferredTokenId: 1 })).rejects.toThrow("No active");
  });

  it("marks only the account with invalid_grant as requiring login", async () => {
    const dispatcher = new AntigravityDispatcher();
    const expired = row(1);
    expired.credentials.expiresAt = 1;
    dispatcher.replaceTokens([expired, row(2)]);
    mocks.find.mockResolvedValue({ ...expired, active: true, reauth_required: false });
    mocks.refresh.mockRejectedValue(new AntigravityHttpError(400, "invalid_grant"));
    const result = await dispatcher.generate(req);
    expect(result.tokenName).toBe("antigravity/account-2");
    expect(mocks.dead).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), "antigravity:invalid_grant");
    expect(dispatcher.tokenNames).toEqual(["antigravity/account-2"]);
  });

  it("does not recreate credentials after a concurrent deletion/relogin", async () => {
    const dispatcher = new AntigravityDispatcher();
    const expired = row(1);
    expired.credentials.expiresAt = 1;
    dispatcher.replaceTokens([expired]);
    mocks.find.mockResolvedValue({ ...expired, active: true, reauth_required: false });
    mocks.refresh.mockResolvedValue({ ...expired.credentials, accessToken: "new" });
    mocks.save.mockResolvedValue(false);
    await expect(dispatcher.generate(req)).rejects.toThrow("changed during refresh");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
