/** Live SDK → server → provider → request-log checks. Use an isolated test server. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { generateText, Output, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { qgrid, type QgridAnthropicModel, type QgridOpenAIModel } from "../src/index";

async function main() {
  assert.equal(
    process.env.QGRID_REAL_PROVIDER_ACCEPTANCE,
    "1",
    "Set QGRID_REAL_PROVIDER_ACCEPTANCE=1 to spend provider quota",
  );
  const serverUrl = process.env.QGRID_URL;
  const models = process.env.QGRID_MODEL?.split(",").map((model) => model.trim());
  assert.ok(serverUrl, "Set QGRID_URL to an isolated test server");
  assert.ok(
    models?.length && models.every((model) => /^(openai|anthropic)\/.+/.test(model)),
    "Set QGRID_MODEL to an explicit provider/model (comma-separated for multiple models)",
  );
  const projectName = `qgrid-e2e-${randomUUID()}`;

  async function readLog(path: string) {
    const response = await fetch(new URL(path, serverUrl));
    assert.ok(response.ok, `Log lookup failed: ${response.status} ${path}`);
    return response.json();
  }

  async function assertLog(id: unknown, marker?: string) {
    assert.ok(typeof id === "number" && Number.isSafeInteger(id) && id > 0, "Missing requestLogId");
    const parent = await readLog(`/api/requestLog/findById?subset=A&id=${id}`);
    assert.equal(parent.id, id);
    assert.equal(parent.project_name, projectName);
    assert.equal(parent.status, "succeeded");
    assert.ok(
      typeof parent.response === "string" && parent.response.trim(),
      "Empty logged response",
    );
    const params = new URLSearchParams({
      subset: "A",
      "rawParams[request_log_id]": String(id),
      "rawParams[num]": "50",
      "rawParams[page]": "1",
      "rawParams[orderBy]": "id-asc",
    });
    const { rows } = (await readLog(`/api/requestLogStep/findMany?${params}`)) as {
      rows: Array<{
        type: string;
        tool_name: string | null;
        tool_result: string | null;
      }>;
    };
    assert.ok(
      rows.filter((step) => step.type === "generate").length >= (marker ? 2 : 1),
      "Missing generation steps",
    );
    if (marker) {
      assert.ok(
        rows.some(
          (step) =>
            step.type === "tool_call" &&
            step.tool_name === "lookupMarker" &&
            step.tool_result?.includes(marker),
        ),
        "Missing executed tool result in this request log",
      );
    }
    console.log(`  ✓ requestLogId=${id}, steps=${rows.length}`);
  }

  for (const modelId of models) {
    const config: { serverUrl: string; projectName: string } = { serverUrl, projectName };
    const model = modelId.startsWith("openai/")
      ? qgrid(modelId as QgridOpenAIModel, config)
      : qgrid(modelId as QgridAnthropicModel, config);
    console.log(`\n${modelId} (${projectName})`);

    const text = await generateText({ model, prompt: "Give a short greeting.", maxRetries: 0 });
    assert.ok(text.text.trim(), "Empty text response");
    assert.equal(text.finishReason, "stop");
    await assertLog(text.providerMetadata?.qgrid?.requestLogId);

    const stream = streamText({ model, prompt: "Give a short greeting.", maxRetries: 0 });
    let streamedText = "";
    for await (const chunk of stream.textStream) streamedText += chunk;
    assert.ok(streamedText.trim(), "Empty stream");
    assert.equal(await stream.finishReason, "stop");
    await assertLog((await stream.providerMetadata)?.qgrid?.requestLogId);

    const marker = randomUUID();
    let executions = 0;
    const schema = z.object({ marker: z.string() });
    const result = await generateText({
      model,
      prompt:
        "Call lookupMarker exactly once. Only that tool knows the marker. After receiving its result, return the marker in the requested JSON object.",
      tools: {
        lookupMarker: tool({
          description: "Look up the hidden marker.",
          inputSchema: z.object({}),
          execute: async () => {
            executions++;
            return { marker };
          },
        }),
      },
      output: Output.object({ schema }),
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    });
    assert.equal(executions, 1, "Expected one actual tool execution");
    assert.equal(result.finishReason, "stop");
    assert.equal(
      schema.parse(result.output).marker,
      marker,
      "Final output did not use the tool result",
    );
    const id = result.providerMetadata?.qgrid?.requestLogId;
    assert.ok(result.steps.length >= 2, "Missing tool continuation");
    assert.ok(
      result.steps.every((step) => step.providerMetadata?.qgrid?.requestLogId === id),
      "Tool steps must share one parent log",
    );
    await assertLog(id, marker);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
