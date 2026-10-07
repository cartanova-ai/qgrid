/** Opt-in regression: structured direct answers with tools present, including OpenAI tuples.
 * QGRID_ACCEPTANCE_REPEATS defaults to 1; increase only for a repetition investigation.
 * Non-streaming tool follow-up coverage lives in e2e.ts.
 */
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
  const repeats = Number(process.env.QGRID_ACCEPTANCE_REPEATS ?? "1");
  assert.ok(
    Number.isSafeInteger(repeats) && repeats > 0,
    "QGRID_ACCEPTANCE_REPEATS must be a positive integer",
  );
  const projectName = `qg-struct-${randomUUID()}`;

  for (const modelId of models) {
    const config: { serverUrl: string; projectName: string } = { serverUrl, projectName };
    const model = modelId.startsWith("openai/")
      ? qgrid(modelId as QgridOpenAIModel, config)
      : qgrid(modelId as QgridAnthropicModel, config);
    // Tuple normalization is an OpenAI-specific regression; Anthropic keeps a plain object.
    const schema: z.ZodType<
      { tuple: [{ label: "tuple" }, 11] } | { details: { label: "direct" } }
    > = modelId.startsWith("openai/")
      ? z.object({ tuple: z.tuple([z.object({ label: z.literal("tuple") }), z.literal(11)]) })
      : z.object({ details: z.object({ label: z.literal("direct") }) });
    for (let attempt = 1; attempt <= repeats; attempt++) {
      for (const mode of ["generate", "stream"] as const) {
        let executions = 0;
        const request = {
          model,
          prompt:
            "Answer directly with the object required by the output schema. Do not call any tool.",
          tools: {
            lookupMarker: tool({
              description: "Only call this tool when the user requests a marker lookup.",
              inputSchema: z.object({}),
              execute: async () => {
                executions++;
                return { marker: "unexpected" };
              },
            }),
          },
          output: Output.object({ schema }),
          stopWhen: stepCountIs(3),
          maxRetries: 0,
        };
        if (mode === "generate") {
          const result = await generateText(request);
          schema.parse(result.output);
          assert.equal(result.finishReason, "stop");
          assert.equal(result.steps.length, 1, "Direct answer should not need a tool continuation");
        } else {
          const result = streamText(request);
          let text = "";
          for await (const chunk of result.textStream) text += chunk;
          const output = schema.parse(await result.output);
          assert.deepEqual(JSON.parse(text), output, "Streamed JSON must match parsed output");
          assert.equal(await result.finishReason, "stop");
          assert.equal((await result.steps).length, 1);
        }
        assert.equal(executions, 0, "Direct answer unexpectedly executed a tool");
        console.log(`  ✓ ${modelId} ${mode} direct structured answer ${attempt}/${repeats}`);
      }
    }

    // Keep the streamed tool-answer envelope regression separate from the default generate flow.
    const marker = randomUUID();
    let executions = 0;
    const result = streamText({
      model,
      prompt: "Call lookupMarker once. After the result arrives, return its hidden marker as JSON.",
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
      output: Output.object({ schema: z.object({ marker: z.string() }) }),
      stopWhen: stepCountIs(3),
      maxRetries: 0,
    });
    let text = "";
    for await (const chunk of result.textStream) text += chunk;
    assert.equal(executions, 1);
    assert.deepEqual(await result.output, { marker });
    assert.deepEqual(JSON.parse(text), { marker }, "Streamed tool answer must match final output");
    assert.equal(await result.finishReason, "stop");
    assert.ok((await result.steps).length >= 2);
    console.log(`  ✓ ${modelId} stream tool follow-up`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
