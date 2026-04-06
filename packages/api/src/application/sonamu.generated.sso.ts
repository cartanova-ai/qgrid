/**
 * @generated
 * 직접 수정하지 마세요.
 */
import type { DatabaseSchemaExtend, PuriLoaderQueries, PuriWrapper } from "sonamu";
import type { RequestLogBaseSchema, RequestLogSubsetKey } from "./sonamu.generated";

// SubsetQuery: RequestLog
export const requestLogSubsetQueries = {
  A: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_logs").select({
      id: "request_logs.id",
      created_at: "request_logs.created_at",
      token_name: "request_logs.token_name",
      query: "request_logs.query",
      response: "request_logs.response",
      input_tokens: "request_logs.input_tokens",
      output_tokens: "request_logs.output_tokens",
      cache_read_tokens: "request_logs.cache_read_tokens",
      cache_creation_tokens: "request_logs.cache_creation_tokens",
      duration_ms: "request_logs.duration_ms",
    });
  },
};

// LoaderQuery: RequestLog
export const requestLogLoaderQueries = {
  A: [],
} as const satisfies PuriLoaderQueries<RequestLogSubsetKey>;

// DatabaseSchema
declare module "sonamu" {
  export interface DatabaseSchemaExtend {
    request_logs: RequestLogBaseSchema;
  }

  export interface DatabaseForeignKeys {}
}
