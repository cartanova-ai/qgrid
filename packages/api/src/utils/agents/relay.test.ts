import http, { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { zstdCompressSync } from "node:zlib";

import { createCredentialRequestTransformation } from "@ai-sdk/harness/utils";
import { getLogger } from "@logtape/logtape";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentsRelay, type AgentsRelayOptions, type RelayCallEnd, type RelaySession } from "./relay";

const placeholder = `aisdkhc_${"x".repeat(43)}`;
const usage = { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } };
const sse = `event: response.created\r\ndata: {"type":"response.created","response":{"id":"resp-1"}}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"한글"}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { model: "served-model", usage } })}\n\n`;

function fixture(overrides: Partial<AgentsRelayOptions> = {}) {
  const session: RelaySession = {
    sessionId: "session-1", tokenId: 1, model: "openai/gpt-6-astra", status: "running",
    activeTurn: { turnId: "turn-1", modelCallCount: 0, startedAt: Date.now() },
    containerIp: "172.30.0.2",
  };
  const metadata = {
    name: "fixture", active: true, generation: 1, weight: 1,
    credentials: { accessToken: "fixture-access-token", accountId: "fixture-account", refreshToken: "fixture-refresh-token", accessTokenExpiresAt: Date.now() + 60_000 },
  };
  const dispatcher = {
    tokenMetadata: new Map([[1, metadata]]),
    isQuotaEligible: vi.fn().mockResolvedValue(true),
    refreshCredentials: vi.fn().mockResolvedValue({ accessToken: "refreshed-fixture-token", accountId: "refreshed-account" }),
  };
  const records: RelayCallEnd[] = [];
  const sessions = {
    resolveSession: vi.fn((key: string) => key === "session-key" ? session : undefined),
    onCallStart: vi.fn(),
    onCallEnd: vi.fn((record: RelayCallEnd) => { records.push(record); }),
    onLimitExceeded: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  const createServer = vi.spyOn(http, "createServer");
  const relay = new AgentsRelay({
    sessions, dispatcher, fetch, isLinux: true,
    limits: { maxModelCalls: 60, maxTurnMs: 20 * 60_000 }, ...overrides,
  });
  const servers = createServer.mock.results.slice(-2).map((result) => result.value as http.Server);
  const server = servers[0]!;
  const rule = createCredentialRequestTransformation({
    matchUrl: "http://host.docker.internal:44901/backend-api/codex",
    matchHeaders: { Authorization: `Bearer ${placeholder}` },
    transformHeaders: { Authorization: "Bearer session-key" },
  });
  relay.addRules(session.sessionId, [rule]);

  function request({ body = Buffer.from('{"model":"gpt-6-astra"}'), headers = {}, path = "/backend-api/codex/responses", ip = "::ffff:172.30.0.2", end = true }: {
    body?: Buffer; headers?: http.IncomingHttpHeaders; path?: string; ip?: string; end?: boolean;
  } = {}) {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: ip });
    const req = new IncomingMessage(socket);
    req.url = path;
    req.method = "POST";
    req.headers = { host: "host.docker.internal:44901", authorization: `Bearer fake.payload.${placeholder}`, "content-type": "application/json", ...headers };
    const read = vi.spyOn(req, "read");
    const writes: Buffer[] = [];
    const output = new Duplex({ read() {}, write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); callback(); } });
    const res = new ServerResponse(req);
    res.useChunkedEncodingByDefault = false;
    res.assignSocket(output as Socket);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    res.once("finish", settle);
    res.once("close", settle);
    server.emit("request", req, res);
    req.push(body);
    if (end) {
      req.complete = true;
      req.push(null);
    }
    return { req, res, read, output, done, text: () => Buffer.concat(writes).toString("utf8") };
  }
  return { relay, servers, server, request, session, metadata, dispatcher, sessions, fetch, records, rule };
}

async function finished(request: ReturnType<ReturnType<typeof fixture>["request"]>) {
  await request.done;
  // onCallEnd runs immediately after HTTP completion in the handler's finally block.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return request;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("AgentsRelay header gates", () => {
  it.each([
    ["unknown key", 401, "unknown_session"],
    ["ip", 403, "ip_mismatch"],
    ["state", 403, "invalid_state"],
    ["turn", 403, "inactive_turn"],
    ["count", 429, "limit_exceeded"],
    ["time", 429, "limit_exceeded"],
    ["token", 503, "token_unavailable"],
    ["quota", 503, "quota_exceeded"],
  ])("rejects %s before reading a large body", async (gate, status, code) => {
    const f = fixture();
    const headers: http.IncomingHttpHeaders = { "content-length": String(10 * 1024 * 1024) };
    if (gate === "unknown key") headers.authorization = "Bearer unknown";
    if (gate === "state") f.session.status = "idle";
    if (gate === "turn") f.session.activeTurn = undefined;
    if (gate === "count") f.session.activeTurn!.modelCallCount = 60;
    if (gate === "time") f.session.activeTurn!.startedAt -= 20 * 60_000;
    if (gate === "token") f.metadata.active = false;
    if (gate === "quota") f.dispatcher.isQuotaEligible.mockResolvedValue(false);
    const r = await finished(f.request({ headers, ip: gate === "ip" ? "172.30.0.3" : "172.30.0.2", body: Buffer.alloc(10 * 1024 * 1024) }));
    expect(r.res.statusCode).toBe(status);
    expect(r.text()).toContain(code);
    expect(r.read).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.sessions.onCallStart).not.toHaveBeenCalled();
    if (gate === "count" || gate === "time") expect(f.sessions.onLimitExceeded).toHaveBeenCalledWith("session-1", gate === "time" ? "time" : "model_calls");
    if (gate !== "quota") expect(f.dispatcher.isQuotaEligible).not.toHaveBeenCalled();
  });

  it("applies gates in session → IP → state → turn → limits → token → quota order", async () => {
    const f = fixture();
    f.session.status = "idle";
    f.session.activeTurn = undefined;
    f.metadata.active = false;
    f.dispatcher.isQuotaEligible.mockResolvedValue(false);
    expect((await finished(f.request({ ip: "wrong", headers: { authorization: "Bearer unknown" } }))).res.statusCode).toBe(401);
    expect((await finished(f.request({ ip: "wrong" }))).text()).toContain("ip_mismatch");
    expect((await finished(f.request())).text()).toContain("invalid_state");
    f.session.status = "running";
    expect((await finished(f.request())).text()).toContain("inactive_turn");
    f.session.activeTurn = { turnId: "turn-1", modelCallCount: 60, startedAt: Date.now() };
    expect((await finished(f.request())).text()).toContain("limit_exceeded");
    f.session.activeTurn = { turnId: "turn-2", modelCallCount: 0, startedAt: Date.now() };
    expect((await finished(f.request())).text()).toContain("token_unavailable");
    f.metadata.active = true;
    expect((await finished(f.request())).text()).toContain("quota_exceeded");
  });

  it("normalizes a JWT placeholder, preserves Pi identity, and strips hop headers", async () => {
    const f = fixture({ isLinux: false });
    const r = await finished(f.request({ ip: "docker-desktop", headers: {
      originator: "pi", "user-agent": "pi/1.5.0", session_id: "pi-session", "x-client-app": "pi", "openai-beta": "responses=experimental", "x-codex-installation-id": "install", conversation_id: "conversation",
      "chatgpt-account-id": "untrusted", connection: "keep-alive, x-private", "x-private": "drop", te: "trailers",
    } }));
    expect(r.res.statusCode).toBe(200);
    const init = f.fetch.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-access-token");
    expect(headers.get("chatgpt-account-id")).toBe("fixture-account");
    for (const key of ["originator", "user-agent", "session_id", "x-client-app", "openai-beta", "x-codex-installation-id", "conversation_id"]) expect(headers.get(key)).toBe(r.req.headers[key]);
    for (const key of ["host", "connection", "x-private", "te", "content-length"]) expect(headers.has(key)).toBe(false);
    expect(f.sessions.resolveSession).toHaveBeenCalledWith("session-key");
    f.relay.removeRules("session-1");
    expect((await finished(f.request())).res.statusCode).toBe(401);
  });

  it("enforces rule host/path/method/query and session ownership", async () => {
    const f = fixture();
    expect((await finished(f.request({ headers: { host: "wrong-host" } }))).res.statusCode).toBe(401);
    f.relay.removeRules("session-1");
    f.relay.addRules("other-session", [f.rule]);
    expect((await finished(f.request())).res.statusCode).toBe(401);
    f.relay.removeRules("other-session");
    f.relay.addRules("session-1", [{ ...f.rule, match: { ...f.rule.match, method: ["POST"], queryString: [{ key: { exact: "mode" }, value: { exact: "sse" } }] } }]);
    expect((await finished(f.request())).res.statusCode).toBe(401);
    expect((await finished(f.request({ path: "/backend-api/codex/responses?mode=sse" }))).res.statusCode).toBe(200);
  });

  it("reserves concurrent calls while quota and body are pending", async () => {
    const f = fixture({ limits: { maxModelCalls: 1, maxTurnMs: 60_000 } });
    let release!: (value: boolean) => void;
    f.dispatcher.isQuotaEligible.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = f.request();
    await vi.waitFor(() => expect(f.dispatcher.isQuotaEligible).toHaveBeenCalledOnce());
    expect((await finished(f.request())).res.statusCode).toBe(429);
    release(true);
    await finished(first);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect((await finished(f.request())).res.statusCode).toBe(429);
  });
});

describe("AgentsRelay body and routing", () => {
  it.each([false, true])("rejects bodies above 8 MiB (content-length: %s)", async (declared) => {
    const f = fixture();
    const body = Buffer.alloc(8 * 1024 * 1024 + 1);
    const r = await finished(f.request({ body, headers: declared ? { "content-length": String(body.length) } : {} }));
    expect(r.res.statusCode).toBe(413);
    expect(f.fetch).not.toHaveBeenCalled();
    if (declared) expect(r.read).not.toHaveBeenCalled();
  });

  it("times out incomplete bodies at 30 seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const r = f.request({ end: false });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(r.res.writableEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await r.done;
    expect(r.res.statusCode).toBe(408);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("decodes zstd only for inspection and forwards the original bytes", async () => {
    const f = fixture();
    const body = zstdCompressSync(Buffer.from('{"model":"gpt-6-astra"}'));
    const r = await finished(f.request({ body, headers: { "content-encoding": "zstd" } }));
    expect(r.res.statusCode).toBe(200);
    expect(f.fetch.mock.calls[0]![1]!.body).toEqual(body);
    expect(new Headers(f.fetch.mock.calls[0]![1]!.headers).get("content-encoding")).toBe("zstd");
    expect(f.sessions.onCallStart.mock.calls[0]![0].reqBytes).toBe(body.length);
  });

  it("rejects zstd expansion above 32 MiB and mismatched/malformed models", async () => {
    const f = fixture();
    const bomb = zstdCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1, " "));
    expect((await finished(f.request({ body: bomb, headers: { "content-encoding": "zstd" } }))).res.statusCode).toBe(413);
    expect((await finished(f.request({ body: zstdCompressSync(Buffer.from('{"model":"other"}')), headers: { "content-encoding": "zstd" } }))).text()).toContain("model_mismatch");
    expect((await finished(f.request({ body: Buffer.from("{}")}))).res.statusCode).toBe(403);
    expect((await finished(f.request({ body: Buffer.from("invalid")}))).res.statusCode).toBe(400);
    expect((await finished(f.request({ headers: { "content-encoding": "zstd" } }))).res.statusCode).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("normalizes paths, rejects traversal, keeps query, and pins the upstream origin", async () => {
    const f = fixture();
    for (const path of ["/backend-api/codex/%2e%2e/secret", "/backend-api/codex/../secret", "/other", "/backend-api/codex"]) {
      const r = await finished(f.request({ path }));
      expect(r.res.statusCode).toBe(404);
      expect(r.read).not.toHaveBeenCalled();
    }
    await finished(f.request({ path: "https://attacker.invalid/backend-api/codex/responses?a=1" }));
    expect(String(f.fetch.mock.calls[0]![0])).toBe("https://chatgpt.com/backend-api/codex/responses?a=1");
    expect(f.fetch.mock.calls[0]![1]!.redirect).toBe("manual");
  });

  it("does not follow redirects and records 502", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://attacker.invalid" } }));
    const r = await finished(f.request());
    expect(r.res.statusCode).toBe(502);
    expect(f.records[0]).toMatchObject({ status: 502, error: "upstream_redirect", usage: null });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});

describe("AgentsRelay streaming and records", () => {
  it("forwards split UTF-8 SSE bytes unchanged and records zero usage with a UUID", async () => {
    const f = fixture();
    const bytes = Buffer.from(sse);
    f.fetch.mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } })));
    const r = await finished(f.request());
    expect(r.text().endsWith(sse)).toBe(true);
    expect(f.sessions.onCallStart).toHaveBeenCalledOnce();
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ responseId: "resp-1", model: "served-model", status: 200, usage, attempts: 1 });
    const start = f.sessions.onCallStart.mock.calls[0]![0];
    expect(start).toMatchObject({ sessionId: "session-1", turnId: "turn-1", model: "openai/gpt-6-astra", callId: f.records[0]!.callId });
    expect(start.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.records[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  it("records missing usage as null", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response('data: {"type":"response.completed","response":{}}\n\n'));
    await finished(f.request());
    expect(f.records[0]!.usage).toBeNull();
  });

  it.each([200, 401])("refreshes once before forwarding a 401, final status %i", async (status) => {
    const f = fixture();
    const cancel = vi.fn();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 401 }));
    f.fetch.mockResolvedValueOnce(new Response(status === 200 ? sse : "still unauthorized", { status }));
    await finished(f.request());
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.dispatcher.refreshCredentials).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(f.fetch.mock.calls[1]![1]!.headers).get("authorization")).toBe("Bearer refreshed-fixture-token");
    expect(f.sessions.onCallStart).toHaveBeenCalledOnce();
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ status, attempts: 2, usage: status === 200 ? usage : null });
    if (status === 200) expect(f.records[0]!.error).toBe("401 → refreshed");
  });

  it("records 4xx with null usage and redacts credentials from the error excerpt", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(`invalid fixture-access-token ${"x".repeat(400)}`, { status: 400 }));
    await finished(f.request());
    expect(f.records[0]).toMatchObject({ status: 400, usage: null, attempts: 1 });
    expect(f.records[0]!.error).toContain("[redacted]");
    expect(JSON.stringify(f.records)).not.toContain("fixture-access-token");
  });

  it("redacts tokens spanning the 300-character error excerpt boundary", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    f.fetch.mockResolvedValue(new Response(`${"x".repeat(290)}fixture-access-token`, { status: 400 }));
    await finished(f.request());
    expect(f.records[0]!.error).not.toContain("fixture");
    expect(f.records[0]!.error).toContain("[redacted]");
    expect(f.records[0]!.error).toContain("401 → refreshed");
  });

  it("records refresh failure without a second attempt or leaked exception text", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    f.dispatcher.refreshCredentials.mockRejectedValue(new Error("fixture-refresh-token"));
    const r = await finished(f.request());
    expect(r.res.statusCode).toBe(503);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.records[0]).toMatchObject({ status: 503, error: "token_unavailable", usage: null, attempts: 1 });
    expect(r.text()).not.toContain("fixture-refresh-token");
  });

  it("records fetch failures before any response bytes", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error("private transport details"));
    const r = await finished(f.request());
    expect(r.res.statusCode).toBe(502);
    expect(f.records[0]).toMatchObject({ status: 502, error: "upstream_disconnected", usage: null });
    expect(f.sessions.onCallStart).toHaveBeenCalledOnce();
  });

  it("aborts upstream and records a downstream disconnect", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => new Response(new ReadableStream()));
    const r = f.request();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    r.output.destroy();
    await finished(r);
    expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(f.records[0]).toMatchObject({ status: 499, error: "aborted", usage: null });
  });

  it.each(["eof", "error"])("records upstream disconnection (%s) without retry", async (mode) => {
    const f = fixture();
    let sent = false;
    f.fetch.mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"id":"partial"}}\n\n')); }
      else if (mode === "error") controller.error(new Error("secret upstream error"));
      else controller.close();
    } })));
    await finished(f.request());
    expect(f.records[0]).toMatchObject({ status: 502, error: "upstream_disconnected", usage: null });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.dispatcher.refreshCredentials).not.toHaveBeenCalled();
  });

  it("aborts every upstream of a turn, including a stalled stream", async () => {
    const f = fixture();
    const cancelled = vi.fn();
    f.fetch.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"id":"partial"}}\n\n')); }, cancel: cancelled })));
    const first = f.request();
    const second = f.request();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    f.relay.abortTurn("different-turn");
    expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    f.relay.abortTurn("turn-1");
    await Promise.all([finished(first), finished(second)]);
    expect(f.records).toHaveLength(2);
    for (const record of f.records) expect(record).toMatchObject({ status: 499, error: "aborted", usage: null });
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("aborts before body reading if the turn ends during quota lookup", async () => {
    const f = fixture();
    f.dispatcher.isQuotaEligible.mockImplementation(async () => { f.relay.abortTurn("turn-1"); return true; });
    const r = await finished(f.request());
    expect(r.read).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects a turn or token that changed while receiving the body", async () => {
    for (const change of ["turn", "token"]) {
      const f = fixture();
      const r = f.request({ end: false });
      await vi.waitFor(() => expect(r.read).toHaveBeenCalled());
      if (change === "turn") f.session.activeTurn = undefined;
      else f.metadata.active = false;
      r.req.complete = true;
      r.req.push(null);
      await finished(r);
      expect(r.res.statusCode).toBe(change === "turn" ? 403 : 503);
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });

  it("enforces the turn deadline while upstream stalls", async () => {
    vi.useFakeTimers();
    const f = fixture({ limits: { maxModelCalls: 60, maxTurnMs: 1000 } });
    f.fetch.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const r = f.request();
    await vi.advanceTimersByTimeAsync(1000);
    await r.done;
    expect(f.records[0]).toMatchObject({ status: 429, error: "limit_exceeded", usage: null });
  });

  it("rejects WebSocket upgrades and logs the transport mismatch", () => {
    const f = fixture();
    const warn = vi.spyOn(getLogger(["qgrid", "agents", "relay"]), "warn");
    const socket = { end: vi.fn() };
    f.server.emit("upgrade", {}, socket, Buffer.alloc(0));
    expect(socket.end.mock.calls[0]![0]).toContain("400 Bad Request");
    expect(warn).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("binds both default addresses and rolls back a failed listen", async () => {
    const f = fixture();
    const close = vi.spyOn(f.relay, "close").mockResolvedValue();
    const listens = f.servers.map((server, index) => vi.spyOn(server, "listen").mockImplementation(() => {
      queueMicrotask(() => server.emit(index === 0 ? "listening" : "error", new Error("bind failed")));
      return server;
    }));
    await expect(f.relay.listen()).rejects.toThrow("bind failed");
    expect(listens[0]).toHaveBeenCalledWith(44901, "127.0.0.1");
    expect(listens[1]).toHaveBeenCalledWith(44901, "172.30.0.1");
    expect(close).toHaveBeenCalledOnce();
  });

  it("supports custom bind addresses and port and closes its HTTP servers", async () => {
    const f = fixture({ bindAddresses: ["127.0.0.2"], port: 44902 });
    const listen = vi.spyOn(f.server, "listen").mockImplementation(() => {
      queueMicrotask(() => f.server.emit("listening"));
      return f.server;
    });
    const close = vi.spyOn(f.server, "close").mockImplementation((callback) => {
      callback?.();
      return f.server;
    });
    const connections = vi.spyOn(f.server, "closeAllConnections").mockImplementation(() => {});
    vi.spyOn(f.server, "listening", "get").mockReturnValue(true);
    await f.relay.listen();
    expect(listen).toHaveBeenCalledWith(44902, "127.0.0.2");
    expect(f.server.headersTimeout).toBe(30_000);
    expect(f.server.requestTimeout).toBe(30_000);
    await f.relay.close();
    expect(close).toHaveBeenCalledOnce();
    expect(connections).toHaveBeenCalledOnce();
  });
});
