/** Real HTTP/SSE → qgrid → subscription provider checks; uses quota, no request-log DB writes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { generateText, Output, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import {
  qgrid,
  type QgridAnthropicModel,
  type QgridOpenAIModel,
  type QgridProviderOptions,
} from "../src/index";

async function main() {
  assert.equal(
    process.env.QGRID_REAL_PROVIDER_ACCEPTANCE,
    "1",
    "Set QGRID_REAL_PROVIDER_ACCEPTANCE=1 to use provider quota",
  );
  const serverUrl = process.env.QGRID_URL;
  const modelIds = process.env.QGRID_MODEL?.split(",").map((model) => model.trim());
  assert.ok(serverUrl, "Set QGRID_URL to an isolated qgrid HTTP server");
  assert.ok(
    modelIds?.length && modelIds.every((model) => /^(openai|anthropic)\/.+/.test(model)),
    "Set QGRID_MODEL to explicit models supporting thinking:false",
  );
  const projectName = `qgrid-thinking-e2e-${randomUUID()}`;
  let checks = 0;
  for (const modelId of modelIds) {
    const config: { serverUrl: string; projectName: string; defaultEffort: "high" } = {
      serverUrl,
      projectName,
      defaultEffort: "high",
    };
    const model = modelId.startsWith("openai/")
      ? qgrid(modelId as QgridOpenAIModel, config)
      : qgrid(modelId as QgridAnthropicModel, config);
    const options = {
      thinking: false,
      effort: "high",
      logger: false,
    } satisfies QgridProviderOptions;
    const marker = `OK_${randomUUID().slice(0, 8)}`;
    const check = (name: string) => {
      checks++;
      console.log(`PASS ${modelId} ${name}`);
    };
    const text = await generateText({
      model,
      prompt: `Reply with exactly ${marker}.`,
      providerOptions: { qgrid: options },
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60000),
    });
    assert.ok(text.text.includes(marker), "Off response lost the marker");
    assert.equal(text.finishReason, "stop");
    if (modelId.startsWith("openai/"))
      assert.equal(text.usage.outputTokenDetails.reasoningTokens, 0);
    assert.equal(text.providerMetadata?.qgrid?.requestLogId, undefined);
    check("thinking=false (overrides default/request high)");

    const enabled = await generateText({
      model,
      prompt: `Reply with exactly ${marker}.`,
      providerOptions: { qgrid: { ...options, thinking: true, effort: "low" } },
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60000),
    });
    assert.ok(enabled.text.includes(marker));
    assert.equal(enabled.finishReason, "stop");
    check("thinking=true");

    const stream = streamText({
      model,
      prompt: `Reply with exactly ${marker}.`,
      providerOptions: { qgrid: options },
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60000),
    });
    let streamed = "";
    for await (const delta of stream.textStream) streamed += delta;
    assert.ok(streamed.includes(marker), "Empty or invalid SSE response");
    assert.equal(await stream.finishReason, "stop");
    check("thinking=false stream over HTTP/SSE");

    const hidden = randomUUID();
    let executions = 0;
    const schema = z.object({ marker: z.string() });
    const result = await generateText({
      model,
      prompt:
        "Call lookupMarker exactly once. Only that tool knows the marker. After its result, return the marker in the requested JSON object.",
      providerOptions: { qgrid: options },
      tools: {
        lookupMarker: tool({
          description: "Return the hidden marker.",
          inputSchema: z.object({}),
          execute: async () => {
            executions++;
            return { marker: hidden };
          },
        }),
      },
      output: Output.object({ schema }),
      stopWhen: stepCountIs(3),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(90000),
    });
    assert.equal(executions, 1, "Expected one real tool execution");
    assert.ok(result.steps.length >= 2, "Missing tool continuation");
    assert.equal(schema.parse(result.output).marker, hidden);
    assert.equal(result.finishReason, "stop");
    check("thinking=false tool execution + follow-up + structured output");
  }

  for (const model of ["openai/gpt-6-astra", "anthropic/claude-fable-5-1"]) {
    const response: Response = await fetch(`${serverUrl}/api/qgrid/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        args: { model, prompt: "Reply OK.", thinking: false, logger: false },
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 400, `${model} must reject thinking:false over HTTP`);
    assert.match(await response.text(), /thinking:false/);
    checks++;
    console.log(`PASS ${model} unsupported -> HTTP 400`);
  }
  for (const endpoint of ["query", "prepareStream"]) {
    const invalid: Response = await fetch(`${serverUrl}/api/qgrid/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        args: { model: modelIds[0], prompt: "Reply OK.", thinking: "false", logger: false },
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(invalid.status, 400, `${endpoint} HTTP schema must reject nonboolean thinking`);
    checks++;
    console.log(`PASS ${endpoint} nonboolean thinking -> HTTP 400`);
  }
  console.log(JSON.stringify({ result: "passed", checks, models: modelIds, serverUrl }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
