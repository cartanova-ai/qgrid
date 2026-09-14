import { describe, expect, it } from "vitest";

import { buildImageGenerationToolSteps, formatImagePartForLog, imageGenerationToolArgs } from "./qgrid-response-format";

it("logs observed standalone settings separately from requested controls without a requested-price assumption", () => {
  const requestedOptions = { quality: "high" as const, size: "1024x1024" as const, background: "transparent" as const };
  const generation = {
    route: "codex-images" as const, model: "gpt-image-2" as const,
    quality: "medium", size: "1254x1254", background: "transparent",
    usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
  };
  const [step] = buildImageGenerationToolSteps({
    prompt: "draw", model: "openai/gpt-5.5", imageGenerationOptions: requestedOptions,
  }, [{ type: "image", data: "png", generation }], 0);
  const args = JSON.parse(step!.tool_args);
  expect(args.requestedOptions).toEqual(requestedOptions);
  expect(args.observedGeneration).toEqual(generation);
  expect(args).not.toHaveProperty("pricingAssumption");
});

describe("qgrid response log formatting", () => {
  it("logs the returned MIME and requested output format", () => {
    expect(formatImagePartForLog({ type: "image", data: "webp", mediaType: "image/webp" })).toContain("data:image/webp;base64,webp");
    expect(JSON.parse(imageGenerationToolArgs({ prompt: "draw", imageGenerationOptions: { outputFormat: "webp" } })).tool.outputFormat).toBe("webp");
  });

  it("records requested image controls separately from pricing assumptions", () => {
    const requestedOptions = { background: "transparent", size: "1024x1024", quality: "high" } as const;
    const args = JSON.parse(imageGenerationToolArgs({
      prompt: "an isolated circle", imageGeneration: true,
      imageGenerationOptions: requestedOptions,
    }));
    expect(args.requestedOptions).toEqual(requestedOptions);
    expect(args.pricingAssumption).not.toHaveProperty("background");
  });

  it("includes input images in image-generation tool args", () => {
    expect(
      JSON.parse(
        imageGenerationToolArgs({
          prompt: "stage this room",
          model: "openai/gpt-5.5",
          input: [
            { type: "text", text: "stage this room", text_elements: [] },
            { type: "image", url: "data:image/webp;base64,UklGRg==" },
          ],
        }),
      ),
    ).toMatchObject({
      prompt: "stage this room",
      inputImages: [{ mediaType: "image/webp", data: "UklGRg==", byteSize: 4 }],
    });
  });

  it("can omit input images from later multi-output tool args", () => {
    const args = JSON.parse(
      imageGenerationToolArgs(
        {
          prompt: "stage this room",
          input: [{ type: "image", url: "data:image/webp;base64,UklGRg==" }],
        },
        { includeInputImages: false },
      ),
    );

    expect(args.inputImages).toBeUndefined();
  });

  it("masks non-image data urls that reach input image tool args", () => {
    const args = JSON.parse(
      imageGenerationToolArgs({
        prompt: "stage this room",
        input: [{ type: "image", url: "data:application/pdf;base64,JVBERi0xLjQ=" }],
      }),
    );

    expect(args.inputImages).toEqual([
      {
        mediaType: "application/pdf",
        url: "[data-url 40 chars]",
        byteSize: 8,
      },
    ]);
  });

  it("builds multi-output image-generation tool steps without duplicating input images", () => {
    const steps = buildImageGenerationToolSteps(
      {
        prompt: "stage this room",
        input: [{ type: "image", url: "data:image/webp;base64,UklGRg==" }],
      },
      [
        { type: "image", data: "first", revisedPrompt: "first" },
        { type: "image", data: "second", revisedPrompt: "second" },
      ],
      2,
    );

    expect(JSON.parse(steps[0]!.tool_args).inputImages).toEqual([
      { mediaType: "image/webp", data: "UklGRg==", byteSize: 4 },
    ]);
    expect(JSON.parse(steps[1]!.tool_args).inputImages).toBeUndefined();
    expect(steps.map((step) => step.tool_call_id)).toEqual([
      "image_generation:2:0",
      "image_generation:2:1",
    ]);
  });
});
