/**
 * ClaudePool — 멀티 토큰 프로세스 풀.
 *
 * 2-layer 아키텍처: ClaudePool → Worker (flat)
 * - Map<token, Worker[]>로 토큰별 워커 관리 (원본 토큰이 키)
 * - least-queue-depth 라우팅
 * - 투명한 쿼터 failover (QuotaError 시 다른 토큰으로 자동 재시도)
 * - 워커 관리만 담당 (DB 의존 없음)
 */
import type { CliResult, PoolConfig, QueryInput, TokenStats } from "./qgrid.types";
import { QuotaError } from "./qgrid.types";
import { Worker, type WorkerConfig } from "./worker";

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
    this.cwd = config.cwd ?? "/tmp/qgrid";
    this.maxCalls = config.maxCalls ?? 500;

    config.tokens.forEach((token) => {
      this.createWorkers(token);
    });
  }

  getStats(tokenNames?: Map<string, string>): TokenStats[] {
    return [...this.workers.keys()].map((token) => ({
      token,
      name: tokenNames?.get(token) ?? "Unknown Key",
      requests: this.requestCounts.get(token) ?? 0,
      active: !this.quotaExhausted.has(token),
    }));
  }

  selectWorker(): Worker | null {
    const candidates = [...this.workers.entries()]
      .filter(([token]) => !this.quotaExhausted.has(token))
      .flatMap(([, workers]) => workers);

    if (candidates.length === 0) return null;

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

// Pool 싱글턴 관리
let pool: ClaudePool | null = null;

export function initPool(tokens: string[]): ClaudePool {
  pool = new ClaudePool({ tokens });
  return pool;
}

export function getPool(): ClaudePool {
  if (!pool) throw new Error("Pool not initialized. Call initPool() first.");
  return pool;
}
