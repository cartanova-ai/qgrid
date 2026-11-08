/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { type z } from "zod";

import { AgentSessionBaseSchema, AgentSessionBaseListParams } from "../sonamu.generated";

// AgentSession - ListParams
export const AgentSessionListParams = AgentSessionBaseListParams;

export type AgentSessionListParams = z.infer<typeof AgentSessionListParams>;

// AgentSession - SaveParams
export const AgentSessionSaveParams = AgentSessionBaseSchema.partial({
  id: true,
  created_at: true,
});

export type AgentSessionSaveParams = z.infer<typeof AgentSessionSaveParams>;
