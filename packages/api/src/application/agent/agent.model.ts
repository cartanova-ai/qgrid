import { isDeepStrictEqual } from "node:util";

import { BaseModelClass, Puri, transactional } from "sonamu";

import { RequestLogModel, type RequestLogStepFields } from "../request-log/request-log.model";
import {
  type AgentSessionSubsetA,
  type AgentSessionStatus,
  type AgentTurnSubsetA,
  type AgentTurnStatus,
} from "../sonamu.generated";
import { type AgentLifecycleState, type AgentPendingActions, type AgentTools } from "./agent.types";

export type AgentSessionRow = AgentSessionSubsetA;

export type AgentTurnRow = AgentTurnSubsetA;

export type AgentActionResult = Omit<
  NonNullable<AgentPendingActions[number]["result"]>,
  "receivedAt"
>;

export type AgentSessionCreate = Omit<
  AgentSessionRow,
  "created_at" | "updated_at" | "last_turn_at"
> &
  Partial<Pick<AgentSessionRow, "created_at" | "updated_at" | "last_turn_at">>;

export class AgentStateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type StepInput = { key: string; seq?: number; step: Omit<RequestLogStepFields, "step_index"> };

type StepPatch = Partial<RequestLogStepFields>;

class AgentModelClass extends BaseModelClass {
  constructor() {
    super("AgentSession");
  }

  async listSessions(): Promise<AgentSessionRow[]> {
    return this.getPuri("w").from("agent_sessions").selectAll();
  }

  async getSession(id: string): Promise<AgentSessionRow> {
    const row = await this.getPuri("w").from("agent_sessions").selectAll().where("id", id).first();

    if (!row) throw new AgentStateError(404, "session_not_found");

    return row;
  }

  async getTurn(id: number): Promise<AgentTurnRow> {
    const row = await this.getPuri("w").from("agent_turns").selectAll().where("id", id).first();

    if (!row) throw new AgentStateError(404, "turn_not_found");

    return row;
  }

  async latestTurn(sessionId: string): Promise<AgentTurnRow | null> {
    return (
      (await this.getPuri("w")
        .from("agent_turns")
        .selectAll()
        .where("session_id", sessionId)
        .orderBy("index", "desc")
        .first()) ?? null
    );
  }

  async createSession(row: AgentSessionCreate): Promise<AgentSessionRow> {
    await this.getPuri("w").from("agent_sessions").insert(row);

    return this.getSession(row.id);
  }

  async updateSession(
    id: string,
    patch: Partial<Omit<AgentSessionRow, "id" | "status">>,
  ): Promise<void> {
    await this.getPuri("w")
      .from("agent_sessions")
      .where("id", id)
      .update({ ...patch, updated_at: new Date() });
  }

  async transition(
    id: string,
    from: AgentSessionStatus[],
    to: AgentSessionStatus,
    patch: Partial<Omit<AgentSessionRow, "id" | "status">> = {},
  ): Promise<AgentSessionRow> {
    const count = await this.getPuri("w")
      .from("agent_sessions")
      .where("id", id)
      .whereIn("status", from)
      .update({ ...patch, status: to, updated_at: new Date() });

    if (count === 0) {
      const current = await this.getSession(id);
      throw new AgentStateError(
        409,
        current.status === "running" || current.status === "waiting_action"
          ? "session_busy"
          : "invalid_state",
      );
    }

    return this.getSession(id);
  }

  @transactional({ dbPreset: "w" })
  async beginTurn(
    sessionId: string,
    prompt: string,
    redactedLog?: {
      user_prompt: string;
      system_prompt: string;
      project_name: string | null;
      tools: AgentTools;
    },
  ): Promise<AgentTurnRow> {
    const session = await this.transition(sessionId, ["idle"], "running", {
      last_turn_at: new Date(),
      stop_reason: null,
    });

    const previous = await this.latestTurn(sessionId);

    const requestLogId = await RequestLogModel.createRun({
      user_prompt: prompt,
      system_prompt: session.instructions,
      requested_model_name: session.model,
      project_name: session.project_name,
      tools: session.tools,
      ...redactedLog,
    });

    await RequestLogModel.recordRunProgress(requestLogId, { token_name: session.token_name });

    const rows = await this.getPuri("w")
      .from("agent_turns")
      .insert({
        session_id: sessionId,
        index: (previous?.index ?? -1) + 1,
        prompt,
        status: "running",
        request_log_id: requestLogId,
        pending_actions: [],
        logged_steps: {},
        last_logged_event_seq: previous?.last_logged_event_seq ?? 0,
      })
      .returning("id");

    return this.getTurn(rows[0]!.id);
  }

  private async lockTurn(turnId: number): Promise<AgentTurnRow> {
    const turn = await this.getPuri("w")
      .from("agent_turns")
      .selectAll()
      .where("id", turnId)
      .forUpdate()
      .first();

    if (!turn) throw new AgentStateError(404, "turn_not_found");

    return turn;
  }

  private async lockSession(sessionId: string): Promise<void> {
    const row = await this.getPuri("w")
      .from("agent_sessions")
      .select({ id: "id" })
      .where("id", sessionId)
      .forUpdate()
      .first();

    if (!row) throw new AgentStateError(404, "session_not_found");
  }

  @transactional({ dbPreset: "w" })
  async recordStep(turnId: number, input: StepInput): Promise<number> {
    const turn = await this.lockTurn(turnId);

    if (turn.status !== "running" && turn.status !== "waiting_action") {
      const existing = turn.logged_steps[input.key];

      if (existing !== undefined) return existing;
      throw new AgentStateError(409, "invalid_state");
    }

    return this.appendStep(turn, input);
  }

  private async appendStep(turn: AgentTurnRow, { key, seq, step }: StepInput): Promise<number> {
    if (turn.request_log_id === null) throw new Error("Agent turn has no request log");

    const existing =
      turn.logged_steps[key] ?? (seq === undefined ? undefined : turn.logged_steps[`seq:${seq}`]);

    let stepId = existing;

    if (stepId === undefined) {
      const row = await this.getPuri("w")
        .from("request_log_steps")
        .select({ max: Puri.max("step_index") })
        .where("request_log_id", turn.request_log_id)
        .first();

      stepId = await RequestLogModel.appendStep(turn.request_log_id, {
        ...step,
        step_index: (row?.max ?? -1) + 1,
      });
    }

    const logged = { ...turn.logged_steps, [key]: stepId };

    if (seq !== undefined) logged[`seq:${seq}`] = stepId;
    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turn.id)
      .update({
        logged_steps: logged,
        last_logged_event_seq: Math.max(turn.last_logged_event_seq, seq ?? 0),
      });

    return stepId;
  }

  @transactional({ dbPreset: "w" })
  async recordCallStart(turnId: number, key: string, model: string): Promise<number> {
    const turn = await this.lockTurn(turnId);

    if (turn.status !== "running") throw new AgentStateError(409, "invalid_state");
    const duplicate = turn.logged_steps[key] !== undefined;

    const id = await this.appendStep(turn, {
      key,
      step: {
        type: "generate",
        requested_model_name: model,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        cost_usd: null,
      },
    });

    if (!duplicate)
      await this.getPuri("w")
        .from("agent_turns")
        .where("id", turnId)
        .increment("model_call_count", 1);

    return id;
  }

  @transactional({ dbPreset: "w" })
  async updateStep(turnId: number, key: string, patch: StepPatch, alias?: string): Promise<void> {
    const turn = await this.lockTurn(turnId);
    const stepId = turn.logged_steps[key];

    if (stepId === undefined) throw new Error(`Missing agent step ${key}`);
    await this.getPuri("w").from("request_log_steps").where("id", stepId).update(patch);

    if (alias)
      await this.getPuri("w")
        .from("agent_turns")
        .where("id", turnId)
        .update({ logged_steps: { ...turn.logged_steps, [alias]: stepId } });
  }

  @transactional({ dbPreset: "w" })
  async recoverCalls(turnId: number): Promise<void> {
    const turn = await this.lockTurn(turnId);

    if (turn.request_log_id === null) return;

    const unfinished = await this.getPuri("w")
      .from("request_log_steps")
      .select({ id: "id", created_at: "created_at" })
      .where("request_log_id", turn.request_log_id)
      .where("type", "generate")
      .where("duration_ms", null)
      .where("error", null);

    for (const step of unfinished) {
      await this.getPuri("w")
        .from("request_log_steps")
        .where("id", step.id)
        .update({
          error: "upstream_disconnected",
          duration_ms: Math.min(
            2_147_483_647,
            Math.max(0, Date.now() - new Date(step.created_at).getTime()),
          ),
        });
    }
  }

  @transactional({ dbPreset: "w" })
  async recordEvent(
    turnId: number,
    seq: number | undefined,
    patch: Pick<Partial<AgentTurnRow>, "result_text"> = {},
  ): Promise<void> {
    const turn = await this.lockTurn(turnId);

    if (turn.status !== "running" && turn.status !== "waiting_action") return;

    if (seq !== undefined && seq <= turn.last_logged_event_seq) return;
    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turnId)
      .update({
        ...patch,
        last_logged_event_seq: Math.max(turn.last_logged_event_seq, seq ?? 0),
      });
  }

  @transactional({ dbPreset: "w" })
  async recordToolResult(
    turnId: number,
    input: {
      toolCallId: string;
      output?: unknown;
      error?: string;
      seq?: number;
      truncate?: boolean;
    },
  ): Promise<void> {
    const turn = await this.lockTurn(turnId);

    if (turn.status !== "running" && turn.status !== "waiting_action") return;

    if (input.seq !== undefined && input.seq <= turn.last_logged_event_seq) return;

    // Tool results are intentionally opaque JSON; strings stay readable in existing log views.
    const text =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      typeof input.output === "string" ? input.output : (JSON.stringify(input.output) ?? "null");

    const output = input.truncate
      ? new TextDecoder().decode(Buffer.from(text).subarray(0, 4096), { stream: true })
      : text;

    if (turn.request_log_id !== null) {
      const step = await this.getPuri("w")
        .from("request_log_steps")
        .select({ created_at: "created_at" })
        .where("request_log_id", turn.request_log_id)
        .where("tool_call_id", input.toolCallId)
        .where("type", "tool_call")
        .first();

      await this.getPuri("w")
        .from("request_log_steps")
        .where("request_log_id", turn.request_log_id)
        .where("tool_call_id", input.toolCallId)
        .where("type", "tool_call")
        .update({
          tool_result: input.error === undefined ? output : null,
          error: input.error ?? null,
          tool_duration_ms: step
            ? Math.max(0, Date.now() - new Date(step.created_at).getTime())
            : null,
        });
    }

    const pending = turn.pending_actions.map((action) =>
      action.toolCallId === input.toolCallId && action.result
        ? { ...action, deliveredAt: action.deliveredAt ?? new Date().toISOString() }
        : action,
    );

    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turnId)
      .update({
        pending_actions: pending,
        last_logged_event_seq: Math.max(turn.last_logged_event_seq, input.seq ?? 0),
      });
  }

  @transactional({ dbPreset: "w" })
  async suspend(
    sessionId: string,
    turnId: number,
    envelope: AgentLifecycleState,
    pending: AgentPendingActions,
    seq: number,
  ): Promise<void> {
    await this.lockSession(sessionId);
    const turn = await this.lockTurn(turnId);
    const merged = new Map(turn.pending_actions.map((action) => [action.toolCallId, action]));

    for (const action of pending) {
      merged.set(action.toolCallId, { ...action, ...merged.get(action.toolCallId) });
    }

    await this.transition(sessionId, ["running"], "waiting_action", { lifecycle_state: envelope });
    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turnId)
      .where("status", "running")
      .update({
        status: "waiting_action",
        pending_actions: [...merged.values()],
        last_logged_event_seq: Math.max(turn.last_logged_event_seq, seq),
      });
  }

  @transactional({ dbPreset: "w" })
  async checkpoint(
    sessionId: string,
    turnId: number | null,
    envelope: AgentLifecycleState,
    seq: number,
    pending?: AgentPendingActions,
  ): Promise<void> {
    await this.lockSession(sessionId);
    await this.updateSession(sessionId, { lifecycle_state: envelope });

    if (turnId !== null) {
      const turn = await this.lockTurn(turnId);

      const update: Partial<AgentTurnRow> = {
        last_logged_event_seq: Math.max(turn.last_logged_event_seq, seq),
      };

      if (pending !== undefined) update.pending_actions = pending;
      await this.getPuri("w").from("agent_turns").where("id", turnId).update(update);
    }
  }

  @transactional({ dbPreset: "w" })
  async saveActionResult(
    sessionId: string,
    toolCallId: string,
    result: AgentActionResult,
  ): Promise<{ turn: AgentTurnRow; duplicate: boolean }> {
    await this.lockSession(sessionId);
    const latest = await this.latestTurn(sessionId);

    if (!latest) throw new AgentStateError(404, "action_not_found");
    const turn = await this.lockTurn(latest.id);
    const action = turn.pending_actions.find((item) => item.toolCallId === toolCallId);

    if (!action) throw new AgentStateError(404, "action_not_found");

    if (action.result) {
      if (
        !isDeepStrictEqual(
          { output: action.result.output, error: action.result.error },
          { output: result.output, error: result.error },
        )
      )
        throw new AgentStateError(409, "action_result_conflict");

      return { turn, duplicate: true };
    }

    if (turn.status !== "waiting_action" && turn.status !== "running")
      throw new AgentStateError(409, "invalid_state");
    action.result = { ...result, receivedAt: new Date().toISOString() };
    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turn.id)
      .update({ pending_actions: turn.pending_actions });

    if (turn.request_log_id !== null)
      await this.getPuri("w")
        .from("request_log_steps")
        .where("request_log_id", turn.request_log_id)
        .where("tool_call_id", toolCallId)
        .where("type", "tool_call")
        .update({
          tool_result:
            result.error === undefined ? (JSON.stringify(result.output) ?? "null") : null,
          error: result.error ?? null,
          tool_duration_ms: Math.max(0, Date.now() - Date.parse(action.requestedAt)),
        });

    return { turn, duplicate: false };
  }

  @transactional({ dbPreset: "w" })
  async markDelivered(turnId: number, ids: string[]): Promise<void> {
    const turn = await this.lockTurn(turnId);
    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turnId)
      .update({
        pending_actions: turn.pending_actions.map((action) =>
          ids.includes(action.toolCallId) && action.result
            ? { ...action, deliveredAt: action.deliveredAt ?? new Date().toISOString() }
            : action,
        ),
      });
  }

  @transactional({ dbPreset: "w" })
  async claimContinuation(
    sessionId: string,
    allowIncomplete: boolean = false,
  ): Promise<AgentTurnRow> {
    await this.lockSession(sessionId);
    const turn = await this.latestTurn(sessionId);

    if (!turn) throw new AgentStateError(404, "turn_not_found");

    if (
      !allowIncomplete &&
      (!turn.pending_actions.length || turn.pending_actions.some((action) => !action.result))
    )
      throw new AgentStateError(409, "invalid_state");
    await this.transition(sessionId, ["waiting_action"], "running");
    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turn.id)
      .where("status", "waiting_action")
      .update({ status: "running" });

    return this.getTurn(turn.id);
  }

  @transactional({ dbPreset: "w" })
  async finish(
    sessionId: string,
    turnId: number,
    status: Extract<AgentTurnStatus, "succeeded" | "failed" | "aborted">,
    error?: string,
    sessionStatus: "idle" | "stopped" | "failed" = "idle",
    stopReason?: string,
    checkpoint?: { lifecycleState: AgentLifecycleState; seq: number; resultText: string },
  ): Promise<AgentTurnRow> {
    await this.lockSession(sessionId);
    const turn = await this.lockTurn(turnId);

    if (turn.status !== "running" && turn.status !== "waiting_action") return turn;
    const session = await this.getSession(sessionId);
    const now = new Date();

    const usage =
      turn.request_log_id === null
        ? null
        : await RequestLogModel.aggregateStepUsage(turn.request_log_id, "w");

    if (turn.request_log_id !== null && usage) {
      const lastStep = await this.getPuri("w")
        .from("request_log_steps")
        .select({ model_name: "model_name" })
        .where("request_log_id", turn.request_log_id)
        .where("type", "generate")
        .where("model_name", "!=", null)
        .orderBy("step_index", "desc")
        .first();

      const toolCount = await this.getPuri("w")
        .from("request_log_steps")
        .select({ count: Puri.count("id") })
        .where("request_log_id", turn.request_log_id)
        .where("type", "tool_call")
        .first();

      await RequestLogModel.finishRun(turn.request_log_id, {
        ...usage,
        status: status === "failed" ? "error" : status,
        token_name: session.token_name,
        requested_model_name: session.model,
        model_name: lastStep?.model_name ?? null,
        cost_source: "pricing_table",
        duration_ms: now.getTime() - new Date(turn.started_at).getTime(),
        response: checkpoint?.resultText ?? turn.result_text ?? "",
        error_message: error,
        tool_call_count: Number(toolCount?.count ?? 0),
      });
    }

    await this.getPuri("w")
      .from("agent_turns")
      .where("id", turnId)
      .update({
        status,
        finished_at: now,
        error_message: error ?? null,
        usage,
        result_text: checkpoint?.resultText ?? turn.result_text,
        last_logged_event_seq: Math.max(turn.last_logged_event_seq, checkpoint?.seq ?? 0),
      });
    await this.transition(sessionId, ["running", "waiting_action"], sessionStatus, {
      stop_reason: stopReason ?? null,
      last_turn_at: now,
      lifecycle_state: checkpoint?.lifecycleState ?? session.lifecycle_state,
    });

    return this.getTurn(turnId);
  }
}

export const AgentModel = new AgentModelClass();
