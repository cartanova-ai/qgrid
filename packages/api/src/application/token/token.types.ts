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
