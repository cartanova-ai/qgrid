/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */
import type { z } from "zod";
import { TokenBaseListParams, TokenBaseSchema } from "../sonamu.generated";

// Token - ListParams
export const TokenListParams = TokenBaseListParams;
export type TokenListParams = z.infer<typeof TokenListParams>;

// Token - SaveParams
export const TokenSaveParams = TokenBaseSchema.partial({
  id: true,
  created_at: true,
  name: true,
  refresh_token: true,
  expires_at: true,
  account_uuid: true,
  active: true,
});
export type TokenSaveParams = z.infer<typeof TokenSaveParams>;
