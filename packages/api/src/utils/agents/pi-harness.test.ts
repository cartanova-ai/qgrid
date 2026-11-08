import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";

import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkSandboxSession,
} from "@ai-sdk/harness";
import { isSandboxCredentialPlaceholder } from "@ai-sdk/harness/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { createSandboxPi, derivePiSessionSecrets, reconstructContinueState } from "./pi-harness";

const settings = {
  secret: "test-only-secret",
  relayBaseUrl: "http://host.docker.internal:44901/backend-api/codex",
  model: "openai/gpt-6.1-sol",
  reasoningEffort: "high" as const,
  startupTimeoutMs: 1000,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test endpoint");
  let socket: WebSocket;
  const messages: Record<string, any>[] = [];
  const connections: string[] = [];
  let rejectNext = false;
  server.on("connection", (ws, request) => {
    if (rejectNext) {
      rejectNext = false;
      ws.close(1011, "test unavailable");
      return;
    }
    socket = ws;
    connections.push(request.url!);
    ws.send(JSON.stringify({ type: "bridge-hello", state: "waiting", lastSeq: 0 }));
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "stop") {
        ws.send(JSON.stringify({ type: "bridge-stop", data: { piSession: "persisted-pi" } }));
      }
    });
  });
  const process = {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"bridge-ready","port":8787}\n'));
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    kill: vi.fn().mockResolvedValue(undefined),
  };
  const sandbox = {
    id: "container-one",
    run: vi.fn().mockResolvedValue({ stdout: "/home/node\n", stderr: "", exitCode: 0 }),
    spawn: vi.fn().mockResolvedValue(process),
    writeTextFile: vi.fn().mockResolvedValue(undefined),
    readTextFile: vi.fn().mockResolvedValue(""),
    addRequestTransformations: vi.fn().mockResolvedValue(undefined),
    getPortEndpoint: vi.fn().mockResolvedValue({ url: `ws://127.0.0.1:${address.port}` }),
  };
  const harness = createSandboxPi(settings);
  const start = (state: { resumeFrom?: any; continueFrom?: any } = {}) =>
    harness.doStart({
      sessionId: "session-one",
      sessionWorkDir: "/workspace/a b",
      sandboxSession: sandbox as unknown as HarnessV1NetworkSandboxSession,
      permissionMode: "allow-all",
      ...state,
    });
  return {
    harness,
    sandbox,
    process,
    start,
    messages,
    connections,
    rejectNextConnection: () => {
      rejectNext = true;
    },
    send: (event: Record<string, any>) => socket.send(JSON.stringify(event)),
  };
}

describe("sandbox Pi harness", () => {
  it("derives isolated deterministic credentials with a valid placeholder", () => {
    const first = derivePiSessionSecrets(settings.secret, "one");
    expect(first.sessionKey).toBe(
      createHmac("sha256", settings.secret).update("one\0session-key").digest("base64url"),
    );
    expect(first).toEqual(derivePiSessionSecrets(settings.secret, "one"));
    expect(new Set(Object.values(first)).size).toBe(3);
    expect(isSandboxCredentialPlaceholder(first.placeholder)).toBe(true);
    for (const other of [
      derivePiSessionSecrets(settings.secret, "two"),
      derivePiSessionSecrets("other", "one"),
    ]) {
      expect(other.bridgeToken).not.toBe(first.bridgeToken);
      expect(other.sessionKey).not.toBe(first.sessionKey);
      expect(other.placeholder).not.toBe(first.placeholder);
    }
  });

  it("boots the preinstalled bridge and sends the qgrid model and turn configuration", async () => {
    const f = await fixture();
    expect(await f.harness.getBootstrap!()).toMatchObject({ files: [], commands: [] });
    expect(Object.keys(f.harness.builtinTools)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
    ]);
    const session = await f.start();
    const credentials = derivePiSessionSecrets(settings.secret, "session-one");
    expect(f.sandbox.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining(
          "node /opt/qgrid-pi-bridge/bridge.mjs --workdir '/workspace/a b'",
        ),
        env: expect.objectContaining({
          OPENAI_BASE_URL: settings.relayBaseUrl,
          CODEX_API_KEY: credentials.placeholder,
          BRIDGE_CHANNEL_TOKEN: credentials.bridgeToken,
          BRIDGE_WS_PORT: "8787",
        }),
      }),
    );
    expect(f.sandbox.addRequestTransformations).toHaveBeenCalledWith([
      expect.objectContaining({
        match: expect.objectContaining({
          headers: [
            {
              key: { exact: "Authorization" },
              value: { exact: `Bearer ${credentials.placeholder}` },
            },
          ],
        }),
        transform: { headers: { Authorization: `Bearer ${credentials.sessionKey}` } },
      }),
    ]);
    expect(
      new URL(f.connections[0]!, "http://localhost").searchParams.get("agent_bridge_token"),
    ).toBe(credentials.bridgeToken);
    const tools = [
      { name: "approve", description: "Approve", inputSchema: { type: "object" as const } },
    ];
    const turn = await session.doPromptTurn({
      prompt: "Do work",
      instructions: "Be careful",
      tools,
      skills: [],
      emit() {},
    });
    await vi.waitFor(() =>
      expect(f.messages[0]).toEqual({
        type: "start",
        model: settings.model,
        instructions: "Be careful",
        tools,
        reasoningEffort: "high",
        prompt: "Do work",
        sessionId: "session-one",
      }),
    );
    await session.doSuspendTurn();
    await turn.done;
  });

  it("rejects structured output before sending a start command", async () => {
    const f = await fixture();
    const session = await f.start();
    const options = { tools: [], skills: [], emit() {}, responseFormat: { type: "json" as const } };
    await expect(session.doPromptTurn({ ...options, prompt: "json" })).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
    await expect(session.doContinueTurn(options)).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
    expect(f.messages).toEqual([]);
    await session.doDestroy();
  });

  it("round-trips suspended and detached state, reconnects without spawning, and forwards tool results", async () => {
    const f = await fixture();
    const session = await f.start();
    const received: any[] = [];
    const turn = await session.doPromptTurn({
      prompt: "work",
      instructions: "rules",
      model: "openai/gpt-6-sol",
      tools: [],
      skills: [],
      emit: (part) => received.push(part),
    });
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    f.send({ type: "tool-call", toolCallId: "call-1", toolName: "approve", input: "{}", seq: 4 });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const suspended = JSON.parse(JSON.stringify(await session.doSuspendTurn()));
    await turn.done;
    expect(suspended).toEqual({
      type: "continue-turn",
      harnessId: "qgrid-pi",
      specificationVersion: "harness-v1",
      data: {
        bridge: { port: 8787, lastSeenEventId: 4 },
        piSession: "session-one",
        model: "openai/gpt-6-sol",
        instructionsHash: createHash("sha256").update("rules").digest("hex"),
      },
    });
    const resumed = await f.start({ continueFrom: suspended });
    expect(resumed.isResume).toBe(true);
    expect(f.sandbox.spawn).toHaveBeenCalledOnce();
    const continuation = await resumed.doContinueTurn({
      instructions: "rules",
      tools: [],
      skills: [],
      emit: (part) => received.push(part),
    });
    await continuation.submitToolResult({ toolCallId: "call-1", output: { approved: true } });
    await vi.waitFor(() =>
      expect(f.messages.slice(1)).toEqual([
        { type: "resume", lastSeenEventId: 4 },
        { type: "tool-result", toolCallId: "call-1", output: { approved: true } },
      ]),
    );
    f.send({ ...finish, seq: 5 });
    await continuation.done;
    const detached = await resumed.doDetach();
    const attached = await f.start({ resumeFrom: detached });
    expect(f.sandbox.spawn).toHaveBeenCalledOnce();
    const stopped = await attached.doStop();
    expect(stopped.data).toEqual({
      ...suspended.data,
      piSession: "persisted-pi",
      bridge: { port: 8787, lastSeenEventId: 5 },
    });
    const again = await f.start({ resumeFrom: stopped });
    const next = await again.doPromptTurn({ prompt: "next", tools: [], skills: [], emit() {} });
    await vi.waitFor(() =>
      expect(f.messages.at(-1)).toMatchObject({
        type: "start",
        resume: "persisted-pi",
        model: "openai/gpt-6-sol",
      }),
    );
    await again.doSuspendTurn();
    await next.done;
  });

  it("reconstructs a continuation without a saved envelope and replays from the persisted cursor", async () => {
    const f = await fixture();
    const continueFrom = reconstructContinueState({
      sessionId: "session-one",
      lastSeenEventId: 40,
      piSession: "pi-one",
    });
    expect(continueFrom).toEqual({
      type: "continue-turn",
      harnessId: "qgrid-pi",
      specificationVersion: "harness-v1",
      data: {
        bridge: { port: 8787, lastSeenEventId: 40 },
        piSession: "pi-one",
        model: null,
        instructionsHash: null,
      },
    });
    const session = await f.start({ continueFrom: JSON.parse(JSON.stringify(continueFrom)) });
    expect(f.sandbox.spawn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.messages).toEqual([{ type: "resume", lastSeenEventId: 40 }]));
    // Replay arrives before the caller has attached its turn listeners.
    f.send({ type: "text-start", id: "t", seq: 41 });
    f.send({ type: "text-delta", id: "t", delta: "replayed", seq: 42 });
    f.send({ ...finish, seq: 43 });
    const received: any[] = [];
    const turn = await session.doContinueTurn({
      tools: [],
      skills: [],
      emit: (part) => received.push(part),
    });
    await turn.done;
    expect(received.map((part) => part.providerMetadata.qgrid.seq)).toEqual([41, 42, 43]);
    expect((await session.doDetach()).data).toMatchObject({ bridge: { lastSeenEventId: 43 } });
  });

  it.each([true, false])(
    "respawns an unavailable bridge; completed disk log = %s",
    async (completed) => {
      const f = await fixture();
      f.rejectNextConnection();
      f.sandbox.readTextFile.mockResolvedValue(
        completed ? JSON.stringify({ ...finish, seq: 8 }) : '{"type":"tool-call","seq":7}',
      );
      const session = await f.start({
        continueFrom: reconstructContinueState({ sessionId: "session-one", lastSeenEventId: 7 }),
      });
      expect(f.sandbox.spawn).toHaveBeenCalledOnce();
      expect(f.sandbox.spawn.mock.calls[0]![0].env.BRIDGE_REPLAY_FROM_DISK).toBe("1");
      await vi.waitFor(() => expect(f.messages).toEqual([{ type: "resume", lastSeenEventId: 7 }]));
      if (completed) {
        const turn = await session.doContinueTurn({ tools: [], skills: [], emit() {} });
        f.send({ ...finish, seq: 8 });
        await turn.done;
      } else {
        await expect(session.doContinueTurn({ tools: [], skills: [], emit() {} })).rejects.toThrow(
          "restarted before the turn finished",
        );
      }
      await session.doDestroy();
      expect(f.process.kill).toHaveBeenCalledOnce();
    },
  );

  it("attaches seq to every stream part through the real channel parser, including finish and error", async () => {
    const f = await fixture();
    const session = await f.start();
    const received: any[] = [];
    const turn = await session.doPromptTurn({
      prompt: "work",
      tools: [],
      skills: [],
      emit: (part) => received.push(part),
    });
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    const events = [
      { type: "stream-start" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "hello" },
      { type: "text-end", id: "text" },
      { type: "reasoning-start", id: "reason" },
      { type: "reasoning-delta", id: "reason", delta: "think" },
      { type: "reasoning-end", id: "reason" },
      { type: "tool-input-start", id: "tool", toolName: "bash" },
      { type: "tool-input-delta", id: "tool", delta: "{}" },
      { type: "tool-input-end", id: "tool" },
      {
        type: "tool-call",
        toolCallId: "tool",
        toolName: "bash",
        input: "{}",
        providerExecuted: true,
      },
      { type: "tool-approval-request", approvalId: "approval", toolCallId: "tool" },
      { type: "tool-result", toolCallId: "tool", toolName: "bash", result: "output" },
      { type: "file-change", event: "modify", path: "a.txt" },
      { type: "compaction", trigger: "auto", summary: "summary" },
      { type: "finish-step", finishReason: { unified: "stop", raw: "stop" }, usage },
      { type: "raw", rawValue: "raw" },
      finish,
    ];
    for (const [index, event] of events.entries()) f.send({ ...event, seq: index + 1 });
    await turn.done;
    expect(received).toHaveLength(events.length);
    for (const [index, part] of received.entries()) {
      expect(part.type).toBe(events[index]!.type);
      expect(part.providerMetadata).toEqual({ qgrid: { seq: index + 1 } });
      expect(part.harnessMetadata).toEqual(part.providerMetadata);
    }
    const failure = await session.doPromptTurn({
      prompt: "fail",
      tools: [],
      skills: [],
      emit: (part) => received.push(part),
    });
    const rejected = expect(failure.done).rejects.toThrow("Pi bridge turn failed");
    f.send({ type: "error", error: "failed", seq: 19 });
    await rejected;
    expect(received.at(-1)).toMatchObject({
      type: "error",
      providerMetadata: { qgrid: { seq: 19 } },
    });
    await session.doDestroy();
  });

  it("sends abort and keeps the bridge's terminal aborted event", async () => {
    const f = await fixture();
    const session = await f.start();
    const controller = new AbortController();
    const received: any[] = [];
    const turn = await session.doPromptTurn({
      prompt: "work",
      tools: [],
      skills: [],
      abortSignal: controller.signal,
      emit: (part) => received.push(part),
    });
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    controller.abort();
    await vi.waitFor(() => expect(f.messages.at(-1)).toEqual({ type: "abort" }));
    f.send({ ...finish, finishReason: { unified: "other", raw: "aborted" }, seq: 1 });
    await turn.done;
    expect(received).toEqual([
      expect.objectContaining({
        finishReason: { unified: "other", raw: "aborted" },
        providerMetadata: { qgrid: { seq: 1 } },
      }),
    ]);
    await session.doDestroy();
  });

  it("rejects unsupported permission modes before starting a process", async () => {
    const f = await fixture();
    await expect(
      f.harness.doStart({
        sessionId: "one",
        sessionWorkDir: "/workspace",
        sandboxSession: f.sandbox as unknown as HarnessV1NetworkSandboxSession,
        permissionMode: "allow-reads",
      }),
    ).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    expect(f.sandbox.spawn).not.toHaveBeenCalled();
  });
});

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
};
const finish = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  totalUsage: usage,
};
