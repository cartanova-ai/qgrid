import { zstdDecompressSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { type GenerateRequest } from "../common/provider-dispatcher";
import golden from "./__fixtures__/golden-responses-1.0.60.json";
import { GROK_OAUTH_CLIENT_ID, GROK_OAUTH_SCOPES } from "./grok-constants";
import { GrokHttpError } from "./grok-direct-client";
import {
  GrokAttemptBudgetExceededError,
  GrokCapacityError,
  GrokDispatcher,
  GrokInvalidRequestError,
  GrokNoWorkersError,
  GrokOnDemandExcludedError,
  GrokRateLimitedError,
  GrokVersionGateError,
  GrokZdrVideoUnavailableError,
  grokTicksToUsd,
} from "./grok-dispatcher";
import { GrokMediaClient, GrokMediaDeliveryError } from "./grok-media-client";
import { GrokVoiceClient } from "./grok-voice-client";
import {
  type GrokCredentials,
  type GrokMediaAuth,
  type GrokMediaPort,
  type GrokRefresher,
  type GrokRefreshResult,
  type GrokVoicePort,
} from "./grok-types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function jwt(sub: string): string {
  return `${segment({ alg: "ES256", typ: "at+jwt" })}.${segment({
    iss: "https://auth.x.ai",
    sub,
    exp: 2_000_000_000,
  })}.c2ln`;
}

function guid(n: number, block: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${String(block).repeat(8)}-0000-4000-8000-${hex}`;
}

function credentialsFor(id: number, version = 0): GrokCredentials {
  return {
    authMode: "oauth",
    accessToken: jwt(`user-${id}-v${version}`),
    refreshToken: `refresh-${id}`,
    expiresAt: "2030-01-01T00:00:00Z",
    issuer: "https://auth.x.ai",
    clientId: GROK_OAUTH_CLIENT_ID,
    scopes: [...GROK_OAUTH_SCOPES],
    userId: guid(id, 1),
    sessionId: guid(id, 2),
    agentId: guid(id, 3),
  };
}

const sseHeaders = { ...golden.response.headers };

function sseEvent(value: { type: string } & Record<string, unknown>): string {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

/** A stream built from the fixture's event types, ending at response.completed (no [DONE]). */
function goldenStream(text = "pong"): string {
  const half = Math.ceil(text.length / 2);
  return [
    sseEvent({ type: "response.created", response: { id: "resp_1", model: "grok-4.7" } }),
    sseEvent({ type: "response.in_progress", response: { id: "resp_1" } }),
    sseEvent({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } }),
    sseEvent({ type: "response.reasoning_summary_part.added", item_id: "rs_1" }),
    sseEvent({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "hm" }),
    sseEvent({ type: "response.reasoning_summary_text.done", item_id: "rs_1" }),
    sseEvent({ type: "response.reasoning_summary_part.done", item_id: "rs_1" }),
    sseEvent({
      type: "response.output_item.done",
      item: { type: "reasoning", id: "rs_1", encrypted_content: "enc" },
    }),
    sseEvent({ type: "response.content_part.added", item_id: "msg_1" }),
    sseEvent({ type: "response.output_text.delta", item_id: "msg_1", delta: text.slice(0, half) }),
    sseEvent({ type: "response.output_text.delta", item_id: "msg_1", delta: text.slice(half) }),
    sseEvent({ type: "response.output_text.done", item_id: "msg_1" }),
    sseEvent({ type: "response.content_part.done", item_id: "msg_1" }),
    sseEvent({
      type: "response.completed",
      response: { id: "resp_1", model: "grok-4.7", usage: golden.response.terminalUsage },
    }),
  ].join("");
}

type ChatReply =
  | { kind: "ok"; body?: string; headers?: Record<string, string> }
  | { kind: "http"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "connect" };

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

interface Harness {
  dispatcher: GrokDispatcher;
  clock: { now: number };
  chat: Map<number, ChatReply[]>;
  settings: Map<number, unknown>;
  /** GET /user?include=subscription bodies; absent ids answer 404 (lookup_failed). */
  users: Map<number, unknown>;
  billing: Map<number, unknown>;
  requests: CapturedRequest[];
  /** "<path> <access token>" for every /settings, /user and /billing lookup, in call order. */
  events: string[];
  /** Access tokens the lookup endpoints answer with 401. */
  revoked: Set<string>;
  reauth: ReturnType<typeof vi.fn>;
  refresher: GrokRefresher & {
    ensureFresh: ReturnType<typeof vi.fn>;
    refreshAfterUnauthorized: ReturnType<typeof vi.fn>;
  };
  add(id: number, weight?: number, threshold?: number | null): void;
  chatCalls(): number[];
}

function tokenIdOf(headers: Headers, harness: () => Harness): number {
  const auth = headers.get("authorization") ?? "";
  for (const [id, token] of harness().dispatcher.tokens) {
    if (token.credentials && auth === `Bearer ${token.credentials.accessToken}`) return id;
  }
  for (const id of harness().dispatcher.tokens.keys()) {
    for (let v = 0; v < 5; v++) if (auth === `Bearer ${credentialsFor(id, v).accessToken}`) return id;
  }
  return -1;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function billingAt(percent: number, end = "2030-01-08T00:00:00Z") {
  return {
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2030-01-01T00:00:00Z", end },
      creditUsagePercent: percent,
      prepaidBalance: { val: 0 },
    },
  };
}

function createHarness(
  options: {
    maxInflightPerToken?: number;
    media?: GrokMediaPort;
    voice?: GrokVoicePort;
    sleep?: boolean;
  } = {},
): Harness {
  const clock = { now: Date.parse("2030-01-02T00:00:00Z") };
  const chat = new Map<number, ChatReply[]>();
  const settings = new Map<number, unknown>();
  const users = new Map<number, unknown>();
  const billing = new Map<number, unknown>();
  const requests: CapturedRequest[] = [];
  const events: string[] = [];
  const revoked = new Set<string>();
  let harness: Harness | undefined;
  const self = () => harness!;

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const id = tokenIdOf(headers, self);
    const lookup = ["/settings", "/user?", "/billing"].find((path) => url.includes(path));
    if (lookup) {
      const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
      events.push(`${lookup} ${bearer}`);
      if (revoked.has(bearer)) return json({ error: "unauthorized" }, 401);
    }
    if (url.endsWith("/settings")) return json(settings.get(id) ?? { on_demand_enabled: null });
    if (url.includes("/user?")) return users.has(id) ? json(users.get(id)) : json({}, 404);
    if (url.includes("/billing")) return json(billing.get(id) ?? billingAt(1));
    if (url.endsWith("/models")) return json({ error: "not found" }, 404);
    if (url.endsWith("/responses")) {
      const raw = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
      const body: unknown =
        headers.get("content-encoding") === "zstd"
          ? JSON.parse(zstdDecompressSync(raw).toString("utf8"))
          : JSON.parse(new TextDecoder().decode(raw));
      requests.push({ url, headers, body });
      const reply = chat.get(id)?.shift() ?? { kind: "ok" };
      if (reply.kind === "connect") throw new TypeError("fetch failed");
      if (reply.kind === "http") {
        return new Response(reply.body ?? "", {
          status: reply.status,
          headers: reply.headers ?? {},
        });
      }
      return new Response(reply.body ?? goldenStream(), {
        status: 200,
        headers: reply.headers ?? sseHeaders,
      });
    }
    return json({}, 404);
  };

  const refresher = {
    ensureFresh: vi.fn(async (token: { credentials: GrokCredentials }) => token.credentials),
    refreshAfterUnauthorized: vi.fn(
      async (token: { tokenId: number }): Promise<GrokRefreshResult> => ({
        status: "refreshed",
        credentials: credentialsFor(token.tokenId, 1),
      }),
    ),
  };
  const reauth = vi.fn(async () => true);

  const dispatcher = new GrokDispatcher({
    refresher,
    fetch: fakeFetch,
    now: () => clock.now,
    maxInflightPerToken: options.maxInflightPerToken,
    reportReauthRequired: reauth,
    ...(options.media ? { media: options.media } : {}),
    ...(options.voice ? { voice: options.voice } : {}),
    sleep: async (ms) => {
      clock.now += ms;
    },
  });

  harness = {
    dispatcher,
    clock,
    chat,
    settings,
    users,
    billing,
    requests,
    events,
    revoked,
    reauth,
    refresher,
    add(id, weight = 1, threshold = null) {
      dispatcher.onTokenAdded(id, `t${id}`, credentialsFor(id), threshold, weight);
    },
    chatCalls() {
      return requests.map((r) => tokenIdOf(r.headers, self));
    },
  };
  return harness;
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "grok-4.7",
    coldInput: [{ type: "text", text: "ping", text_elements: [] }],
    ...overrides,
  };
}

const exhausted = JSON.stringify({ code: "subscription:free-usage-exhausted", error: "exhausted" });

// ---------------------------------------------------------------------------
// Selection and token sink
// ---------------------------------------------------------------------------

describe("GrokDispatcher selection", () => {
  it("distributes 800 selections 5:2:1 through SmoothWeightedRoundRobin", async () => {
    const h = createHarness();
    h.add(1, 5);
    h.add(2, 2);
    h.add(3, 1);
    const counts = new Map<number, number>();
    for (let i = 0; i < 800; i++) {
      const reservation = await h.dispatcher.selectToken("chat");
      counts.set(reservation.token.id, (counts.get(reservation.token.id) ?? 0) + 1);
      reservation.release();
    }
    expect(counts.get(1)).toBe(500);
    expect(counts.get(2)).toBe(200);
    expect(counts.get(3)).toBe(100);
  });

  it("feeds the selector from onTokenAdded/Updated/Removed and replaceTokens", () => {
    const h = createHarness();
    h.add(1, 5);
    h.add(2, 2);
    expect([...h.dispatcher.selector.weights]).toEqual([
      [1, 5],
      [2, 2],
    ]);
    h.dispatcher.onTokenUpdated(2, "t2", credentialsFor(2), null, 7);
    expect(h.dispatcher.selector.weights.get(2)).toBe(7);
    h.dispatcher.onTokenRemoved(1);
    expect(h.dispatcher.selector.weights.has(1)).toBe(false);
    expect(h.dispatcher.tokens.has(1)).toBe(false);
    h.dispatcher.replaceTokens([
      { id: 3, name: "t3", credentials: credentialsFor(3), quotaThreshold: null, weight: 4 },
    ]);
    expect([...h.dispatcher.selector.weights]).toEqual([[3, 4]]);
    expect([...h.dispatcher.tokens.keys()]).toEqual([3]);
  });

  it("treats an invalid credentials row as inactive without throwing", async () => {
    const h = createHarness();
    expect(() =>
      h.dispatcher.onTokenAdded(9, "bad", { accessToken: "xai-api-key" }, null, 1),
    ).not.toThrow();
    const [state] = h.dispatcher.tokenStates();
    expect(state).toMatchObject({ id: 9, active: false });
    expect(state!.invalidReason).toContain("accessToken");
    expect(state!.invalidReason).not.toContain("xai-api-key");
    await expect(h.dispatcher.selectToken("chat")).rejects.toBeInstanceOf(GrokNoWorkersError);
    // A later valid update reactivates it.
    h.dispatcher.onTokenUpdated(9, "bad", credentialsFor(9), null, 1);
    const reservation = await h.dispatcher.selectToken("chat");
    expect(reservation.token.id).toBe(9);
  });

  it("never exceeds the in-flight cap under 50 concurrent selections", async () => {
    const h = createHarness({ maxInflightPerToken: 1 });
    h.add(1, 5);
    h.add(2, 2);
    h.add(3, 1);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => h.dispatcher.selectToken("chat")),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(3);
    expect(new Set(fulfilled.map((r) => r.value.token.id))).toEqual(new Set([1, 2, 3]));
    for (const r of rejected) expect(r.reason).toBeInstanceOf(GrokCapacityError);
    for (const token of h.dispatcher.tokens.values()) expect(token.inFlight).toBe(1);
    for (const r of fulfilled) r.value.release();
    for (const token of h.dispatcher.tokens.values()) expect(token.inFlight).toBe(0);
  });

  it("honors preferredTokenId and requirePreferredToken", async () => {
    const h = createHarness();
    h.add(1, 5, 50);
    h.add(2, 1);
    const preferred = await h.dispatcher.selectToken("chat", { preferredTokenId: 2 });
    expect(preferred.token.id).toBe(2);
    preferred.release();
    h.billing.set(1, billingAt(100));
    await expect(
      h.dispatcher.selectToken("chat", { preferredTokenId: 1, requirePreferredToken: true }),
    ).rejects.toBeInstanceOf(QuotaThresholdExceededError);
    const fallback = await h.dispatcher.selectToken("chat", { preferredTokenId: 1 });
    expect(fallback.token.id).toBe(2);
  });

  it("excludes on-demand accounts (D6) and allows on_demand_enabled null", async () => {
    const h = createHarness();
    h.add(1);
    h.settings.set(1, { on_demand_enabled: true });
    await expect(h.dispatcher.selectToken("chat")).rejects.toBeInstanceOf(
      GrokOnDemandExcludedError,
    );
    expect(h.dispatcher.tokenStates()[0]!.onDemandExcluded).toBe(true);

    const h2 = createHarness();
    h2.add(1);
    h2.settings.set(1, { on_demand_enabled: null });
    const reservation = await h2.dispatcher.selectToken("chat");
    expect(reservation.token.id).toBe(1);
  });

  it("fails open when billing and settings lookups fail", async () => {
    const h = createHarness();
    h.add(1, 1, 10);
    h.billing.set(1, { unexpected: true });
    h.settings.set(1, "not an object");
    const reservation = await h.dispatcher.selectToken("chat");
    expect(reservation.token.id).toBe(1);
  });

  it("refreshes an expired token before the gating lookups and gates on the refreshed values", async () => {
    const h = createHarness();
    h.add(1, 1, 50);
    const fresh = { ...credentialsFor(1, 1), expiresAt: "2031-01-01T00:00:00Z" };
    // The stored bearer is expired: a lookup with it would fail and open the gates.
    h.revoked.add(credentialsFor(1).accessToken);
    h.settings.set(1, { on_demand_enabled: true });
    h.refresher.ensureFresh.mockImplementation(async () => {
      h.events.push("refresh");
      return fresh;
    });
    await expect(h.dispatcher.generate(request())).rejects.toBeInstanceOf(
      GrokOnDemandExcludedError,
    );
    expect(h.refresher.ensureFresh).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toBe("refresh");
    expect(h.events.slice(1).sort()).toEqual(
      [
        `/billing ${fresh.accessToken}`,
        `/settings ${fresh.accessToken}`,
        `/user? ${fresh.accessToken}`,
      ].sort(),
    );
    expect(h.requests).toHaveLength(0);
  });

  it("persists reauth and skips the lookups when the pre-lookup refresh finds a dead token", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.refresher.ensureFresh.mockImplementationOnce(async () => {
      throw Object.assign(new Error("dead"), {
        name: "GrokReauthRequiredError",
        oauthError: "invalid_grant",
      });
    });
    const reservation = await h.dispatcher.selectToken("chat", { preferredTokenId: 1 });
    expect(reservation.token.id).toBe(2);
    expect(h.dispatcher.tokens.get(1)!.reauthRequired).toBe(true);
    expect(h.events.some((event) => event.endsWith(credentialsFor(1).accessToken))).toBe(false);
    expect(h.reauth).toHaveBeenCalledTimes(1);
    expect(h.reauth).toHaveBeenCalledWith(
      { id: 1, name: "t1", credentials: credentialsFor(1) },
      "grok:invalid_grant",
    );
  });

  it("re-reads the cached lookups after a refresh replaces the bearer", async () => {
    const h = createHarness();
    h.add(1);
    h.chat.set(1, [{ kind: "http", status: 401 }]);
    await h.dispatcher.generate(request());
    const token = h.dispatcher.tokens.get(1)!;
    expect(token.credentials?.accessToken).toBe(credentialsFor(1, 1).accessToken);
    // The same-token retry re-gates with the refreshed bearer before it is sent.
    expect(h.events).toContain(`/settings ${credentialsFor(1, 1).accessToken}`);
    expect(h.events).toContain(`/user? ${credentialsFor(1, 1).accessToken}`);
    h.events.length = 0;
    await h.dispatcher.prefetch(token);
    expect(h.events).toEqual([]);
  });

  it("refreshUsage reads billing for a token without a quota threshold", async () => {
    const h = createHarness();
    h.add(1);
    h.billing.set(1, billingAt(12));

    await h.dispatcher.refreshUsage(1);

    expect(h.dispatcher.tokenStates()[0]?.lastBilling).toMatchObject({ utilizationPct: 12 });
    expect(h.events.some((event) => event.startsWith("/billing"))).toBe(true);
  });

  it("ignores the configured threshold while weekly quota remains", async () => {
    const h = createHarness();
    h.add(1, 1, 75);
    h.billing.set(1, billingAt(92));
    const reservation = await h.dispatcher.selectToken("chat");
    expect(reservation.token.id).toBe(1);
    reservation.release();
    expect(h.dispatcher.getQuotaSnapshot()[0]).toMatchObject({ threshold: 100, blocked: false });
  });

  it.each([75, null])("blocks exhausted weekly quota with configured threshold %s", async (threshold) => {
    const h = createHarness();
    h.add(1, 1, threshold);
    h.billing.set(1, billingAt(100));
    await expect(h.dispatcher.selectToken("chat")).rejects.toBeInstanceOf(
      QuotaThresholdExceededError,
    );
    expect(h.dispatcher.getQuotaSnapshot()[0]).toMatchObject({ threshold: 100, blocked: true });
    h.clock.now += 61_000;
    h.billing.set(1, billingAt(92));
    const reservation = await h.dispatcher.selectToken("chat");
    expect(reservation.token.id).toBe(1);
    reservation.release();
  });
});

// ---------------------------------------------------------------------------
// Chat failure handling (§5.4)
// ---------------------------------------------------------------------------

describe("GrokDispatcher chat", () => {
  it("parses the fixture stream and maps usage and cost", async () => {
    const h = createHarness();
    h.add(7);
    const deltas: string[] = [];
    const result = await new Promise<Awaited<ReturnType<GrokDispatcher["generate"]>>>(
      (resolve, reject) => {
        h.dispatcher
          .generateStream(request({ promptCacheKey: "conv-key", systemPrompt: "be brief" }), {
            onDelta: (text) => deltas.push(text),
            onComplete: resolve,
            onError: reject,
          })
          .catch(reject);
      },
    );
    expect(deltas.join("")).toBe("pong");
    expect(result).toMatchObject({
      text: "pong",
      tokenName: "t7",
      model: "grok-4.7",
      costUsd: 0.046524,
      costSource: "provider",
      usage: {
        inputTokens: 27150,
        cachedInputTokens: 6528,
        outputTokens: 336,
        reasoningOutputTokens: 335,
        totalTokens: 27486,
        contextTokens: 27150 + 344,
      },
      providerMetadata: { xai: { costInUsdTicks: 465240000, contextWindow: 256000 } },
      threadCoord: { workerId: 7, threadId: "conv-key", epoch: -1 },
    });
    expect(grokTicksToUsd(465240000)).toBe(0.046524);

    const sent = h.requests[0]!;
    expect(sent.headers.get("content-encoding")).toBe("zstd");
    expect(sent.headers.get("x-grok-model-override")).toBe("grok-4.7");
    expect(sent.headers.get("x-grok-user-id")).toBe(credentialsFor(7).userId);
    expect(sent.headers.get("x-grok-session-id")).toBe(credentialsFor(7).sessionId);
    expect(sent.headers.get("x-grok-turn-idx")).toBe("1");
    const convId = sent.headers.get("x-grok-conv-id");
    expect(convId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sent.body).toMatchObject({
      model: "grok-4.7",
      prompt_cache_key: convId,
      store: false,
      stream: true,
      input: [
        { type: "message", role: "system", content: "be brief" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] },
      ],
    });

    // Same promptCacheKey -> same conv id, fresh request id.
    await h.dispatcher.generate(request({ promptCacheKey: "conv-key" }));
    expect(h.requests[1]!.headers.get("x-grok-conv-id")).toBe(convId);
    expect(h.requests[1]!.headers.get("x-grok-req-id")).not.toBe(
      sent.headers.get("x-grok-req-id"),
    );
  });

  it("rejects fields Grok does not support", async () => {
    const h = createHarness();
    h.add(1);
    await expect(
      h.dispatcher.generate(request({ imageGenerationOptions: { quality: "high" } })),
    ).rejects.toBeInstanceOf(GrokInvalidRequestError);
    await expect(h.dispatcher.generate(request({ serviceTier: "fast" }))).rejects.toBeInstanceOf(
      GrokInvalidRequestError,
    );
    for (const xai of [{ serviceTier: "priority" }, { parallelToolCalls: false }]) {
      await expect(
        h.dispatcher.generate(request({ providerOptions: { xai } })),
      ).rejects.toBeInstanceOf(GrokInvalidRequestError);
    }
    expect(h.requests).toHaveLength(0);
  });

  it("forwards an unlisted model id and reports the serving model", async () => {
    const h = createHarness();
    h.add(1);
    h.chat.set(1, [{ kind: "ok", body: goldenStream().replaceAll("grok-4.7", "grok-4.5-build") }]);
    const result = await h.dispatcher.generate(request({ model: "grok/grok-composer-2.5" }));
    expect(result.model).toBe("grok-4.5-build");
    expect(result.requestedModel).toBe("grok-composer-2.5");
    expect(result.providerMetadata).toEqual({
      xai: { costInUsdTicks: 465240000, contextWindow: 256000 },
    });
    const sent = h.requests[0]!;
    expect(sent.headers.get("x-grok-model-override")).toBe("grok-composer-2.5");
    expect(sent.body).toMatchObject({ model: "grok-composer-2.5", reasoning: { effort: "high" } });
  });

  it("puts a 429 token in cooldown, fails over, and readmits it after expiry", async () => {
    const h = createHarness();
    h.add(1, 5);
    h.add(2, 1);
    h.chat.set(1, [{ kind: "http", status: 429, headers: { "retry-after": "5" } }]);
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(h.chatCalls()).toEqual([1, 2]);
    expect(h.dispatcher.isEligible(h.dispatcher.tokens.get(1)!, "chat")).toBe(false);
    // Cooldown is scoped to the request class.
    expect(h.dispatcher.isEligible(h.dispatcher.tokens.get(1)!, "image")).toBe(true);
    h.clock.now += 5_001;
    expect(h.dispatcher.isEligible(h.dispatcher.tokens.get(1)!, "chat")).toBe(true);
  });

  it("caps Retry-After at 120 s and reports GrokRateLimitedError after one wait", async () => {
    const h = createHarness();
    h.add(1);
    h.chat.set(1, [{ kind: "http", status: 429, headers: { "retry-after": "600" } }]);
    const startedAt = h.clock.now;
    const error = await h.dispatcher.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokRateLimitedError);
    // 120 s cooldown, one 30 s in-place wait -> 90 s left.
    expect((error as GrokRateLimitedError).retryAfterSec).toBe(90);
    expect(h.clock.now - startedAt).toBe(30_000);
  });

  it("clears an exhaustion block after fresh billing falls below 100%", async () => {
    const h = createHarness();
    h.add(1, 5, 80);
    h.add(2, 1);
    h.chat.set(1, [{ kind: "http", status: 429, body: exhausted }]);
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    const token = h.dispatcher.tokens.get(1)!;
    expect(token.quotaBlocks.get("chat")).toBe(Date.parse("2030-01-08T00:00:00Z"));
    // Within one cache period no billing read is made, so the block holds.
    await h.dispatcher.prefetch(token);
    expect(h.dispatcher.isEligible(token, "chat")).toBe(false);
    h.clock.now += 61_000;
    h.billing.set(1, billingAt(92));
    await h.dispatcher.prefetch(token);
    expect(h.dispatcher.isEligible(token, "chat")).toBe(true);
  });

  it("refreshes once on 401 and retries the same token", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.chat.set(1, [{ kind: "http", status: 401 }]);
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t1");
    expect(h.refresher.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.requests[1]!.headers.get("authorization")).toBe(
      `Bearer ${credentialsFor(1, 1).accessToken}`,
    );
  });

  it("marks reauthRequired after a second 401", async () => {
    const h = createHarness();
    h.add(1);
    h.chat.set(1, [
      { kind: "http", status: 401 },
      { kind: "http", status: 401 },
    ]);
    const error = await h.dispatcher.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect((error as GrokHttpError).status).toBe(401);
    expect(h.refresher.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.dispatcher.tokenStates()[0]!.reauthRequired).toBe(true);
    expect(h.reauth).toHaveBeenCalledTimes(1);
    expect(h.reauth).toHaveBeenCalledWith(
      { id: 1, name: "t1", credentials: credentialsFor(1, 1) },
      "grok:unauthorized_after_refresh",
    );
  });

  it("marks reauthRequired when the refresher reports reauth_required", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.chat.set(1, [{ kind: "http", status: 401 }]);
    h.refresher.refreshAfterUnauthorized.mockResolvedValueOnce({
      status: "reauth_required",
      reason: "invalid_grant",
    });
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(h.dispatcher.tokens.get(1)!.reauthRequired).toBe(true);
    expect(h.reauth).toHaveBeenCalledTimes(1);
    expect(h.reauth).toHaveBeenCalledWith(
      { id: 1, name: "t1", credentials: credentialsFor(1) },
      "grok:invalid_grant",
    );
    // A dead token is not selected again, so nothing is persisted twice.
    await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(h.reauth).toHaveBeenCalledTimes(1);
  });

  it("fails over and marks reauth when ensureFresh reports a dead refresh token", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.refresher.ensureFresh.mockImplementationOnce(async () => {
      throw Object.assign(new Error("invalid_grant"), { name: "GrokReauthRequiredError" });
    });
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(h.dispatcher.tokens.get(1)!.reauthRequired).toBe(true);
    expect(h.chatCalls()).toEqual([2]);
  });

  it("fails over without marking reauth when the forced refresh throws", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.chat.set(1, [{ kind: "http", status: 401 }]);
    h.refresher.refreshAfterUnauthorized.mockRejectedValueOnce(new Error("network"));
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(h.dispatcher.tokens.get(1)!.reauthRequired).toBe(false);
    expect(h.reauth).not.toHaveBeenCalled();
  });

  it("treats a chat 403 as permanent for the request", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.chat.set(1, [{ kind: "http", status: 403, body: "forbidden" }]);
    const error = await h.dispatcher
      .generate(request({ preferredTokenId: 1 }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect((error as GrokHttpError).bodyText).toBe("forbidden");
    expect(h.chatCalls()).toEqual([1]);
    expect(h.refresher.refreshAfterUnauthorized).not.toHaveBeenCalled();
  });

  it("does not retry or fail over when x-should-retry is false", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.chat.set(1, [
      { kind: "http", status: 429, headers: { "x-should-retry": "false", "retry-after": "3" } },
    ]);
    await expect(
      h.dispatcher.generate(request({ preferredTokenId: 1 })),
    ).rejects.toBeInstanceOf(GrokHttpError);
    expect(h.chatCalls()).toEqual([1]);
  });

  it("trips the version gate on 426, naming both versions, and re-probes after 10 min", async () => {
    const generateImages = vi.fn(async () => ({ data: [{ b64_json: "aGk=" }] }));
    const media: GrokMediaPort = {
      generateImages,
      editImages: vi.fn(),
      startVideo: vi.fn(),
      getVideo: vi.fn(),
    };
    const h = createHarness({ media });
    h.add(1);
    h.add(2);
    h.chat.set(1, [
      {
        kind: "http",
        status: 426,
        body: JSON.stringify({
          error:
            "Your Grok CLI version (1.0.60) is outdated. Please update to version 1.0.13 or later.",
        }),
      },
    ]);
    const error = await h.dispatcher
      .generate(request({ preferredTokenId: 1 }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokVersionGateError);
    expect((error as Error).message).toContain("1.0.60");
    expect((error as Error).message).toContain("1.0.13");
    expect(h.chatCalls()).toEqual([1]);

    // Fail fast without a request while the gate is tripped.
    await expect(h.dispatcher.generate(request())).rejects.toBeInstanceOf(GrokVersionGateError);
    expect(h.requests).toHaveLength(1);
    // api.x.ai traffic is unaffected.
    await expect(h.dispatcher.generateImages({ model: "m", prompt: "p" })).resolves.toMatchObject({
      result: { data: [{ b64_json: "aGk=" }] },
    });

    h.clock.now += 600_000;
    const result = await h.dispatcher.generate(request());
    expect(result.text).toBe("pong");
    expect(h.dispatcher.versionGateState().tripped).toBe(false);
  });

  it("fails over on 5xx before the first event", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.chat.set(1, [{ kind: "http", status: 503 }]);
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(h.dispatcher.tokens.get(1)!.failoverCount).toBe(1);
  });

  it("never fails over after an event was forwarded", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    const truncated = goldenStream().split("event: response.output_text.done")[0]!;
    h.chat.set(1, [{ kind: "ok", body: truncated }]);
    const deltas: string[] = [];
    const errors: Error[] = [];
    await expect(
      h.dispatcher.generateStream(request({ preferredTokenId: 1 }), {
        onDelta: (text) => deltas.push(text),
        onComplete: () => undefined,
        onError: (e) => errors.push(e),
      }),
    ).rejects.toThrow(/terminal event/);
    expect(deltas.join("")).toBe("pong");
    expect(errors).toHaveLength(1);
    expect(h.chatCalls()).toEqual([1]);
  });

  it("does not fail over after response.created even when nothing was forwarded", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    const createdOnly = sseEvent({ type: "response.created", response: { id: "r" } });
    h.chat.set(1, [{ kind: "ok", body: createdOnly }]);
    await expect(h.dispatcher.generate(request({ preferredTokenId: 1 }))).rejects.toThrow();
    expect(h.chatCalls()).toEqual([1]);
  });

  it("stops after the attempt budget is exhausted", async () => {
    const h = createHarness();
    for (const id of [1, 2, 3, 4]) {
      h.add(id);
      h.chat.set(id, [{ kind: "http", status: 429, headers: { "retry-after": "60" } }]);
    }
    const error = await h.dispatcher.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokAttemptBudgetExceededError);
    expect(h.requests).toHaveLength(3);
  });

  it("fails over at most once on transient errors", async () => {
    const h = createHarness();
    for (const id of [1, 2, 3]) {
      h.add(id);
      h.chat.set(id, [{ kind: "connect" }]);
    }
    const error = await h.dispatcher.generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect((error as GrokHttpError).classification.kind).toBe("transient");
    expect(h.requests).toHaveLength(2);
  });

  it("releases reservations after success and failure", async () => {
    const h = createHarness({ maxInflightPerToken: 1 });
    h.add(1);
    await h.dispatcher.generate(request());
    h.chat.set(1, [{ kind: "http", status: 400, body: "bad" }]);
    await expect(h.dispatcher.generate(request())).rejects.toBeInstanceOf(GrokHttpError);
    expect(h.dispatcher.tokens.get(1)!.inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Media routing
// ---------------------------------------------------------------------------

describe("GrokDispatcher image generation tool", () => {
  it("adds the server-side image tool and returns completed images", async () => {
    const h = createHarness();
    h.add(1);
    const imageItem = {
      type: "image_generation_call",
      id: "ig_1",
      status: "completed",
      result: "/9j/4AAQSkZJRg",
      prompt: "a small red apple",
    };
    h.chat.set(1, [
      {
        kind: "ok",
        body: [
          sseEvent({ type: "response.created", response: { id: "resp_1", model: "grok-4.7" } }),
          sseEvent({ type: "response.output_item.done", item: imageItem }),
          sseEvent({ type: "response.output_text.delta", item_id: "msg_1", delta: "Here it is." }),
          sseEvent({
            type: "response.completed",
            response: { id: "resp_1", model: "grok-4.7", usage: golden.response.terminalUsage },
          }),
        ].join(""),
      },
    ]);

    const result = await h.dispatcher.generate(request({ imageGeneration: "auto" }));

    expect(h.requests[0]?.body).toMatchObject({ tools: [{ type: "image_generation" }] });
    expect(result.text).toBe("Here it is.");
    expect(result.images).toEqual([
      { data: "/9j/4AAQSkZJRg", mediaType: "image/jpeg", revisedPrompt: "a small red apple" },
    ]);
  });

  it("reports the token, serving model, and TTFT as progress", async () => {
    const h = createHarness();
    h.add(1);
    const progress = vi.fn();

    await h.dispatcher.generate(request({ onProgress: progress }));

    expect(progress.mock.calls.map(([update]) => update)).toEqual([
      { tokenName: "t1" },
      { model: "grok-4.7" },
      { ttftMs: expect.any(Number) },
    ]);
  });

  it("sends no image tool without imageGeneration", async () => {
    const h = createHarness();
    h.add(1);

    const result = await h.dispatcher.generate(request());

    expect(h.requests[0]?.body).not.toHaveProperty("tools");
    expect(result.images).toBeUndefined();
  });
});

describe("GrokDispatcher media", () => {
  it("blocks the request class on media 403 and fails over once", async () => {
    const seen: string[] = [];
    const media: GrokMediaPort = {
      generateImages: vi.fn(async (auth: GrokMediaAuth) => {
        seen.push(auth.bearer);
        if (auth.bearer === credentialsFor(1).accessToken) {
          throw new GrokHttpError({ kind: "entitlement", status: 403 }, "tier");
        }
        return { data: [{ b64_json: "aGk=" }] };
      }),
      editImages: vi.fn(),
      startVideo: vi.fn(),
      getVideo: vi.fn(),
    };
    const h = createHarness({ media });
    h.add(1);
    h.add(2);
    const result = await h.dispatcher.generateImages({
      model: "m",
      prompt: "p",
      preferredTokenId: 1,
    });
    expect(result.tokenId).toBe(2);
    expect(seen).toHaveLength(2);
    const token = h.dispatcher.tokens.get(1)!;
    expect(h.dispatcher.isEligible(token, "image")).toBe(false);
    expect(h.dispatcher.isEligible(token, "stt")).toBe(true);
    expect(h.dispatcher.isEligible(token, "chat")).toBe(true);
  });

  it("never replays a media POST after a transient failure", async () => {
    const startVideo = vi.fn(async () => {
      throw new GrokHttpError({ kind: "transient", status: 502 }, "");
    });
    const media: GrokMediaPort = {
      generateImages: vi.fn(),
      editImages: vi.fn(),
      startVideo,
      getVideo: vi.fn(),
    };
    const h = createHarness({ media });
    h.add(1);
    h.add(2);
    await expect(h.dispatcher.startVideo({ model: "v", prompt: "p" })).rejects.toBeInstanceOf(
      GrokHttpError,
    );
    expect(startVideo).toHaveBeenCalledTimes(1);
  });

  it("polls a video on the token that started it", async () => {
    const getVideo = vi.fn(async () => ({ status: "done", video: { url: "https://x/v.mp4" } }));
    const media: GrokMediaPort = {
      generateImages: vi.fn(),
      editImages: vi.fn(),
      startVideo: vi.fn(),
      getVideo,
    };
    const h = createHarness({ media });
    h.add(1, 100);
    h.add(2, 1);
    const status = await h.dispatcher.getVideo(2, "req-1");
    expect(status.tokenId).toBe(2);
    expect(getVideo).toHaveBeenCalledWith(
      { bearer: credentialsFor(2).accessToken, sessionId: credentialsFor(2).sessionId },
      "req-1",
      undefined,
    );
  });

  it("polls a started video past the quota, cooldown and capacity gates", async () => {
    const getVideo = vi.fn(async () => ({ status: "pending" }));
    const media: GrokMediaPort = {
      generateImages: vi.fn(),
      editImages: vi.fn(),
      startVideo: vi.fn(),
      getVideo,
    };
    const h = createHarness({ media, maxInflightPerToken: 1 });
    h.add(1, 1, 50);
    h.billing.set(1, billingAt(100));
    const token = h.dispatcher.tokens.get(1)!;
    token.cooldowns.set("video", h.clock.now + 120_000);
    token.inFlight = 1;

    await expect(h.dispatcher.startVideo({ model: "v", prompt: "p" })).rejects.toBeInstanceOf(
      Error,
    );
    await expect(h.dispatcher.getVideo(1, "req-1")).resolves.toMatchObject({ tokenId: 1 });
    expect(getVideo).toHaveBeenCalledTimes(1);
  });

  function imageFetch(failToken1: Error) {
    const calls: Array<{ authorization: string | null; sessionId: string | null }> = [];
    const impl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      calls.push({ authorization, sessionId: headers.get("x-grok-session-id") });
      if (authorization === `Bearer ${credentialsFor(1).accessToken}`) throw failToken1;
      return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { impl, calls };
  }

  function codedError(code: string): TypeError {
    return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  }

  it("fails an image over once after a provable pre-send connect failure", async () => {
    const { impl, calls } = imageFetch(codedError("ECONNREFUSED"));
    const h = createHarness({ media: new GrokMediaClient({ fetch: impl }) });
    h.add(1);
    h.add(2);
    const result = await h.dispatcher.generateImages({
      model: "m",
      prompt: "p",
      preferredTokenId: 1,
    });
    expect(result.tokenId).toBe(2);
    expect(calls).toEqual([
      {
        authorization: `Bearer ${credentialsFor(1).accessToken}`,
        sessionId: credentialsFor(1).sessionId,
      },
      {
        authorization: `Bearer ${credentialsFor(2).accessToken}`,
        sessionId: credentialsFor(2).sessionId,
      },
    ]);
  });

  it("allows only one pre-send failover", async () => {
    const calls: string[] = [];
    const media = new GrokMediaClient({
      fetch: async (_input, init) => {
        calls.push(new Headers(init?.headers).get("authorization") ?? "");
        throw codedError("ENOTFOUND");
      },
    });
    const h = createHarness({ media });
    h.add(1);
    h.add(2);
    h.add(3);
    const error = await h.dispatcher
      .generateImages({ model: "m", prompt: "p" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect((error as GrokHttpError).status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("never fails an image over after a possibly-sent failure", async () => {
    const { impl, calls } = imageFetch(codedError("ECONNRESET"));
    const h = createHarness({ media: new GrokMediaClient({ fetch: impl }) });
    h.add(1);
    h.add(2);
    await expect(
      h.dispatcher.generateImages({ model: "m", prompt: "p", preferredTokenId: 1 }),
    ).rejects.toBeInstanceOf(GrokMediaDeliveryError);
    expect(calls).toHaveLength(1);
  });

  it("fails STT over once after a provable pre-send connect failure", async () => {
    const calls: string[] = [];
    const voice = new GrokVoiceClient({
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        calls.push(authorization);
        if (authorization === `Bearer ${credentialsFor(1).accessToken}`)
          throw codedError("ECONNREFUSED");
        return new Response(JSON.stringify({ text: "hi" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const h = createHarness({ voice });
    h.add(1);
    h.add(2);
    const result = await h.dispatcher.transcribe({
      audio: new Uint8Array([1]),
      mediaType: "audio/wav",
      preferredTokenId: 1,
    });
    expect(result.tokenId).toBe(2);
    expect(calls).toEqual([
      `Bearer ${credentialsFor(1).accessToken}`,
      `Bearer ${credentialsFor(2).accessToken}`,
    ]);
  });

  it("never fails voice over on a status-0 error marked shouldRetry false", async () => {
    const transcribe = vi.fn(async () => {
      throw new GrokHttpError({ kind: "transient", status: 0, shouldRetry: false }, "");
    });
    const h = createHarness({ voice: { transcribe, speak: vi.fn() } });
    h.add(1);
    h.add(2);
    await expect(
      h.dispatcher.transcribe({ audio: new Uint8Array([1]), mediaType: "audio/wav" }),
    ).rejects.toBeInstanceOf(GrokHttpError);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Zero Data Retention and video (plan §11)
// ---------------------------------------------------------------------------

describe("GrokDispatcher zero data retention", () => {
  const zdrMessage =
    "Zero Data Retention teams must provide output.upload_url for video generation.";
  const zdrRejection = () =>
    new GrokHttpError(
      { kind: "invalid_request", status: 400, message: zdrMessage },
      JSON.stringify({ code: "invalid_request", error: zdrMessage }),
    );
  const user = (id: number, codingDataRetentionOptOut: boolean) => ({
    userId: guid(id, 1),
    subscriptionTier: "SuperGrok",
    codingDataRetentionOptOut,
  });
  const { "x-zero-data-retention": _zdr, "x-data-retention": _retention, ...plainHeaders } =
    sseHeaders;

  function videoMedia(startVideo: GrokMediaPort["startVideo"]): GrokMediaPort {
    return { generateImages: vi.fn(), editImages: vi.fn(), startVideo, getVideo: vi.fn() };
  }

  it("excludes a ZDR token from video only", async () => {
    const h = createHarness();
    h.add(1);
    h.users.set(1, user(1, true));
    await expect(h.dispatcher.selectToken("video")).rejects.toThrow(GrokZdrVideoUnavailableError);
    for (const requestClass of ["chat", "image", "stt", "tts"] as const) {
      const reservation = await h.dispatcher.selectToken(requestClass);
      expect(reservation.token.id).toBe(1);
      reservation.release();
    }
    expect(h.dispatcher.tokenStates()[0]!.zdrVideoExcluded).toBe(true);
    expect(h.dispatcher.getQuotaSnapshot()[0]!.zdrVideoExcluded).toBe(true);
  });

  it("routes video to a token whose ZDR state is unknown or off", async () => {
    const h = createHarness();
    h.add(1);
    const unknown = await h.dispatcher.selectToken("video");
    expect(unknown.token.id).toBe(1);
    expect(unknown.token.zdr).toBeNull();
    unknown.release();

    const h2 = createHarness();
    h2.add(1, 100);
    h2.add(2, 1);
    h2.users.set(1, user(1, true));
    h2.users.set(2, user(2, false));
    const off = await h2.dispatcher.selectToken("video");
    expect(off.token.id).toBe(2);
    expect(h2.dispatcher.tokenStates().map((s) => s.zdrVideoExcluded)).toEqual([true, false]);
  });

  it("names the ZDR tokens when no video token is eligible", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.users.set(1, user(1, true));
    h.users.set(2, user(2, true));
    const error = await h.dispatcher.selectToken("video").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokZdrVideoUnavailableError);
    expect((error as GrokZdrVideoUnavailableError).tokenNames).toEqual(["t1", "t2"]);
    expect((error as Error).message).toContain("t1, t2");
    expect((error as Error).message).toContain("data-retention opt-out");
    await expect(
      h.dispatcher.selectToken("video", { preferredTokenId: 1, requirePreferredToken: true }),
    ).rejects.toThrow(GrokZdrVideoUnavailableError);
  });

  it("reports on-demand before ZDR when both exclude tokens", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    h.settings.set(1, { on_demand_enabled: true });
    h.users.set(2, user(2, true));
    await expect(h.dispatcher.selectToken("video")).rejects.toBeInstanceOf(
      GrokOnDemandExcludedError,
    );
  });

  it("flips ZDR on the upstream 400 and fails over to another token exactly once", async () => {
    const startVideo = vi.fn(async (auth: GrokMediaAuth) => {
      if (auth.bearer === credentialsFor(1).accessToken) throw zdrRejection();
      return { request_id: "req-2" };
    });
    const h = createHarness({ media: videoMedia(startVideo) });
    h.add(1);
    h.add(2);
    const result = await h.dispatcher.startVideo({ model: "v", prompt: "p", preferredTokenId: 1 });
    expect(result.tokenId).toBe(2);
    expect(startVideo).toHaveBeenCalledTimes(2);
    const token = h.dispatcher.tokens.get(1)!;
    expect(token.zdr).toBe(true);
    expect(h.dispatcher.isEligible(token, "video")).toBe(false);
    expect(h.dispatcher.isEligible(token, "chat")).toBe(true);
    expect(h.dispatcher.isEligible(token, "image")).toBe(true);
  });

  it("surfaces GrokZdrVideoUnavailableError after every token refuses with the ZDR 400", async () => {
    const startVideo = vi.fn(async () => {
      throw zdrRejection();
    });
    const h = createHarness({ media: videoMedia(startVideo) });
    h.add(1);
    h.add(2);
    await expect(h.dispatcher.startVideo({ model: "v", prompt: "p" })).rejects.toThrow(
      GrokZdrVideoUnavailableError,
    );
    expect(startVideo).toHaveBeenCalledTimes(2);
  });

  it("does not treat other video 400s as ZDR", async () => {
    const startVideo = vi.fn(async () => {
      throw new GrokHttpError({ kind: "invalid_request", status: 400, message: "bad prompt" }, "");
    });
    const h = createHarness({ media: videoMedia(startVideo) });
    h.add(1);
    h.add(2);
    await expect(h.dispatcher.startVideo({ model: "v", prompt: "p" })).rejects.toBeInstanceOf(
      GrokHttpError,
    );
    expect(startVideo).toHaveBeenCalledTimes(1);
    for (const token of h.dispatcher.tokens.values()) expect(token.zdr).toBeNull();
  });

  it("learns ZDR from x-zero-data-retention on a chat response and never clears it from absence", async () => {
    const h = createHarness();
    h.add(1);
    h.chat.set(1, [{ kind: "ok", headers: plainHeaders }, { kind: "ok" }, { kind: "ok", headers: plainHeaders }]);
    await h.dispatcher.generate(request());
    expect(h.dispatcher.tokens.get(1)!.zdr).toBeNull();
    await h.dispatcher.generate(request());
    expect(h.dispatcher.tokens.get(1)!.zdr).toBe(true);
    await h.dispatcher.generate(request());
    expect(h.dispatcher.tokens.get(1)!.zdr).toBe(true);
    await expect(h.dispatcher.selectToken("video")).rejects.toThrow(GrokZdrVideoUnavailableError);
  });

  it("keeps the last ZDR value when the /user lookup fails and clears it on a false read", async () => {
    const h = createHarness();
    h.add(1);
    h.users.set(1, user(1, true));
    await expect(h.dispatcher.selectToken("video")).rejects.toThrow(GrokZdrVideoUnavailableError);

    h.users.delete(1);
    h.clock.now += 61_000;
    await expect(h.dispatcher.selectToken("video")).rejects.toThrow(GrokZdrVideoUnavailableError);
    expect(h.dispatcher.tokens.get(1)!.subscription?.value.kind).toBe("lookup_failed");

    h.users.set(1, user(1, false));
    h.clock.now += 61_000;
    const reservation = await h.dispatcher.selectToken("video");
    expect(reservation.token.id).toBe(1);
    expect(reservation.token.zdr).toBe(false);
  });

  it("resets ZDR when the token's credentials change", async () => {
    const h = createHarness();
    h.add(1);
    h.users.set(1, user(1, true));
    await expect(h.dispatcher.selectToken("video")).rejects.toThrow(GrokZdrVideoUnavailableError);
    h.users.delete(1);
    h.dispatcher.onTokenUpdated(1, "t1", credentialsFor(1, 2), null, 1);
    const reservation = await h.dispatcher.selectToken("video");
    expect(reservation.token.zdr).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Credential snapshots, re-gating, and reservations across refreshes
// ---------------------------------------------------------------------------

describe("GrokDispatcher refresh recovery", () => {
  const far = "2031-01-01T00:00:00Z";

  /** Records "send <bearer>" in h.events for every chat request, and runs `after` once it settles. */
  function traceSends(h: Harness, after?: (send: number) => void): void {
    const client = h.dispatcher.client;
    const original = client.stream.bind(client);
    let sends = 0;
    vi.spyOn(client, "stream").mockImplementation(async (args) => {
      const send = ++sends;
      h.events.push(`send ${args.headers.authorization ?? ""}`);
      try {
        return await original(args);
      } finally {
        after?.(send);
      }
    });
  }

  it("keeps a token whose pre-lookup refresh failed out of selection until its gates are read", async () => {
    const h = createHarness();
    h.add(1);
    const fresh = { ...credentialsFor(1, 1), expiresAt: far };
    h.revoked.add(credentialsFor(1).accessToken);
    h.settings.set(1, { on_demand_enabled: true });
    h.refresher.ensureFresh
      .mockImplementationOnce(async () => {
        throw new Error("network");
      })
      .mockImplementation(async (token) =>
        token.credentials.accessToken === credentialsFor(1).accessToken ? fresh : token.credentials,
      );
    traceSends(h);
    await expect(h.dispatcher.generate(request())).rejects.toBeInstanceOf(
      GrokOnDemandExcludedError,
    );
    expect(h.refresher.ensureFresh).toHaveBeenCalledTimes(2);
    expect(h.events).toContain(`/settings ${fresh.accessToken}`);
    expect(h.events.some((event) => event.startsWith("send"))).toBe(false);
    expect(h.dispatcher.tokens.get(1)!.inFlight).toBe(0);

    // With the gate open, the lookups still precede the send.
    const ok = createHarness();
    ok.add(1);
    ok.refresher.ensureFresh
      .mockImplementationOnce(async () => {
        throw new Error("network");
      })
      .mockImplementation(async (token) =>
        token.credentials.accessToken === credentialsFor(1).accessToken ? fresh : token.credentials,
      );
    traceSends(ok);
    await ok.dispatcher.generate(request());
    const settingsAt = ok.events.indexOf(`/settings ${fresh.accessToken}`);
    const sendAt = ok.events.indexOf(`send Bearer ${fresh.accessToken}`);
    expect(settingsAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThan(settingsAt);
  });

  it("re-gates a token whose bearer the attempt refreshed after selection", async () => {
    const h = createHarness();
    const a0 = { ...credentialsFor(1), expiresAt: far };
    const a1 = { ...credentialsFor(1, 1), expiresAt: far };
    h.dispatcher.onTokenAdded(1, "t1", a0, null, 1);
    h.add(2);
    h.refresher.ensureFresh.mockImplementation(async (token) => {
      if (token.credentials.accessToken !== a0.accessToken) return token.credentials;
      // The refresh lands between selection and send; the account turned on-demand meanwhile.
      h.settings.set(1, { on_demand_enabled: true });
      return a1;
    });
    traceSends(h);
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(h.chatCalls()).toEqual([2]);
    expect(h.events).toContain(`/settings ${a1.accessToken}`);
    expect(h.events).not.toContain(`send Bearer ${a1.accessToken}`);
    expect(h.dispatcher.tokens.get(1)!.inFlight).toBe(0);
  });

  it("ignores a 401 for a bearer a concurrent refresh already replaced and retries the new one", async () => {
    const h = createHarness();
    h.add(1);
    const token = h.dispatcher.tokens.get(1)!;
    const a2 = credentialsFor(1, 2);
    h.chat.set(1, [
      { kind: "http", status: 401 },
      { kind: "http", status: 401 },
    ]);
    // Request A presents A1 after its forced refresh; A2 is installed while that send is in flight.
    traceSends(h, (send) => {
      if (send === 2) h.dispatcher.storeCredentials(token, a2);
    });
    const result = await h.dispatcher.generate(request());
    expect(result.tokenName).toBe("t1");
    expect(token.reauthRequired).toBe(false);
    expect(h.reauth).not.toHaveBeenCalled();
    expect(h.refresher.refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.requests.map((r) => r.headers.get("authorization"))).toEqual([
      `Bearer ${credentialsFor(1).accessToken}`,
      `Bearer ${credentialsFor(1, 1).accessToken}`,
      `Bearer ${a2.accessToken}`,
    ]);
  });

  it("does not mark newer credentials dead when a stale refresh reports reauth", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    const token = h.dispatcher.tokens.get(1)!;
    const a2 = credentialsFor(1, 2);
    let calls = 0;
    h.refresher.ensureFresh.mockImplementation(async (ref) => {
      if (ref.credentials.accessToken !== credentialsFor(1).accessToken) return ref.credentials;
      if (++calls === 1) return ref.credentials;
      // The attempt's refresh of A0 dies after another path already installed A2.
      h.dispatcher.storeCredentials(token, a2);
      throw Object.assign(new Error("invalid_grant"), { name: "GrokReauthRequiredError" });
    });
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    expect(token.reauthRequired).toBe(false);
    expect(h.reauth).not.toHaveBeenCalled();
  });


  it("fails over to another token once the stale-401 retry allowance is spent", async () => {
    const h = createHarness();
    h.add(1);
    h.add(2);
    const token = h.dispatcher.tokens.get(1)!;
    // Every send on token 1 is answered 401, and a concurrent refresh keeps replacing its bearer
    // before the 401 lands, so each failure looks stale.
    h.chat.set(1, [
      { kind: "http", status: 401 },
      { kind: "http", status: 401 },
      { kind: "http", status: 401 },
      { kind: "http", status: 401 },
    ]);
    let generation = 0;
    traceSends(h, (send) => {
      if (send >= 2) h.dispatcher.storeCredentials(token, credentialsFor(1, ++generation + 1));
    });
    const result = await h.dispatcher.generate(request({ preferredTokenId: 1 }));
    expect(result.tokenName).toBe("t2");
    const sendsOnTokenOne = h.requests.filter((r) =>
      r.headers.get("x-grok-user-id") === credentialsFor(1).userId,
    ).length;
    // Initial send, forced-refresh retry, one stale retry; never a fourth on the same token.
    expect(sendsOnTokenOne).toBeLessThanOrEqual(3);
    expect(token.reauthRequired).toBe(false);
  });

  it("holds the reservation across the 401 refresh so the retry stays within the in-flight cap", async () => {
    const h = createHarness({ maxInflightPerToken: 1 });
    h.add(1);
    const token = h.dispatcher.tokens.get(1)!;
    h.chat.set(1, [{ kind: "http", status: 401 }]);
    let finishRefresh: (() => void) | undefined;
    h.refresher.refreshAfterUnauthorized.mockImplementationOnce(
      () =>
        new Promise<GrokRefreshResult>((resolve) => {
          finishRefresh = () => resolve({ status: "refreshed", credentials: credentialsFor(1, 1) });
        }),
    );
    const observed: number[] = [];
    traceSends(h, () => observed.push(token.inFlight));
    const a = h.dispatcher.generate(request());
    await vi.waitFor(() => expect(finishRefresh).toBeDefined());
    observed.push(token.inFlight);
    // B arrives while A refreshes: the cap is still held by A.
    await expect(h.dispatcher.selectToken("chat")).rejects.toBeInstanceOf(GrokCapacityError);
    observed.push(token.inFlight);
    finishRefresh!();
    const result = await a;
    expect(result.tokenName).toBe("t1");
    // 401 send, during the refresh, B's rejected selection, the retry send.
    expect(observed).toEqual([1, 1, 1, 1]);
    expect(token.inFlight).toBe(0);
  });
});
