/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */
/** biome-ignore-all lint: generated는 무시 */
/** biome-ignore-all assist: generated는 무시 */
/** biome-ignore-all format: generated는 무시 */

import { ApplySonamuFilter, SonamuQueryMode,zArrayable} from "./sonamu.shared";
import { z } from 'zod';

// Enums: RequestLog
export const RequestLogOrderBy = z.enum(["id-desc"]).describe("RequestLogOrderBy");
export type RequestLogOrderBy = z.infer<typeof RequestLogOrderBy>;
export const RequestLogOrderByLabel = {"id-desc":"ID최신순"};
export const RequestLogSearchField = z.enum(["id","token_name","query"]).describe("RequestLogSearchField");
export type RequestLogSearchField = z.infer<typeof RequestLogSearchField>;
export const RequestLogSearchFieldLabel = {"id":"ID","token_name":"토큰이름","query":"쿼리"};

// BaseSchema: RequestLog
export const RequestLogBaseSchema = 
z.object({
id: z.int(),
created_at: z.date(),
token_name: z.string().max(100),
query: z.string(),
response: z.string(),
input_tokens: z.int(),
output_tokens: z.int(),
cache_read_tokens: z.int(),
cache_creation_tokens: z.int(),
duration_ms: z.int(),

});
export type RequestLogBaseSchema = z.infer<typeof RequestLogBaseSchema> & {readonly __hasDefault__: readonly ["created_at", "id"],};

// BaseListParams: RequestLog
export const RequestLogBaseListParams = z.object({
  num: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  search: RequestLogSearchField,
  keyword: z.string(),
  orderBy: RequestLogOrderBy,
  queryMode: SonamuQueryMode,
  id: zArrayable(z.number().int().positive()),
  sonamuFilter: z.custom<ApplySonamuFilter<RequestLogBaseSchema, never, never>>(),token_name: z.string().max(100),
}).partial();;
export type RequestLogBaseListParams = z.infer<typeof RequestLogBaseListParams>;

// Subsets: RequestLog
export const RequestLogSubsetA = 
z.object({
id: z.int(),
created_at: z.date(),
token_name: z.string().max(100),
query: z.string(),
response: z.string(),
input_tokens: z.int(),
output_tokens: z.int(),
cache_read_tokens: z.int(),
cache_creation_tokens: z.int(),
duration_ms: z.int(),

});
export type RequestLogSubsetA = z.infer<typeof RequestLogSubsetA>;
export type RequestLogSubsetMapping = {
  A: RequestLogSubsetA;
};
export const RequestLogSubsetKey = z.enum(["A"]);
export type RequestLogSubsetKey = z.infer<typeof RequestLogSubsetKey>;