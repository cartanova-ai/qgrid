/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { type z } from "zod";

import { AgentTurnBaseSchema, AgentTurnBaseListParams } from "../sonamu.generated";

export const AgentTurnListParams = AgentTurnBaseListParams;

export type AgentTurnListParams = z.infer<typeof AgentTurnListParams>;

export const AgentTurnSaveParams = AgentTurnBaseSchema.partial({ id: true });

export type AgentTurnSaveParams = z.infer<typeof AgentTurnSaveParams>;
