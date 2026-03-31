/**
 * ByCC Frame — Sonamu HTTP API 엔드포인트.
 *
 * POST   /api/bycc/query       — LLM 쿼리 (system?, prompt)
 * GET    /api/bycc/stats       — 토큰별 사용량
 * POST   /api/bycc/addToken    — 토큰 추가
 * POST   /api/bycc/removeToken — 토큰 제거
 * GET    /api/bycc/health      — 헬스체크
 */
import { api, BaseFrameClass } from "sonamu";
import type { CliResult, HealthResponse, TokenStats } from "./bycc.types";
import { pool } from "./pool.functions";
import { getTokenFilePath, updateTokenInFile } from "./tokens.functions";

class ByccFrameClass extends BaseFrameClass {
  constructor() {
    super("Bycc");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(prompt: string, system?: string, timeout?: number): Promise<CliResult> {
    return pool.query({ system, prompt }, timeout);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    return pool.getStats();
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(token: string): Promise<{ added: boolean; token: string }> {
    const masked = pool.addToken(token);
    return { added: true, token: masked };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(masked: string, name?: string, token?: string): Promise<{ updated: boolean }> {
    const entry = updateTokenInFile(masked, { name, token });
    if (!entry) return { updated: false };

    // 토큰 값이 변경되면 풀의 워커도 교체
    if (token) {
      pool.destroyWorkers(masked);
      pool.createWorkers(token);
    }
    return { updated: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(masked: string): Promise<{ removed: boolean }> {
    const removed = pool.removeToken(masked);
    return { removed };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async health(): Promise<HealthResponse> {
    return {
      status: "ok",
      workers: [...pool.workers.values()].flat().length,
      activeTokens: pool.workers.size - pool.quotaExhausted.size,
      tokenDir: getTokenFilePath(),
    };
  }
}

export const ByccFrame = new ByccFrameClass();
