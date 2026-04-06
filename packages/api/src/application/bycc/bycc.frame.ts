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
import { RequestLogModel } from "../request-log/request-log.model";
import type { CliResult, HealthResponse, TokenStats } from "./bycc.types";
import { pool } from "./pool.functions";
import { getTokenFilePath, loadTokens, updateTokenInFile } from "./tokens.functions";

class ByccFrameClass extends BaseFrameClass {
  constructor() {
    super("Bycc");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(prompt: string, system?: string, timeout?: number): Promise<CliResult> {
    const result = await pool.query({ system, prompt }, timeout);

    // 로그 기록 실패해도 쿼리 결과는 반환
    const tokenEntry = loadTokens().find((e) => e.token === pool.lastUsedToken);
    RequestLogModel.save([
      {
        token_name: tokenEntry?.name ?? "Unknown",
        query: system ? `[System]\n${system}\n\n[User]\n${prompt}` : prompt,
        response: result.text,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_input_tokens,
        cache_creation_tokens: result.usage.cache_creation_input_tokens,
        duration_ms: result.durationMs,
      },
    ]).catch((e) => console.error("requestLog save failed:", e));

    return result;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    return pool.getStats();
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(token: string, name?: string): Promise<{ added: boolean }> {
    pool.addToken(token, name);
    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(
    token: string,
    name?: string,
    newToken?: string,
  ): Promise<{ updated: boolean }> {
    const entry = updateTokenInFile(token, { name, token: newToken || undefined });
    if (!entry) return { updated: false };

    if (newToken) {
      pool.destroyWorkers(token);
      pool.createWorkers(newToken);
    }
    return { updated: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(token: string): Promise<{ removed: boolean }> {
    const removed = pool.removeToken(token);
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
