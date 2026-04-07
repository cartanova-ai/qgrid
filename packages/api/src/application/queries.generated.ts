/**
 * @generated
 * 직접 수정하지 마세요.
 */
/** biome-ignore-all lint: generated는 무시 */
/** biome-ignore-all assist: generated는 무시 */

import type { SSRQuery } from "sonamu/ssr";

// SSRQuery 헬퍼 함수
function createSSRQuery(
  modelName: string,
  methodName: string,
  params: any[],
  serviceKey: [string, string],
): SSRQuery {
  return { modelName, methodName, params, serviceKey, __brand: "SSRQuery" } as SSRQuery;
}

import { RequestLogListParams } from "./request-log/request-log.types";
import { RequestLogSubsetKey, TokenSubsetKey } from "./sonamu.generated";
import { TokenListParams } from "./token/token.types";

export namespace TokenService {
  export const getToken = <T extends TokenSubsetKey>(subset: T, id: number): SSRQuery =>
    createSSRQuery("TokenModel", "findById", [subset, id], ["Token", "getToken"]);

  export const getTokens = <T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
  ): SSRQuery =>
    createSSRQuery("TokenModel", "findMany", [subset, rawParams], ["Token", "getTokens"]);
}

export namespace RequestLogService {
  export const getRequestLog = <T extends RequestLogSubsetKey>(subset: T, id: number): SSRQuery =>
    createSSRQuery("RequestLogModel", "findById", [subset, id], ["RequestLog", "getRequestLog"]);

  export const getRequestLogs = <T extends RequestLogSubsetKey, LP extends RequestLogListParams>(
    subset: T,
    rawParams?: LP,
  ): SSRQuery =>
    createSSRQuery(
      "RequestLogModel",
      "findMany",
      [subset, rawParams],
      ["RequestLog", "getRequestLogs"],
    );
}

export namespace ByccService {
  export const stats = (): SSRQuery => createSSRQuery("ByccFrame", "stats", [], ["Bycc", "stats"]);

  export const usage = (tokenName?: string): SSRQuery =>
    createSSRQuery("ByccFrame", "usage", [tokenName], ["Bycc", "usage"]);

  export const health = (): SSRQuery =>
    createSSRQuery("ByccFrame", "health", [], ["Bycc", "health"]);
}
