// 읽기 전용 모니터링 API. 조회 자체는 request log에 남기지 않는다.
import { api, BaseFrameClass, DB } from "sonamu";

import { resolveOpenAITransportKind } from "../../utils/providers/openai/openai-transport-config";
import { QgridDispatcher } from "../qgrid/qgrid.dispatcher";
import { RequestLogModel } from "../request-log/request-log.model";
import { monitLogBuffer } from "./log-buffer";
import {
  type MonitLogChunk,
  type MonitServerInfo,
  type MonitStats,
  type MonitVitals,
} from "./monit.types";

// 응답당 엔트리 상한 — 폴링 클라이언트는 다음 폴에서 이어서 따라잡는다.
const RESPONSE_ENTRY_LIMIT = 1_000;

class MonitFrameClass extends BaseFrameClass {
  constructor() {
    super("Monit");
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async monitLogs(cursor?: number): Promise<MonitLogChunk> {
    return {
      processStartedAt: monitLogBuffer.processStartedAt,
      ...monitLogBuffer.after(cursor, RESPONSE_ENTRY_LIMIT),
      vitals: currentVitals(),
    };
  }

  // 프로세스 정적 정보 — 폴링 불필요, 페이지당 1회 조회.
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async monitInfo(): Promise<MonitServerInfo> {
    const transport = resolveOpenAITransportKind();
    const host = process.env.HOST ?? "localhost";
    const port = process.env.PORT ?? "44900";
    const conn = activeDbConnection();
    return {
      serverUrl: `http://${host}:${port}`,
      dbHost: conn.host ?? "localhost",
      dbName: conn.database ?? "qgrid",
      openai: { transport },
    };
  }

  // DB를 조회하므로 메모리 기반 vitals보다 느린 주기로 폴링한다.
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async monitStats(): Promise<MonitStats> {
    const windowMinutes = 60;
    const since = new Date(Date.now() - windowMinutes * 60_000);
    return { windowMinutes, providers: await RequestLogModel.providerStatsSince(since) };
  }
}

function currentVitals(): MonitVitals {
  const anthropic = QgridDispatcher.anthropicDispatcher;
  return {
    openaiInFlight: QgridDispatcher.openaiDispatcher?.inFlight ?? 0,
    openaiQuotaByToken: QgridDispatcher.openaiDispatcher?.getQuotaSnapshot() ?? [],
    anthropicTokenCount: anthropic?.tokenPool.size ?? 0,
    anthropicTokenNames: anthropic
      ? [...anthropic.tokenPool.values()].map((token) => token.name).toSorted()
      : [],
    anthropicInFlight: anthropic?.inFlight ?? 0,
  };
}

// 실제 활성 knex 연결에서 읽는다 — dev 서버의 통합 테스트 러너가 process.env.SONAMU_DB_NAME 을
// 테스트 DB 이름으로 덮어쓰므로 env 는 신뢰할 수 없다. DB 미초기화(부팅 전) 시에만 env 폴백.
function activeDbConnection(): { host?: string; database?: string } {
  try {
    const connection = DB.getDBConfig("w").connection;
    if (typeof connection === "object" && connection !== null) {
      return connection as { host?: string; database?: string };
    }
  } catch {
    // DB config 미초기화 — env 폴백으로 진행
  }
  return { host: process.env.SONAMU_DB_HOST, database: process.env.SONAMU_DB_NAME };
}

export const MonitFrame = new MonitFrameClass();
