import { z } from "zod";

export const AgentTools = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    gate: z.enum(["auto", "approval", "report"]),
    timeoutSec: z.number().int().positive().optional(),
  }),
);

export type AgentTools = z.infer<typeof AgentTools>;

// Keep the framework-owned fields as well as the adapter's data when persisting an envelope.
export const AgentLifecycleState = z.record(z.string(), z.unknown());

export type AgentLifecycleState = z.infer<typeof AgentLifecycleState>;

export const AgentPendingActions = z.array(
  z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    gate: z.enum(["auto", "approval", "report"]),
    requestedAt: z.string(),
    result: z
      .object({
        output: z.unknown().optional(),
        error: z.string().optional(),
        receivedAt: z.string(),
      })
      .optional(),
    deliveredAt: z.string().optional(),
  }),
);

export type AgentPendingActions = z.infer<typeof AgentPendingActions>;

export const AgentLoggedSteps = z.record(z.string(), z.number().int());

export type AgentLoggedSteps = z.infer<typeof AgentLoggedSteps>;

export const AgentTurnUsage = z.record(z.string(), z.unknown());

export type AgentTurnUsage = z.infer<typeof AgentTurnUsage>;

export const AgentToolDefinition = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  description: z.string().trim().min(1),
  inputSchema: z.object({ type: z.literal("object") }).catchall(z.unknown()),
  gate: z.enum(["auto", "approval", "report"]),
  timeoutSec: z.number().int().positive().optional(),
});

export type AgentToolDefinition = z.infer<typeof AgentToolDefinition>;

export const AgentWorkspace = z
  .object({
    git: z
      .object({
        url: z.url().refine((value) => {
          const url = new URL(value);

          return (
            url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
          );
        }),
        ref: z
          .string()
          .min(1)
          .refine(
            (value) => !value.startsWith("-") && [...value].every((character) => character > " "),
          ),
        token: z
          .string()
          .min(1)
          .refine((value) => !/[\r\n\0]/.test(value))
          .optional(),
      })
      .optional(),
    // Match existing JSON media inputs; the HTTP body limit also bounds this payload.
    archive: z.base64().min(1).optional(),
  })
  .refine((value) => !(value.git && value.archive), "Choose git or archive");

export type AgentWorkspace = z.infer<typeof AgentWorkspace>;

export const AgentSessionCreateInput = z.object({
  model: z.string().min(1),
  instructions: z.string(),
  tools: z.array(AgentToolDefinition),
  projectName: z.string().min(1).optional(),
  workspace: AgentWorkspace.optional(),
  env: z
    .record(
      z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
      z.string().refine((value) => !value.includes("\0")),
    )
    .optional(),
  idleTtlSec: z.number().int().positive().optional(),
  retainSec: z.number().int().positive().optional(),
  imageProfile: z.literal("default").optional(),
});

export type AgentSessionCreateInput = z.infer<typeof AgentSessionCreateInput>;

export const AgentSessionInput = z.object({ sessionId: z.string().min(1) });

export type AgentSessionInput = z.infer<typeof AgentSessionInput>;

export const AgentSessionPromptInput = AgentSessionInput.extend({ prompt: z.string().min(1) });

export type AgentSessionPromptInput = z.infer<typeof AgentSessionPromptInput>;

export const AgentSessionGetInput = AgentSessionInput.extend({
  includeDiff: z.boolean().optional(),
});

export type AgentSessionGetInput = z.infer<typeof AgentSessionGetInput>;

export const AgentActionResultInput = AgentSessionInput.extend({
  toolCallId: z.string().min(1),
  output: z.json().optional(),
  error: z.string().optional(),
});

export type AgentActionResultInput = z.infer<typeof AgentActionResultInput>;

const SessionStatus = z.enum([
  "creating",
  "idle",
  "running",
  "waiting_action",
  "stopped",
  "failed",
  "destroyed",
]);

const TurnStatus = z.enum(["running", "waiting_action", "succeeded", "failed", "aborted"]);
export const AgentSessionCreateOutput = z.object({ sessionId: z.string(), status: SessionStatus });

export type AgentSessionCreateOutput = z.infer<typeof AgentSessionCreateOutput>;

export const AgentSessionPromptOutput = z.object({ turnId: z.number().int() });

export type AgentSessionPromptOutput = z.infer<typeof AgentSessionPromptOutput>;

export const AgentSessionGetOutput = z.object({
  session: z.object({
    id: z.string(),
    status: SessionStatus,
    model: z.string(),
    projectName: z.string().nullable(),
    createdAt: z.string(),
    lastTurnAt: z.string(),
    stopReason: z.string().optional(),
  }),
  turn: z
    .object({
      id: z.number().int(),
      index: z.number().int(),
      status: TurnStatus,
      pendingActions: z.array(
        z.object({
          toolCallId: z.string(),
          toolName: z.string(),
          input: z.unknown(),
          gate: z.enum(["auto", "approval", "report"]),
          requestedAt: z.string(),
        }),
      ),
      resultText: z.string().optional(),
      errorMessage: z.string().optional(),
      requestLogId: z.number().int().optional(),
      usage: AgentTurnUsage.optional(),
    })
    .optional(),
  workspaceDiff: z.string().optional(),
});

export type AgentSessionGetOutput = z.infer<typeof AgentSessionGetOutput>;

export const AgentActionResultOutput = z.object({
  accepted: z.literal(true),
  turnStatus: TurnStatus,
});

export type AgentActionResultOutput = z.infer<typeof AgentActionResultOutput>;

export const AgentSessionStopOutput = z.object({ status: SessionStatus });

export type AgentSessionStopOutput = z.infer<typeof AgentSessionStopOutput>;

export const AgentSessionDestroyOutput = z.object({ destroyed: z.literal(true) });

export type AgentSessionDestroyOutput = z.infer<typeof AgentSessionDestroyOutput>;
