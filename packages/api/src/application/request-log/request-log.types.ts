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
