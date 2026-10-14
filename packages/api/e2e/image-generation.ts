/**
 * Opt-in live E2E acceptance for qgrid Images and dashboard auto-image chat.
 * Scenarios run sequentially without retries and consume subscription quota.
 * The optional batch case preserves AI SDK's concurrent per-image calls.
 * Default: 8 generated images, 3 text calls, validation failures, and cancellation.
 * Optional cases: batch (2 more images), logger-off (1 more image), cancel-direct.
 *
 * QGRID_REAL_PROVIDER_ACCEPTANCE=1 QGRID_URL=http://127.0.0.1:44901 \
 * QGRID_OPENAI_MODEL=openai/gpt-6-luna QGRID_TOKEN_NAME=openai/example \
 * QGRID_IMAGE_E2E_OUTPUT=/tmp/qgrid-image-e2e \
 * mise exec -- pnpm exec tsx packages/api/e2e/image-generation.ts
 *
 * QGRID_IMAGE_SMOKE_CASES=negative,text,stream,auto-text,direct-opaque
 * narrows the run. No case silently generates prerequisites: editing uses local
 * fixtures, or an image already generated earlier in this invocation.
 * PNGs are visual evidence; summary.json and results.jsonl never contain base64.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateImage, generateText, streamText } from "ai";
import { PNG } from "pngjs";

import {
  qgrid,
  type QgridImageProviderOptions,
  type QgridOpenAIModel,
} from "../../ai-sdk/src/index";
import {
  type ImageGenerationMetadata,
  type QueryInput,
  type QueryOutput,
} from "../src/application/qgrid/qgrid.types";

const BASE = process.env.QGRID_URL;
const MODEL = process.env.QGRID_OPENAI_MODEL as QgridOpenAIModel | undefined;
const TOKEN = process.env.QGRID_TOKEN_NAME;
const PROJECT = process.env.QGRID_IMAGE_E2E_PROJECT ?? `qgrid-image-e2e-${randomUUID().slice(0, 8)}`;
const OUTPUT = process.env.QGRID_IMAGE_E2E_OUTPUT ?? path.join(os.tmpdir(), PROJECT);
const TIMEOUT_MS = 240_000;
const DEFAULT_CASES = [
  "negative",
  "text",
  "stream",
  "auto-text",
  "direct-opaque",
  "direct-transparent",
  "direct-edit",
  "auto-opaque",
  "auto-transparent",
  "auto-edit",
  "auto-multi",
  "auto-new",
  "cancel",
];
const CASES = (process.env.QGRID_IMAGE_SMOKE_CASES ?? DEFAULT_CASES.join(","))
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

type LogRow = {
  id: number;
  project_name: string;
  requested_model_name: string;
  model_name: string;
  status: string;
  cost_usd: number;
  image_cost_usd: number | null;
  image_cost_method: string | null;
  is_image_generation: boolean;
  input_tokens: number;
  output_tokens: number;
  tool_call_count: number;
};
type LogStep = { type: string; tool_name: string | null; error: string | null };
type ImageMetadata = { requestLogId?: number; generation: ImageGenerationMetadata };
type Evidence = Record<string, unknown>;
type Result = { name: string; ok: boolean; durationMs: number; evidence: Evidence; error?: string };
const results: Result[] = [];
const evidence: Record<string, Evidence> = {};
let previousImage: Uint8Array | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/data:image\/[^;,]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]")
    .replace(/[A-Za-z0-9+/=]{120,}/g, "[payload omitted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1_000);
}

function project(name: string): string {
  const label = `${PROJECT}:${name}`;
  assert(label.length <= 50, "E2E project label exceeds the request-log limit");
  return label;
}
function config(name: string) {
  return { serverUrl: BASE!, projectName: project(name) };
}
function imageModel(name: string) {
  return qgrid.image("openai/gpt-image-2", config(name));
}
function textModel(name: string) {
  return qgrid(MODEL!, config(name));
}
function providerOptions(extra: QgridImageProviderOptions = {}) {
  return { qgrid: { ...(TOKEN ? { tokenName: TOKEN } : {}), ...extra } };
}

async function apiGet<T>(resource: string, filters: Record<string, string>): Promise<T[]> {
  const params = new URLSearchParams({
    subset: resource === "requestLogStep" ? "A" : "P",
    "rawParams[num]": "100",
    ...filters,
  });
  const response = await fetch(`${BASE}/api/${resource}/findMany?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${resource} lookup HTTP ${response.status}`);
  const body = (await response.json()) as { rows: T[] };
  assert(Array.isArray(body.rows), `${resource} lookup has no rows`);
  return body.rows;
}

async function logs(name: string): Promise<LogRow[]> {
  return apiGet("requestLog", { "rawParams[project_name]": project(name) });
}

async function waitLog(name: string, id?: number, status = "succeeded"): Promise<LogRow> {
  // Read-only polling lets asynchronous log finalization settle. Never replay generation.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await logs(name);
    const row = rows.find((item) => id === undefined || item.id === id);
    if (row?.status === status) return row;
    if (row && ["succeeded", "error", "aborted"].includes(row.status)) {
      throw new Error(`request log ${row.id}: expected ${status}, got ${row.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no ${status} request log for ${name}`);
}

async function raw(
  name: string,
  args: Partial<QueryInput>,
  signal?: AbortSignal,
): Promise<QueryOutput> {
  const response = await fetch(`${BASE}/api/qgrid/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      args: {
        model: MODEL,
        prompt: "",
        effort: "low",
        timeout: TIMEOUT_MS,
        projectName: project(name),
        ...(TOKEN ? { tokenName: TOKEN } : {}),
        ...args,
      },
    }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`query HTTP ${response.status}: ${safeError(await response.text())}`);
  return (await response.json()) as QueryOutput;
}

function fixture(shape: "circle" | "square"): Buffer {
  const png = new PNG({ width: 128, height: 128 });
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const inside =
        shape === "circle"
          ? (x - 64) ** 2 + (y - 64) ** 2 < 40 ** 2
          : x >= 24 && x < 104 && y >= 24 && y < 104;
      const rgb = inside ? (shape === "circle" ? [240, 30, 30] : [25, 60, 240]) : [255, 255, 255];
      const offset = (y * 128 + x) * 4;
      png.data[offset] = rgb[0]!;
      png.data[offset + 1] = rgb[1]!;
      png.data[offset + 2] = rgb[2]!;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const redCircle = fixture("circle");
const blueSquare = fixture("square");
function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}
function history(images: Uint8Array[]): string {
  return JSON.stringify(
    images.map((bytes, index) => ({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `Previous conversation image ${index + 1}.` },
        { type: "input_image", image_url: dataUrl(bytes) },
      ],
    })),
  );
}

async function saveImage(name: string, bytes: Uint8Array, transparent: boolean, index = 0) {
  assert(
    Buffer.from(bytes)
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "not PNG bytes",
  );
  const decoded = PNG.sync.read(Buffer.from(bytes));
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let i = 3; i < decoded.data.length; i += 4) {
    if (decoded.data[i] === 0) transparentPixels++;
    if (decoded.data[i]! > 0) visiblePixels++;
  }
  const file = path.join(OUTPUT, `${name}-${index + 1}.png`);
  await writeFile(file, bytes);
  const stats = {
    file,
    bytes: bytes.length,
    width: decoded.width,
    height: decoded.height,
    transparentPixels,
    visiblePixels,
  };
  evidence[name] = { ...evidence[name], [`image${index + 1}`]: stats };
  assert(visiblePixels > 0, "image is entirely transparent");
  assert(
    !transparent || transparentPixels > 0,
    "transparent request has no fully transparent pixels",
  );
  assert(transparent || transparentPixels === 0, "opaque request returned transparent pixels");
  return stats;
}

async function verifyImageLog(
  name: string,
  metadata: ImageMetadata,
  isDirect: boolean,
  expectedReferences: boolean,
) {
  const generation = metadata.generation;
  assert(generation.route === "codex-images", `unexpected route ${generation.route}`);
  assert(generation.model, "missing image model metadata");
  const usage = generation.usage;
  assert(usage && usage.output_tokens > 0, "missing image usage");
  assert(
    usage.total_tokens === usage.input_tokens + usage.output_tokens,
    "inconsistent total image tokens",
  );
  const detail = usage.input_tokens_details;
  assert(
    detail && detail.text_tokens + detail.image_tokens === usage.input_tokens,
    "missing/inconsistent image input breakdown",
  );
  assert(
    expectedReferences ? detail.image_tokens > 0 : detail.image_tokens === 0,
    `reference selection mismatch: image input tokens=${detail.image_tokens}`,
  );
  const expectedImageCost = Math.round(
    detail.text_tokens * 5 + detail.image_tokens * 8 + usage.output_tokens * 30,
  );
  assert(metadata.requestLogId !== undefined, "missing requestLogId");
  const row = await waitLog(name, metadata.requestLogId);
  assert(row.project_name === project(name), "project label mismatch");
  assert(row.is_image_generation, "is_image_generation=false");
  assert(
    row.image_cost_usd === expectedImageCost,
    `image cost mismatch: ${row.image_cost_usd} != ${expectedImageCost} microUSD`,
  );
  assert(
    row.image_cost_method?.includes("reported-usage"),
    "image cost did not use reported usage",
  );
  assert(isDirect ? row.cost_usd === 0 : row.cost_usd > 0, `invalid driver cost ${row.cost_usd}`);
  assert(
    row.requested_model_name === (isDirect ? "openai/gpt-image-2" : MODEL),
    "requested model mismatch",
  );
  assert(
    row.model_name === (isDirect ? `openai/${generation.model}` : MODEL),
    `served model mismatch: ${row.model_name}`,
  );
  assert(
    isDirect
      ? row.input_tokens === 0 && row.output_tokens === 0
      : row.input_tokens > 0 && row.output_tokens > 0,
    "driver usage mixed with image usage",
  );
  const steps = await apiGet<LogStep>("requestLogStep", {
    "rawParams[request_log_id]": String(row.id),
  });
  assert(
    steps.some((step) => step.type === "generate"),
    "missing generate log step",
  );
  assert(
    steps.filter((step) => step.type === "tool_call" && step.tool_name === "image_generation")
      .length === 1,
    "expected exactly one image-generation log step",
  );
  evidence[name] = {
    ...evidence[name],
    generation,
    requestLogId: row.id,
    driverCostMicroUsd: row.cost_usd,
    imageCostMicroUsd: row.image_cost_usd,
    combinedCostMicroUsd: row.cost_usd + row.image_cost_usd!,
    imageCostMethod: row.image_cost_method,
    requestedModel: row.requested_model_name,
    servedModel: row.model_name,
    steps: steps.map(({ type, tool_name, error }) => ({ type, tool_name, error })),
  };
}

async function direct(
  name: string,
  options: { transparent?: boolean; edit?: boolean; logger?: boolean; n?: number } = {},
) {
  const transparent = options.transparent ?? false;
  const prompt = options.edit
    ? {
        text: "Edit this reference: recolor the red circle to green. Keep the circular shape and white background. No text.",
        images: [redCircle],
      }
    : `Create one centered solid red circle, flat icon, no text or shadows. ${transparent ? "Fully transparent background; visible red circle, transparent outside it." : "Plain solid white opaque background."}`;
  const model = imageModel(name);
  const result = await generateImage({
    model,
    prompt,
    n: options.n ?? 1,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    providerOptions: providerOptions({
      background: transparent ? "transparent" : "opaque",
      ...(options.logger === false ? { logger: false } : {}),
    }),
  });
  const metadata = result.providerMetadata.qgrid.images as unknown as ImageMetadata[];
  assert(result.images.length === (options.n ?? 1), "wrong SDK image count");
  assert(metadata.length === result.images.length, "wrong metadata image count");
  let inputTokens = 0;
  let outputTokens = 0;
  for (const [index, image] of result.images.entries()) {
    assert(image.mediaType === "image/png", "SDK returned wrong media type");
    const dimensions = await saveImage(name, image.uint8Array, transparent, index);
    const item = metadata[index]!;
    assert(
      item.generation.size === `${dimensions.width}x${dimensions.height}`,
      "image dimensions differ from generation metadata",
    );
    evidence[name] = { ...evidence[name], generation: item.generation, usage: result.usage };
    if (options.logger === false)
      assert(item.requestLogId === undefined, "logger:false exposed requestLogId");
    else await verifyImageLog(name, item, true, options.edit ?? false);
    inputTokens += item.generation.usage?.input_tokens ?? 0;
    outputTokens += item.generation.usage?.output_tokens ?? 0;
    assert(
      result.responses[index]?.modelId === item.generation.model,
      "SDK response model differs from image metadata",
    );
  }
  assert(
    result.usage.inputTokens === inputTokens &&
      result.usage.outputTokens === outputTokens &&
      result.usage.totalTokens === inputTokens + outputTokens,
    "standard SDK usage does not equal image metadata usage",
  );
  if (options.logger === false)
    assert((await logs(name)).length === 0, "logger:false created a request log");
  if ((options.n ?? 1) > 1)
    assert(
      new Set(metadata.map((item) => item.requestLogId)).size === options.n,
      "batched images reused log IDs",
    );
}

async function automatic(
  name: string,
  transparent = false,
  refs: Uint8Array[] = [],
  fresh = false,
) {
  const prompt = fresh
    ? "Create a NEW unrelated image: one solid yellow triangle on a white opaque background. Do not edit or use any previous images as references. No text."
    : refs.length > 1
      ? "Create an image combining BOTH reference images: the red circle from the first image on the left and blue square from the second image on the right, white opaque background. Use both images as references. No text."
      : refs.length === 1
        ? "Edit the most recent image: change the subject to green, preserve its shape and white opaque background. Use the last image as the reference. No text."
        : `Generate an actual image of one solid red circle, flat icon. ${transparent ? "The background must be genuinely transparent, no white backdrop, checkerboard, or shadow." : "Solid white opaque background, no text."}`;
  const result = await raw(name, {
    imageGeneration: "auto",
    prompt,
    ...(refs.length ? { history: history(refs) } : {}),
  });
  const images = result.content.filter((part) => part.type === "image");
  assert(images.length === 1, `expected one auto image, got ${images.length}`);
  assert(result.finishReason === "stop", "auto image left an unhandled tool call");
  assert(
    !result.content.some((part) => part.type === "tool-call"),
    "internal image tool leaked to caller",
  );
  assert(
    result.usage.input_tokens > 0 && result.usage.output_tokens > 0 && result.costUsd > 0,
    "auto driver usage missing",
  );
  const image = images[0]!;
  assert(image.mediaType === "image/png", "raw image MIME mismatch");
  const bytes = Buffer.from(image.data, "base64");
  const dimensions = await saveImage(name, bytes, transparent);
  assert(image.generation, "missing generation metadata");
  assert(
    image.generation.size === `${dimensions.width}x${dimensions.height}`,
    "image dimensions differ from generation metadata",
  );
  evidence[name] = { ...evidence[name], driverUsage: result.usage, driverCostUsd: result.costUsd };
  await verifyImageLog(
    name,
    { requestLogId: result.requestLogId, generation: image.generation },
    false,
    refs.length > 0 && !fresh,
  );
  previousImage = bytes;
}

async function text(name: string, streaming: boolean) {
  const args = {
    model: textModel(name),
    prompt: "Reply with exactly IMAGE_TEXT_OK",
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000),
    providerOptions: providerOptions(),
  };
  const result = streaming ? streamText(args) : await generateText(args);
  let value = "";
  if (streaming && "textStream" in result)
    for await (const chunk of result.textStream) value += chunk;
  else value = await result.text;
  assert(value.includes("IMAGE_TEXT_OK"), `unexpected text response: ${value.slice(0, 150)}`);
  const metadata = await result.providerMetadata;
  const id = metadata?.qgrid?.requestLogId;
  assert(typeof id === "number", "missing SDK text requestLogId");
  const row = await waitLog(name, id);
  assert(
    !row.is_image_generation && row.image_cost_usd === null,
    "text-only request charged image cost",
  );
  evidence[name] = { requestLogId: id, usage: await result.usage, text: value };
}

async function expectReject(label: string, action: () => Promise<unknown>, pattern: RegExp) {
  try {
    await action();
  } catch (error) {
    const message = safeError(error);
    assert(pattern.test(message), `${label}: unexpected rejection ${message}`);
    return { label, error: message };
  }
  throw new Error(`${label}: unexpectedly accepted`);
}

async function negative() {
  // All requests here must fail validation without invoking a live provider.
  const rejected = [];
  for (const option of ["imageGeneration", "imageGenerationOptions"]) {
    rejected.push(
      await expectReject(
        option,
        () =>
          generateText({
            model: textModel("negative"),
            prompt: "must not run",
            maxRetries: 0,
            providerOptions: { qgrid: { [option]: option === "imageGeneration" ? true : {} } },
          }),
        /removed.*generateImage/i,
      ),
    );
  }
  const base = {
    model: imageModel("negative"),
    prompt: "must not run",
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(15_000),
  };
  rejected.push(
    await expectReject(
      "non-PNG",
      () => generateImage({ ...base, providerOptions: { qgrid: { outputFormat: "webp" } } }),
      /PNG output only/i,
    ),
  );
  rejected.push(
    await expectReject(
      "mask",
      () =>
        generateImage({
          ...base,
          prompt: { text: "must not run", images: [redCircle], mask: redCircle },
        }),
      /masks are not supported/i,
    ),
  );
  rejected.push(
    await expectReject(
      "six references",
      () =>
        generateImage({
          ...base,
          prompt: { text: "must not run", images: Array.from({ length: 6 }, () => redCircle) },
        }),
      /at most five/i,
    ),
  );
  for (const [label, endpoint, args, pattern] of [
    [
      "auto non-PNG",
      "query",
      { model: MODEL, imageGeneration: "auto", imageGenerationOptions: { outputFormat: "webp" } },
      /PNG/i,
    ],
    [
      "raw image stream",
      "prepareStream",
      { model: MODEL, imageGeneration: "auto" },
      /imageGeneration.*stream/i,
    ],
    [
      "invalid image-model mode",
      "query",
      { model: "openai/gpt-image-2", imageGeneration: "auto" },
      /imageGeneration.*true|image model|image-only/i,
    ],
  ] as const) {
    const response = await fetch(`${BASE}/api/qgrid/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { prompt: "must not run", logger: false, ...args } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = safeError(await response.text());
    assert(
      !response.ok && pattern.test(body),
      `${label}: expected rejection, HTTP ${response.status}: ${body}`,
    );
    assert(response.status === 400, `${label}: expected HTTP 400`);
    rejected.push({ label, status: response.status, error: body });
  }
  evidence.negative = { rejected };
}

async function cancel() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    await expectReject(
      "cancellation",
      () =>
        raw(
          "cancel",
          {
            imageGeneration: "auto",
            prompt: "Generate an actual image of a solid orange star on a white background.",
          },
          controller.signal,
        ),
      /abort|cancel/i,
    );
  } finally {
    clearTimeout(timer);
  }
  const row = await waitLog("cancel", undefined, "aborted");
  assert(
    !row.is_image_generation && row.image_cost_usd === null,
    "aborted request recorded a finished image",
  );
  evidence.cancel = {
    requestLogId: row.id,
    status: row.status,
    imageCostMicroUsd: row.image_cost_usd,
  };
}

async function cancelDirect() {
  const name = "cancel-direct";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    await expectReject(
      name,
      () =>
        generateImage({
          model: imageModel(name),
          prompt: "Create one solid orange star on a plain white background.",
          providerOptions: providerOptions({ background: "opaque" }),
          abortSignal: controller.signal,
          maxRetries: 0,
        }),
      /abort|cancel/i,
    );
  } finally {
    clearTimeout(timer);
  }
  const row = await waitLog(name, undefined, "aborted");
  assert(
    row.is_image_generation && row.image_cost_usd === null,
    "cancelled direct request recorded a completed image cost",
  );
  const steps = await apiGet<LogStep>("requestLogStep", {
    "rawParams[request_log_id]": String(row.id),
  });
  assert(
    !steps.some((step) => step.tool_name === "image_generation"),
    "cancelled direct request recorded a finished image step",
  );
  evidence[name] = {
    requestLogId: row.id,
    status: row.status,
    imageCostMicroUsd: row.image_cost_usd,
  };
}

const tests: Record<string, () => Promise<void>> = {
  negative,
  text: () => text("text", false),
  stream: () => text("stream", true),
  "auto-text": async () => {
    const result = await raw("auto-text", {
      imageGeneration: "auto",
      prompt: "What is 2 + 2? Reply only with 4; do not generate any image.",
    });
    assert(
      result.text.trim() === "4" && !result.content.some((part) => part.type === "image"),
      "auto text-only response failed",
    );
    const row = await waitLog("auto-text", result.requestLogId);
    assert(
      !row.is_image_generation && row.image_cost_usd === null,
      "auto text-only response charged for an image",
    );
    evidence["auto-text"] = { requestLogId: row.id, text: result.text, usage: result.usage };
  },
  "direct-opaque": () => direct("direct-opaque"),
  "direct-transparent": () => direct("direct-transparent", { transparent: true }),
  "direct-edit": () => direct("direct-edit", { edit: true }),
  "auto-opaque": () => automatic("auto-opaque"),
  "auto-transparent": () => automatic("auto-transparent", true),
  "auto-edit": () => automatic("auto-edit", false, [previousImage ?? redCircle]),
  "auto-multi": () => automatic("auto-multi", false, [redCircle, blueSquare]),
  "auto-new": () => automatic("auto-new", false, [redCircle, blueSquare], true),
  cancel,
  "cancel-direct": cancelDirect,
  batch: () => direct("batch", { n: 2 }),
  "logger-off": () => direct("logger-off", { logger: false }),
};

async function main() {
  assert(
    process.env.QGRID_REAL_PROVIDER_ACCEPTANCE === "1",
    "Set QGRID_REAL_PROVIDER_ACCEPTANCE=1 to authorize live subscription usage",
  );
  assert(BASE && /^https?:\/\//.test(BASE), "Set an explicit QGRID_URL");
  assert(
    MODEL?.startsWith("openai/") && !MODEL.includes("gpt-image"),
    "Set an explicit OpenAI chat QGRID_OPENAI_MODEL",
  );
  assert(CASES.length && new Set(CASES).size === CASES.length, "Cases must be nonempty and unique");
  for (const name of CASES)
    assert(tests[name], `Unknown case ${name}. Available: ${Object.keys(tests).join(",")}`);
  const healthResponse = await fetch(`${BASE}/api/qgrid/health`, {
    signal: AbortSignal.timeout(15_000),
  });
  assert(healthResponse.ok, `test server health HTTP ${healthResponse.status}`);
  const health = (await healthResponse.json()) as {
    ready?: boolean;
    activeTokens?: number;
    providers?: { openai?: string };
  };
  assert(
    health.ready && health.providers?.openai === "ready" && (health.activeTokens ?? 0) > 0,
    "Test server is not ready with an active OpenAI token; restart it after runtime changes before spending quota",
  );
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(path.join(OUTPUT, "reference-red-circle.png"), redCircle);
  await writeFile(path.join(OUTPUT, "reference-blue-square.png"), blueSquare);
  console.log(JSON.stringify({ project: PROJECT, output: OUTPUT, model: MODEL, cases: CASES }));
  for (const name of CASES) {
    const start = Date.now();
    console.log(`START ${name}`);
    let error: string | undefined;
    try {
      await tests[name]!();
    } catch (caught) {
      error = safeError(caught);
    }
    const result: Result = {
      name,
      ok: error === undefined,
      durationMs: Date.now() - start,
      evidence: evidence[name] ?? {},
      ...(error ? { error } : {}),
    };
    results.push(result);
    await appendFile(path.join(OUTPUT, "results.jsonl"), `${JSON.stringify(result)}\n`);
    await writeFile(
      path.join(OUTPUT, "summary.json"),
      JSON.stringify({ project: PROJECT, model: MODEL, cases: CASES, results }, null, 2),
    );
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${name} (${result.durationMs}ms)${error ? `: ${error}` : ""}`,
    );
  }
  console.log(
    `${results.filter((result) => result.ok).length}/${results.length} passed; ${path.join(OUTPUT, "summary.json")}`,
  );
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
