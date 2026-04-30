/**
 * QgridDispatcher — OAuth 토큰 선택 + claude CLI fresh spawn 디스패처 싱글턴.
 *
 * - 매 요청마다 새 claude CLI 프로세스 spawn → 응답 후 종료
 * - system 은 --append-system-prompt 로 분리 전달 (user turn 오염 방지)
 * - least-used round-robin 으로 토큰 선택
 * - QuotaError 는 그대로 상위 전파 (자동 failover 없음, UI 에서 수동 토글)
 *
 * env allowlist: PATH, TMPDIR, CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_DISABLE_*
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { getLogger } from "@logtape/logtape";

import { type CliResult, type QueryInput, type TokenStats } from "./qgrid.types";
import { maskToken, ProcessError, QuotaError, TimeoutError } from "./qgrid.types";

const logger = getLogger(["qgrid"]);

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 600_000;

// claude CLI 의 cwd. 이 경로의 .claude/settings.json 이 project scope 로 로드되어
// 혹시라도 있을 user scope (~/.claude/settings.json)를 덮어씀 (--setting-sources project 와 함께).
const CLAUDE_CWD = "/tmp/qgrid";

// qgrid 전용 project settings — user scope 격리용
const QGRID_CLAUDE_SETTINGS = {
  alwaysThinkingEnabled: false, // thinking block 차단
  includeGitInstructions: false, // system prompt 의 git 가이드 제거
  cleanupPeriodDays: 1,
};

class QgridDispatcherClass {
  tokens = new Map<string, string>();
  requestCounts = new Map<string, number>();
  rrIndex = 0;

  constructor() {
    mkdirSync(`${CLAUDE_CWD}/.claude`, { recursive: true });
    writeFileSync(
      `${CLAUDE_CWD}/.claude/settings.json`,
      JSON.stringify(QGRID_CLAUDE_SETTINGS, null, 2),
    );
  }

  getStats(): TokenStats[] {
    return [...this.tokens.entries()].map(([token, name]) => ({
      token,
      name,
      requests: this.requestCounts.get(token) ?? 0,
    }));
  }

  selectToken(): { token: string; name: string } | null {
    const entries = [...this.tokens.entries()];
    if (entries.length === 0) return null;

    const minCount = Math.min(...entries.map(([t]) => this.requestCounts.get(t) ?? 0));
    const idle = entries.filter(([t]) => (this.requestCounts.get(t) ?? 0) === minCount);
    const picked = idle[this.rrIndex % idle.length]!;
    this.rrIndex++;
    return { token: picked[0], name: picked[1] };
  }

  async query(input: QueryInput, timeoutMs?: number): Promise<CliResult> {
    const sel = this.selectToken();
    if (!sel) throw new QuotaError("No tokens available");

    // await 전에 count 선반영. 병렬 요청이 동시에 도착해도 각자 다른 토큰을 고르도록.
    this.requestCounts.set(sel.token, (this.requestCounts.get(sel.token) ?? 0) + 1);

    logger.info(`→ ${sel.name} (model: ${input.model ?? DEFAULT_MODEL})`);

    const result = await executeClaude(input, sel.token, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { ...result, tokenName: sel.name, model: input.model ?? DEFAULT_MODEL };
  }

  addToken(token: string, name: string): void {
    if (this.tokens.has(token)) return;
    this.tokens.set(token, name);
    this.requestCounts.set(token, 0);
  }

  removeToken(token: string): void {
    this.tokens.delete(token);
    this.requestCounts.delete(token);
  }

  hasToken(token: string): boolean {
    return this.tokens.has(token);
  }
}

async function executeClaude(
  input: QueryInput,
  token: string,
  timeoutMs: number,
): Promise<CliResult> {
  const model = input.model ?? DEFAULT_MODEL;
  const timeout = input.timeout ?? timeoutMs;
  const useStructuredOutput = input.jsonSchema && input.jsonSchema.length > 0;

  // --tools "" 로 모든 tool 을 기본 차단. structured output 쓰면 StructuredOutput 만 화이트리스트.
  // --tools "" 는 반드시 뒤에 다른 플래그가 와야 CLI 파싱이 빈 문자열로 인식
  const toolArgs = useStructuredOutput
    ? ["--tools", "", "--allowed-tools", "StructuredOutput"]
    : ["--tools", ""];

  const args: string[] = [
    "-p",
    ...toolArgs,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    // structured output 은 tool_use + tool_result 로 2턴 소비
    useStructuredOutput ? "2" : "1",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
    "--model",
    model,
    // thinking 비활성화는 project settings (alwaysThinkingEnabled: false) 에서 처리
    "--exclude-dynamic-system-prompt-sections", // cwd/env 를 user msg 로 이동 → prefix cache 안정화
    "--no-session-persistence", // ~/.claude/projects/ 의 orphan jsonl 누적 방지
  ];
  if (useStructuredOutput) {
    args.push("--json-schema", input.jsonSchema!);
  }
  if (input.system) {
    args.push("--append-system-prompt", input.system);
  }
  args.push(input.prompt);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
  };

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env,
      cwd: CLAUDE_CWD,
    });

    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new TimeoutError(`Timeout after ${timeout / 1000}s (token: ${maskToken(token)})`));
    }, timeout);

    child.stdout?.on("data", (d: Buffer) => {
      if (settled) return;
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.type === "result" && !settled) {
            // --json-schema 사용 시 structured_output 에 파싱된 객체가 온다 → 우선 사용
            let text: string;
            if (j.structured_output !== undefined) {
              text = JSON.stringify(j.structured_output);
            } else {
              text = (j.result ?? "")
                .replace(/^```(?:json)?\s*\n?/i, "")
                .replace(/\n?```\s*$/i, "");
            }

            if (text.startsWith("You've hit")) {
              settled = true;
              clearTimeout(timer);
              reject(new QuotaError(`Quota exhausted (token: ${maskToken(token)})`));
              return;
            }

            const u = j.usage ?? {};
            settled = true;
            clearTimeout(timer);
            resolve({
              text,
              usage: {
                input_tokens: u.input_tokens ?? 0,
                output_tokens: u.output_tokens ?? 0,
                cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
                cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
              },
              durationMs: j.duration_ms ?? 0,
              costUsd: j.total_cost_usd ?? 0,
            });
          }
        } catch {}
      }
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError(`CLI process closed without result (token: ${maskToken(token)})`));
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError(`CLI process error: ${err.message} (token: ${maskToken(token)})`));
    });
  });
}

export const QgridDispatcher = new QgridDispatcherClass();
