import { type HarnessV1LifecycleState } from "@ai-sdk/harness";
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentModel, AgentStateError, type AgentSessionRow, type AgentTurnRow } from "../../application/agent/agent.model";
import { QuotaThresholdExceededError } from "../../application/qgrid/qgrid.types";
import { AgentTokenError } from "./credential-store";
import { type DockerSandboxProvider, type DockerSandboxSession } from "./docker-sandbox";
import { AgentSessionRunner, type AgentSessionRunnerOptions, toPiModelId } from "./session-runner";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const resumeState: HarnessV1LifecycleState = {
  type: "resume-session", harnessId: "pi", specificationVersion: "harness-v1", data: { session: "saved" },
};

function continueState(pendingToolResults = [{ toolCallId: "tool-1", toolName: "lookup", input: '{"id":1}' }]): HarnessV1LifecycleState {
  return { type: "continue-turn", harnessId: "pi", specificationVersion: "harness-v1", data: { session: "saved" }, pendingToolResults };
}

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
    request_log_id: 30, pending_actions: [], logged_steps: {}, last_logged_event_seq: 0,
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
      active.result_text = checkpoint.resultText;
    }
    return { ...active };
  });
  const claim = vi.spyOn(AgentModel, "claimContinuation").mockImplementation(async () => {
    row.status = "running";
    active.status = "running";
    return { ...active };
  });
  const checkpoint = vi.spyOn(AgentModel, "checkpoint").mockResolvedValue(undefined);
  vi.spyOn(AgentModel, "recoverCalls").mockResolvedValue(undefined);
  const callStart = vi.spyOn(AgentModel, "recordCallStart").mockResolvedValue(41);
  const stepUpdate = vi.spyOn(AgentModel, "updateStep").mockResolvedValue(undefined);
  const events = vi.spyOn(AgentModel, "recordEvent").mockImplementation(async (_id, _seq, patch) => {
    if (patch?.result_text !== undefined) active.result_text = patch.result_text;
  });
  const steps = vi.spyOn(AgentModel, "recordStep").mockResolvedValue(22);
  const results = vi.spyOn(AgentModel, "recordToolResult").mockResolvedValue(undefined);
  const suspend = vi.spyOn(AgentModel, "suspend").mockImplementation(async (_id, _turn, envelope, actions) => {
    row.status = "waiting_action";
    row.lifecycle_state = envelope;
    active.status = "waiting_action";
    active.pending_actions = actions;
  });
  return { row, active, update, transition, begin, finish, claim, checkpoint, callStart, stepUpdate, events, steps, results, suspend };
}

function fixture(overrides: Partial<AgentSessionRunnerOptions> = {}) {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 104857600 1048576 103809024 1% /\n", stderr: "" });
  const sandbox = { id: "test-agent", run, defaultWorkingDirectory: "/workspace" } as unknown as DockerSandboxSession;
  const provider = {
    callerEnvironment: vi.fn().mockResolvedValue({}),
    dataRootFreeBytes: vi.fn().mockResolvedValue(100 * 1024 ** 3),
    createSession: vi.fn().mockResolvedValue(sandbox),
    resumeSession: vi.fn().mockResolvedValue(sandbox),
    inspectIp: vi.fn().mockResolvedValue("172.30.0.2"),
    destroyContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    pruneOrphans: vi.fn().mockResolvedValue(undefined),
  };
  const dispatcher = {
    selectToken: vi.fn(),
    tokenMetadata: new Map(),
    refreshCredentials: vi.fn(),
    isQuotaEligible: vi.fn().mockResolvedValue(true),
  };
  const runner = new AgentSessionRunner({
    provider: provider as unknown as DockerSandboxProvider,
    dispatcher: { ...dispatcher, ...overrides.dispatcher } as AgentSessionRunnerOptions["dispatcher"],
    maxSessions: 4, idleTtlSec: 1800, retainSec: 86400,
    maxModelCallsPerTurn: 60, maxTurnSeconds: 1200, minFreeDiskGb: 20, ...overrides,
  });
  cleanup.push(() => runner.shutdown());
  return { runner, provider, sandbox, run };
}

type Part = Record<string, unknown> & { type: string };

/** Replace the in-process Pi harness with a scripted stream; abort ends the stream like Pi does. */
function harness(config: { hold?: boolean; parts?: Part[]; abortCloses?: boolean } = {}) {
  const end = Promise.withResolvers<void>();
  if (!config.hold) end.resolve();
  let signal: AbortSignal | undefined;
  const live = {
    hasUnfinishedTurn: vi.fn(() => false),
    detach: vi.fn(async () => resumeState),
    suspendTurn: vi.fn(async () => { end.resolve(); return continueState(); }),
  };
  const create = vi.spyOn(HarnessAgent.prototype, "createSession").mockResolvedValue(live as unknown as HarnessAgentSession);
  const result = (options: { abortSignal?: AbortSignal }) => {
    signal = options.abortSignal;
    if (options.abortSignal?.aborted) end.resolve();
    if (options.abortSignal && config.abortCloses !== false)
      options.abortSignal.addEventListener("abort", () => end.resolve(), { once: true });
    return Promise.resolve({ fullStream: { async *[Symbol.asyncIterator]() {
      for (const part of config.parts ?? []) yield part;
      await end.promise;
    } } }) as unknown as ReturnType<HarnessAgent["stream"]>;
  };
  const stream = vi.spyOn(HarnessAgent.prototype, "stream").mockImplementation(result);
  const continued = vi.spyOn(HarnessAgent.prototype, "continueStream").mockImplementation(result);
  cleanup.push(async () => { end.resolve(); await Promise.resolve(); });
  return { create, stream, continued, live, end, signal: () => signal };
}

const usage = { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 40, noCacheTokens: 60, cacheWriteTokens: 0 } };

describe("agent runner model ids and tools", () => {
  it("maps qgrid model ids onto Pi's Codex provider and rejects built-in tool names", async () => {
    expect(toPiModelId("openai/gpt-6-astra")).toBe("openai-codex/gpt-6-astra");
    const { runner } = fixture();
    await expect(runner.create({ model: "openai/gpt-6-astra", tools: [{ name: "bash", description: "x", inputSchema: { type: "object" }, gate: "auto" }] }))
      .rejects.toMatchObject({ status: 400, code: "invalid_tool_name" });
    await expect(runner.create({ model: "anthropic/claude" })).rejects.toMatchObject({ status: 400, code: "unsupported_agent_model" });
  });
});

describe("agent runner token selection", () => {
  it.each(["creating", "idle", "running", "waiting_action", "stopped", "failed", "destroyed"] as const)("counts only live sessions toward maxSessions: %s", async (status) => {
    const db = modelFixture(session({ status }));
    const selectToken = vi.fn().mockResolvedValue({ tokenId: 9, metadata: { name: "fixture-account" } });
    const { runner, provider } = fixture({ maxSessions: 1, dispatcher: { selectToken } as never });
    vi.spyOn(AgentModel, "createSession").mockImplementation(async (row) => { Object.assign(db.row, row); return db.row; });
    harness();
    const result = runner.create({ model: db.row.model });
    if (["stopped", "failed", "destroyed"].includes(status)) {
      await expect(result).resolves.toMatchObject({ status: "idle" });
      expect(provider.createSession).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toMatchObject({ status: 429, code: "limit_exceeded:max_sessions" });
      expect(selectToken).not.toHaveBeenCalled();
      expect(provider.createSession).not.toHaveBeenCalled();
    }
  });

  it("retries a transient selection failure once after 250 ms with the same preferred token", async () => {
    vi.useFakeTimers();
    const db = modelFixture();
    const selectToken = vi.fn()
      .mockRejectedValueOnce(new QuotaThresholdExceededError("quota_threshold gate: all_exceeded"))
      .mockResolvedValue({ tokenId: 9, metadata: { name: "fixture-account" } });
    const { runner, provider } = fixture({ dispatcher: { selectToken } as never });
    vi.spyOn(AgentModel, "createSession").mockImplementation(async (row) => { Object.assign(db.row, row); return db.row; });
    harness();
    const result = runner.create({ model: db.row.model, tokenId: 9 });
    await vi.advanceTimersByTimeAsync(0);
    expect(selectToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(selectToken).toHaveBeenCalledTimes(1);
    expect(provider.createSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: "idle", token_id: 9 });
    expect(selectToken).toHaveBeenCalledTimes(2);
    expect(selectToken.mock.calls[0]).toEqual([9, true, expect.any(AbortSignal)]);
    expect(selectToken.mock.calls[1]).toEqual(selectToken.mock.calls[0]);
  });

  it.each([
    [new QuotaThresholdExceededError("all_exceeded"), { status: 503, code: "quota_exceeded" }],
    [new Error("NO_OPENAI_WORKERS"), { status: 503, code: "token_unavailable" }],
    [new Error("unexpected selection failure"), { message: "unexpected selection failure" }],
  ])("maps the retry's failure without allocating a session: %s", async (error, expected) => {
    vi.useFakeTimers();
    const db = modelFixture();
    const selectToken = vi.fn().mockRejectedValueOnce(new Error("transient")).mockRejectedValue(error);
    const { runner, provider } = fixture({ dispatcher: { selectToken } as never });
    const create = vi.spyOn(AgentModel, "createSession");
    const result = runner.create({ model: db.row.model }).catch((caught: Error) => caught);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject(expected);
    expect(selectToken).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(provider.createSession).not.toHaveBeenCalled();
  });
});

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
});

describe("agent runner recovery", () => {
  it("keeps unresolved waiting actions in the DB without restoring Pi", async () => {
    const { result: _result, ...unresolved } = pending();
    const db = modelFixture(session({ status: "waiting_action", lifecycle_state: continueState() }), turn({ status: "waiting_action", pending_actions: [unresolved] }));
    const { runner, provider } = fixture();
    const agent = harness();
    await runner.start();
    expect(agent.create).not.toHaveBeenCalled();
    expect(db.claim).not.toHaveBeenCalled();
    expect(provider.pruneOrphans).toHaveBeenCalledWith(new Set([db.row.id]));
  });

  it("replays a saved result from the persisted continuation after a crash", async () => {
    const db = modelFixture(session({ status: "waiting_action", lifecycle_state: continueState() }), turn({ status: "waiting_action", pending_actions: [pending()] }));
    const { runner } = fixture();
    const agent = harness();
    await runner.start();
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.claim).toHaveBeenCalledWith(db.row.id);
    expect(agent.create).toHaveBeenCalledWith(expect.objectContaining({ continueFrom: expect.objectContaining({ type: "continue-turn", pendingToolResults: [expect.objectContaining({ toolCallId: "tool-1" })] }) }));
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [{
      type: "tool-result", toolCallId: "tool-1", toolName: "lookup", output: { type: "json", value: { found: true } },
    }] }));
  });

  it("fails an in-flight turn after a restart, stops the container and keeps the session usable", async () => {
    const db = modelFixture(session({ status: "running", lifecycle_state: resumeState }), turn());
    const { runner, provider } = fixture();
    const agent = harness();
    await runner.start();
    expect(agent.create).not.toHaveBeenCalled();
    expect(provider.stopContainer).toHaveBeenCalledWith(db.row.id);
    expect(db.finish).toHaveBeenCalledWith(db.row.id, 12, "failed", "server_restart", "idle");
    expect(db.row.status).toBe("idle");
  });

  it("resumes a running turn whose continuation and results were saved before the crash", async () => {
    const db = modelFixture(session({ status: "running", lifecycle_state: continueState() }), turn({ pending_actions: [pending()] }));
    const { runner, provider } = fixture();
    const agent = harness();
    await runner.start();
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(provider.stopContainer).not.toHaveBeenCalled();
    expect(agent.create).toHaveBeenCalledWith(expect.objectContaining({ continueFrom: expect.objectContaining({ type: "continue-turn" }) }));
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [expect.objectContaining({ toolCallId: "tool-1" })] }));
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "succeeded", undefined, "idle", undefined, expect.anything());
  });

  it("destroys sessions persisted by the previous adapter format", async () => {
    const db = modelFixture(session({ status: "stopped", lifecycle_state: { type: "resume-session", harnessId: "qgrid-pi", specificationVersion: "harness-v1", data: {} } }));
    const { runner, provider } = fixture();
    await runner.start();
    expect(provider.destroyContainer).toHaveBeenCalledWith(db.row.id);
    expect(db.row).toMatchObject({ status: "destroyed", stop_reason: "format_change" });
    expect(runner.sessionCount()).toBe(0);
  });

  it("resumes a stopped session from its saved state and reports an unfinished turn", async () => {
    const db = modelFixture(session({ status: "stopped", lifecycle_state: resumeState }));
    const { runner } = fixture();
    const agent = harness();
    agent.live.hasUnfinishedTurn.mockReturnValue(true);
    await expect(runner.prompt(db.row.id, "again")).rejects.toMatchObject({ status: 409, code: "unfinished_turn" });
    expect(agent.create).toHaveBeenCalledWith(expect.objectContaining({ resumeFrom: expect.objectContaining({ type: "resume-session" }) }));
    expect(db.finish).toHaveBeenCalledWith(db.row.id, 12, "failed", "unfinished_turn");
  });
});

describe("agent runner turn ownership", () => {
  it("redacts the initial action-result log copy while preserving the submitted result", async () => {
    const { result: _result, ...action } = pending();
    const db = modelFixture(session({ status: "waiting_action" }), turn({ status: "waiting_action", pending_actions: [action] }));
    const { runner, provider } = fixture();
    provider.callerEnvironment.mockResolvedValue({ PASSWORD: "secret-value" });
    const result = { output: { nested: ["secret-value"] }, error: "Failed: secret-value" };
    const save = vi.spyOn(AgentModel, "saveActionResult").mockResolvedValue({ turn: db.active, duplicate: false });
    await runner.actionResult(db.row.id, action.toolCallId, result);
    expect(save).toHaveBeenCalledWith(db.row.id, action.toolCallId, result, { output: { nested: ["[REDACTED]"] }, error: "Failed: [REDACTED]" });
    expect(result).toEqual({ output: { nested: ["secret-value"] }, error: "Failed: secret-value" });
  });

  it.each(["running", "waiting_action"] as const)("rejects %s prompts before accessing Docker", async (status) => {
    const db = modelFixture(session({ status }));
    const { runner, provider } = fixture();
    provider.callerEnvironment.mockRejectedValue(new Error("Docker unavailable"));
    await expect(runner.prompt(db.row.id, "Go")).rejects.toMatchObject({ status: 409, code: "session_busy" });
    expect(provider.callerEnvironment).not.toHaveBeenCalled();
    expect(db.begin).not.toHaveBeenCalled();
  });

  it("records one generate step per Pi model call with usage, served model and limits", async () => {
    const db = modelFixture();
    const { runner } = fixture({ maxModelCallsPerTurn: 1 });
    const second = Promise.withResolvers<void>();
    const agent = harness({ hold: true });
    agent.stream.mockImplementation(async (options) => {
      options.abortSignal?.addEventListener("abort", () => second.resolve(), { once: true });
      return { fullStream: { async *[Symbol.asyncIterator]() {
        yield { type: "start-step", request: {}, warnings: [] };
        yield { type: "text-start", id: "a" };
        yield { type: "text-delta", id: "a", text: "answer" };
        yield { type: "text-end", id: "a" };
        yield { type: "finish-step", finishReason: "stop", usage, response: { id: "resp-1", modelId: "gpt-6-astra" } };
        yield { type: "start-step", request: {}, warnings: [] };
        await second.promise;
      } } } as Awaited<ReturnType<HarnessAgent["stream"]>>;
    });
    await runner.prompt(db.row.id, "count");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.callStart).toHaveBeenNthCalledWith(1, 12, "call:12:1", "openai/gpt-6.1-sol");
    expect(db.stepUpdate).toHaveBeenCalledWith(12, "call:12:1", expect.objectContaining({
      model_name: "openai/gpt-6-astra", input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, finish_reason: "stop", cost_source: "pricing_table",
    }), "response:resp-1");
    expect(db.events).toHaveBeenCalledWith(12, undefined, { result_text: "answer" });
    expect(db.callStart).toHaveBeenNthCalledWith(2, 12, "call:12:2", "openai/gpt-6.1-sol");
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "failed", "limit_exceeded:calls", "idle", undefined, expect.objectContaining({ lifecycleState: resumeState }));
    expect(db.stepUpdate).toHaveBeenCalledWith(12, "call:12:2", expect.objectContaining({ error: "limit_exceeded:calls" }));
  });

  it("maps a credential store rejection to the turn error code", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    harness({ parts: [{ type: "error", error: new Error("Credential store read failed for openai-codex", { cause: new AgentTokenError("quota_exceeded") }) }] });
    await runner.prompt(db.row.id, "go");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "failed", "quota_exceeded", "idle", undefined, expect.anything());
  });

  it("redacts caller env from prompt logs, tool arguments/results and final text", async () => {
    const db = modelFixture();
    const { runner, provider } = fixture();
    provider.callerEnvironment.mockResolvedValue({ PASSWORD: "secret-value" });
    harness({ parts: [
      { type: "tool-call", toolCallId: "shell-1", toolName: "bash", input: { command: "echo secret-value" } },
      { type: "tool-result", toolCallId: "shell-1", toolName: "bash", output: "secret-value" },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", text: "Result: secret-value" },
      { type: "text-end", id: "answer" },
    ] });
    await runner.prompt(db.row.id, "Inspect secret-value");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.begin).toHaveBeenCalledWith(db.row.id, "Inspect secret-value", expect.objectContaining({ user_prompt: "Inspect [REDACTED]" }));
    const written = JSON.stringify([db.events.mock.calls, db.steps.mock.calls, db.results.mock.calls, db.finish.mock.calls]);
    expect(written).not.toContain("secret-value");
    expect(written).toContain("[REDACTED]");
    expect(db.results).toHaveBeenCalledWith(12, expect.objectContaining({ toolCallId: "shell-1", truncate: true }));
    expect((await runner.get(db.row.id)).turn?.result_text).toBe("Result: [REDACTED]");
  });

  it("prepares git before creating the Pi session and never persists create credentials", async () => {
    const db = modelFixture();
    const { runner, provider, sandbox, run } = fixture({ dispatcher: { selectToken: vi.fn().mockResolvedValue({ tokenId: 9, metadata: { name: "fixture-account" } }) } as never });
    const created = vi.spyOn(AgentModel, "createSession").mockImplementation(async (row) => { Object.assign(db.row, row); return db.row; });
    const agent = harness();
    provider.createSession.mockResolvedValue(sandbox);
    const input = { model: db.row.model, instructions: "Use PASSWORD", tools: db.row.tools, env: { PASSWORD: "env-secret" }, workspace: { git: { url: "https://example.com/repo.git", ref: "main", token: "git-secret" } } };
    const result = await runner.create(input);
    expect(result.status).toBe("idle");
    expect(provider.createSession).toHaveBeenCalledWith({ sessionId: result.id, env: input.env });
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(agent.create.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(created.mock.calls)).not.toMatch(/env-secret|git-secret/);
  });

  it("only executes diff on demand and masks it", async () => {
    const db = modelFixture();
    const { runner, provider, run } = fixture();
    provider.callerEnvironment.mockResolvedValue({ PASSWORD: "secret-value" });
    run.mockResolvedValue({ exitCode: 0, stdout: "+secret-value", stderr: "" });
    await runner.get(db.row.id);
    expect(run).not.toHaveBeenCalled();
    expect((await runner.get(db.row.id, true)).workspaceDiff).toBe("+[REDACTED]");
    db.row.status = "stopped";
    await expect(runner.get(db.row.id, true)).rejects.toMatchObject({ status: 409 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("suspends a caller-tool pause with its pending actions and resumes from the saved continuation", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness({ parts: [
      { type: "start-step", request: {}, warnings: [] },
      { type: "tool-call", toolCallId: "tool-1", toolName: "lookup", input: { id: 1 } },
      { type: "finish-step", finishReason: "tool-calls", usage, response: { id: "resp-1", modelId: "gpt-6.1-sol" } },
    ] });
    // Fresh session before the prompt; paused on the caller tool once the stream drained.
    agent.live.hasUnfinishedTurn.mockReturnValueOnce(false).mockReturnValue(true);
    await runner.prompt(db.row.id, "look it up");
    await vi.waitFor(() => expect(db.suspend).toHaveBeenCalled());
    expect(db.steps).toHaveBeenCalledWith(12, expect.objectContaining({ key: "tool:tool-1" }));
    expect(db.suspend).toHaveBeenCalledWith(db.row.id, 12, expect.objectContaining({ type: "continue-turn" }), [expect.objectContaining({
      toolCallId: "tool-1", toolName: "lookup", input: { id: 1 }, gate: "auto",
    })], 0);
    expect(db.row.status).toBe("waiting_action");
    expect(db.finish).not.toHaveBeenCalled();

    agent.live.hasUnfinishedTurn.mockReturnValue(false);
    vi.spyOn(AgentModel, "saveActionResult").mockImplementation(async (_id, toolCallId, result) => {
      const action = db.active.pending_actions.find((item) => item.toolCallId === toolCallId)!;
      action.result = { ...result, receivedAt: new Date().toISOString() };
      return { turn: { ...db.active }, duplicate: false };
    });
    await runner.actionResult(db.row.id, "tool-1", { output: { found: true } });
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalledTimes(1));
    expect(agent.create).toHaveBeenLastCalledWith(expect.objectContaining({ continueFrom: expect.objectContaining({ type: "continue-turn" }) }));
    expect(agent.continued).toHaveBeenCalledWith(expect.objectContaining({ toolResultContinuations: [expect.objectContaining({ toolCallId: "tool-1", output: { type: "json", value: { found: true } } })] }));
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "succeeded", undefined, "idle", undefined, expect.objectContaining({ lifecycleState: resumeState }));
    expect(db.row.status).toBe("idle");
  });

  it("expires unresolved actions using the tool timeout (600 seconds by default)", async () => {
    const { result: _result, ...action } = pending();
    const db = modelFixture(session({ status: "waiting_action", lifecycle_state: continueState() }), turn({ status: "waiting_action", pending_actions: [{ ...action, requestedAt: new Date(Date.now() - 601_000).toISOString() }] }));
    const { runner } = fixture();
    harness({ hold: true });
    await runner.sweep();
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.finish).toHaveBeenCalledWith(db.row.id, db.active.id, "failed", "action_timeout", "idle", undefined, expect.anything());
  });

  it("fails an in-flight turn on shutdown and checkpoints idle sessions", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness({ hold: true });
    await runner.prompt(db.row.id, "keep working");
    await runner.shutdown();
    expect(agent.signal()?.aborted).toBe(true);
    expect(db.finish).toHaveBeenCalledWith(db.row.id, 12, "failed", "server_restart", "idle", undefined, expect.objectContaining({ lifecycleState: resumeState }));
    expect(agent.live.suspendTurn).not.toHaveBeenCalled();
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

  it("distinguishes caller cancellation from a time limit and persists the detached state", async () => {
    const db = modelFixture();
    const { runner } = fixture();
    const agent = harness({ hold: true });
    await runner.prompt(db.row.id, "cancel me");
    await runner.cancel(db.row.id);
    expect(agent.signal()?.aborted).toBe(true);
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "aborted", "cancelled", "idle", undefined, expect.objectContaining({ lifecycleState: resumeState }));

    db.active.status = "running";
    db.finish.mockClear();
    const held = Promise.withResolvers<void>();
    agent.stream.mockImplementation(async (options) => {
      options.abortSignal?.addEventListener("abort", () => held.resolve(), { once: true });
      return { fullStream: { async *[Symbol.asyncIterator]() { await held.promise; } } } as Awaited<ReturnType<HarnessAgent["stream"]>>;
    });
    await runner.prompt(db.row.id, "limited");
    runner.onLimitExceeded(db.row.id, "time");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    expect(db.finish).toHaveBeenLastCalledWith(db.row.id, 12, "failed", "limit_exceeded:time", "idle", undefined, expect.objectContaining({ lifecycleState: resumeState }));
  });

  it("stops the container after 10 seconds when Pi does not honor the abort", async () => {
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

  it("parks idle sessions with their detached state and restores them on the next prompt", async () => {
    const db = modelFixture(session({ last_turn_at: new Date(Date.now() - 1_801_000) }));
    const { runner, provider } = fixture();
    const agent = harness();
    await runner.prompt(db.row.id, "first");
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
    await runner.sweep();
    expect(provider.stopContainer).toHaveBeenCalledWith(db.row.id);
    expect(db.row).toMatchObject({ status: "stopped", stop_reason: "idle", lifecycle_state: resumeState });
    db.finish.mockClear();
    await runner.prompt(db.row.id, "second");
    expect(agent.create).toHaveBeenLastCalledWith(expect.objectContaining({ resumeFrom: resumeState }));
    await vi.waitFor(() => expect(db.finish).toHaveBeenCalled());
  });
});
