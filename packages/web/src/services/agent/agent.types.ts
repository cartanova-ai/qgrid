/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { z } from "zod";

export const AgentTools = z.array(
  z.object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    gate: z.enum(["auto", "approval", "report"]),
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
