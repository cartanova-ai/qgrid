import { type HarnessV1ContinueTurnOptions, type HarnessV1StreamPart } from "@ai-sdk/harness";
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentModel, AgentStateError, type AgentSessionRow, type AgentTurnRow } from "../../application/agent/agent.model";
import { type DockerSandboxProvider, type DockerSandboxSession } from "./docker-sandbox";
import * as piHarness from "./pi-harness";
import { derivePiSessionSecrets, reconstructContinueState } from "./pi-harness";
import { type AgentsRelay } from "./relay";
import { AgentSessionRunner, type AgentSessionRunnerOptions } from "./session-runner";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function session(patch: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: "test-agent", status: "idle", harness: "pi", model: "openai/gpt-6.1-sol",
    token_id: 9, token_name: "fixture-account", project_name: "runner-test", instructions: "Test instructions",
    tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" }, gate: "auto" }],
    webhook_url: null, webhook_secret: null, lifecycle_state: null,
    container_name: "qgrid-agents-test-agent", container_ip: "172.30.0.2",
    idle_ttl_sec: 1800, retain_sec: 86400, stop_reason: null,
    last_turn_at: new Date(), created_at: new Date(), updated_at: new Date(), ...patch,
  };
}

function turn(patch: Partial<AgentTurnRow> = {}): AgentTurnRow {
  return {
    id: 12, session_id: "test-agent", index: 0, prompt: "Do the task", status: "running",
    request_log_id: 30, pending_actions: [], logged_steps: {}, last_logged_event_seq: 7,
    model_call_count: 0, started_at: new Date(), finished_at: null,
    result_text: null, error_message: null, usage: null, ...patch,
  };
}

function pending(delivered = false) {
  return {
    toolCallId: "tool-1", toolName: "lookup", input: { id: 1 }, gate: "auto" as const,
    requestedAt: new Date().toISOString(), result: { output: { found: true }, receivedAt: new Date().toISOString() },
    deliveredAt: delivered ? new Date().toISOString() : undefined,
  };
}

function modelFixture(row = session(), active = turn()) {
  vi.spyOn(AgentModel, "listSessions").mockImplementation(async () => [row]);
  vi.spyOn(AgentModel, "getSession").mockImplementation(async () => ({ ...row }));
  vi.spyOn(AgentModel, "getTurn").mockImplementation(async () => ({ ...active }));
  vi.spyOn(AgentModel, "latestTurn").mockImplementation(async () => ({ ...active }));
  const update = vi.spyOn(AgentModel, "updateSession").mockImplementation(async (_id, patch) => { Object.assign(row, patch); });
  const transition = vi.spyOn(AgentModel, "transition").mockImplementation(async (_id, from, to, patch) => {
    if (!from.includes(row.status)) throw new AgentStateError(409, row.status === "running" ? "session_busy" : "invalid_state");
    Object.assign(row, patch, { status: to });
    return { ...row };
  });
  const begin = vi.spyOn(AgentModel, "beginTurn").mockImplementation(async () => {
    if (row.status !== "idle") throw new AgentStateError(409, "session_busy");
    row.status = "running";
    return { ...active };
  });
  const finish = vi.spyOn(AgentModel, "finish").mockImplementation(async (_id, _turn, status, error, next = "idle", _stopReason, checkpoint) => {
    active.status = status;
    active.error_message = error ?? null;
    row.status = next;
    if (checkpoint) {
      row.lifecycle_state = checkpoint.lifecycleState;
      active.last_logged_event_seq = checkpoint.seq;
      active.result_text = checkpoint.resultText;
    }
    return { ...active };
  });
  const claim = vi.spyOn(AgentModel, "claimContinuation").mockImplementation(async () => {
    row.status = "running";
    active.status = "running";
    return { ...active };
  });
  vi.spyOn(AgentModel, "checkpoint").mockResolvedValue(undefined);
  vi.spyOn(AgentModel, "recoverCalls").mockResolvedValue(undefined);
  return { row, active, update, transition, begin, finish, claim };
}

function fixture(overrides: Partial<AgentSessionRunnerOptions> = {}) {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 104857600 1048576 103809024 1% /\n", stderr: "" });
  const sandbox = { run } as unknown as DockerSandboxSession;
  const provider = {
    dataRootFreeBytes: vi.fn().mockResolvedValue(100 * 1024 ** 3),
    createSession: vi.fn().mockResolvedValue(sandbox),
    resumeSession: vi.fn().mockResolvedValue(sandbox),
    inspectIp: vi.fn().mockResolvedValue("172.30.0.2"),
    destroyContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    pruneOrphans: vi.fn().mockResolvedValue(undefined),
  };
  const relay = { abortTurn: vi.fn(), removeRules: vi.fn() };
  const runner = new AgentSessionRunner({
    provider: provider as unknown as DockerSandboxProvider,
    dispatcher: { selectToken: vi.fn() }, secret: "runner-test-secret",
    relayBaseUrl: "http://host.docker.internal:44901/backend-api/codex",
    maxSessions: 4, idleTtlSec: 1800, retainSec: 86400,
    maxModelCallsPerTurn: 60, maxTurnSeconds: 1200, minFreeDiskGb: 20, ...overrides,
  });
  runner.setRelay(relay as unknown as AgentsRelay);
  cleanup.push(() => runner.shutdown());
  return { runner, provider, sandbox, run, relay };
}

function harness(config: { hold?: boolean; abortCloses?: boolean } = {}) {
  const end = Promise.withResolvers<void>();
  if (!config.hold) end.resolve();
  let signal: AbortSignal | undefined;
  let onBridgeEvent: piHarness.SandboxPiSettings["onBridgeEvent"];
  const originalPi = piHarness.createSandboxPi;
  vi.spyOn(piHarness, "createSandboxPi").mockImplementation((settings) => {
    onBridgeEvent = settings.onBridgeEvent;
    return originalPi(settings);
  });
  const acknowledgeAbort = () => onBridgeEvent?.({
    type: "finish", seq: 10, finishReason: { unified: "other", raw: "aborted" },
    totalUsage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
  });
  const state = reconstructContinueState({ sessionId: "test-agent", lastSeenEventId: 9 });
  const live = {
    hasUnfinishedTurn: vi.fn(() => false),
    detach: vi.fn(async () => ({ ...state, type: "resume-session" as const })),
    suspendTurn: vi.fn(async () => { end.resolve(); return state; }),
  };
  const create = vi.spyOn(HarnessAgent.prototype, "createSession").mockResolvedValue(live as unknown as HarnessAgentSession);
  const result = (options: { abortSignal?: AbortSignal }) => {
    signal = options.abortSignal;
    if (options.abortSignal && options.abortSignal.aborted) end.resolve();
    if (options.abortSignal && config.abortCloses !== false)
      options.abortSignal.addEventListener("abort", () => { acknowledgeAbort(); end.resolve(); }, { once: true });
    return Promise.resolve({ fullStream: { async *[Symbol.asyncIterator]() { await end.promise; } } }) as unknown as ReturnType<HarnessAgent["stream"]>;
  };
  const stream = vi.spyOn(HarnessAgent.prototype, "stream").mockImplementation(result);
  const continued = vi.spyOn(HarnessAgent.prototype, "continueStream").mockImplementation(result);
  cleanup.push(async () => { end.resolve(); await Promise.resolve(); });
  return { create, stream, continued, live, end, acknowledgeAbort, signal: () => signal };
}

describe("agent runner disk guard", () => {
  it("rejects insufficient daemon data-root space before container allocation", async () => {
    const { runner, provider } = fixture();
    provider.dataRootFreeBytes.mockResolvedValue(19 * 1024 ** 3);
    await expect(runner.checkDisk()).rejects.toMatchObject({ status: 429, code: "limit_exceeded:disk" });
    expect(provider.createSession).not.toHaveBeenCalled();
  });

  it("uses overlay df in a disposable probe when data-root is not mounted in the API container", async () => {
    const { runner, provider, run } = fixture();
    provider.dataRootFreeBytes.mockRejectedValue(new Error("ENOENT"));
    await runner.checkDisk();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: "df -P /" }));
    const id = provider.createSession.mock.calls[0]![0].sessionId;
    expect(id).toMatch(/^disk-probe-/);
    expect(provider.destroyContainer).toHaveBeenCalledWith(id);
  });

  it("cleans the disk probe and refuses creation when df cannot report space", async () => {
    const { runner, provider, run } = fixture();
    provider.dataRootFreeBytes.mockRejectedValue(new Error("ENOENT"));
    run.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "df failed" });
    await expect(runner.checkDisk()).rejects.toThrow("agents_disk_check_failed");
    expect(provider.destroyContainer).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing session container for df without stopping it", async () => {
    const db = modelFixture();
    const { runner, provider, run } = fixture();
    harness();
    await runner.prompt(db.row.id, "hello");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    provider.dataRootFreeBytes.mockRejectedValue(new Error("ENOENT"));
    await runner.checkDisk();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: "df -P /" }));
    expect(provider.createSession).not.toHaveBeenCalled();
    expect(provider.destroyContainer).not.toHaveBeenCalled();
  });
});

describe("agent runner recovery", () => {
  it("keeps unresolved waiting actions in the DB without replaying the bridge", async () => {
    const action = pending();
    const { result: _result, ...unresolved } = action;
    const db = modelFixture(session({ status: "waiting_action" }), turn({ status: "waiting_action", pending_actions: [unresolved] }));
    const { runner, provider } = fixture();
    const agent = harness();
    await runner.start();
    expect(agent.create).not.toHaveBeenCalled();
    expect(db.claim).not.toHaveBeenCalled();
    expect(provider.pruneOrphans).toHaveBeenCalledWith(new Set([db.row.id]));
    expect((await AgentModel.latestTurn(db.row.id))?.pending_actions).toEqual([unresolved]);
  });

  it("replays a saved result after a crash between saving it and continuation", async () => {
    const db = modelFixture(session({ status: "waiting_action" }), turn({ status: "waiting_action", pending_actions: [pending()] }));
    const { runner } = fixture();
    const agent = harness();
    await runner.start();
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.claim).toHaveBeenCalledWith(db.row.id);
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [{
      type: "tool-result", toolCallId: "tool-1", toolName: "lookup", output: { type: "json", value: { found: true } },
    }] }));
  });

  it("redelivers undelivered results for a running turn", async () => {
    modelFixture(session({ status: "running" }), turn({ pending_actions: [pending()] }));
    const { runner } = fixture();
    const agent = harness();
    await runner.start();
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [expect.objectContaining({ toolCallId: "tool-1" })] }));
    expect(agent.stream).not.toHaveBeenCalled();
  });

  it("reconnects a running turn with its persisted bridge cursor and no new prompt", async () => {
    modelFixture(session({ status: "running" }), turn({ last_logged_event_seq: 42 }));
    const { runner } = fixture();
    const agent = harness();
    await runner.start();
    expect(agent.create).toHaveBeenCalledWith(expect.objectContaining({ continueFrom: expect.objectContaining({
      type: "continue-turn", data: expect.objectContaining({ bridge: { port: 8787, lastSeenEventId: 42 } }),
    }) }));
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [] }));
    expect(agent.stream).not.toHaveBeenCalled();
  });

  it("does not submit a result again after delivery was persisted", async () => {
    modelFixture(session({ status: "running" }), turn({ pending_actions: [pending(true)] }));
    const { runner } = fixture();
    const agent = harness();
    await runner.start();
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [] }));
  });
});

describe("agent runner turn ownership", () => {
  it("ignores duplicate text events before appending the next unique delta", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness();
    const record = vi.spyOn(AgentModel, "recordEvent").mockResolvedValue(undefined);
    agent.stream.mockResolvedValue({ fullStream: {
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta", id: "answer", text: "hello", providerMetadata: { qgrid: { seq: 8 } } };
        yield { type: "text-delta", id: "answer", text: "hello", providerMetadata: { qgrid: { seq: 8 } } };
        yield { type: "text-delta", id: "answer", text: " world", providerMetadata: { qgrid: { seq: 9 } } };
      },
    } } as Awaited<ReturnType<HarnessAgent["stream"]>>);
    await runner.prompt(db.row.id, "hello");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(record.mock.calls.filter(([, seq]) => seq === 8)).toHaveLength(1);
    expect(record).toHaveBeenCalledWith(12, 9, { result_text: "hello world" });
  });

  it("defers the host-tool cursor until envelope and pending actions are suspended together", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness();
    const record = vi.spyOn(AgentModel, "recordStep").mockResolvedValue(22);
    const event = vi.spyOn(AgentModel, "recordEvent").mockResolvedValue(undefined);
    const suspend = vi.spyOn(AgentModel, "suspend").mockResolvedValue(undefined);
    const state = {
      ...reconstructContinueState({ sessionId: db.row.id, lastSeenEventId: 9 }),
      pendingToolResults: [{ toolCallId: "tool-1", toolName: "lookup", input: '{"id":1}' }],
    };
    agent.live.hasUnfinishedTurn.mockReturnValue(true);
    agent.live.suspendTurn.mockResolvedValue(state);
    agent.stream.mockResolvedValue({ fullStream: {
      async *[Symbol.asyncIterator]() {
        yield { type: "tool-call", toolCallId: "tool-1", toolName: "lookup", input: { id: 1 }, providerMetadata: { qgrid: { seq: 8 } } };
        yield { type: "finish-step", finishReason: "tool-calls", providerMetadata: { qgrid: { seq: 9 } } };
      },
    } } as Awaited<ReturnType<HarnessAgent["stream"]>>);
    await runner.prompt(db.row.id, "look it up");
    await vi.waitFor(() => expect(suspend).toHaveBeenCalled());
    expect(record).toHaveBeenCalledWith(12, expect.objectContaining({ key: "tool:tool-1", seq: undefined }));
    expect(event.mock.calls.every(([, seq]) => seq === undefined)).toBe(true);
    expect(suspend).toHaveBeenCalledWith(db.row.id, 12, state, [expect.objectContaining({
      toolCallId: "tool-1", toolName: "lookup", input: { id: 1 }, gate: "auto",
    })], 9);
    expect(db.finish).not.toHaveBeenCalled();
  });

  it("suspends an in-flight turn and persists the shutdown checkpoint after its stream drains", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness({ hold: true });
    agent.live.hasUnfinishedTurn.mockReturnValue(true);
    await runner.prompt(db.row.id, "keep working");
    await runner.shutdown();
    expect(agent.live.suspendTurn).toHaveBeenCalledTimes(1);
    expect(AgentModel.checkpoint).toHaveBeenCalledWith(db.row.id, 12, expect.objectContaining({ type: "continue-turn" }), 9);
    expect(db.finish).not.toHaveBeenCalled();
  });

  it("serializes same-session prompts and rejects the second before starting a second stream", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness({ hold: true });
    const results = await Promise.allSettled([runner.prompt(db.row.id, "one"), runner.prompt(db.row.id, "two")]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 409, code: "session_busy" } });
    expect(agent.stream).toHaveBeenCalledTimes(1);
    agent.end.resolve();
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
  });

  it("distinguishes caller cancellation from model-call limit exhaustion", async () => {
    const db = modelFixture();
    const { runner, relay } = fixture();
    const agent = harness({ hold: true });
    await runner.prompt(db.row.id, "cancel me");
    await runner.cancel(db.row.id);
    expect(agent.signal()?.aborted).toBe(true);
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "aborted", "cancelled", "idle", undefined, expect.objectContaining({ lifecycleState: expect.objectContaining({ type: "resume-session" }) }));
    expect(relay.abortTurn).toHaveBeenCalledWith("12");

    db.active.status = "running";
    db.finish.mockClear();
    const held = Promise.withResolvers<void>();
    agent.stream.mockImplementation(async (options) => {
      options.abortSignal?.addEventListener("abort", () => { agent.acknowledgeAbort(); held.resolve(); }, { once: true });
      return { fullStream: { async *[Symbol.asyncIterator]() { await held.promise; } } } as Awaited<ReturnType<HarnessAgent["stream"]>>;
    });
    await runner.prompt(db.row.id, "limited");
    runner.onLimitExceeded(db.row.id, "model_calls");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "failed", "limit_exceeded:model_calls", "idle", undefined, expect.objectContaining({ lifecycleState: expect.objectContaining({ type: "resume-session" }) }));
  });

  it("stops the container after 10 seconds without the bridge abort completion", async () => {
    vi.useFakeTimers();
    const db = modelFixture();
    const { runner, provider } = fixture();
    const agent = harness({ hold: true, abortCloses: false });
    await runner.prompt(db.row.id, "hang");
    const cancellation = runner.cancel(db.row.id);
    await vi.advanceTimersByTimeAsync(9999);
    expect(provider.stopContainer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await cancellation;
    expect(provider.stopContainer).toHaveBeenCalledWith(db.row.id);
    expect(db.finish).toHaveBeenCalledWith(db.row.id, 12, "aborted", "cancelled", "stopped", "abort_timeout", undefined);
    agent.end.resolve();
  });

  it("resolves relay sessions to their pinned token and active persisted turn", async () => {
    const db = modelFixture(session({ status: "running" }), turn({ model_call_count: 3 }));
    const { runner } = fixture();
    const key = derivePiSessionSecrets("runner-test-secret", db.row.id).sessionKey;
    await expect(runner.resolveSession(key)).resolves.toMatchObject({
      tokenId: 9, containerIp: "172.30.0.2", status: "running",
      activeTurn: { turnId: "12", modelCallCount: 3 },
    });
  });
});

describe("agent runner with the real HarnessAgent", () => {
  it("suspends a caller tool and records its bridge delivery echo after actionResult resumes it", async () => {
    const db = modelFixture();
    const { runner, sandbox } = fixture();
    Object.assign(sandbox, { defaultWorkingDirectory: "/workspace" });
    let seq = 7;
    let prompts = 0;
    const submitted = vi.fn();
    const starts = vi.fn();
    const originalPi = piHarness.createSandboxPi;
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    vi.spyOn(piHarness, "createSandboxPi").mockImplementation((settings) => ({
      ...originalPi(settings),
      getBootstrap: undefined,
      doStart: async (start) => {
        starts(start);
        let done = Promise.withResolvers<void>();
        let options: HarnessV1ContinueTurnOptions;
        const state = () => reconstructContinueState({ sessionId: start.sessionId, lastSeenEventId: seq });
        const emit = (event: HarnessV1StreamPart) => {
          const frame = Object.assign(event, {
            seq: ++seq, providerMetadata: { qgrid: { seq } }, harnessMetadata: { qgrid: { seq } },
          });
          settings.onBridgeEvent?.(frame);
          options.emit(frame);
        };
        const control = () => ({
          done: done.promise,
          submitToolResult: async (result: { toolCallId: string; output: unknown }) => {
            submitted(result);
            setTimeout(() => {
              emit({ type: "tool-result", toolCallId: result.toolCallId, toolName: "lookup", result: { found: true } });
              emit({ type: "text-start", id: "answer" });
              emit({ type: "text-delta", id: "answer", delta: "done" });
              emit({ type: "text-end", id: "answer" });
              emit({ type: "finish-step", finishReason: { unified: "stop", raw: "stop" }, usage });
              emit({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, totalUsage: usage });
              done.resolve();
            }, 0);
          },
        });
        return {
          sessionId: start.sessionId, isResume: Boolean(start.continueFrom || start.resumeFrom),
          doPromptTurn: async (input) => {
            options = input;
            prompts++;
            setTimeout(() => {
              emit({ type: "stream-start", warnings: [] });
              if (prompts === 1) {
                emit({ type: "tool-call", toolCallId: "tool-1", toolName: "lookup", input: '{"id":1}' });
                emit({ type: "finish-step", finishReason: { unified: "tool-calls", raw: "host-input" }, usage });
              } else {
                emit({ type: "text-start", id: "second" });
                emit({ type: "text-delta", id: "second", delta: "new answer" });
                emit({ type: "text-end", id: "second" });
                emit({ type: "finish-step", finishReason: { unified: "stop", raw: "stop" }, usage });
                emit({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, totalUsage: usage });
                done.resolve();
              }
            }, 0);
            return control();
          },
          doContinueTurn: async (input) => { options = input; done = Promise.withResolvers<void>(); return control(); },
          doCompact: async () => { throw new Error("Test adapter does not compact"); },
          doSuspendTurn: async () => { done.resolve(); return state(); },
          doDetach: async () => ({ ...state(), type: "resume-session" as const }),
          doStop: async () => ({ ...state(), type: "resume-session" as const }),
          doDestroy: async () => { done.resolve(); },
        };
      },
    }));
    const step = vi.spyOn(AgentModel, "recordStep").mockResolvedValue(22);
    vi.spyOn(AgentModel, "recordEvent").mockImplementation(async (_id, nextSeq, patch) => {
      if (nextSeq !== undefined) db.active.last_logged_event_seq = nextSeq;
      if (patch?.result_text !== undefined) db.active.result_text = patch.result_text;
    });
    const suspend = vi.spyOn(AgentModel, "suspend").mockImplementation(async (_id, _turn, envelope, actions, cursor) => {
      db.row.status = "waiting_action";
      db.row.lifecycle_state = envelope;
      db.active.status = "waiting_action";
      db.active.pending_actions = actions;
      db.active.last_logged_event_seq = cursor;
    });
    const delivery = vi.spyOn(AgentModel, "recordToolResult").mockImplementation(async (_id, result) => {
      const action = db.active.pending_actions.find((item) => item.toolCallId === result.toolCallId);
      if (action) action.deliveredAt = new Date().toISOString();
    });
    vi.spyOn(AgentModel, "saveActionResult").mockImplementation(async (_id, toolCallId, result) => {
      const action = db.active.pending_actions.find((item) => item.toolCallId === toolCallId)!;
      action.result = { ...result, receivedAt: new Date().toISOString() };
      return { turn: { ...db.active }, duplicate: false };
    });

    await runner.prompt(db.row.id, "look it up");
    await vi.waitFor(() => expect(suspend).toHaveBeenCalledTimes(1));
    expect(db.row.status).toBe("waiting_action");
    expect(db.row.lifecycle_state).toMatchObject({
      type: "continue-turn", pendingToolResults: [expect.objectContaining({ toolCallId: "tool-1" })],
      turnSettings: expect.objectContaining({ model: db.row.model }),
    });
    expect(step).toHaveBeenCalledTimes(1);
    expect(db.finish).not.toHaveBeenCalled();

    await runner.actionResult(db.row.id, "tool-1", { output: { found: true } });
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalledTimes(1));
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery).toHaveBeenCalledWith(12, expect.objectContaining({ toolCallId: "tool-1", output: { found: true } }));
    expect(db.active.pending_actions[0]?.deliveredAt).toEqual(expect.any(String));
    expect(db.active.result_text).toBe("done");
    expect(db.active.status).toBe("succeeded");
    const completedCursor = seq;
    expect(db.row.lifecycle_state).toMatchObject({ type: "resume-session", data: { bridge: { lastSeenEventId: completedCursor } } });
    expect(db.active.last_logged_event_seq).toBe(completedCursor);
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "succeeded", undefined, "idle", undefined, expect.objectContaining({ seq: completedCursor, resultText: "done" }));

    db.begin.mockImplementation(async () => {
      db.row.status = "running";
      Object.assign(db.active, { id: 13, index: 1, status: "running", pending_actions: [], result_text: null });
      return { ...db.active };
    });
    await runner.prompt(db.row.id, "a new question");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalledTimes(2));
    const nextStart = starts.mock.calls[2]![0];
    expect(nextStart.continueFrom).toBeUndefined();
    expect(nextStart.resumeFrom).toMatchObject({ type: "resume-session", data: { bridge: { lastSeenEventId: completedCursor } } });
    expect(nextStart.resumeFrom.continueFrom).toBeUndefined();
    expect(nextStart.resumeFrom.pendingToolResults).toBeUndefined();
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(db.active.result_text).toBe("new answer");
  });
});
