/** Explicit live acceptance: QGRID_REAL_PROVIDER_ACCEPTANCE=1 is required. */
import assert from "node:assert/strict";

import { generateText, streamText, Output, tool, stepCountIs } from "ai";
import { z } from "zod";

import { qgrid, type QgridAntigravityProviderOptions } from "../src/index";

if (process.env.QGRID_REAL_PROVIDER_ACCEPTANCE !== "1") {
  throw new Error("Set QGRID_REAL_PROVIDER_ACCEPTANCE=1 to use real subscription quota");
}
const model = qgrid("antigravity/gemini-3.1-flash-lite", {
  serverUrl: process.env.QGRID_URL ?? "http://127.0.0.1:45118",
  projectName: "qgrid-antigravity-http-acceptance",
});
const providerOptions = { qgrid: {
  tokenName: process.env.QGRID_TOKEN_NAME ?? "antigravity/http-test",
  timeoutMs: 60_000,
} satisfies QgridAntigravityProviderOptions };

const text = await generateText({ model, providerOptions, prompt: "Reply with exactly: QGRID_SDK_OK" });
assert.equal(text.text.trim(), "QGRID_SDK_OK");
console.log("PASS SDK generateText");

const stream = streamText({ model, providerOptions, prompt: "Reply with exactly: QGRID_STREAM_OK" });
let streamed = "";
for await (const chunk of stream.textStream) streamed += chunk;
assert.equal(streamed.trim(), "QGRID_STREAM_OK");
assert.equal(await stream.finishReason, "stop");
console.log("PASS SDK streamText");

const structured = await generateText({ model, providerOptions,
  prompt: "Return status ok and count 3 using the requested schema.",
  output: Output.object({ schema: z.object({ status: z.literal("ok"), count: z.literal(3) }) }),
});
assert.deepEqual(structured.output, { status: "ok", count: 3 });
console.log("PASS SDK structured output");

let calls = 0;
const tools = await generateText({ model, providerOptions,
  prompt: "Call lookup exactly once to obtain the secret word. Then reply with only the returned word. Do not guess it.",
  tools: { lookup: tool({ description: "Returns the secret word", inputSchema: z.object({}), execute: async () => { calls++; return { word: "orchid" }; } }) },
  stopWhen: stepCountIs(3),
});
assert.equal(calls, 1);
assert.equal(tools.text.trim(), "orchid");
console.log("PASS SDK client tool round trip");
