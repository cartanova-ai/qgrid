import {
  type ImageGenerationOptions,
  type ImageGenerationQuality,
  type ImageGenerationSize,
  type QueryOutput,
} from "./qgrid.types";

export const CODEX_IMAGE_GENERATION_MODEL = "gpt-image-2";
export const DEFAULT_IMAGE_GENERATION_QUALITY: ImageGenerationQuality = "medium";
export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = "1536x1024";

export type ResolvedImageGenerationOptions = {
  quality: ImageGenerationQuality;
  size: ImageGenerationSize;
};

// OpenAI gpt-image-2 image output cost estimates by quality/size:
// https://developers.openai.com/api/docs/guides/image-generation#calculating-costs
const IMAGE_OUTPUT_COST_MICRO_USD: Record<
  ImageGenerationQuality,
  Partial<Record<ImageGenerationSize, number>>
> = {
  low: {
    "1024x1024": 6_000,
    "1024x1536": 5_000,
    "1536x1024": 5_000,
  },
  medium: {
    "1024x1024": 53_000,
    "1024x1536": 41_000,
    "1536x1024": 41_000,
  },
  high: {
    "1024x1024": 211_000,
    "1024x1536": 165_000,
    "1536x1024": 165_000,
  },
};

export function resolveImageGenerationOptions(
  options: ImageGenerationOptions | undefined,
): ResolvedImageGenerationOptions {
  return {
    quality: options?.quality ?? DEFAULT_IMAGE_GENERATION_QUALITY,
    size: options?.size ?? DEFAULT_IMAGE_GENERATION_SIZE,
  };
}

export function imageGenerationCostMethod(
  options: ImageGenerationOptions | undefined,
  result?: QueryOutput,
): string | null {
  if (
    result?.content.some(
      (item) => item.type === "image" && item.generation?.route === "codex-responses",
    )
  )
    return null;
  if (
    result?.content.some(
      (item) => item.type === "image" && item.generation?.route === "codex-images",
    )
  ) {
    return "estimated:gpt-image-2:reported-usage:public-prices:conservative";
  }
  const resolved = resolveImageGenerationOptions(options);
  if (IMAGE_OUTPUT_COST_MICRO_USD[resolved.quality][resolved.size] === undefined) return null;
  return `assumed:${CODEX_IMAGE_GENERATION_MODEL}:${resolved.quality}:${resolved.size}:png`;
}

export function estimateImageGenerationCostMicroUsd(
  result: QueryOutput,
  options: ImageGenerationOptions | undefined,
): number | null {
  const images = result.content.filter((item) => item.type === "image");
  const imageCount = images.length;
  if (imageCount === 0) return null;
  // Hosted Responses reports observed settings but no trustworthy image usage
  // or guaranteed image model. Requested size/quality cannot price that output.
  if (images.some((image) => image.generation?.route === "codex-responses")) return null;
  if (images.some((image) => image.generation?.route === "codex-images")) {
    // The standalone response's aggregate usage is carried by its first image only.
    // Do not multiply it by output count or price it as the requested text driver.
    const usage = images.find((image) => image.generation?.usage)?.generation?.usage;
    if (!usage) return null;
    // Public GPT Image 2 rates verified 2026-09-08: text input $5/M, image input
    // $8/M, output $30/M. Amounts below are microUSD, so no /1M conversion.
    // https://developers.openai.com/api/docs/pricing#image-generation
    // Use a consistent reported split; unknown input is conservatively priced as
    // images. Cache discounts and private subscription billing remain unknown.
    const details = usage.input_tokens_details;
    const textTokens =
      details && details.text_tokens + details.image_tokens <= usage.input_tokens
        ? details.text_tokens
        : 0;
    return Math.round(
      textTokens * 5 + (usage.input_tokens - textTokens) * 8 + usage.output_tokens * 30,
    );
  }
  const resolved = resolveImageGenerationOptions(options);
  const unitCost = IMAGE_OUTPUT_COST_MICRO_USD[resolved.quality][resolved.size];
  return unitCost === undefined ? null : imageCount * unitCost;
}
