import { type z } from "zod";

import { AgentTurnBaseSchema, AgentTurnBaseListParams } from "../sonamu.generated";

export const AgentTurnListParams = AgentTurnBaseListParams;

export type AgentTurnListParams = z.infer<typeof AgentTurnListParams>;

export const AgentTurnSaveParams = AgentTurnBaseSchema.partial({ id: true });

export type AgentTurnSaveParams = z.infer<typeof AgentTurnSaveParams>;
