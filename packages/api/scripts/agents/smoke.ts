/**
 * Live P1 acceptance smoke (no provider credentials or server imports).
 * mise exec -- pnpm --filter qgrid-api exec tsx scripts/agents/smoke.ts [URL]
 *   --scenarios M1,S1,S2,S3,S6,A7 --docker
 * macOS: QGRID_AGENTS_HOST_MODE=auto detects Docker Desktop; set QGRID_AGENTS_ISOLATION_CHECK=warn.
 *
 * --docker asserts that the Docker CLI targets the server's Docker daemon.
 * --restart-cmd must restart the API and return; --kill-cmd must SIGKILL it and return.
 * These operator-supplied commands run in the caller's working directory.
 * Missing prerequisites are skipped; missing evidence or failed assertions fail the run.
 * Reports contain measurements, never container dumps, credentials or raw HTTP bodies.
 */
// Scenario reports and the generic HTTP encoder carry heterogeneous JSON; assertions
// below validate the measurements being certified, without a second copy of API schemas.
/* oxlint-disable anti-slop/no-unsafe-dictionary-type */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  type AgentSessionCreateInput,
  type AgentSessionCreateOutput,
  type AgentSessionGetOutput,
} from "../../src/application/agent/agent.types";
import {
  type RequestLogStepSubsetA,
  type RequestLogSubsetP,
} from "../../src/application/sonamu.generated";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    docker: { type: "boolean", default: false },
    "restart-cmd": { type: "string" },
    "kill-cmd": { type: "string" },
    scenarios: { type: "string" },
    model: { type: "string", default: "openai/gpt-6-astra" },
    "timeout-sec": { type: "string", default: "900" },
    "relay-port": { type: "string", default: "44901" },
    "idle-ttl-sec": { type: "string" },
    "host-ip": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

const ids = ["M1", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "A7"];

if (values.help) {
  console.log(`Usage: smoke.ts [http://localhost:44900] [--docker] [--scenarios ${ids.join(",")}]
  --model openai/gpt-6-astra   --timeout-sec 900   --relay-port 44901
  --restart-cmd COMMAND       --kill-cmd COMMAND
  --idle-ttl-sec 30  Confirm the server's effective idle TTL (does not change it).
  --host-ip IP     Additional host interface to probe in Linux S12.
Docker is required for S5/S9/S10/S11/S12 and independent A7 grading.
S3/S4 need S1; S6 audits every turn produced by the selected scenarios.`);
  process.exit(0);
}

assert(positionals.length <= 1, "Supply at most one server URL");

const base = new URL(positionals[0] ?? "http://localhost:44900");

assert(["http:", "https:"].includes(base.protocol) && !base.username && !base.password);

const selected = new Set(values.scenarios?.split(",") ?? ids);

assert(
  [...selected].every((id) => ids.includes(id)),
  "Unknown scenario",
);

assert(selected.size > 0, "Select at least one scenario");

const timeoutMs = Number(values["timeout-sec"]) * 1000;
const relayPort = Number(values["relay-port"]);

assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "Invalid timeout");

assert(Number.isInteger(relayPort) && relayPort > 0 && relayPort <= 65535, "Invalid relay port");

assert(
  !values["idle-ttl-sec"] || values["idle-ttl-sec"] === "30",
  "Only the 30 s test TTL is supported",
);

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/deti-judge");
const startedAt = new Date().toISOString();
const reportPath = join(here, "out", `agents-smoke-${startedAt.replaceAll(/[:.]/g, "-")}.json`);
const projectName = `agents-smoke-${randomUUID()}`;
const sessions = new Set<string>();
const turns = new Map<number, { sessionId: string; turnId: number; modelCallCount: number }>();
const secrets = new Set<string>();

type Metrics = Record<string, unknown>;

type Result = {
  status: "passed" | "failed" | "skipped";
  ms: number;
  metrics: Metrics;
  reason?: string;
};

const results: Record<string, Result> = {};
const cleanupErrors: string[] = [];

function redact(text: string) {
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");

  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[ANTHROPIC_TOKEN]")
    .replace(/aisdkhc_[A-Za-z0-9_-]+/g, "[PLACEHOLDER]");
}

async function save() {
  await mkdir(dirname(reportPath), { recursive: true });

  const passed =
    !Object.values(results).some((r) => r.status === "failed") && cleanupErrors.length === 0;

  await writeFile(
    reportPath,
    redact(
      JSON.stringify(
        {
          startedAt,
          server: base.origin,
          model: values.model,
          projectName,
          selected: [...selected],
          passed,
          complete: passed && ids.every((id) => results[id]?.status === "passed"),
          results,
          cleanupErrors,
        },
        null,
        2,
      ),
    ) + "\n",
  );
}

class Skip extends Error {}

async function scenario(id: string, execute: (metrics: Metrics) => Promise<void>) {
  if (!selected.has(id)) {
    results[id] = { status: "skipped", ms: 0, metrics: {}, reason: "not_selected" };

    return;
  }

  const start = performance.now();
  const metrics: Metrics = {};
  const previousSessions = new Set(sessions);
  console.log(`${id} starting`);

  try {
    await execute(metrics);
    results[id] = { status: "passed", ms: Math.round(performance.now() - start), metrics };
  } catch (error) {
    results[id] = {
      status: error instanceof Skip ? "skipped" : "failed",
      ms: Math.round(performance.now() - start),
      metrics,
      reason: redact(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    // A failed scenario must not exhaust maxSessions for all subsequent scenarios.
    for (const sessionId of sessions) {
      if (previousSessions.has(sessionId) || sessionId === mainSession) continue;

      try {
        await destroy(sessionId);
      } catch (error) {
        cleanupErrors.push(redact(`sessionDestroy ${sessionId}: ${String(error)}`));
      }
    }
  }

  console.log(`${id} ${results[id]!.status}: ${results[id]!.reason ?? `${results[id]!.ms} ms`}`);
  await save();
}

// API errors intentionally exclude response bodies (which may echo input or secrets).
async function api<T>(
  path: string,
  params: Record<string, unknown> = {},
  post = false,
): Promise<T> {
  const url = new URL(`/api/${path}`, base);

  if (!post) {
    for (const [key, value] of Object.entries(params)) {
      // The encoder receives only locally constructed arguments, not external input.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof
      if (typeof value === "object" && value !== null) {
        for (const [field, entry] of Object.entries(value))
          url.searchParams.set(`${key}[${field}]`, String(entry));
      } else url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: post ? { "content-type": "application/json" } : undefined,
    body: post ? JSON.stringify(params) : undefined,
    signal: AbortSignal.timeout(120_000),
  });

  assert(response.ok, `${path}: HTTP ${response.status}`);

  // SAFETY: callers select the repository's response contract and assert required evidence.
  return response.json() as Promise<T>;
}

const get = (sessionId: string) =>
  api<AgentSessionGetOutput>("agent/sessionGet", { params: { sessionId } });

const post = <T>(method: string, params: Record<string, unknown>) =>
  api<T>(`agent/${method}`, { params }, true);

async function create(extra: Partial<AgentSessionCreateInput> = {}) {
  const start = performance.now();

  const response = await post<AgentSessionCreateOutput>("sessionCreate", {
    model: values.model,
    projectName,
    instructions: "Work in /workspace. Use your tools to execute tasks; keep replies short.",
    tools: [
      {
        name: "lookup_magic_number",
        description: "Return the session's magic number.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        gate: "auto",
      },
    ],
    ...extra,
  });

  assert(response.sessionId, "sessionCreate omitted sessionId");
  sessions.add(response.sessionId);

  return { ...response, responseMs: performance.now() - start };
}

async function destroy(sessionId: string) {
  await post("sessionDestroy", { sessionId });
  sessions.delete(sessionId);
}

async function startTurn(sessionId: string, text: string) {
  const response = await post<{ turnId: number }>("sessionPrompt", { sessionId, prompt: text });
  assert(Number.isInteger(response.turnId), "sessionPrompt omitted turnId");
  const turn = (await get(sessionId)).turn;
  assert.equal(turn?.id, response.turnId);

  if (turn?.requestLogId)
    turns.set(turn.requestLogId, {
      sessionId,
      turnId: response.turnId,
      modelCallCount: turn.modelCallCount,
    });

  return response.turnId;
}

async function waitTurn(sessionId: string, turnId: number, waitingAction = false) {
  const deadline = Date.now() + timeoutMs;
  let nextProgress = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const state = await get(sessionId);
    const turn = state.turn;
    assert(turn?.id === turnId, "Latest turn changed unexpectedly");

    if (turn.requestLogId)
      turns.set(turn.requestLogId, { sessionId, turnId, modelCallCount: turn.modelCallCount });

    if (
      ["succeeded", "failed", "aborted"].includes(turn.status) ||
      (waitingAction && turn.status === "waiting_action")
    )
      return turn;
    assert(turn.status !== "waiting_action", "Unexpected required_action");

    if (Date.now() >= nextProgress) {
      console.log(`turn ${turnId}: ${turn.status}`);
      nextProgress = Date.now() + 30_000;
    }

    await sleep(500);
  }

  throw new Error(`Turn ${turnId} timed out after ${timeoutMs} ms`);
}

async function prompt(sessionId: string, text: string) {
  const turn = await waitTurn(sessionId, await startTurn(sessionId, text));
  assert.equal(
    turn.status,
    "succeeded",
    `Turn ${turn.id}: ${turn.status} (${turn.errorMessage ?? ""})`,
  );

  return turn;
}

async function run(command: string, args: string[], input?: string, allowFailure = false) {
  return new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;

    const timer = setTimeout(() => {
      failure = new Error(`${command} timed out`);
      child.kill("SIGKILL");
    }, 120_000);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > 16 * 1024 ** 2) {
        failure = new Error(`${command} output exceeded 16 MiB`);
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.resume(); // Do not echo Docker, shell or Git diagnostics containing credentials.
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);

      if (failure) reject(failure);
      else if (code !== 0 && !allowFailure)
        reject(new Error(`${command} ${args[0] ?? ""} exited ${code}`));
      else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code: code ?? -1 });
    });
    child.stdin.on("error", () => {}); // Early command exit may close stdin before all input is consumed.
    child.stdin.end(input);
  });
}

const container = (id: string) => `qgrid-agents-${id}`;

function requireDocker() {
  if (!values.docker) throw new Skip("requires --docker on the server's Docker host");
}

async function exec(id: string, args: string[], input?: string, allowFailure = false) {
  requireDocker();

  return run("docker", ["exec", "-i", container(id), ...args], input, allowFailure);
}

async function containerState(id: string) {
  return (
    await run("docker", ["inspect", "--format", "{{.State.Status}}", container(id)])
  ).stdout.trim();
}

const usageFields = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
] as const;

async function logs(requestLogId: number) {
  const parent = await api<RequestLogSubsetP>("requestLog/findById", {
    subset: "P",
    id: requestLogId,
  });

  const steps: RequestLogStepSubsetA[] = [];

  for (let page = 1; ; page++) {
    const result = await api<{ rows: RequestLogStepSubsetA[] }>("requestLogStep/findMany", {
      subset: "A",
      rawParams: {
        request_log_id: requestLogId,
        num: 100,
        page,
        orderBy: "id-asc",
        queryMode: "list",
      },
    });

    steps.push(...result.rows);

    if (result.rows.length < 100) break;
  }

  return { parent, steps };
}

function summarize(log: Awaited<ReturnType<typeof logs>>) {
  const generate = log.steps.filter((step) => step.type === "generate");
  const tool = log.steps.filter((step) => step.type === "tool_call");

  return {
    requestLogId: log.parent.id,
    tokenName: log.parent.token_name,
    stepCount: log.steps.length,
    generateCount: generate.length,
    toolCallCount: tool.length,
    usage: Object.fromEntries(
      usageFields.map((field) => [
        field,
        generate.reduce((sum, step) => sum + (step[field] ?? 0), 0),
      ]),
    ),
    parentUsage: Object.fromEntries(usageFields.map((field) => [field, log.parent[field] ?? 0])),
    parentToolCallCount: log.parent.tool_call_count,
  };
}

function assertAccounting(log: Awaited<ReturnType<typeof logs>>) {
  const summary = summarize(log);
  assert.equal(new Set(log.steps.map((s) => s.id)).size, summary.stepCount, "Duplicate step IDs");
  assert.equal(
    new Set(log.steps.map((s) => s.step_index)).size,
    summary.stepCount,
    "Duplicate step indices",
  );
  const toolIds = log.steps.filter((s) => s.type === "tool_call").map((s) => s.tool_call_id);
  assert(toolIds.every(Boolean), "Missing tool call ID");
  assert.equal(new Set(toolIds).size, toolIds.length, "Replayed tool call logged twice");
  assert.deepEqual(
    summary.parentUsage,
    summary.usage,
    "Parent usage differs from generate-step sum",
  );
  assert.equal(
    summary.parentToolCallCount,
    summary.toolCallCount,
    "Parent tool_call_count differs from steps",
  );

  return summary;
}

async function restart(command: string, previousProcess: number) {
  await run("/bin/sh", ["-c", command]);
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    try {
      const [health, info] = await Promise.all([
        api<{ agents: { ready: boolean } }>("qgrid/health"),
        api<{ processStartedAt: number }>("monit/monitLogs"),
      ]);

      if (health.agents.ready && info.processStartedAt !== previousProcess)
        return info.processStartedAt;
    } catch {
      /* The API is expected to be unavailable while restarting. */
    }

    await sleep(1000);
  }

  throw new Error("API did not restart with agents ready within 120 s");
}

async function scanSandboxDump(id: string) {
  // Scan in the container and return counts only. Never transport a raw credential dump.
  const scan = `import os, glob, re, json
patterns = {'jwtHits': rb'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+', 'anthropicHits': rb'sk-ant-[A-Za-z0-9_-]+', 'placeholderHits': rb'aisdkhc_[A-Za-z0-9_-]{43}'}
result = dict.fromkeys(patterns, 0)
result.update(files=0, bytes=0, unreadableFiles=0)
paths = glob.glob('/proc/*/environ')
for root in ['/home', '/workspace', '/tmp']:
    for directory, _, names in os.walk(root):
        paths.extend(os.path.join(directory, name) for name in names if not os.path.islink(os.path.join(directory, name)))
for path in paths:
    try:
        with open(path, 'rb') as f:
            carry = b''
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk: break
                result['bytes'] += len(chunk)
                data = carry + chunk
                for key, pattern in patterns.items():
                    result[key] += sum(1 for m in re.finditer(pattern, data) if m.end() > len(carry))
                carry = data[-8192:]
        result['files'] += 1
    except OSError:
        if not path.startswith('/proc/'): result['unreadableFiles'] += 1
print(json.dumps(result))`;

  const counts: Record<string, number> = JSON.parse(
    (await run("docker", ["exec", "-i", "-u", "root", container(id), "python3", "-c", scan]))
      .stdout,
  );

  assert.equal(counts.jwtHits, 0, "Real JWT pattern in sandbox dump");
  assert.equal(counts.anthropicHits, 0, "Anthropic token pattern in sandbox dump");
  assert(Number(counts.placeholderHits) >= 1, "No placeholder in sandbox dump");
  assert.equal(counts.unreadableFiles, 0, "Incomplete home/workspace/tmp dump");

  return counts;
}

async function placeholder(id: string) {
  const result = await exec(id, [
    "python3",
    "-c",
    `
import glob, re
values = set()
for path in glob.glob('/proc/*/environ'):
    try:
        values.update(re.findall(rb'aisdkhc_[A-Za-z0-9_-]{43}', open(path, 'rb').read()))
    except (OSError, PermissionError): pass
assert len(values) == 1, 'Expected exactly one sandbox placeholder'
print(next(iter(values)).decode())
`,
  ]);

  const value = result.stdout.trim();
  assert(/^aisdkhc_[A-Za-z0-9_-]{43}$/.test(value), "No unique placeholder in bridge environment");
  secrets.add(value);

  return value;
}

// Send only sandbox placeholders, never real credentials. A mismatched model ensures an
// isolation regression cannot accidentally spend a token by forwarding a valid request.
async function probeRelay(sourceId: string, credential: string) {
  const source = `const fs = require('node:fs');
const token = fs.readFileSync(0, 'utf8');
fetch('http://host.docker.internal:${relayPort}/backend-api/codex/responses', {
  method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'smoke-invalid-model', input: 'isolation probe' }),
  signal: AbortSignal.timeout(10000)
}).then(async r => { await r.body?.cancel(); console.log(r.status); }).catch(() => process.exit(1));`;

  const result = await exec(sourceId, ["node", "-e", source], credential);
  const status = Number(result.stdout.trim());
  assert(Number.isInteger(status) && status >= 100, "Relay returned no HTTP status");

  return status;
}

let mainSession: string | undefined;

async function main() {
  if (!mainSession) mainSession = (await create()).sessionId;

  return mainSession;
}

async function recovery(id: "S7" | "S8", metrics: Metrics) {
  const restartCommand = values["restart-cmd"];

  if (!restartCommand || (id === "S8" && !values["kill-cmd"]))
    throw new Skip("requires --restart-cmd (and --kill-cmd for S8)");
  const sessionId = (await create()).sessionId;
  const marker = `finished-${id.toLowerCase()}`;

  const turnId = await startTurn(
    sessionId,
    `Create slow.py containing print('${marker}'). Run exactly 'sleep 40 && python3 slow.py' and wait for it. Reply with only its output.`,
  );

  await sleep(15_000);
  const beforeTurn = (await get(sessionId)).turn;
  assert(
    beforeTurn?.id === turnId && beforeTurn.status === "running",
    "Long turn not running at 15 s",
  );
  assert(beforeTurn.requestLogId, "Missing request log before restart");
  const before = await logs(beforeTurn.requestLogId);
  metrics.before = summarize(before);
  metrics.sleepToolObserved = before.steps.some(
    (step) => step.type === "tool_call" && /sleep 40/.test(step.tool_args ?? ""),
  );

  if (id === "S7")
    assert(metrics.sleepToolObserved, "sleep 40 tool not observed before graceful restart");

  const processBefore = (await api<{ processStartedAt: number }>("monit/monitLogs"))
    .processStartedAt;

  assert(processBefore, "Missing server process start time");

  if (id === "S8") {
    await run("/bin/sh", ["-c", values["kill-cmd"]!]);
    let unreachable = false;

    try {
      await api("qgrid/health");
    } catch {
      unreachable = true;
    }

    assert(unreachable, "--kill-cmd did not take the API offline");
  }

  metrics.processBefore = processBefore;
  metrics.processAfter = await restart(restartCommand, processBefore);
  const turn = await waitTurn(sessionId, turnId);
  metrics.recoveredStatus = turn.status;
  assert.equal(turn.requestLogId, beforeTurn.requestLogId, "Recovery changed parent request log");
  const after = await logs(beforeTurn.requestLogId);
  metrics.after = summarize(after);
  assertAccounting(after);

  for (const step of before.steps) {
    const restored = after.steps.find((candidate) => candidate.id === step.id);
    assert(restored, `Lost step ${step.id} during recovery`);

    for (const field of ["step_index", "type", "tool_call_id", ...usageFields] as const) {
      if (step[field] !== null)
        assert.equal(restored[field], step[field], `Recovery rewrote ${field} of step ${step.id}`);
    }
  }

  // A settled parent must remain identical on another read: replay must not add steps/usage.
  await sleep(1500);
  const settled = await logs(beforeTurn.requestLogId);
  assert.deepEqual(
    summarize(settled),
    summarize(after),
    "Settled accounting changed after recovery",
  );
  metrics.settled = summarize(settled);

  if (id === "S8" && turn.status === "failed") {
    const retry = await prompt(
      sessionId,
      "Continue the interrupted task. Run python3 slow.py and reply with only its output.",
    );

    metrics.retryTurnId = retry.id;
    assert(retry.resultText?.includes(marker), "Re-prompt did not complete slow.py");
  } else {
    assert.equal(turn.status, "succeeded");
    assert(turn.resultText?.includes(marker), "Recovered turn omitted slow.py output");
  }

  await destroy(sessionId);
}

const TASK_DIR = "/workspace/task";

const TASK_PROMPT = `[deti dev0] 신고 #10 · 콘텐츠 오류 · 기타

> 도민: How do I get there?
> 거기 어떻게 가요?

**추가 설명**
여기 지문이 how do I get there 인데, 그대로 입력해도 "여기 빠진 자리가 있어요" 라고 뜨네요;; 화나요

| 항목 | 내용 |
| -- | -- |
| 지역 | 일본 도쿄 |
| 장소 | 시부야 스크램블 교차로 |
| 에피소드 | 쿠폰의 주인 (#10390) |
| 위치 | 씬 1 · 15번째 줄 |
| 종류 | 학습 드릴 (타이핑 모드) |
| 신고자 | Test A (a@test.com) |

---
작업 지시:
1. ${TASK_DIR} 저장소에서 이 신고를 재현하는 **실패하는 테스트를 먼저 추가**한다 (node:test, src/*.test.ts, \`npm test\`로 실행).
2. 근본 원인을 찾아 **최소한으로** 고친다. 기존 테스트는 전부 통과해야 한다.
3. 커밋은 하지 않는다.
4. 마지막 답변에 반드시 적을 것: (a) 근본 원인 2문장 이내, (b) 수정한 파일 목록, (c) \`git diff\` 전체 출력.`;

async function archiveFixture() {
  const directory = await mkdtemp(join(tmpdir(), "qgrid-deti-smoke-"));

  try {
    await cp(join(fixture, "task"), join(directory, "task"), { recursive: true });
    const task = join(directory, "task");
    await run("git", ["-C", task, "init", "-q", "-b", "main"]);
    await run("git", ["-C", task, "add", "-A"]);
    await run("git", [
      "-C",
      task,
      "-c",
      "user.name=smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const path = join(directory, "fixture.tar.gz");
    await run("tar", ["-czf", path, "-C", directory, "task"]);

    return (await readFile(path)).toString("base64");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function taskHashes(id: string) {
  const source = `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const result = {};
function walk(dir, relative = '') {
  for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
    if (item.name === '.git') continue;
    const name = path.posix.join(relative, item.name), full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, name);
    else result[name] = item.isSymbolicLink() ? 'symlink:' + fs.readlinkSync(full) : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
}
walk('${TASK_DIR}'); console.log(JSON.stringify(result));`;

  // SAFETY: the fixed container program emits a dictionary of paths to string digests.
  return JSON.parse((await exec(id, ["node", "-e", source])).stdout) as Record<string, string>;
}

function tap(result: { stdout: string; code: number }) {
  const number = (field: string) =>
    Number(result.stdout.match(new RegExp(`^# ${field} (\\d+)$`, "m"))?.[1] ?? NaN);

  return {
    exitCode: result.code,
    tests: number("tests"),
    pass: number("pass"),
    fail: number("fail"),
    skipped: number("skipped"),
    cancelled: number("cancelled"),
    todo: number("todo"),
  };
}

try {
  const health = await api<{ agents?: { enabled: boolean; ready: boolean; reason?: string } }>(
    "qgrid/health",
  );

  assert(
    health.agents?.enabled && health.agents.ready,
    `Agents not ready: ${health.agents?.reason ?? "disabled"}`,
  );

  await scenario("M1", async (metrics) => {
    const samples: { responseMs: number; readyMs: number }[] = [];
    metrics.samples = samples;

    for (let index = 0; index < 3; index++) {
      const session = await create();
      samples.push({ responseMs: session.responseMs, readyMs: session.readyMs });
      await destroy(session.sessionId);
    }

    metrics.medianResponseMs = samples.map((s) => s.responseMs).toSorted((a, b) => a - b)[1];
    metrics.medianReadyMs = samples.map((s) => s.readyMs).toSorted((a, b) => a - b)[1];
    metrics.within2Seconds =
      Number(metrics.medianResponseMs) <= 2000 && Number(metrics.medianReadyMs) <= 2000;
    metrics.bridgeReadyReported = samples.every(
      (s) => Number.isFinite(s.readyMs) && s.readyMs >= 0 && s.readyMs <= s.responseMs,
    );
    assert(metrics.within2Seconds, "sessionCreate response or bridge-ready median exceeds 2000 ms");
    assert(
      metrics.bridgeReadyReported,
      "sessionCreate does not expose valid readyMs; bridge readiness cannot be certified",
    );
  });

  await scenario("S1", async (metrics) => {
    const id = await main();

    const turn = await prompt(
      id,
      "Create sum.py that prints the sum of 1..100, run it with python3, and reply with only the printed number. Also remember the codeword 'pelican-37' for later in this session; do not write it to any file.",
    );

    metrics.turnId = turn.id;
    metrics.text = turn.resultText;
    assert(/\b5050\b/.test(turn.resultText ?? ""), "Expected 5050");
    assert(turn.requestLogId, "Missing parent request log");
    const log = await logs(turn.requestLogId);
    metrics.log = summarize(log);
    assertAccounting(log);
    assert(
      log.steps.some((step) => step.type === "tool_call"),
      "No tool_call step",
    );

    if (values.docker) {
      metrics.output = (
        await exec(id, ["sh", "-c", "test -f /workspace/sum.py && python3 /workspace/sum.py"])
      ).stdout.trim();
      assert.equal(metrics.output, "5050");
      metrics.fileEvidence = "docker exec: /workspace/sum.py";
    } else {
      // The API has no arbitrary file-read endpoint; use successful built-in write evidence.
      const written = log.steps.some(
        (step) =>
          step.type === "tool_call" &&
          step.tool_name === "write" &&
          /sum\.py/.test(step.tool_args ?? "") &&
          step.tool_result &&
          !step.error,
      );

      metrics.fileEvidence = "successful write tool step (live filesystem check requires --docker)";
      assert(
        written,
        "No successful sum.py write evidence; use --docker for independent filesystem verification",
      );
    }
  });

  await scenario("S2", async (metrics) => {
    const id = await main();

    const turnId = await startTurn(
      id,
      "Call lookup_magic_number, multiply its value by 6, and reply with only the number.",
    );

    const pending = await waitTurn(id, turnId, true);
    metrics.requiredAction = {
      status: pending.status,
      names: pending.pendingActions.map((action) => action.toolName),
    };
    assert.equal(pending.status, "waiting_action", "No required_action in P1 pendingActions");
    assert.equal(pending.pendingActions.length, 1);
    const action = pending.pendingActions[0]!;
    assert.equal(action.toolName, "lookup_magic_number");
    await post("actionResult", {
      sessionId: id,
      toolCallId: action.toolCallId,
      output: { value: 7 },
    });
    const turn = await waitTurn(id, turnId);
    metrics.turnId = turn.id;
    metrics.text = turn.resultText;
    assert.equal(turn.status, "succeeded");
    assert.equal(turn.resultText?.trim(), "42");
  });

  await scenario("S3", async (metrics) => {
    assert(results.S1?.status === "passed" && mainSession, "S3 requires a passing S1");

    const turn = await prompt(
      mainSession,
      "What codeword did I give you earlier? Reply with only the codeword, without using tools.",
    );

    metrics.text = turn.resultText;
    assert.equal(turn.resultText?.trim(), "pelican-37");
  });

  await scenario("S4", async (metrics) => {
    if (!values["restart-cmd"]) throw new Skip("requires --restart-cmd");
    assert(results.S1?.status === "passed" && mainSession, "S4 requires a passing S1");
    const stopped = await post<{ status: string }>("sessionStop", { sessionId: mainSession });
    assert.equal(stopped.status, "stopped");
    const before = (await api<{ processStartedAt: number }>("monit/monitLogs")).processStartedAt;
    assert(before, "Missing server process start time");
    metrics.processAfter = await restart(values["restart-cmd"], before);

    const turn = await prompt(
      mainSession,
      "What number did sum.py print earlier? Reply with only the number, without using tools.",
    );

    metrics.text = turn.resultText;
    assert.equal(turn.resultText?.trim(), "5050");
  });

  await scenario("S5", async (metrics) => {
    requireDocker();
    const id = await main();
    Object.assign(metrics, await scanSandboxDump(id));
  });

  await scenario("S7", (metrics) => recovery("S7", metrics));
  await scenario("S8", (metrics) => recovery("S8", metrics));

  await scenario("S9", async (metrics) => {
    requireDocker();
    const owner = (await create()).sessionId;
    const other = (await create()).sessionId;
    const key = await placeholder(owner);
    const turnId = await startTurn(owner, "Run sleep 40 using bash, wait, then reply done.");
    const running = (await get(owner)).turn;
    assert.equal(running?.status, "running");
    metrics.otherContainerStatus = await probeRelay(other, key);
    assert.equal((await get(owner)).turn?.status, "running", "Owner turn ended during IP probe");
    metrics.unregisteredStatus = await probeRelay(owner, `aisdkhc_${"x".repeat(43)}`);
    await waitTurn(owner, turnId);
    metrics.endedTurnStatus = await probeRelay(owner, key);
    assert.deepEqual(
      [metrics.otherContainerStatus, metrics.unregisteredStatus, metrics.endedTurnStatus],
      [403, 401, 403],
    );
    await destroy(owner);
    await destroy(other);
  });

  await scenario("S10", async (metrics) => {
    requireDocker();

    if (values["idle-ttl-sec"] !== "30")
      throw new Skip(
        "requires server idle TTL 30 s, confirmed with --idle-ttl-sec 30; no settings are changed",
      );
    const id = (await create()).sessionId;
    const word = `idle-${randomUUID()}`;
    await prompt(
      id,
      `Remember ${word} in our conversation only; do not write it to disk. Reply OK.`,
    );
    const start = Date.now();

    while ((await containerState(id)) !== "exited" && Date.now() - start < 50_000)
      await sleep(1000);
    metrics.idleMs = Date.now() - start;
    metrics.containerAfterIdle = await containerState(id);
    assert.equal(
      metrics.containerAfterIdle,
      "exited",
      "Container did not stop after the configured 30 s TTL",
    );

    const turnId = await startTurn(
      id,
      "Recall the codeword from our previous conversation. Reply with it only, without using tools.",
    );

    metrics.containerAfterPrompt = await containerState(id);
    assert.equal(metrics.containerAfterPrompt, "running");
    const turn = await waitTurn(id, turnId);
    metrics.text = turn.resultText;
    assert.equal(turn.status, "succeeded");
    assert.equal(turn.resultText?.trim(), word);
    await destroy(id);
  });

  await scenario("S11", async (metrics) => {
    requireDocker();
    const a = (await create()).sessionId;
    const b = (await create()).sessionId;
    const [keyA, keyB] = await Promise.all([placeholder(a), placeholder(b)]);
    metrics.placeholderDistinct = keyA !== keyB;
    metrics.placeholderHashes = [keyA, keyB].map((key) =>
      createHash("sha256").update(key).digest("hex"),
    );

    const [turnA, turnB] = await Promise.all([
      prompt(a, "Write /workspace/only-a.txt containing A, then read it and reply A."),
      prompt(b, "Write /workspace/only-b.txt containing B, then read it and reply B."),
    ]);

    await exec(a, ["sh", "-c", "test -f /workspace/only-a.txt && test ! -e /workspace/only-b.txt"]);
    await exec(b, ["sh", "-c", "test -f /workspace/only-b.txt && test ! -e /workspace/only-a.txt"]);
    metrics.fileIsolation = true;
    assert(turnA.requestLogId && turnB.requestLogId);
    const first = await Promise.all([logs(turnA.requestLogId), logs(turnB.requestLogId)]);
    metrics.firstLogs = first.map(summarize);

    const turnIds = await Promise.all([
      startTurn(a, "Run sleep 40, wait, then read only-a.txt and reply with its content."),
      startTurn(b, "Run sleep 40, wait, then read only-b.txt and reply with its content."),
    ]);

    assert.equal((await get(a)).turn?.status, "running");
    metrics.crossPlaceholderStatus = await probeRelay(b, keyA);
    assert.equal(
      (await get(a)).turn?.status,
      "running",
      "Owner turn ended during cross-placeholder probe",
    );
    const secondTurns = await Promise.all([waitTurn(a, turnIds[0]!), waitTurn(b, turnIds[1]!)]);

    const second = await Promise.all(
      secondTurns.map((turn) => {
        assert.equal(turn.status, "succeeded");
        assert(turn.requestLogId);

        return logs(turn.requestLogId);
      }),
    );

    metrics.secondLogs = second.map(summarize);
    metrics.dumps = await Promise.all([scanSandboxDump(a), scanSandboxDump(b)]);
    metrics.tokenNamesStable = first.every(
      (log, index) =>
        log.parent.token_name && log.parent.token_name === second[index]!.parent.token_name,
    );
    assert(metrics.placeholderDistinct, "Session placeholders are equal");
    assert.equal(metrics.crossPlaceholderStatus, 403);
    assert(metrics.tokenNamesStable, "Session token_name changed between turns");

    for (const log of [...first, ...second]) assertAccounting(log);
    await destroy(a);
    await destroy(b);
  });

  await scenario("S12", async (metrics) => {
    requireDocker();

    if (process.platform !== "linux")
      throw new Skip("Linux host firewall check; Docker Desktop cannot certify host isolation");
    const id = (await create()).sessionId;

    const gateway = (
      await run("docker", [
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}",
        container(id),
      ])
    ).stdout.trim();

    const hostAddresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);

    const hosts = [
      ...new Set([
        "host.docker.internal",
        gateway,
        ...hostAddresses,
        ...[values["host-ip"]].filter(Boolean),
      ]),
    ];

    const targets = hosts.flatMap((host) => [44900, 5432].map((port) => ({ host, port })));
    targets.push({ host: "host.docker.internal", port: 44901 });

    const source = `const net = require('node:net');
Promise.all(${JSON.stringify(targets)}.map(target => new Promise(resolve => {
  const socket = net.createConnection(target); let done = false;
  const finish = reachable => { if (done) return; done = true; socket.destroy(); resolve({...target, reachable}); };
  socket.setTimeout(2000); socket.on('connect', () => finish(true)); socket.on('error', () => finish(false)); socket.on('timeout', () => finish(false));
}))).then(async probes => {
  const r = await fetch('https://github.com', {signal: AbortSignal.timeout(15000)});
  await r.body?.cancel(); console.log(JSON.stringify({probes, githubStatus: r.status}));
}).catch(() => process.exit(1));`;

    // SAFETY: the fixed probe program emits this shape; every result is asserted below.
    const detail = JSON.parse((await exec(id, ["node", "-e", source])).stdout) as {
      probes: { port: number; reachable: boolean }[];
      githubStatus: number;
    };

    Object.assign(metrics, detail);
    assert(
      detail.probes.every((probe) => probe.reachable === (probe.port === 44901)),
      "Host service isolation or relay connectivity failed",
    );
    assert(detail.githubStatus >= 200 && detail.githubStatus < 400, "GitHub is unreachable");
    await destroy(id);
  });

  await scenario("A7", async (metrics) => {
    requireDocker();

    const session = await create({
      workspace: { archive: await archiveFixture() },
      tools: [],
      instructions: `You are a senior engineer fixing a bug report in a disposable Linux sandbox. The repository is at ${TASK_DIR} (read its README first). Work autonomously: reproduce first, fix the root cause with the smallest change, run the tests, then report. Reply in Korean.`,
    });

    const id = session.sessionId;
    // Host tar preserves uid/gid (e.g. macOS 501:20); make the node-owned task writable.
    await run("docker", [
      "exec",
      "-u",
      "root",
      container(id),
      "chown",
      "-R",
      "node:node",
      TASK_DIR,
    ]);
    metrics.nodeVersion = (await exec(id, ["node", "--version"])).stdout.trim();
    const before = await taskHashes(id);

    const visibleCommand = [
      "sh",
      "-c",
      `cd ${TASK_DIR} && node --test --test-reporter=tap src/*.test.ts`,
    ];

    metrics.baselineVisible = tap(await exec(id, visibleCommand, undefined, true));
    const turn = await waitTurn(id, await startTurn(id, TASK_PROMPT));
    metrics.turn = {
      id: turn.id,
      status: turn.status,
      requestLogId: turn.requestLogId,
      usage: turn.usage,
    };
    const after = await taskHashes(id);

    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((file) => before[file] !== after[file])
      .toSorted();

    metrics.changedFiles = changed;
    // Capture changes before the grader injects its own hidden test.
    const visible = tap(await exec(id, visibleCommand, undefined, true));
    metrics.visible = visible;
    const hiddenPath = `${TASK_DIR}/src/judge-typed.hidden.test.ts`;
    assert(
      !Object.hasOwn(after, "src/judge-typed.hidden.test.ts"),
      "Agent created the reserved hidden-test path",
    );
    await exec(
      id,
      ["sh", "-c", `cat > ${hiddenPath}`],
      await readFile(join(fixture, "hidden/judge-typed.hidden.test.ts"), "utf8"),
    );
    let hidden: ReturnType<typeof tap>;

    try {
      hidden = tap(
        await exec(id, ["node", "--test", "--test-reporter=tap", hiddenPath], undefined, true),
      );
      metrics.hidden = hidden;
    } finally {
      await exec(id, ["rm", hiddenPath]);
    }

    assert.equal(turn.status, "succeeded", "deti task turn did not succeed");
    assert.deepEqual(
      hidden,
      { exitCode: 0, tests: 7, pass: 7, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
      "Hidden tests must pass exactly 7/7",
    );
    assert(
      visible.tests > 0 &&
        visible.pass === visible.tests &&
        visible.fail === 0 &&
        visible.exitCode === 0 &&
        visible.skipped === 0 &&
        visible.cancelled === 0 &&
        visible.todo === 0,
      "Visible tests did not all pass",
    );
    assert.deepEqual(
      changed.filter((file) => !/^src\/[^/]+\.test\.ts$/.test(file)),
      ["src/judge-typed.ts"],
      "Only src/judge-typed.ts and src/*.test.ts may change",
    );
    assert(
      changed.every((file) => Object.hasOwn(after, file)),
      "Task files may be added or modified, not deleted",
    );
    await destroy(id);
  });

  // Audit last so it includes recovery, isolation and task turns, including failed calls.
  await scenario("S6", async (metrics) => {
    assert(turns.size > 0, "No observed turns to audit; select an inference scenario");
    const summaries: Metrics[] = [];
    metrics.logs = summaries;
    let generateCount = 0;
    let successWithUsage = 0;
    let failedWithError = 0;

    // Preserve sessionGet counters while polling: old turns are no longer the latest
    // and completed scenarios may already have destroyed their sessions by this audit.
    for (const [requestLogId, turn] of turns) {
      const log = await logs(requestLogId);
      const summary = summarize(log);
      summaries.push({ ...summary, modelCallCount: turn.modelCallCount });
      assertAccounting(log);
      assert.equal(
        turn.modelCallCount,
        summary.generateCount,
        `Turn ${turn.turnId} modelCallCount differs from generate steps`,
      );

      for (const step of log.steps) {
        if (step.type !== "generate") continue;
        generateCount++;

        if (step.error) failedWithError++;
        else {
          assert(
            usageFields.every((field) => step[field] !== null),
            `Generate step ${step.id} has neither usage nor error`,
          );
          successWithUsage++;
        }
      }
    }

    Object.assign(metrics, {
      generateCount,
      successWithUsage,
      failedWithError,
      modelCallCount: [...turns.values()].reduce((sum, turn) => sum + turn.modelCallCount, 0),
    });
    assert(generateCount > 0, "No generate steps");
  });
} catch (error) {
  results.preflight = {
    status: "failed",
    ms: 0,
    metrics: {},
    reason: redact(error instanceof Error ? error.message : String(error)),
  };

  for (const id of ids)
    results[id] ??= { status: "skipped", ms: 0, metrics: {}, reason: "preflight_failed" };
} finally {
  for (const sessionId of sessions) {
    try {
      await destroy(sessionId);
    } catch (error) {
      cleanupErrors.push(
        redact(
          `sessionDestroy ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  await save();
  console.log(`Report: ${reportPath}`);
  process.exitCode =
    Object.values(results).some((r) => r.status === "failed") || cleanupErrors.length ? 1 : 0;
}
