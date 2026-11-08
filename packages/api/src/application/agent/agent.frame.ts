import { getLogger } from "@logtape/logtape";
import { api, BaseFrameClass, SoException } from "sonamu";
import { z } from "zod";

import { type LocalizedString } from "../../i18n/sd.generated";
import { getAgentRunner } from "../../utils/agents/runtime";
import { AgentStateError } from "./agent.model";
import {
  AgentActionResultInput,
  type AgentActionResultOutput,
  AgentSessionCreateInput,
  type AgentSessionCreateOutput,
  type AgentSessionDestroyOutput,
  AgentSessionGetInput,
  AgentSessionGetOutput,
  AgentSessionInput,
  AgentSessionPromptInput,
  type AgentSessionPromptOutput,
  type AgentSessionStopOutput,
} from "./agent.types";

const logger = getLogger(["qgrid", "agents", "api"]);

class AgentApiException extends SoException {
  constructor(status: number, code: string) {
    // SAFETY: these machine-readable error codes are intentionally locale-independent.
    super(status, code as LocalizedString);
  }
}

// Sonamu validates generated argument types before invoking the frame. Validation errors
// can echo rejected enum values; strip that detail before the shared logger/error handler.
export function sanitizeAgentApiError(error: Error): Error {
  if (error instanceof AgentApiException) return error;

  return new AgentApiException(
    error instanceof SoException ? error.statusCode : 500,
    "invalid_agent_request",
  );
}

function parseInput<S extends z.ZodType>(schema: S, value: z.input<S>): z.output<S> {
  const parsed = schema.safeParse(value);

  // Validation details can contain caller-supplied secrets, including invalid enum values.
  if (!parsed.success) throw new AgentApiException(400, "invalid_agent_input");

  return parsed.data;
}

async function run<T>(
  operation: () => Promise<T>,
  sessionId = "",
  secrets: readonly string[] = [],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AgentStateError) throw new AgentApiException(error.status, error.code);
    const code = z.object({ code: z.union([z.string(), z.number()]).optional() }).safeParse(error);
    logger.error(
      "Agent operation failed: {message} (code: {code})",
      getAgentRunner().redact(
        sessionId,
        {
          message: error instanceof Error ? error.message : "Unknown agent error",
          code: code.success ? code.data.code : undefined,
        },
        secrets,
      ),
    );
    // Docker/Git errors may echo environment values or credentials. Never forward their cause.
    throw new AgentApiException(500, "agent_operation_failed");
  }
}

class AgentFrameClass extends BaseFrameClass {
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async sessionCreate(params: AgentSessionCreateInput): Promise<AgentSessionCreateOutput> {
    const input = parseInput(AgentSessionCreateInput, params);

    return run(
      async () => {
        const session = await getAgentRunner().create({
          ...input,
          tools: input.tools.map((definition) => ({
            ...definition,
            timeoutSec: definition.timeoutSec ?? 600,
          })),
        });

        return { sessionId: session.id, status: session.status, readyMs: session.readyMs };
      },
      "",
      [...Object.values(input.env ?? {}), input.workspace?.git?.token ?? ""],
    );
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async sessionPrompt(params: AgentSessionPromptInput): Promise<AgentSessionPromptOutput> {
    const input = parseInput(AgentSessionPromptInput, params);

    return run(
      async () => ({
        turnId: (await getAgentRunner().prompt(input.sessionId, input.prompt)).id,
      }),
      input.sessionId,
    );
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async sessionGet(params: AgentSessionGetInput): Promise<AgentSessionGetOutput> {
    const input = parseInput(AgentSessionGetInput, params);

    return run(async () => {
      const { session, turn, workspaceDiff } = await getAgentRunner().get(
        input.sessionId,
        input.includeDiff,
      );

      // Explicit projection excludes lifecycle state, credentials, instructions and saved results.
      return AgentSessionGetOutput.parse({
        session: {
          id: session.id,
          status: session.status,
          model: session.model,
          projectName: session.project_name,
          createdAt: new Date(session.created_at).toISOString(),
          lastTurnAt: new Date(session.last_turn_at).toISOString(),
          stopReason: session.stop_reason ?? undefined,
        },
        turn: turn
          ? {
              id: turn.id,
              index: turn.index,
              status: turn.status,
              modelCallCount: turn.model_call_count,
              pendingActions: turn.pending_actions
                .filter((action) => !action.result)
                .map((action) => ({
                  toolCallId: action.toolCallId,
                  toolName: action.toolName,
                  input: action.input,
                  gate: action.gate,
                  requestedAt: action.requestedAt,
                })),
              resultText: turn.result_text ?? undefined,
              errorMessage: turn.error_message ?? undefined,
              requestLogId: turn.request_log_id ?? undefined,
              usage: turn.usage ?? undefined,
            }
          : undefined,
        workspaceDiff,
      });
    }, input.sessionId);
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async actionResult(params: AgentActionResultInput): Promise<AgentActionResultOutput> {
    const { sessionId, toolCallId, ...result } = parseInput(AgentActionResultInput, params);

    return run(async () => {
      const saved = await getAgentRunner().actionResult(sessionId, toolCallId, result);

      return { accepted: true, turnStatus: saved.turn.status };
    }, sessionId);
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async sessionStop(params: AgentSessionInput): Promise<AgentSessionStopOutput> {
    const { sessionId } = parseInput(AgentSessionInput, params);

    return run(async () => {
      const runner = getAgentRunner();
      await runner.stop(sessionId);

      return { status: (await runner.get(sessionId)).session.status };
    }, sessionId);
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async sessionDestroy(params: AgentSessionInput): Promise<AgentSessionDestroyOutput> {
    const { sessionId } = parseInput(AgentSessionInput, params);

    return run(async () => {
      await getAgentRunner().destroy(sessionId);

      return { destroyed: true };
    }, sessionId);
  }
}

export const AgentFrame = new AgentFrameClass();
