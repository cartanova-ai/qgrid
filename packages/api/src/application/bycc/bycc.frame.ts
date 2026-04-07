/**
 * ByCC Frame — Sonamu HTTP API 엔드포인트.
 *
 * POST   /api/bycc/query       — LLM 쿼리 (system?, prompt)
 * GET    /api/bycc/stats       — 토큰별 상태
 * POST   /api/bycc/addToken    — 토큰 추가 (수동)
 * POST   /api/bycc/updateToken — 토큰 수정
 * POST   /api/bycc/removeToken — 토큰 제거
 * POST   /api/bycc/oauthLogin  — OAuth 로그인 (브라우저)
 * GET    /api/bycc/usage       — 쿼터 사용률 (Anthropic API)
 * GET    /api/bycc/health      — 헬스체크
 */
import { exec } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { api, BaseFrameClass } from "sonamu";
import { RequestLogModel } from "../request-log/request-log.model";
import { TokenModel } from "../token/token.model";
import type {
  CliResult,
  HealthResponse,
  OAuthLoginResult,
  TokenStats,
  UsageResponse,
} from "./bycc.types";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUsage,
  generatePKCE,
  refreshAccessToken,
} from "./oauth.functions";
import { getPool } from "./pool.functions";

class ByccFrameClass extends BaseFrameClass {
  constructor() {
    super("Bycc");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(prompt: string, system?: string, timeout?: number): Promise<CliResult> {
    const pool = await getPool();
    const result = await pool.query({ system, prompt }, timeout);

    // 로그 기록 실패해도 쿼리 결과는 반환
    TokenModel.findByToken("A", pool.lastUsedToken)
      .then((tokenEntry) => {
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
        ]);
      })
      .catch((e) => console.error("requestLog save failed:", e));

    return result;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    const pool = await getPool();
    return pool.getStats();
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(token: string, name?: string): Promise<{ added: boolean }> {
    const pool = await getPool();
    await pool.addToken(token, name);
    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(
    token: string,
    name?: string,
    newToken?: string,
  ): Promise<{ updated: boolean }> {
    const pool = await getPool();
    const entry = await TokenModel.findByToken("A", token);
    if (!entry) return { updated: false };

    await TokenModel.save([
      {
        id: entry.id,
        token: newToken ?? entry.token,
        ...(name !== undefined && { name }),
      },
    ]);

    if (newToken) {
      pool.destroyWorkers(token);
      pool.createWorkers(newToken);
    }
    return { updated: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(token: string): Promise<{ removed: boolean }> {
    const pool = await getPool();
    const removed = await pool.removeToken(token);
    return { removed };
  }

  // OAuth 로그인 — 임시 콜백 서버를 띄우고 auth URL 반환
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async oauthLogin(name: string): Promise<OAuthLoginResult> {
    const pool = await getPool();
    const { codeVerifier, codeChallenge, state } = generatePKCE();

    // 임시 콜백 서버
    const { port, code } = await new Promise<{ port: number; code: string }>((resolve, reject) => {
      let listenPort = 0;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "", `http://localhost`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }

        const authCode = url.searchParams.get("code");
        const receivedState = url.searchParams.get("state");

        if (!authCode || receivedState !== state) {
          res.writeHead(400);
          res.end("Invalid callback");
          reject(new Error("Invalid OAuth callback"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Login successful!</h1><p>You can close this tab and return to ByCC.</p>");
        resolve({ port: listenPort, code: authCode });
        server.close();
      });

      server.listen(0, "localhost", () => {
        const addrInfo = server.address() as AddressInfo;
        listenPort = addrInfo.port;
        const authUrl = buildAuthUrl(codeChallenge, state, listenPort);

        exec(`open "${authUrl}"`);
      });

      // 5분 타임아웃
      setTimeout(() => {
        server.close();
        reject(new Error("OAuth login timed out"));
      }, 300_000);
    });

    // code → token 교환
    const tokens = await exchangeCodeForTokens(code, codeVerifier, state, port);

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
        name,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt ? BigInt(tokens.expiresAt) : null,
        account_uuid: tokens.accountUuid,
      },
    ]);
    pool.createWorkers(tokens.accessToken);

    return { token: tokens.accessToken, name };
  }

  // 토큰 사용량 조회 (OAuth usage API)
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async usage(tokenName?: string): Promise<UsageResponse> {
    const pool = await getPool();
    const allTokens = await TokenModel.findActive("A");
    const entry = tokenName
      ? allTokens.find((e) => e.name === tokenName && e.refresh_token)
      : allTokens.findLast((e) => e.active && e.refresh_token);

    if (!entry) return {} as UsageResponse;

    // 토큰 만료 체크 + refresh
    let accessToken = entry.token;
    if (entry.expires_at && Number(entry.expires_at) < Date.now() && entry.refresh_token) {
      const refreshed = await refreshAccessToken(entry.refresh_token);
      // DB 업데이트
      await TokenModel.save([
        {
          id: entry.id,
          token: refreshed.accessToken,
          refresh_token: refreshed.refreshToken,
          expires_at: BigInt(refreshed.expiresAt),
        },
      ]);
      // pool 워커도 업데이트
      pool.destroyWorkers(entry.token);
      pool.createWorkers(refreshed.accessToken);
      accessToken = refreshed.accessToken;
    }

    const result = await fetchUsage(accessToken);
    return result ?? ({} as UsageResponse);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async health(): Promise<HealthResponse> {
    const pool = await getPool();
    return {
      status: "ok",
      workers: [...pool.workers.values()].flat().length,
      activeTokens: pool.workers.size - pool.quotaExhausted.size,
    };
  }
}

export const ByccFrame = new ByccFrameClass();
