/**
 * Real subscription chat -> injected Images failure -> HTTP error -> persisted accounting.
 * Start an isolated built API with image-failure-preload.mjs and the same fault/trace paths.
 * Requires QGRID_REAL_PROVIDER_ACCEPTANCE=1, QGRID_URL, QGRID_TOKEN_NAME,
 * QGRID_IMAGE_E2E_FAULT_FILE, QGRID_IMAGE_E2E_TRACE_FILE, QGRID_IMAGE_E2E_OUTPUT.
 * Chat quota is consumed. No real Images request leaves the test server. No retries.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.QGRID_URL;
const token = process.env.QGRID_TOKEN_NAME;
const faultFile = process.env.QGRID_IMAGE_E2E_FAULT_FILE;
const traceFile = process.env.QGRID_IMAGE_E2E_TRACE_FILE;
const output = process.env.QGRID_IMAGE_E2E_OUTPUT;
const project = `qgrid-fail-${randomUUID().slice(0, 8)}`;
type Trace = {
  caseId: string;
  event: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; cached_tokens: number };
};
type Row = {
  id: number;
  status: string;
  model_name: string;
  requested_model_name: string;
  token_name: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  image_cost_usd: number | null;
  image_cost_method: string | null;
  type?: string;
  tool_name?: string;
  error_message?: string;
};

async function traces(caseId: string): Promise<Trace[]> {
  const text = await readFile(traceFile!, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Trace)
    .filter((item) => item.caseId === caseId);
}

async function rows(resource: string, filters: Record<string, string>): Promise<Row[]> {
  const params = new URLSearchParams({
    subset: resource === "requestLog" ? "P" : "A",
    "rawParams[num]": "100",
    ...filters,
  });
  const response = await fetch(`${base}/api/${resource}/findMany?${params}`);
  assert(response.ok, `Failed to read ${resource}: HTTP ${response.status}`);
  return ((await response.json()) as { rows: Row[] }).rows;
}

async function waitFor<T>(read: () => Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const cases = [
  { name: "preflight", mode: "http" },
  { name: "http-failure", mode: "http" },
  { name: "network-failure", mode: "network" },
  { name: "invalid-image", mode: "invalid-image" },
  { name: "cancel-after-driver", mode: "cancel" },
  { name: "logger-off", mode: "http" },
  { name: "success-no-double-count", mode: "success" },
  { name: "astra-http-failure", mode: "http", model: "openai/gpt-6-astra" },
];

async function run(test: (typeof cases)[number]) {
  const model = test.model ?? "openai/gpt-6-luna";
  const caseId = `${project}:${test.name}`;
  assert(caseId.length <= 50, "E2E project label exceeds the request-log limit");
  await writeFile(faultFile!, JSON.stringify({ caseId, mode: test.mode }));
  const controller = new AbortController();
  const request = fetch(`${base}/api/qgrid/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      args: {
        model,
        tokenName: token,
        projectName: caseId,
        effort: "low",
        imageGeneration: "auto",
        prompt:
          "Generate an actual image of one solid red circle on a white background. Use the image tool now. No reference images.",
        ...(test.name === "logger-off" ? { logger: false } : {}),
        ...(test.name === "preflight" ? { imageGenerationOptions: { outputFormat: "webp" } } : {}),
      },
    }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
  });
  // Observe rejections immediately, including while waiting for the image phase.
  const pending = request.then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  if (test.mode === "cancel") {
    await waitFor(
      async () => (await traces(caseId)).find((item) => item.event === "image-request"),
      "image phase after completed driver",
    );
    controller.abort();
  }
  const outcome = await pending;
  if (test.mode === "cancel") {
    assert(
      "error" in outcome && outcome.error instanceof Error && outcome.error.name === "AbortError",
    );
  } else {
    assert(
      "response" in outcome,
      `Unexpected request error: ${"error" in outcome ? outcome.error : ""}`,
    );
    const response = outcome.response;
    const expectedStatus = test.name === "preflight" ? 400 : test.mode === "success" ? 200 : 500;
    assert.equal(response.status, expectedStatus);
    const body = await response.json();
    if (expectedStatus === 500) {
      assert.equal(typeof body.message, "string");
      assert.deepEqual(
        Object.keys(body).toSorted(),
        ["message", "name"],
        "Internal accounting leaked into the HTTP error",
      );
    }
  }

  const events = await traces(caseId);
  const readLogs = () => rows("requestLog", { "rawParams[project_name]": caseId });
  if (test.name === "preflight") {
    assert.equal(events.length, 0);
    assert.equal((await readLogs()).length, 0);
    return { model, noProviderCall: true, noLog: true };
  }
  const completed = events.filter((item) => item.event === "driver-completed");
  assert.equal(completed.length, 1, "Expected one completed chat request");
  assert.equal(
    events.filter((item) => item.event === "image-request").length,
    1,
    "Unexpected image retry",
  );
  const driver = completed[0]!;
  assert(driver.usage && driver.usage.input_tokens > 0 && driver.usage.output_tokens > 0);
  const usage = driver.usage;
  if (test.name === "logger-off") {
    assert.equal((await readLogs()).length, 0);
    return { model, driverUsage: usage, noLog: true };
  }
  const status =
    test.mode === "cancel" ? "aborted" : test.mode === "success" ? "succeeded" : "error";
  const row = await waitFor(
    async () => (await readLogs()).find((item) => item.status === status),
    `${status} request log`,
  );
  assert.equal(row.model_name, `openai/${driver.model}`);
  assert.equal(row.requested_model_name, model);
  assert.equal(row.token_name, token);
  assert.equal(row.input_tokens, usage.input_tokens);
  assert.equal(row.output_tokens, usage.output_tokens);
  assert.equal(row.cache_read_tokens, usage.cached_tokens);
  const rates = model === "openai/gpt-6-astra" ? [10, 1, 50] : [0.1, 0.01, 0.5];
  const expectedCost = Math.round(
    (usage.input_tokens - usage.cached_tokens) * rates[0]! +
      usage.cached_tokens * rates[1]! +
      usage.output_tokens * rates[2]!,
  );
  assert.equal(row.cost_usd, expectedCost);
  const steps = await rows("requestLogStep", { "rawParams[request_log_id]": String(row.id) });
  const generated = steps.filter((item) => item.type === "generate");
  assert.equal(generated.length, 1, "Driver step missing or counted twice");
  assert.equal(generated[0]!.input_tokens, usage.input_tokens);
  assert.equal(generated[0]!.output_tokens, usage.output_tokens);
  assert.equal(generated[0]!.cost_usd, expectedCost);
  assert.equal(
    steps.filter((item) => item.tool_name === "image_generation").length,
    test.mode === "success" ? 1 : 0,
  );
  assert.equal(row.image_cost_usd, test.mode === "success" ? 100 : null);
  if (test.mode !== "success") assert.equal(row.image_cost_method, null);
  return {
    requestLogId: row.id,
    model,
    status,
    driverUsage: usage,
    driverCostMicroUsd: row.cost_usd,
    imageCostMicroUsd: row.image_cost_usd,
    generateSteps: generated.length,
  };
}

async function main() {
  assert.equal(process.env.QGRID_REAL_PROVIDER_ACCEPTANCE, "1");
  assert(base && new URL(base).hostname === "127.0.0.1", "Use an isolated local server");
  assert(
    token && faultFile && traceFile && output,
    "Missing E2E token, fault/trace file, or output directory",
  );
  await mkdir(output, { recursive: true });
  await writeFile(traceFile, "");
  const health = await (await fetch(`${base}/api/qgrid/health`)).json();
  assert(health.ready && health.providers.openai === "ready", "Server is not ready");
  const results = [];
  for (const test of cases) {
    console.log(`START ${test.name}`);
    const start = Date.now();
    try {
      const evidence = await run(test);
      results.push({ name: test.name, ok: true, durationMs: Date.now() - start, evidence });
      console.log(`PASS ${test.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error);
      results.push({ name: test.name, ok: false, durationMs: Date.now() - start, error: message });
      console.log(`FAIL ${test.name}: ${message}`);
    }
    await writeFile(
      path.join(output, "summary.json"),
      JSON.stringify({ project, results, realChat: true, injectedImages: true }, null, 2),
    );
  }
  console.log(`${results.filter((item) => item.ok).length}/${results.length} passed`);
  if (results.some((item) => !item.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
