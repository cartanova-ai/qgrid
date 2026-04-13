/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */
import type { z } from "zod";

import { RequestLogBaseListParams, RequestLogBaseSchema } from "../sonamu.generated";

// RequestLog - ListParams
export const RequestLogListParams = RequestLogBaseListParams;
export type RequestLogListParams = z.infer<typeof RequestLogListParams>;

// RequestLog - SaveParams
export const RequestLogSaveParams = RequestLogBaseSchema.partial({
  id: true,
  created_at: true,
  token_name: true,
});
export type RequestLogSaveParams = z.infer<typeof RequestLogSaveParams>;
