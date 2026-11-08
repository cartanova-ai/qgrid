import { randomUUID } from "node:crypto";

import {
  type HarnessV1ContinueTurnState,
  type HarnessV1LifecycleState,
  type HarnessV1StreamPart,
} from "@ai-sdk/harness";
import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { getLogger } from "@logtape/logtape";
import { jsonSchema, tool, type ToolSet, type ToolResultPart } from "ai";
import { z } from "zod";

import {
  AgentModel,
  AgentStateError,
  type AgentSessionRow as AgentSessionBase,
  type AgentTurnRow as AgentTurnBase,
} from "../../application/agent/agent.model";
import {
  type AgentPendingActions,
  type AgentTools,
  type AgentWorkspace,
} from "../../application/agent/agent.types";
import { QuotaThresholdExceededError } from "../../application/qgrid/qgrid.types";
import { calculateCostUsd } from "../providers/common/model-cost";
import { jsonValueSchema, type JsonValue } from "../providers/common/provider-types";
import { type OpenAIDispatcher } from "../providers/openai/openai-dispatcher";
import { type DockerSandboxProvider, type DockerSandboxSession } from "./docker-sandbox";
import {
  createSandboxPi,
  derivePiSessionSecrets,
  reconstructContinueState,
  PI_BUILTIN_TOOLS,
} from "./pi-harness";
import {
  type AgentsRelay,
  type RelayCallEnd,
  type RelayCallStart,
  type RelaySessionStore,
} from "./relay";
import {
  prepareWorkspace,
  readWorkspaceDiff,
  redactAgentValue,
  WORKSPACE_DIFF_MAX_BYTES,
} from "./workspace";

const logger = getLogger(["qgrid", "agents", "runner"]);

// The catalog shipped in the pinned Pi sandbox image, not the wider qgrid catalog.
export const PI_MODELS = [
  "openai/gpt-6-astra",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
] as const;

export type AgentSessionRunnerOptions = {
  provider: DockerSandboxProvider;
  dispatcher: Pick<OpenAIDispatcher, "selectToken">;
  secret: string;
  relayBaseUrl: string;
  maxSessions: number;
  idleTtlSec: number;
  retainSec: number;
  maxModelCallsPerTurn: number;
  maxTurnSeconds: number;
  minFreeDiskGb: number;
};

export type CreateAgentSession = {
  model: string;
  instructions?: string;
  tools?: AgentTools;
  projectName?: string;
  tokenId?: number;
  idleTtlSec?: number;
  retainSec?: number;
  workspace?: AgentWorkspace;
  env?: Record<string, string>;
};

type PiAgent = HarnessAgent<ReturnType<typeof createSandboxPi>, ToolSet>;

type Stop = { status: "aborted" | "failed"; reason: string };

type Handle = {
  agent: PiAgent;
  sandbox: DockerSandboxSession;
  session?: HarnessAgentSession;
  turn?: AgentTurnBase;
  task?: Promise<void>;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  stop?: Stop;
  suspending?: boolean;
  ended?: boolean;
  seq: number;
  text: string;
  pendingBoundary: boolean;
  bridgeResults: Array<Extract<HarnessV1StreamPart, { type: "tool-result" }> & { seq: number }>;
  abortFinish: ReturnType<typeof Promise.withResolvers<void>>;
  checkpoint?: { lifecycleState: HarnessV1LifecycleState; seq: number; resultText: string };
};

const eventSequence = z.object({
  providerMetadata: z.object({ qgrid: z.object({ seq: z.number().int().nonnegative() }) }),
});

const bridgeCursor = z.object({
  bridge: z.object({ lastSeenEventId: z.number().int().nonnegative() }),
});

const responseUsage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
});

// The framework validates adapter data on createSession; preserve its complete opaque envelope.
const lifecycleSchema = z.custom<HarnessV1LifecycleState>(
  (value) =>
    z
      .object({
        type: z.enum(["continue-turn", "resume-session"]),
        harnessId: z.literal("qgrid-pi"),
        specificationVersion: z.literal("harness-v1"),
        data: z.json(),
      })
      .safeParse(value).success,
);

/** Runner owns Docker lifecycle; HarnessAgent only owns its local bridge connection. */
export class AgentSessionRunner implements RelaySessionStore {
  private readonly handles = new Map<string, Handle>();
  private readonly keys = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly calls = new Map<
    string,
    { sessionId: string; turnId: number; model: string; done: Promise<void>; resolve: () => void }
  >();
  private relay?: AgentsRelay;
  private sweeper?: ReturnType<typeof setInterval>;
  private shuttingDown = false;
  private count = 0;
  private readonly secrets = new Map<string, string[]>();

  constructor(private readonly options: AgentSessionRunnerOptions) {}

  setRelay(relay: AgentsRelay) {
    this.relay = relay;
  }
  sessionCount() {
    return this.count;
  }

  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const tail = before.then(() => promise);
    this.locks.set(id, tail);
    await before;

    try {
      return await operation();
    } finally {
      resolve();

      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  async create(input: CreateAgentSession): Promise<AgentSessionBase & { readyMs: number }> {
    if (!z.enum(PI_MODELS).safeParse(input.model).success)
      throw new AgentStateError(400, "unsupported_agent_model");
    const names = new Set<string>();

    for (const definition of input.tools ?? []) {
      if (definition.name in PI_BUILTIN_TOOLS || names.has(definition.name))
        throw new AgentStateError(400, "invalid_tool_name");
      names.add(definition.name);
    }

    return this.locked("create", async () => {
      if (this.shuttingDown) throw new AgentStateError(503, "agents_shutting_down");
      const sessions = await AgentModel.listSessions();

      if (sessions.filter((row) => row.status !== "destroyed").length >= this.options.maxSessions)
        throw new AgentStateError(429, "limit_exceeded:max_sessions");
      await this.checkDisk();

      const signal = new AbortController().signal;

      const selectToken = () =>
        this.options.dispatcher.selectToken(input.tokenId, input.tokenId !== undefined, signal);

      const selected = await selectToken().catch(async () => {
        // Token refresh/NOTIFY can invalidate the metadata generation during selection.
        await new Promise((resolve) => setTimeout(resolve, 250));

        try {
          return await selectToken();
        } catch (error) {
          if (error instanceof QuotaThresholdExceededError)
            throw new AgentStateError(503, "quota_exceeded");

          if (error instanceof Error && error.message === "NO_OPENAI_WORKERS")
            throw new AgentStateError(503, "token_unavailable");
          throw error;
        }
      });

      const id = randomUUID();
      this.secrets.set(
        id,
        [...new Set([...Object.values(input.env ?? {}), input.workspace?.git?.token ?? ""])]
          .filter(Boolean)
          .toSorted((a, b) => b.length - a.length),
      );
      const now = new Date();
      await AgentModel.createSession({
        id,
        status: "creating",
        harness: "pi",
        model: input.model,
        token_id: selected.tokenId,
        token_name: selected.metadata.name,
        project_name: input.projectName ?? null,
        instructions: input.instructions ?? "",
        tools: input.tools ?? [],
        webhook_url: null,
        webhook_secret: null,
        lifecycle_state: null,
        container_name: `qgrid-agents-${id}`,
        container_ip: "",
        idle_ttl_sec: input.idleTtlSec ?? this.options.idleTtlSec,
        retain_sec: input.retainSec ?? this.options.retainSec,
        stop_reason: null,
        last_turn_at: now,
        created_at: now,
        updated_at: now,
      });
      this.register(id);
      this.count++;

      try {
        const row = await AgentModel.getSession(id);
        const startedAt = performance.now();

        const sandbox = await this.options.provider.createSession({
          sessionId: id,
          env: input.env,
        });

        await prepareWorkspace(sandbox, input.workspace);
        const handle = this.newHandle(row, sandbox);
        this.handles.set(id, handle);
        handle.session = await handle.agent.createSession({
          sessionId: id,
          sandboxSession: sandbox,
        });
        const readyMs = performance.now() - startedAt;
        await AgentModel.transition(id, ["creating"], "idle", {
          container_ip: await this.options.provider.inspectIp(id),
        });

        return { ...(await AgentModel.getSession(id)), readyMs };
      } catch (error) {
        await this.options.provider.destroyContainer(id);
        this.handles.delete(id);
        await AgentModel.transition(id, ["creating"], "failed");
        throw error;
      }
    });
  }

  async prompt(sessionId: string, prompt: string): Promise<AgentTurnBase> {
    return this.locked(sessionId, async () => {
      if (this.shuttingDown) throw new AgentStateError(503, "agents_shutting_down");
      let row = await AgentModel.getSession(sessionId);

      if (row.status === "running" || row.status === "waiting_action")
        throw new AgentStateError(409, "session_busy");

      await this.loadSecrets(row);

      if (row.status === "stopped") {
        try {
          await this.attach(row, false);
          await AgentModel.transition(sessionId, ["stopped"], "idle", {
            stop_reason: null,
            container_ip: await this.options.provider.inspectIp(sessionId),
          });
          row = await AgentModel.getSession(sessionId);
        } catch (error) {
          await AgentModel.transition(sessionId, ["stopped"], "failed");
          throw error;
        }
      }

      // Claim before allocating a request log; concurrent prompts fail without creating a run.
      // Mask log content without changing the prompt or tool schemas executed by Pi.
      const turn = await AgentModel.beginTurn(
        sessionId,
        prompt,
        this.redact(sessionId, {
          user_prompt: prompt,
          system_prompt: row.instructions,
          project_name: row.project_name,
          tools: row.tools,
        }),
      );

      try {
        await this.checkDisk();

        const handle = this.handles.get(sessionId)?.session
          ? this.handles.get(sessionId)!
          : await this.attach(row, false);

        this.launch(row, turn, handle, false);
      } catch (error) {
        await AgentModel.finish(
          sessionId,
          turn.id,
          "failed",
          this.redact(sessionId, error instanceof Error ? error.message : "turn_start_failed"),
        );
        throw error;
      }

      return turn;
    });
  }

  async actionResult(
    sessionId: string,
    toolCallId: string,
    result: { output?: JsonValue; error?: string },
  ) {
    return this.locked(sessionId, async () => {
      if (this.shuttingDown) throw new AgentStateError(503, "agents_shutting_down");
      const saved = await AgentModel.saveActionResult(sessionId, toolCallId, result);
      const row = await AgentModel.getSession(sessionId);

      if (
        row.status === "waiting_action" &&
        saved.turn.pending_actions.length > 0 &&
        saved.turn.pending_actions.every((action) => action.result)
      ) {
        await AgentModel.claimContinuation(sessionId);
        await this.resumeTurn(await AgentModel.getSession(sessionId), saved.turn);
      }

      return { ...saved, turn: await AgentModel.getTurn(saved.turn.id) };
    });
  }

  redact<T>(sessionId: string, value: T, additionalSecrets: readonly string[] = []): T {
    return redactAgentValue(
      value,
      [...(this.secrets.get(sessionId) ?? []), ...additionalSecrets]
        .filter(Boolean)
        .toSorted((a, b) => b.length - a.length),
    );
  }

  private async loadSecrets(row: AgentSessionBase) {
    if (this.secrets.has(row.id) || row.status === "destroyed" || row.status === "failed") return;
    const env = await this.options.provider.callerEnvironment(row.id);
    this.secrets.set(
      row.id,
      [...new Set(Object.values(env))].filter(Boolean).toSorted((a, b) => b.length - a.length),
    );
  }

  async get(sessionId: string, includeDiff = false) {
    const session = await AgentModel.getSession(sessionId);
    await this.loadSecrets(session);
    const turn = await AgentModel.latestTurn(sessionId);
    let workspaceDiff: string | undefined;

    if (includeDiff) {
      if (["creating", "stopped", "destroyed", "failed"].includes(session.status))
        throw new AgentStateError(409, "workspace_diff_unavailable");

      const sandbox =
        this.handles.get(sessionId)?.sandbox ??
        (await this.options.provider.resumeSession({ sessionId }));

      workspaceDiff = new TextDecoder().decode(
        Buffer.from(this.redact(sessionId, await readWorkspaceDiff(sandbox))).subarray(
          0,
          WORKSPACE_DIFF_MAX_BYTES,
        ),
        { stream: true },
      );
    }

    return {
      session: {
        ...session,
        project_name: this.redact(sessionId, session.project_name),
        stop_reason: this.redact(sessionId, session.stop_reason),
      },
      turn: turn
        ? {
            ...turn,
            pending_actions: turn.pending_actions.map((action) => ({
              ...action,
              input: this.redact(sessionId, action.input),
            })),
            result_text: this.redact(sessionId, turn.result_text),
            error_message: this.redact(sessionId, turn.error_message),
            usage: this.redact(sessionId, turn.usage),
          }
        : null,
      workspaceDiff,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.abort(sessionId, { status: "aborted", reason: "cancelled" });
  }

  async stop(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    await this.locked(sessionId, async () => {
      const row = await AgentModel.getSession(sessionId);

      if (row.status === "stopped") return;

      if (row.status !== "idle") throw new AgentStateError(409, "invalid_state");
      await this.park(row, "caller");
    });
  }

  async destroy(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    await this.locked(sessionId, async () => {
      const row = await AgentModel.getSession(sessionId);

      if (row.status === "destroyed") return;
      await this.options.provider.destroyContainer(sessionId);
      await AgentModel.transition(sessionId, [row.status], "destroyed");
      this.forget(sessionId);
      this.secrets.delete(sessionId);
      this.count--;
    });
  }

  async resolveSession(sessionKey: string) {
    let id = this.keys.get(sessionKey);

    if (!id) {
      for (const row of await AgentModel.listSessions()) this.register(row.id);
      id = this.keys.get(sessionKey);
    }

    if (!id) return undefined;
    const row = await AgentModel.getSession(id);
    const turn = row.status === "running" ? await AgentModel.latestTurn(id) : null;

    return {
      sessionId: id,
      tokenId: row.token_id,
      model: row.model,
      status: row.status,
      containerIp: row.container_ip,
      activeTurn:
        turn?.status === "running"
          ? {
              turnId: String(turn.id),
              modelCallCount: turn.model_call_count,
              startedAt: new Date(turn.started_at).getTime(),
            }
          : undefined,
    };
  }

  async onCallStart(record: RelayCallStart) {
    const turnId = Number(record.turnId);

    try {
      await this.checkDisk();
    } catch (error) {
      if (error instanceof AgentStateError && error.code === "limit_exceeded:disk")
        this.onLimitExceeded(record.sessionId, "disk");
      throw error;
    }

    await AgentModel.recordCallStart(turnId, `relay:${record.callId}`, record.model);
    const { promise: done, resolve } = Promise.withResolvers<void>();
    this.calls.set(record.callId, {
      sessionId: record.sessionId,
      turnId,
      model: record.model,
      done,
      resolve,
    });
  }

  async onCallEnd(record: RelayCallEnd) {
    const call = this.calls.get(record.callId);

    if (!call) return;

    try {
      const usage = responseUsage.safeParse(record.usage).data;
      const model = record.model ? `openai/${record.model.replace(/^openai\//, "")}` : call.model;
      const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
      await AgentModel.updateStep(
        call.turnId,
        `relay:${record.callId}`,
        {
          model_name: record.model ? model : null,
          input_tokens: usage?.input_tokens ?? null,
          output_tokens: usage?.output_tokens ?? null,
          cache_read_tokens: usage ? cached : null,
          cache_creation_tokens: usage ? 0 : null,
          cost_usd: usage
            ? Math.round(
                calculateCostUsd(model, {
                  inputTokens: usage.input_tokens,
                  outputTokens: usage.output_tokens,
                  cachedInputTokens: cached,
                }) * 1_000_000,
              )
            : null,
          cost_source: usage ? "pricing_table" : null,
          duration_ms: record.ms,
          finish_reason: usage ? "stop" : null,
          error: this.redact(call.sessionId, record.error ?? null),
        },
        record.responseId ? `response:${record.responseId}` : undefined,
      );
    } finally {
      call.resolve();
      this.calls.delete(record.callId);
    }
  }

  onLimitExceeded(sessionId: string, which: string) {
    void this.abort(sessionId, { status: "failed", reason: `limit_exceeded:${which}` }).catch(() =>
      logger.error("Failed to stop limited agent turn"),
    );
  }

  async checkDisk(): Promise<void> {
    let free: number;

    try {
      free = await this.options.provider.dataRootFreeBytes();
    } catch {
      let sandbox = this.handles.values().next().value?.sandbox;
      const probeId = `disk-probe-${randomUUID()}`;
      const probe = !sandbox;

      try {
        sandbox ??= await this.options.provider.createSession({ sessionId: probeId });

        const result = await sandbox.run({
          command: "df -P /",
          abortSignal: AbortSignal.timeout(10_000),
        });

        const columns = result.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
        free = Number(columns?.[3]) * 1024;

        if (result.exitCode !== 0 || !Number.isFinite(free))
          throw new Error("agents_disk_check_failed");
      } finally {
        if (probe) await this.options.provider.destroyContainer(probeId);
      }
    }

    if (free < this.options.minFreeDiskGb * 1024 ** 3)
      throw new AgentStateError(429, "limit_exceeded:disk");
  }

  async start(): Promise<void> {
    const rows = await AgentModel.listSessions();
    const retained = rows.filter((row) => row.status !== "destroyed");
    this.count = retained.length;
    await this.options.provider.pruneOrphans(new Set(retained.map((row) => row.id)));

    for (const row of retained) {
      this.register(row.id);

      try {
        if (row.status === "creating") {
          await AgentModel.transition(row.id, ["creating"], "failed");
          continue;
        }

        if (row.status === "waiting_action") {
          const turn = await AgentModel.latestTurn(row.id);

          if (turn) await AgentModel.recoverCalls(turn.id);

          if (
            turn?.pending_actions.length &&
            turn.pending_actions.every((action) => action.result)
          ) {
            await AgentModel.claimContinuation(row.id);
            await this.resumeTurn(await AgentModel.getSession(row.id), turn);
          }
          // Persisted pending actions remain available without connecting to the bridge.
        } else if (row.status === "running") {
          const turn = await AgentModel.latestTurn(row.id);

          if (!turn) throw new Error("missing_active_turn");
          await AgentModel.recoverCalls(turn.id);
          await this.resumeTurn(row, turn);
        }
      } catch (error) {
        const turn = await AgentModel.latestTurn(row.id);
        const current = await AgentModel.getSession(row.id);

        if (turn && ["running", "waiting_action"].includes(turn.status))
          await AgentModel.finish(
            row.id,
            turn.id,
            "failed",
            this.redact(row.id, error instanceof Error ? error.message : "recovery_failed"),
            "failed",
          );
        else if (!["failed", "destroyed"].includes(current.status))
          await AgentModel.transition(row.id, [current.status], "failed");
      }
    }

    this.sweeper = setInterval(() => {
      void this.sweep().catch(() => logger.error("Agent sweep failed"));
    }, 60_000);
    this.sweeper.unref();
  }

  async sweep(): Promise<void> {
    for (const candidate of await AgentModel.listSessions()) {
      await this.locked(candidate.id, async () => {
        const row = await AgentModel.getSession(candidate.id);
        const age = (Date.now() - new Date(row.last_turn_at).getTime()) / 1000;

        if ((row.status === "stopped" || row.status === "failed") && age >= row.retain_sec) {
          await this.options.provider.destroyContainer(row.id);
          await AgentModel.transition(row.id, [row.status], "destroyed");
          this.forget(row.id);
          this.secrets.delete(row.id);
          this.count--;
        } else if (row.status === "idle" && age >= row.idle_ttl_sec) {
          await this.park(row, "idle");
        } else if (row.status === "running" || row.status === "waiting_action") {
          const turn = await AgentModel.latestTurn(row.id);

          if (
            turn?.status === "waiting_action" &&
            turn.pending_actions.some(
              (action) =>
                !action.result &&
                Date.now() - new Date(action.requestedAt).getTime() >=
                  (row.tools.find((definition) => definition.name === action.toolName)
                    ?.timeoutSec ?? 600) *
                    1000,
            )
          ) {
            void this.abort(row.id, { status: "failed", reason: "action_timeout" }).catch(() =>
              logger.error("Agent action timeout abort failed"),
            );

            return;
          }

          if (
            turn &&
            Date.now() - new Date(turn.started_at).getTime() >= this.options.maxTurnSeconds * 1000
          )
            this.onLimitExceeded(row.id, "time");
        }
      });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.sweeper);

    for (const [id, handle] of this.handles) {
      let state: HarnessV1LifecycleState | undefined;
      await this.locked(id, async () => {
        clearTimeout(handle.timer);

        if (!handle.session) return;
        handle.suspending = true;
        state = handle.session.hasUnfinishedTurn()
          ? await handle.session.suspendTurn()
          : await handle.session.detach();
        handle.session = undefined;
      });
      // Release the session mutex so a consumer already at its final boundary can drain.
      await handle.task;
      const savedState = state;

      if (!savedState) continue;
      await this.locked(id, async () => {
        const cursor = bridgeCursor.parse(savedState.data).bridge.lastSeenEventId;
        const row = await AgentModel.getSession(id);

        const continuation =
          savedState.type === "continue-turn" ? savedState : savedState.continueFrom;

        if (handle.turn && continuation?.pendingToolResults?.length) {
          await AgentModel.suspend(
            id,
            handle.turn.id,
            continuation,
            this.pendingActions(row, continuation),
            cursor,
          );
        } else await AgentModel.checkpoint(id, handle.turn?.id ?? null, savedState, cursor);
      });
    }
  }

  private register(id: string) {
    this.keys.set(derivePiSessionSecrets(this.options.secret, id).sessionKey, id);
  }

  private forget(id: string) {
    clearTimeout(this.handles.get(id)?.timer);
    this.handles.delete(id);
    this.keys.delete(derivePiSessionSecrets(this.options.secret, id).sessionKey);
    this.relay?.removeRules(id);
  }

  private newHandle(row: AgentSessionBase, sandbox: DockerSandboxSession): Handle {
    const tools: ToolSet = {};

    for (const definition of row.tools) {
      tools[definition.name] = tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema),
      });
    }

    let handle: Handle;

    const agent = new HarnessAgent({
      harness: createSandboxPi({
        secret: this.options.secret,
        relayBaseUrl: this.options.relayBaseUrl,
        model: row.model,
        onBridgeEvent: (event) => {
          if (event.type === "finish" && event.finishReason.raw === "aborted")
            handle.abortFinish.resolve();

          if (
            event.type === "tool-result" &&
            row.tools.some((definition) => definition.name === event.toolName)
          )
            handle.bridgeResults.push(event);
        },
      }),
      model: row.model,
      instructions: row.instructions,
      tools,
      sandboxConfig: { workDir: "." },
    });

    handle = {
      agent,
      sandbox,
      seq: 0,
      text: "",
      pendingBoundary: false,
      bridgeResults: [],
      abortFinish: Promise.withResolvers<void>(),
    };

    return handle;
  }

  private async attach(
    row: AgentSessionBase,
    continuing: boolean,
    turn?: AgentTurnBase,
    abortSignal?: AbortSignal,
  ): Promise<Handle> {
    const sandbox = await this.options.provider.resumeSession({ sessionId: row.id, abortSignal });
    await this.loadSecrets(row);
    const handle = this.newHandle(row, sandbox);

    const fallback = reconstructContinueState({
      sessionId: row.id,
      lastSeenEventId:
        turn?.last_logged_event_seq ??
        (await AgentModel.latestTurn(row.id))?.last_logged_event_seq ??
        0,
    });

    const savedState = row.lifecycle_state
      ? lifecycleSchema.parse(row.lifecycle_state)
      : continuing
        ? fallback
        : { ...fallback, type: "resume-session" as const };

    const state = {
      ...savedState,
      data: { ...bridgeData(savedState), bridge: bridgeData(fallback).bridge },
    };

    let continuation: HarnessV1ContinueTurnState | undefined;

    if (continuing) {
      continuation = state.type === "continue-turn" ? state : (state.continueFrom ?? fallback);
      // DB progress may be newer than the most recent graceful suspension envelope.
      continuation = {
        ...continuation,
        data: {
          ...bridgeData(continuation),
          bridge: { port: 8787, lastSeenEventId: turn?.last_logged_event_seq ?? 0 },
        },
      };
      const pending = turn?.pending_actions.filter((action) => !action.deliveredAt) ?? [];
      continuation = {
        ...continuation,
        pendingToolResults: pending.map((action) => ({
          toolCallId: action.toolCallId,
          toolName: action.toolName,
          input: JSON.stringify(action.input),
        })),
      };
    }

    handle.session = await handle.agent.createSession({
      sessionId: row.id,
      sandboxSession: sandbox,
      abortSignal,
      continueFrom: continuation,
      resumeFrom: continuing
        ? undefined
        : { ...state, type: "resume-session", continueFrom: undefined },
    });
    await AgentModel.updateSession(row.id, {
      container_ip: await this.options.provider.inspectIp(row.id),
    });
    clearTimeout(this.handles.get(row.id)?.timer);
    this.handles.set(row.id, handle);

    return handle;
  }

  private async resumeTurn(row: AgentSessionBase, turn: AgentTurnBase) {
    try {
      const handle = await this.attach(row, true, turn);
      this.launch(row, turn, handle, true);
    } catch (error) {
      await AgentModel.finish(
        row.id,
        turn.id,
        "failed",
        this.redact(row.id, error instanceof Error ? error.message : "resume_failed"),
        "failed",
      );
      throw error;
    }
  }

  private launch(row: AgentSessionBase, turn: AgentTurnBase, handle: Handle, continuing: boolean) {
    clearTimeout(this.handles.get(row.id)?.timer);
    handle.turn = turn;
    handle.controller = new AbortController();
    handle.stop = undefined;
    handle.ended = false;
    handle.seq = turn.last_logged_event_seq;
    handle.text = turn.result_text ?? "";
    handle.pendingBoundary = false;
    handle.abortFinish = Promise.withResolvers<void>();

    const remaining =
      new Date(turn.started_at).getTime() + this.options.maxTurnSeconds * 1000 - Date.now();

    handle.timer = setTimeout(() => this.onLimitExceeded(row.id, "time"), Math.max(0, remaining));
    handle.timer.unref();
    handle.task = this.consume(row, handle, continuing);
    // API callers get the persisted turn immediately; background failure is persisted below.
    void handle.task.catch(() => logger.error("Agent turn persistence failed"));
  }

  private async consume(row: AgentSessionBase, handle: Handle, continuing: boolean) {
    const turn = handle.turn!;
    const session = handle.session!;

    try {
      const continuations: ToolResultPart[] = turn.pending_actions.flatMap((action) =>
        action.result && !action.deliveredAt
          ? [
              {
                type: "tool-result" as const,
                toolCallId: action.toolCallId,
                toolName: action.toolName,
                output:
                  action.result.error !== undefined
                    ? { type: "error-text" as const, value: action.result.error }
                    : {
                        type: "json" as const,
                        value: jsonValueSchema.parse(action.result.output ?? null),
                      },
              },
            ]
          : [],
      );

      const stream = continuing
        ? await handle.agent.continueStream({
            session,
            toolResultContinuations: continuations,
            abortSignal: handle.controller!.signal,
          })
        : await handle.agent.stream({
            session,
            prompt: turn.prompt,
            abortSignal: handle.controller!.signal,
          });

      for await (const part of stream.fullStream) {
        if (handle.ended) break;
        await this.recordBridgeResults(handle);
        const seq = eventSequence.safeParse(part).data?.providerMetadata.qgrid.seq;

        if (seq !== undefined && seq <= handle.seq) continue;
        handle.seq = Math.max(handle.seq, seq ?? 0);

        if (part.type === "tool-call") {
          const host = row.tools.some((definition) => definition.name === part.toolName);

          if (host) handle.pendingBoundary = true;
          await AgentModel.recordStep(turn.id, {
            key: `tool:${part.toolCallId}`,
            seq: handle.pendingBoundary ? undefined : seq,
            step: {
              type: "tool_call",
              tool_call_id: part.toolCallId,
              tool_name: part.toolName,
              tool_args: JSON.stringify(this.redact(row.id, part.input)),
            },
          });
        } else if (part.type === "tool-result" || part.type === "tool-error") {
          await AgentModel.recordToolResult(turn.id, {
            toolCallId: part.toolCallId,
            output:
              part.type === "tool-result"
                ? this.redact(row.id, jsonValueSchema.parse(part.output))
                : undefined,
            error: part.type === "tool-error" ? this.redact(row.id, String(part.error)) : undefined,
            seq: handle.pendingBoundary ? undefined : seq,
            truncate: !row.tools.some((definition) => definition.name === part.toolName),
          });
        } else if (part.type === "text-start") {
          handle.text = "";

          if (seq !== undefined && !handle.pendingBoundary)
            await AgentModel.recordEvent(turn.id, seq, { result_text: "" });
        } else if (part.type === "text-delta") {
          handle.text += part.text;

          if (seq !== undefined && !handle.pendingBoundary)
            await AgentModel.recordEvent(turn.id, seq, {
              result_text: this.redact(row.id, handle.text),
            });
        } else if (part.type === "error") {
          throw new Error("agent_stream_failed", { cause: part.error });
        } else if (seq !== undefined && !handle.pendingBoundary) {
          await AgentModel.recordEvent(turn.id, seq);
        }
      }

      await this.recordBridgeResults(handle);

      if (handle.suspending || handle.ended) return;
      await this.drainCalls(turn.id);

      await this.locked(row.id, async () => {
        if (handle.suspending || handle.ended || handle.stop) {
          // abort() owns finalization after the bridge's explicit aborted finish (or timeout).
          return;
        } else if (session.hasUnfinishedTurn()) {
          const state = await session.suspendTurn();
          handle.session = undefined;
          const pending = this.pendingActions(row, state);
          await AgentModel.recordEvent(turn.id, undefined, {
            result_text: this.redact(row.id, handle.text),
          });
          await AgentModel.suspend(
            row.id,
            turn.id,
            state,
            pending,
            bridgeCursor.parse(state.data).bridge.lastSeenEventId,
          );
        } else {
          await this.finish(row.id, handle);
        }
      });
    } catch (error) {
      if (handle.suspending || handle.ended) return;
      this.relay?.abortTurn(String(turn.id));
      await this.drainCalls(turn.id);

      await this.locked(row.id, async () => {
        if (handle.suspending || handle.ended || handle.stop) return;
        await this.finish(row.id, handle, {
          status: "failed",
          reason: this.redact(
            row.id,
            error instanceof Error ? error.message : "agent_stream_failed",
          ),
        });
      });
    }
  }

  private async drainCalls(turnId: number) {
    await Promise.all(
      this.calls
        .values()
        .filter((call) => call.turnId === turnId)
        .map((call) => call.done),
    );
  }

  private pendingActions(
    row: AgentSessionBase,
    state: HarnessV1ContinueTurnState,
  ): AgentPendingActions {
    return (state.pendingToolResults ?? []).map((action) => ({
      toolCallId: action.toolCallId,
      toolName: action.toolName,
      input: this.redact(row.id, jsonValueSchema.parse(JSON.parse(action.input))),
      gate: row.tools.find((definition) => definition.name === action.toolName)?.gate ?? "auto",
      requestedAt: new Date().toISOString(),
    }));
  }

  private async recordBridgeResults(handle: Handle) {
    for (const event of handle.bridgeResults.splice(0)) {
      if (handle.ended) return;
      await AgentModel.recordToolResult(handle.turn!.id, {
        toolCallId: event.toolCallId,
        output: this.redact(handle.turn!.session_id, event.result),
        error: event.isError
          ? JSON.stringify(this.redact(handle.turn!.session_id, event.result))
          : undefined,
        // fullStream may filter this echo. Persist delivery before any following cursor.
        truncate: !handle.turn!.pending_actions.some(
          (action) => action.toolCallId === event.toolCallId,
        ),
      });
    }
  }

  private async finish(id: string, handle: Handle, stop?: Stop, timedOut = false) {
    if (handle.ended) return;
    handle.ended = true;
    clearTimeout(handle.timer);
    this.relay?.abortTurn(String(handle.turn!.id));

    if (!timedOut && handle.session) {
      try {
        const state = await handle.session.detach();
        handle.checkpoint = {
          lifecycleState: state,
          seq: bridgeCursor.parse(state.data).bridge.lastSeenEventId,
          resultText: this.redact(id, handle.text),
        };
      } catch {
        logger.warn("Could not detach completed agent session");
      }

      handle.session = undefined;
    }

    try {
      await AgentModel.finish(
        id,
        handle.turn!.id,
        stop?.status ?? "succeeded",
        stop?.reason,
        timedOut ? "stopped" : "idle",
        timedOut ? "abort_timeout" : undefined,
        handle.checkpoint,
      );
    } catch (error) {
      handle.ended = false;
      throw error;
    }

    if (timedOut || stop) {
      // Reattach from persisted Pi files for a later prompt after a failed local handle.
      this.handles.delete(id);
    }
  }

  private async abort(id: string, stop: Stop) {
    let handle: Handle | undefined;
    await this.locked(id, async () => {
      const row = await AgentModel.getSession(id);

      if (row.status !== "running" && row.status !== "waiting_action") return;
      const turn = await AgentModel.latestTurn(id);

      if (!turn) return;
      handle = this.handles.get(id);

      if (!handle?.session) {
        if (row.status === "waiting_action") await AgentModel.claimContinuation(id, true);

        try {
          const current = await AgentModel.getSession(id);
          handle = await this.attach(current, true, turn, AbortSignal.timeout(10_000));
          this.launch(current, turn, handle, true);
        } catch {
          // A dead bridge cannot acknowledge cancellation. Preserve the caller's terminal reason.
          await this.options.provider.stopContainer(id);
          await AgentModel.finish(
            id,
            turn.id,
            stop.status,
            stop.reason,
            "stopped",
            "abort_timeout",
          );
          this.forget(id);
          handle = undefined;

          return;
        }
      }

      if (!handle) return;
      handle.stop ??= stop;
      handle.controller?.abort();
      this.relay?.abortTurn(String(turn.id));
    });

    if (!handle || handle.ended) return;
    const active = handle;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const completed = await Promise.race([
        Promise.all([active.task, active.abortFinish.promise]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 10_000);
        }),
      ]);

      await this.locked(id, async () => {
        if (active.ended || this.handles.get(id) !== active) return;

        if (!completed) {
          await this.options.provider.stopContainer(id);
          await this.drainCalls(active.turn!.id);
          await this.finish(id, active, active.stop ?? stop, true);
        } else await this.finish(id, active, active.stop ?? stop);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async park(row: AgentSessionBase, reason: "idle" | "caller") {
    const handle = this.handles.get(row.id);
    let state = row.lifecycle_state;

    if (handle?.session) state = await handle.session.detach();
    await this.options.provider.stopContainer(row.id);
    await AgentModel.transition(row.id, ["idle"], "stopped", {
      lifecycle_state: state,
      stop_reason: reason,
    });
    this.forget(row.id);
  }
}

function bridgeData(state: HarnessV1LifecycleState) {
  return z
    .object({
      bridge: z.object({ port: z.literal(8787), lastSeenEventId: z.number() }),
      piSession: z.string(),
      model: z.string().nullable(),
      instructionsHash: z.string().nullable(),
    })
    .parse(state.data);
}
