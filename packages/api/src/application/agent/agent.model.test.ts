import { randomUUID } from "node:crypto";

import { Client, type ClientConfig } from "pg";
import { Sonamu } from "sonamu";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RequestLogModel } from "../request-log/request-log.model";
import { AgentModel, type AgentSessionRow, type AgentTurnRow } from "./agent.model";
import { type AgentLifecycleState, type AgentPendingActions } from "./agent.types";

const sessions: string[] = [];
const tokens: number[] = [];
const logs: number[] = [];

async function fixture(): Promise<AgentSessionRow> {
  const id = randomUUID();
  const [token] = await AgentModel.getPuri("w").from("tokens").insert({
    provider: "openai", name: `agent-test-${id}`,
    credentials: { accessToken: "test", refreshToken: "test", accessTokenExpiresAt: 0, accountId: id },
  }).returning("id");
  tokens.push(token!.id);
  const session = await AgentModel.createSession({
    id, harness: "pi", status: "idle", model: "openai/gpt-6-astra",
    token_id: token!.id, token_name: "openai/agent-test", project_name: `agent-test-${id}`,
    instructions: "test", tools: [], webhook_url: null, webhook_secret: null,
    lifecycle_state: null, container_name: `qgrid-agents-${id}`, container_ip: "172.30.0.2",
    idle_ttl_sec: 1800, retain_sec: 86400, stop_reason: null,
  });
  sessions.push(id);
  return session;
}

async function begin(session: AgentSessionRow): Promise<AgentTurnRow> {
  const turn = await AgentModel.beginTurn(session.id, "test prompt");
  logs.push(turn.request_log_id!);
  return turn;
}

const envelope: AgentLifecycleState = {
  type: "continue-turn", harnessId: "qgrid-pi", specificationVersion: "harness-v1",
  data: { bridge: { port: 8787, lastSeenEventId: 7 }, piSession: "test", model: "openai/gpt-6-astra", instructionsHash: null },
  pendingToolResults: [{ toolCallId: "action-1", toolName: "approve", input: { issue: 1 } }],
  turnSettings: { model: "openai/gpt-6-astra", instructions: "test" },
};

const pending: AgentPendingActions = [{
  toolCallId: "action-1", toolName: "approve", input: { issue: 1 },
  gate: "approval", requestedAt: new Date().toISOString(),
}];

async function waitingFixture() {
  const session = await fixture();
  const turn = await begin(session);
  await AgentModel.recordStep(turn.id, {
    key: "tool:action-1", step: { type: "tool_call", tool_call_id: "action-1", tool_name: "approve", tool_args: "{}" },
  });
  await AgentModel.suspend(session.id, turn.id, envelope, pending, 7);
  return { session, turn };
}

describe("AgentModel PostgreSQL lifecycle", () => {
  beforeAll(async () => {
    await Sonamu.initForTesting();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const wdb = AgentModel.getPuri("w");
    if (sessions.length) await wdb.from("agent_sessions").whereIn("id", sessions.splice(0)).delete();
    if (logs.length) await wdb.from("request_logs").whereIn("id", logs.splice(0)).delete();
    if (tokens.length) await wdb.from("tokens").whereIn("id", tokens.splice(0)).delete();
  });

  it("claims only one concurrent prompt and creates no log for the rejected transition", async () => {
    const session = await fixture();
    const outcomes = await Promise.allSettled([
      AgentModel.beginTurn(session.id, "first"), AgentModel.beginTurn(session.id, "second"),
    ]);
    const success = outcomes.find((outcome) => outcome.status === "fulfilled");
    expect(success?.status).toBe("fulfilled");
    if (success?.status !== "fulfilled") throw new Error("No prompt was claimed");
    logs.push(success.value.request_log_id!);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected", reason: { status: 409, code: "session_busy" } });
    const rows = await AgentModel.getPuri("w").from("request_logs").select({ id: "id" })
      .where("project_name", session.project_name!);
    expect(rows).toHaveLength(1);
    await expect(AgentModel.transition(session.id, ["stopped"], "idle")).rejects.toMatchObject({ status: 409 });
    await AgentModel.transition(session.id, ["running"], "failed");
    await expect(AgentModel.beginTurn(session.id, "again")).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("commits a stable step and its cursor together, rolls both back, and ignores replay", async () => {
    const turn = await begin(await fixture());
    const step = { type: "tool_call" as const, tool_call_id: "tool-7", tool_name: "read" };
    await expect(AgentModel.recordStep(turn.id, { key: "tool:tool-7", seq: Number.NaN, step })).rejects.toThrow();
    expect((await AgentModel.getTurn(turn.id)).last_logged_event_seq).toBe(0);
    expect(await AgentModel.getPuri("w").from("request_log_steps").select({ id: "id" })
      .where("request_log_id", turn.request_log_id!)).toEqual([]);

    const append = RequestLogModel.appendStep.bind(RequestLogModel);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(RequestLogModel, "appendStep").mockImplementationOnce(async (...args) => {
      const id = await append(...args);
      entered.resolve();
      await release.promise;
      return id;
    });
    const writing = AgentModel.recordStep(turn.id, { key: "tool:tool-7", seq: 7, step });
    const client = new Client(AgentModel.getPuri("w").knex.client.config.connection as ClientConfig);
    await client.connect();
    try {
      await entered.promise;
      const unseenStep = await client.query("SELECT id FROM request_log_steps WHERE request_log_id = $1", [turn.request_log_id]);
      const cursor = await client.query("SELECT last_logged_event_seq FROM agent_turns WHERE id = $1", [turn.id]);
      expect(unseenStep.rows).toEqual([]);
      expect(cursor.rows[0].last_logged_event_seq).toBe(0);
    } finally {
      release.resolve();
      await client.end();
    }
    const first = await writing;
    const replay = await AgentModel.recordStep(turn.id, { key: "tool:tool-7", seq: 7, step });
    expect(replay).toBe(first);
    expect((await AgentModel.getTurn(turn.id)).logged_steps).toEqual({ "tool:tool-7": first, "seq:7": first });
    expect((await AgentModel.getTurn(turn.id)).last_logged_event_seq).toBe(7);
    expect(await AgentModel.getPuri("w").from("request_log_steps").select({ id: "id" })
      .where("request_log_id", turn.request_log_id!)).toHaveLength(1);
  });

  it("saves the full waiting envelope and cursor atomically before accepting idempotent action results", async () => {
    const { session, turn } = await waitingFixture();
    expect(await AgentModel.getSession(session.id)).toMatchObject({ status: "waiting_action", lifecycle_state: envelope });
    expect(await AgentModel.getTurn(turn.id)).toMatchObject({ status: "waiting_action", pending_actions: pending, last_logged_event_seq: 7 });
    await expect(AgentModel.saveActionResult(session.id, "missing", { output: true })).rejects.toMatchObject({ status: 404 });
    // A process exit before saving leaves the action pending; replay of the request saves it once.
    expect((await AgentModel.getTurn(turn.id)).pending_actions[0]!.result).toBeUndefined();
    const first = await AgentModel.saveActionResult(session.id, "action-1", { output: { approved: true, issue: 1 } });
    expect(first.duplicate).toBe(false);
    // The DB record survives an exit after save but before continuation delivery.
    expect((await AgentModel.getTurn(turn.id)).pending_actions[0]).toMatchObject({ result: { output: { approved: true, issue: 1 } } });
    expect((await AgentModel.getTurn(turn.id)).pending_actions[0]!.deliveredAt).toBeUndefined();
    const second = await AgentModel.saveActionResult(session.id, "action-1", { output: { issue: 1, approved: true } });
    expect(second.duplicate).toBe(true);
    await expect(AgentModel.saveActionResult(session.id, "action-1", { output: false })).rejects.toMatchObject({ status: 409, code: "action_result_conflict" });
    await AgentModel.claimContinuation(session.id);
    await AgentModel.recordToolResult(turn.id, { toolCallId: "action-1", output: { approved: true, issue: 1 }, seq: 8 });
    const delivered = (await AgentModel.getTurn(turn.id)).pending_actions[0]!.deliveredAt;
    expect(delivered).toBeDefined();
    const checkpoint = { lifecycleState: { ...envelope, type: "resume-session" }, seq: 9, resultText: "completed" };
    await expect(AgentModel.finish(session.id, turn.id, "succeeded", undefined, "idle", undefined, { ...checkpoint, seq: Number.NaN })).rejects.toThrow();
    expect((await AgentModel.getSession(session.id)).status).toBe("running");
    expect((await AgentModel.getPuri("w").from("request_logs").selectAll().where("id", turn.request_log_id!).first())?.status).toBe("running");
    await AgentModel.finish(session.id, turn.id, "succeeded", undefined, "idle", undefined, checkpoint);
    expect(await AgentModel.getSession(session.id)).toMatchObject({ status: "idle", lifecycle_state: checkpoint.lifecycleState });
    expect(await AgentModel.getTurn(turn.id)).toMatchObject({ status: "succeeded", last_logged_event_seq: 9, result_text: "completed" });
    // An exit after delivery/completion cannot deliver an identical request a second time.
    expect((await AgentModel.saveActionResult(session.id, "action-1", { output: { approved: true, issue: 1 } })).duplicate).toBe(true);
    expect((await AgentModel.getTurn(turn.id)).pending_actions[0]!.deliveredAt).toBe(delivered);
  });

  it("keeps caller abort and limit failure distinct and rolls model usage into the parent", async () => {
    for (const status of ["aborted", "failed"] as const) {
      const session = await fixture();
      const turn = await begin(session);
      const first = await AgentModel.recordCallStart(turn.id, "call:one", session.model);
      expect(await AgentModel.recordCallStart(turn.id, "call:one", session.model)).toBe(first);
      expect((await AgentModel.getTurn(turn.id)).model_call_count).toBe(1);
      await AgentModel.updateStep(turn.id, "call:one", {
        model_name: "openai/gpt-6-astra", input_tokens: 100, output_tokens: 30,
        cache_read_tokens: 40, cache_creation_tokens: 0, cost_usd: 123,
        cost_source: "pricing_table", duration_ms: 50,
      }, "response:resp-one");
      await AgentModel.recordEvent(turn.id, 2, { result_text: "partial answer" });
      const error = status === "failed" ? "limit_exceeded:model_calls" : "cancelled";
      const finished = await AgentModel.finish(session.id, turn.id, status, error, "stopped", "abort_timeout");
      expect(finished).toMatchObject({ status, error_message: error });
      expect(await AgentModel.getSession(session.id)).toMatchObject({ status: "stopped", stop_reason: "abort_timeout" });
      const log = await AgentModel.getPuri("w").from("request_logs").selectAll().where("id", turn.request_log_id!).first();
      expect(log).toMatchObject({
        status: status === "failed" ? "error" : "aborted", token_name: session.token_name,
        requested_model_name: session.model, model_name: session.model,
        input_tokens: 100, output_tokens: 30, cache_read_tokens: 40,
        cost_usd: 123, cost_source: "pricing_table", response: "partial answer", error_message: error,
      });
    }
  });

  it("retains earlier action receipts across slices and permits cancellation without results", async () => {
    const { session, turn } = await waitingFixture();
    await expect(AgentModel.claimContinuation(session.id)).rejects.toMatchObject({ status: 409 });
    await AgentModel.saveActionResult(session.id, "action-1", { output: "approved" });
    await AgentModel.claimContinuation(session.id);
    await AgentModel.markDelivered(turn.id, ["action-1"]);
    const earlier = (await AgentModel.getTurn(turn.id)).pending_actions[0]!;
    await AgentModel.suspend(session.id, turn.id, envelope, [{
      ...pending[0]!, toolCallId: "action-2",
    }], 9);
    const waiting = await AgentModel.getTurn(turn.id);
    expect(waiting.pending_actions).toHaveLength(2);
    expect(waiting.pending_actions[0]).toEqual(earlier);
    expect((await AgentModel.saveActionResult(session.id, "action-1", { output: "approved" })).duplicate).toBe(true);
    await AgentModel.claimContinuation(session.id, true);
    await AgentModel.finish(session.id, turn.id, "aborted", "cancelled");
    await AgentModel.recordEvent(turn.id, 100, { result_text: "late event" });
    await AgentModel.recordToolResult(turn.id, { toolCallId: "action-2", output: "late", seq: 101 });
    await expect(AgentModel.recordStep(turn.id, { key: "late", seq: 102, step: { type: "tool_call" } })).rejects.toMatchObject({ code: "invalid_state" });
    expect(await AgentModel.getTurn(turn.id)).toMatchObject({ status: "aborted", last_logged_event_seq: 9, result_text: null });
  });

  it("leaves agent-owned waiting runs to the runner instead of the native stale cleaner", async () => {
    const { turn } = await waitingFixture();
    const threshold = new Date(Date.now() + 60_000);
    expect(await RequestLogModel.findStaleToolWaitingRunCandidates(threshold, 100)).not.toContain(turn.request_log_id);
    expect(await RequestLogModel.tryExpireStaleToolWaitingRun(turn.request_log_id!, threshold, "stale")).toBe(false);
    const log = await AgentModel.getPuri("w").from("request_logs").select({ status: "status" }).where("id", turn.request_log_id!).first();
    expect(log?.status).toBe("running");
  });

  it("marks relay attempts interrupted by host loss without inventing usage", async () => {
    const turn = await begin(await fixture());
    const interrupted = await AgentModel.recordCallStart(turn.id, "call:interrupted", "openai/gpt-6-astra");
    const completed = await AgentModel.recordCallStart(turn.id, "call:complete", "openai/gpt-6-astra");
    await AgentModel.updateStep(turn.id, "call:complete", { duration_ms: 10, input_tokens: 25, output_tokens: 5 });
    await AgentModel.recoverCalls(turn.id);
    const wdb = AgentModel.getPuri("w");
    expect(await wdb.from("request_log_steps").selectAll().where("id", interrupted).first()).toMatchObject({
      error: "upstream_disconnected", input_tokens: null, output_tokens: null,
    });
    expect(await wdb.from("request_log_steps").selectAll().where("id", completed).first()).toMatchObject({
      error: null, duration_ms: 10, input_tokens: 25, output_tokens: 5,
    });
    expect((await AgentModel.getTurn(turn.id)).model_call_count).toBe(2);
  });
});
