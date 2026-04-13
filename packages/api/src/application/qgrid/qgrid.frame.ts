import type { FastifyReply } from "fastify";
import { api, BaseFrameClass } from "sonamu";

import { RequestLogModel } from "../request-log/request-log.model";
import { TokenModel } from "../token/token.model";
import type { RefreshTokenParams } from "../token/token.types";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUsage,
  generatePKCE,
  refreshAccessToken,
} from "./oauth";
import { type ClaudePool, getPool } from "./pool";
import type {
  CliResult,
  HealthResponse,
  OAuthStartResult,
  TokenStats,
  UsageResponse,
} from "./qgrid.types";

// PKCE 세션 메모리 저장 (state → { codeVerifier, name, redirectUri })
const pendingOAuth = new Map<string, { codeVerifier: string; name: string; redirectUri: string }>();

class QgridFrameClass extends BaseFrameClass {
  constructor() {
    super("Qgrid");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(prompt: string, system?: string, timeout?: number): Promise<CliResult> {
    const pool = getPool();
    const result = await pool.query({ system, prompt }, timeout);

    // 로그 기록 실패해도 쿼리 결과는 반환
    TokenModel.findByToken("A", pool.lastUsedToken)
      .then((tokenEntry) => {
        RequestLogModel.save([
          {
            token_name: tokenEntry?.name ?? "Unknown Key",
            query: system ? `[System]\n${system}\n\n[User]\n${prompt}` : prompt,
            response: result.text,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cache_read_tokens: result.usage.cache_read_input_tokens,
            cache_creation_tokens: result.usage.cache_creation_input_tokens,
            duration_ms: result.durationMs,
          },
        ]);
      })
      .catch((e) => console.error("requestLog save failed:", e));

    return result;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    const pool = getPool();
    const entries = await TokenModel.findActive("A");
    const tokenNames = new Map(entries.map((e) => [e.token, e.name]));
    return pool.getStats(tokenNames);
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(token: string, name: string, refreshToken?: string): Promise<{ added: boolean }> {
    await TokenModel.save([
      {
        token,
        name,
        ...(refreshToken && refreshToken.length > 0 ? { refresh_token: refreshToken } : {}),
      },
    ]);
    getPool().createWorkers(token);
    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(
    token: string,
    name?: string,
    newToken?: string,
    refreshToken?: string,
  ): Promise<{ updated: boolean }> {
    const pool = getPool();
    const entry = await TokenModel.findByToken("A", token);
    if (!entry) return { updated: false };

    const hasNewToken = newToken !== undefined && newToken.length > 0;
    const hasRefreshToken = refreshToken !== undefined && refreshToken.length > 0;
    await TokenModel.save([
      {
        id: entry.id,
        token: hasNewToken ? newToken : entry.token,
        name: name !== undefined ? name : entry.name,
        ...(hasRefreshToken ? { refresh_token: refreshToken } : {}),
      },
    ]);

    if (hasNewToken) {
      pool.destroyWorkers(token);
      pool.createWorkers(newToken);
    }
    return { updated: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(token: string): Promise<{ removed: boolean }> {
    const pool = getPool();
    if (!pool.workers.has(token)) return { removed: false };

    const entry = await TokenModel.findByToken("A", token);
    if (entry) await TokenModel.del([entry.id]);
    pool.destroyWorkers(token);
    return { removed: true };
  }

  /**
   *
   * @param id token_id
   * 토큰 활성화/비활성화 토글 (pool 워커 생성/제거 & DB의 active 필드 업데이트)
   *
   * @returns 토큰 활성화 여부
   */
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async toggleToken(id: number): Promise<{ active: boolean }> {
    const pool = getPool();
    const entry = await TokenModel.findOne("A", { id });
    if (!entry) return { active: false };

    const newActive = !entry.active;
    await TokenModel.save([{ id, token: entry.token, active: newActive, name: entry.name }]);

    // 토큰의 새로운 상태가 활성화면/비활성화면
    if (newActive) {
      // 워커 생성
      pool.createWorkers(entry.token);
    } else {
      // 워커 제거
      pool.destroyWorkers(entry.token);
    }

    return { active: newActive };
  }

  // OAuth 로그인: authUrl 생성 (프론트에서 이 API 호출 후 authUrl로 리다이렉트)
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthStart(name: string): Promise<OAuthStartResult> {
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    const serverPort = process.env.PORT ?? "44900";
    const redirectUri = `http://localhost:${serverPort}/callback`;
    const authUrl = buildAuthUrl(codeChallenge, state, redirectUri);

    // PKCE를 메모리에 저장 (5분 TTL)
    pendingOAuth.set(state, { codeVerifier, name, redirectUri });
    setTimeout(() => pendingOAuth.delete(state), 300_000);

    return { authUrl };
  }

  // OAuth 콜백 처리 — sonamu.config.ts의 custom 라우트에서 호출됨
  async handleOAuthCallback(code: string, state: string, reply: FastifyReply): Promise<void> {
    const pool = getPool();
    const pending = pendingOAuth.get(state);
    if (!pending) {
      return reply.redirect("/?oauth=error&reason=invalid_state");
    }
    pendingOAuth.delete(state);

    try {
      const tokens = await exchangeCodeForTokens(
        code,
        pending.codeVerifier,
        state,
        pending.redirectUri,
      );

      // 같은 계정의 이전 토큰이 있으면 교체
      if (tokens.accountUuid) {
        const oldEntries = await TokenModel.findByAccountUuid("A", tokens.accountUuid);
        for (const old of oldEntries) {
          pool.destroyWorkers(old.token);
          await TokenModel.del([old.id]);
        }
      }

      // 새 토큰 저장 + pool에 등록
      await TokenModel.save([
        {
          token: tokens.accessToken,
          name: pending.name,
          refresh_token: tokens.refreshToken,
          expires_at: tokens.expiresAt ? BigInt(tokens.expiresAt) : null,
          account_uuid: tokens.accountUuid,
        },
      ]);
      pool.createWorkers(tokens.accessToken);

      return reply.redirect(`/?oauth=success&name=${encodeURIComponent(pending.name)}`);
    } catch (e) {
      return reply.redirect(`/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`);
    }
  }

  // 토큰 사용량 조회 (OAuth usage API)
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async usage(tokenName?: string): Promise<UsageResponse> {
    const pool = getPool();
    const { rows: allTokens } = await TokenModel.findMany("A");
    const entry = tokenName
      ? allTokens.find((e) => e.name === tokenName)
      : allTokens.findLast((e) => e.active);

    if (!entry) return { error: "NOT_FOUND" };

    // 만료 확인 + refresh 시도
    let accessToken = entry.token;
    const isExpired = entry.expires_at && Number(entry.expires_at) < Date.now();

    if (isExpired && entry.refresh_token) {
      try {
        accessToken = await this.refreshToken(pool, entry);
      } catch (e) {
        console.warn(`[usage] refresh failed for ${entry.name}: ${(e as Error).message}`);
        return { error: "re-login required" };
      }
    }

    // usage 호출
    const result = await fetchUsage(accessToken);

    // 인증 에러면 refresh_token으로 재시도
    if (result.error && entry.refresh_token) {
      try {
        accessToken = await this.refreshToken(pool, entry);
        return await fetchUsage(accessToken);
      } catch (e) {
        console.warn(`[usage] refresh failed for ${entry.name}: ${(e as Error).message}`);
        return { error: "re-login required" };
      }
    }

    return result;
  }

  async refreshToken(pool: ClaudePool, token: RefreshTokenParams): Promise<string> {
    if (!token.refresh_token) throw new Error("No refresh token");
    const refreshed = await refreshAccessToken(token.refresh_token);
    await TokenModel.save([
      {
        id: token.id,
        token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        expires_at: BigInt(refreshed.expiresAt),
        name: token.name ?? "",
      },
    ]);
    pool.destroyWorkers(token.token);
    pool.createWorkers(refreshed.accessToken);
    return refreshed.accessToken;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async health(): Promise<HealthResponse> {
    const pool = getPool();
    return {
      status: "ok",
      workers: [...pool.workers.values()].flat().length,
      activeTokens: pool.workers.size - pool.quotaExhausted.size,
    };
  }
}

export const QgridFrame = new QgridFrameClass();
