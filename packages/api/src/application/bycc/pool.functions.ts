/**
 * ClaudePool — 멀티 토큰 프로세스 풀.
 *
 * 2-layer 아키텍처: ClaudePool → Worker (flat)
 * - Map<token, Worker[]>로 토큰별 워커 관리 (원본 토큰이 키)
 * - least-queue-depth 라우팅
 * - 투명한 쿼터 failover (QuotaError 시 다른 토큰으로 자동 재시도)
 * - DB(tokens 테이블) 기반 토큰 관리
 */
import { TokenModel } from "../token/token.model";
import type { CliResult, PoolConfig, QueryInput, TokenStats } from "./bycc.types";
import { QuotaError } from "./bycc.types";
import { Worker, type WorkerConfig } from "./worker.functions";

class ClaudePool {
  workers = new Map<string, Worker[]>();
  quotaExhausted = new Set<string>();
  requestCounts = new Map<string, number>();
  lastUsedToken = "";
  size: number;
  model: string;
  timeout: number;
  cwd: string;
  maxCalls: number;

  constructor(config: PoolConfig) {
    this.size = config.size ?? 3;
    this.model = config.model ?? "sonnet";
    this.timeout = config.timeout ?? 300_000;
    this.cwd = config.cwd ?? "/tmp/bycc";
    this.maxCalls = config.maxCalls ?? 500;

    config.tokens.forEach((token) => {
      this.createWorkers(token);
    });
  }

  async addToken(token: string, name?: string): Promise<void> {
    await TokenModel.save([{ token, name, active: true }]);
    this.createWorkers(token);
  }

  async removeToken(token: string): Promise<boolean> {
    if (!this.workers.has(token)) return false;

    const entry = await TokenModel.findByToken("A", token);
    if (entry) await TokenModel.del([entry.id]);
    this.destroyWorkers(token);
    return true;
  }

  async getStats(): Promise<TokenStats[]> {
    const entries = await TokenModel.findActive("A");
    return [...this.workers.keys()].map((token) => ({
      token,
      name: entries.find((e) => e.token === token)?.name ?? undefined,
      requests: this.requestCounts.get(token) ?? 0,
      active: !this.quotaExhausted.has(token),
    }));
  }

  selectWorker(): Worker | null {
    const candidates = [...this.workers.entries()]
      .filter(([token]) => !this.quotaExhausted.has(token))
      .flatMap(([, workers]) => workers);

    if (candidates.length === 0) return null;

    // 햔제 찰; 증 + 대기 큐 합계가 가장 적은 워커에 배정
    return candidates.reduce((best, w) => (w.getQueueDepth() < best.getQueueDepth() ? w : best));
  }

  async query(input: QueryInput, timeoutMs?: number): Promise<CliResult> {
    const triedTokens = new Set<string>();

    while (true) {
      const worker = this.selectWorker();
      if (!worker) {
        throw new QuotaError("All tokens exhausted");
      }

      if (triedTokens.has(worker.tokenId)) {
        throw new QuotaError("All tokens exhausted");
      }

      try {
        const result = await worker.query(input, timeoutMs);
        this.lastUsedToken = worker.tokenId;
        this.requestCounts.set(worker.tokenId, (this.requestCounts.get(worker.tokenId) ?? 0) + 1);

        return result;
      } catch (err) {
        if (err instanceof QuotaError) {
          this.quotaExhausted.add(worker.tokenId);
          triedTokens.add(worker.tokenId);
          continue;
        }
        throw err;
      }
    }
  }

  kill(): void {
    [...this.workers.values()].flat().forEach((w) => {
      w.kill();
    });
  }

  createWorkers(token: string): void {
    if (this.workers.has(token)) return;

    const workerConfig: WorkerConfig = {
      token,
      model: this.model,
      timeout: this.timeout,
      cwd: this.cwd,
      maxCalls: this.maxCalls,
    };

    const workers = Array.from({ length: this.size }, () => new Worker(workerConfig));
    this.workers.set(token, workers);
    this.requestCounts.set(token, 0);
  }

  destroyWorkers(token: string): void {
    const workers = this.workers.get(token);
    if (!workers) return;

    workers.forEach((w) => {
      w.kill();
    });
    this.workers.delete(token);
    this.quotaExhausted.delete(token);
    this.requestCounts.delete(token);
  }
}

// DB에서 인증토큰 로드
let pool: ClaudePool | null = null;
let initPromise: Promise<ClaudePool> | null = null;

export async function initPool(): Promise<ClaudePool> {
  const entries = await TokenModel.findActive("A");
  const tokens = entries.map((e) => e.token);
  pool = new ClaudePool({ tokens });
  return pool;
}

export async function getPool(): Promise<ClaudePool> {
  if (pool) return pool;
  if (!initPromise) {
    initPromise = initPool().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}
