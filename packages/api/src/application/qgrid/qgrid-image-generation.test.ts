import { describe, expect, it } from "vitest";

import { estimateImageGenerationCostMicroUsd, imageGenerationCostMethod } from "./qgrid-image-generation";
import { QueryInput, type ImageGenerationMetadata, type QgridContent, type QueryOutput } from "./qgrid.types";

const options = { quality: "high" as const, size: "1024x1024" as const, background: "transparent" as const };
const generation: ImageGenerationMetadata = {
  route: "codex-images", model: "gpt-image-2", background: "transparent",
  size: "1254x1254", quality: "medium",
};
function result(content: QgridContent[]): QueryOutput {
  return {
    text: "", content, finishReason: "stop", tokenName: "token", model: "gpt-image-2",
    usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    durationMs: 10, ttftMs: 0, costUsd: 0, costSource: "pricing_table",
  };
}

describe("standalone image cost estimates", () => {
  it("accepts automatic image mode while preserving boolean requests", () => {
    for (const imageGeneration of [true, false, "auto"] as const) {
      expect(QueryInput.parse({ prompt: "chat", imageGeneration }).imageGeneration).toBe(imageGeneration);
    }
    expect(QueryInput.safeParse({ prompt: "chat", imageGeneration: "required" }).success).toBe(false);
  });
  it("uses response usage once for multiple outputs without pricing requested settings or driver tokens", () => {
    const output = result([
      { type: "image", data: "first", generation: { ...generation,
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300,
          input_tokens_details: { text_tokens: 40, image_tokens: 60, cached_tokens: 50 } },
      } },
      { type: "image", data: "second", generation },
    ]);
    expect(estimateImageGenerationCostMicroUsd(output, options)).toBe(6_680);
    expect(imageGenerationCostMethod(options, output)).toBe(
      "estimated:gpt-image-2:reported-usage:public-prices:conservative",
    );
  });

  it("does not substitute requested size pricing when standalone usage is missing", () => {
    expect(estimateImageGenerationCostMicroUsd(result([{ type: "image", data: "png", generation }]), options)).toBeNull();
  });

  it("prices unknown input remainder at the image rate and ignores inconsistent splits", () => {
    for (const [textTokens, imageTokens, expected] of [[40, 10, 6_680], [100, 60, 6_800]]) {
      const output = result([{ type: "image", data: "png", generation: { ...generation, usage: {
        input_tokens: 100, output_tokens: 200, total_tokens: 300,
        input_tokens_details: { text_tokens: textTokens!, image_tokens: imageTokens! },
      } } }]);
      expect(estimateImageGenerationCostMicroUsd(output, options)).toBe(expected);
    }
  });

  it("preserves legacy per-image price assumptions when response metadata is absent", () => {
    const output = result([{ type: "image", data: "first" }, { type: "image", data: "second" }]);
    expect(estimateImageGenerationCostMicroUsd(output, options)).toBe(422_000);
    expect(imageGenerationCostMethod(options, output)).toBe("assumed:gpt-image-2:high:1024x1024:png");
  });
});
