import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { getLogger } from "@logtape/logtape";
import { BadRequestException } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type LocalizedString } from "../../i18n/sd.generated";
import { handleServerError } from "../../server-error-handler";
import { getAgentRunner } from "../../utils/agents/runtime";
import { AgentSessionRunner, type AgentSessionRunnerOptions } from "../../utils/agents/session-runner";
import { AgentFrame, sanitizeAgentApiError } from "./agent.frame";
import { AgentStateError } from "./agent.model";
import { type AgentSessionCreateInput, type AgentSessionPromptInput, type AgentActionResultInput, type AgentSessionInput, type AgentSessionGetInput } from "./agent.types";

vi.mock("../../utils/agents/runtime", () => ({ getAgentRunner: vi.fn() }));

const input: AgentSessionCreateInput = {
  model: "openai/gpt-6.1-sol", instructions: "Do the task",
  tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" }, gate: "auto" }],
};
const session = {
  id: "session-1", status: "idle", model: input.model, project_name: "tests",
  created_at: new Date("2026-11-08T00:00:00Z"), last_turn_at: new Date("2026-11-08T00:00:00Z"),
  stop_reason: null, token_id: 123, lifecycle_state: { secret: "private-lifecycle" },
};
const turn = {
  id: 1, index: 0, status: "waiting_action", result_text: null, error_message: null,
  request_log_id: 10, usage: { inputTokens: 12 }, model_call_count: 3,
  pending_actions: [{ toolCallId: "call-1", toolName: "lookup", input: { id: 1 }, gate: "auto", requestedAt: "2026-11-08T00:00:00Z" }],
};
const runner = { create: vi.fn(), prompt: vi.fn(), get: vi.fn(), actionResult: vi.fn(), stop: vi.fn(), destroy: vi.fn(), redact: vi.fn() };
let server: FastifyInstance;

beforeEach(() => {
  vi.resetAllMocks();
  const redactor = new AgentSessionRunner({} as AgentSessionRunnerOptions);
  runner.redact.mockImplementation(redactor.redact.bind(redactor));
  vi.mocked(getAgentRunner).mockReturnValue(runner as unknown as AgentSessionRunner);
  runner.create.mockResolvedValue({ ...session, readyMs: 125 });
  runner.prompt.mockResolvedValue({ ...turn, status: "running" });
  runner.get.mockResolvedValue({ session, turn });
  runner.actionResult.mockResolvedValue({ turn: { ...turn, status: "running" }, duplicate: false });
  server = Fastify();
  server.setErrorHandler<FastifyError>((error, _request, reply) => handleServerError(sanitizeAgentApiError(error), reply));
  // Same HTTP -> frame -> shared error handler boundary as the existing qgrid frame tests.
  server.post("/api/agent/sessionCreate", (request) => AgentFrame.sessionCreate((request.body as { params: AgentSessionCreateInput }).params));
  server.post("/api/agent/sessionPrompt", (request) => AgentFrame.sessionPrompt((request.body as { params: AgentSessionPromptInput }).params));
  server.post("/api/agent/actionResult", (request) => AgentFrame.actionResult((request.body as { params: AgentActionResultInput }).params));
  server.post("/api/agent/sessionStop", (request) => AgentFrame.sessionStop((request.body as { params: AgentSessionInput }).params));
  server.post("/api/agent/sessionDestroy", (request) => AgentFrame.sessionDestroy((request.body as { params: AgentSessionInput }).params));
  server.get("/api/agent/sessionGet", (request) => AgentFrame.sessionGet(request.query as AgentSessionGetInput));
});
afterEach(async () => { await server.close(); vi.restoreAllMocks(); });

describe("AgentFrame", () => {
  it.each([
    { name: "Invalid" }, { name: "x" }, { name: "a".repeat(65) },
    { description: undefined }, { description: " " }, { inputSchema: { type: "array" } },
    { gate: "secret-invalid-gate" }, { timeoutSec: 0 },
  ])("rejects invalid tool definitions: %j", async (patch) => {
    const response = await server.inject({ method: "POST", url: "/api/agent/sessionCreate", payload: { params: { ...input, tools: [{ ...input.tools[0], ...patch }] } } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("secret-invalid-gate");
    expect(runner.create).not.toHaveBeenCalled();
  });

  it("passes secrets only to the runner, defaults timeout and returns a narrow response", async () => {
    const params = { ...input, env: { DB_PASSWORD: "env-secret" }, workspace: { git: { url: "https://example.com/repo.git", ref: "main", token: "git-secret" } } };
    const response = await server.inject({ method: "POST", url: "/api/agent/sessionCreate", payload: { params } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: session.id, status: "idle", readyMs: 125 });
    expect(runner.create).toHaveBeenCalledWith({ ...params, tools: [{ ...params.tools[0], timeoutSec: 600 }] });
  });

  it.each([
    { workspace: { git: { url: "https://secret@example.com/repo.git", ref: "main" } } },
    { workspace: { git: { url: "file:///repo", ref: "main" } } },
    { workspace: { archive: "not-base64" } },
    { workspace: { archive: "YWJj", git: { url: "https://example.com/repo", ref: "main" } } },
    { env: { "INVALID=NAME": "private-value" } }, { idleTtlSec: 0 }, { retainSec: -1 }, { imageProfile: "other" },
  ])("validates workspace, environment and limits: %j", async (patch) => {
    const response = await server.inject({ method: "POST", url: "/api/agent/sessionCreate", payload: { params: { ...input, ...patch } } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("private-value");
    expect(runner.create).not.toHaveBeenCalled();
  });

  it("does not expose Docker errors or Sonamu validation details containing env/token values", async () => {
    const log = vi.spyOn(getLogger(["qgrid"]), "error");
    const diagnostic = vi.spyOn(getLogger(["qgrid", "agents", "api"]), "error");
    runner.create.mockRejectedValue(Object.assign(new Error("Docker rejected env-secret git-secret", { cause: new Error("private cause") }), { code: "DOCKER_env-secret", stack: "private stack" }));
    const params = { ...input, env: { PASSWORD: "env-secret", EMPTY: "" }, workspace: { git: { url: "https://example.com/repo.git", ref: "main", token: "git-secret" } } };
    const response = await server.inject({ method: "POST", url: "/api/agent/sessionCreate", payload: { params } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toMatch(/env-secret|git-secret|Docker/);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/env-secret|git-secret|Docker/);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "Agent operation failed: {message} (code: {code})",
      { message: "Docker rejected [REDACTED] [REDACTED]", code: "DOCKER_[REDACTED]" },
    );
    const mapped = sanitizeAgentApiError(new BadRequestException("env-secret git-secret" as LocalizedString));
    expect(mapped).toMatchObject({ statusCode: 400, message: "invalid_agent_request" });
    expect(JSON.stringify(mapped)).not.toMatch(/env-secret|git-secret/);
  });

  it.each([[409, "session_busy"], [404, "session_not_found"], [503, "agents_unavailable"], [503, "quota_exceeded"], [503, "token_unavailable"], [429, "limit_exceeded:max_sessions"], [400, "unsupported_agent_model"]])("preserves runner status %i", async (status, code) => {
    runner.prompt.mockRejectedValue(new AgentStateError(Number(status), String(code)));
    const response = await server.inject({ method: "POST", url: "/api/agent/sessionPrompt", payload: { params: { sessionId: session.id, prompt: "Go" } } });
    expect(response.statusCode).toBe(status);
    expect(response.json().message).toBe(code);
    if (status === 503) expect(response.headers["retry-after"]).toBe("30");
  });

  it("returns only the public latest turn and pending actions", async () => {
    runner.get.mockResolvedValue({ session, turn: { ...turn, pending_actions: [...turn.pending_actions, { ...turn.pending_actions[0], result: { output: "private-result" } }] } });
    const response = await server.inject("/api/agent/sessionGet?sessionId=session-1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: { id: session.id, status: "idle", model: input.model, projectName: "tests", createdAt: "2026-11-08T00:00:00.000Z", lastTurnAt: "2026-11-08T00:00:00.000Z" },
      turn: { id: 1, index: 0, status: "waiting_action", pendingActions: turn.pending_actions, requestLogId: 10, usage: { inputTokens: 12 }, modelCallCount: 3 },
    });
    expect(response.body).not.toMatch(/private|token_id|lifecycle/);
    expect(runner.get).toHaveBeenCalledWith(session.id, undefined);
    runner.get.mockResolvedValue({ session, turn: null, workspaceDiff: "+change" });
    expect(await AgentFrame.sessionGet({ sessionId: session.id, includeDiff: true })).toMatchObject({ workspaceDiff: "+change" });
    expect(runner.get).toHaveBeenLastCalledWith(session.id, true);
  });

  it("delegates prompt, idempotent action result, stop and destroy", async () => {
    expect(await AgentFrame.sessionPrompt({ sessionId: session.id, prompt: "Go" })).toEqual({ turnId: 1 });
    for (const duplicate of [false, true]) {
      runner.actionResult.mockResolvedValue({ turn: { ...turn, status: "running" }, duplicate });
      const response = await server.inject({ method: "POST", url: "/api/agent/actionResult", payload: { params: { sessionId: session.id, toolCallId: "call-1", output: { ok: true } } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: true, turnStatus: "running" });
    }
    runner.get.mockResolvedValue({ session: { ...session, status: "stopped" } });
    expect(await AgentFrame.sessionStop({ sessionId: session.id })).toEqual({ status: "stopped" });
    expect(await AgentFrame.sessionDestroy({ sessionId: session.id })).toEqual({ destroyed: true });
    expect(runner.stop).toHaveBeenCalledWith(session.id);
    expect(runner.destroy).toHaveBeenCalledWith(session.id);
  });

  it.each([404, 409])("preserves actionResult %i without rewriting runner semantics", async (status) => {
    runner.actionResult.mockRejectedValue(new AgentStateError(status, status === 404 ? "tool_call_not_found" : "turn_finished"));
    const response = await server.inject({ method: "POST", url: "/api/agent/actionResult", payload: { params: { sessionId: session.id, toolCallId: "call-1", error: "denied" } } });
    expect(response.statusCode).toBe(status);
  });
});
