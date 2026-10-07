/** Opt-in telemetry regression: qgrid's native tool run must not be logged twice. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import {
  createQgridLogger,
  qgrid,
  type QgridAnthropicModel,
  type QgridOpenAIModel,
} from "../src/index";

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

  for (const modelId of models) {
    const projectName = `qg-log-${randomUUID()}`;
    const errors: Error[] = [];
    const logger = createQgridLogger({
      serverUrl,
      projectName,
      onLogError: (error) => errors.push(error),
    });
    const config: { serverUrl: string; projectName: string } = { serverUrl, projectName };
    const model = modelId.startsWith("openai/")
      ? qgrid(modelId as QgridOpenAIModel, config)
      : qgrid(modelId as QgridAnthropicModel, config);
    let executions = 0;
    const result = await generateText({
      model,
      prompt: "Call lookupMarker once, then report the marker it returns.",
      tools: {
        lookupMarker: tool({
          description: "Look up a hidden marker.",
          inputSchema: z.object({}),
          execute: async () => {
            executions++;
            return { marker: randomUUID() };
          },
        }),
      },
      stopWhen: stepCountIs(3),
      maxRetries: 0,
      experimental_telemetry: logger,
    });
    assert.equal(result.finishReason, "stop");
    assert.ok(result.text.trim());
    assert.equal(executions, 1);
    assert.deepEqual(errors, []);
    const id = result.providerMetadata?.qgrid?.requestLogId;
    assert.equal(typeof id, "number", "Missing native requestLogId");
    const params = new URLSearchParams({
      subset: "A",
      "rawParams[project_name]": projectName,
      "rawParams[num]": "2",
      "rawParams[page]": "1",
    });
    const response = await fetch(new URL(`/api/requestLog/findMany?${params}`, serverUrl));
    assert.ok(response.ok, `Log lookup failed: ${response.status}`);
    const { rows } = (await response.json()) as {
      rows: Array<{ id: number; project_name: string; status: string }>;
    };
    assert.equal(rows.length, 1, "Telemetry must not duplicate the native qgrid log");
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].project_name, projectName);
    assert.equal(rows[0].status, "succeeded");
    console.log(`  ✓ ${modelId}: one native log, requestLogId=${id}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
