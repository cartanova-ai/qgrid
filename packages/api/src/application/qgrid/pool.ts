/**
 * ClaudePool — 멀티 토큰 프로세스 풀.
 *
 * 2-layer 라우팅: 토큰 선택 (least-total-depth + round-robin) → 워커 선택
 * - Map<token, Worker[]>로 토큰별 워커 관리
 * - 토큰 간 quota 균등 소진
 */
import { type CliResult, type PoolConfig, type QueryInput, type TokenStats } from "./qgrid.types";
import { QuotaError } from "./qgrid.types";
import { Worker, type WorkerConfig } from "./worker";

export class ClaudePool {
  workers = new Map<string, Worker[]>();
  tokenNames = new Map<string, string>();
  quotaExhausted = new Set<string>();
  requestCounts = new Map<string, number>();
  lastUsedToken = "";
  lastUsedWorkerIndex = 0;
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

    config.tokens.forEach(({ token, name }) => {
      this.createWorkers(token, name);
    });
  }

  getLastUsedWorkerName(): string {
    const baseName = this.tokenNames.get(this.lastUsedToken) ?? "Unknown";
    return `${baseName}-${this.lastUsedWorkerIndex}`;
  }

  getStats(): TokenStats[] {
    return [...this.workers.keys()].map((token) => ({
      token,
      name: this.tokenNames.get(token) ?? "Unknown",
      requests: this.requestCounts.get(token) ?? 0,
      active: !this.quotaExhausted.has(token),
    }));
  }

  private tokenRrIndex = 0;
  private workerRrIndexes = new Map<string, number>();

  selectWorker(): Worker | null {
    const availableTokens = [...this.workers.entries()].filter(
      ([token]) => !this.quotaExhausted.has(token),
    );

    if (availableTokens.length === 0) return null;

    // 1단계: 토큰별 총 큐 depth가 가장 낮은 토큰 선택
    const tokenDepths = availableTokens.map(([token, workers]) => ({
      token,
      workers,
      totalDepth: workers.reduce((sum, w) => sum + w.getQueueDepth(), 0),
    }));
    const minTokenDepth = Math.min(...tokenDepths.map((t) => t.totalDepth));
    const idleTokens = tokenDepths.filter((t) => t.totalDepth === minTokenDepth);
    const selected = idleTokens[this.tokenRrIndex % idleTokens.length]!;
    this.tokenRrIndex++;

    // 2단계: 토큰 내에서 least-depth 워커, 동률이면 round-robin
    const minDepth = Math.min(...selected.workers.map((w) => w.getQueueDepth()));
    const idleWorkers = selected.workers.filter((w) => w.getQueueDepth() === minDepth);
    const wrIdx = this.workerRrIndexes.get(selected.token) ?? 0;
    const picked = idleWorkers[wrIdx % idleWorkers.length]!;
    this.workerRrIndexes.set(selected.token, wrIdx + 1);

    return picked;
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
        const tokenWorkers = this.workers.get(worker.tokenId);
        this.lastUsedWorkerIndex = tokenWorkers ? tokenWorkers.indexOf(worker) + 1 : 0;
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

  createWorkers(token: string, name: string): void {
    if (this.workers.has(token)) return;

    this.tokenNames.set(token, name);
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
    this.tokenNames.delete(token);
    this.quotaExhausted.delete(token);
    this.requestCounts.delete(token);
  }
}

// Pool 싱글턴 관리
let pool: ClaudePool | null = null;

export function initPool(tokens: { token: string; name: string }[]): ClaudePool {
  pool = new ClaudePool({ tokens });
  return pool;
}

export function getPool(): ClaudePool {
  if (!pool) throw new Error("Pool not initialized. Call initPool() first.");
  return pool;
}
