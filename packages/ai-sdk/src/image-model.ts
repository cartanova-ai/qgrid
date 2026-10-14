import { type ImageModelV3, type ImageModelV3File } from "@ai-sdk/provider";

import { qgridFetch } from "./http-transport";
import {
  type QgridImageModel,
  type QgridImageProviderConfig,
  type QgridImageProviderOptions,
  type QgridInputPart,
  type QueryOutput,
} from "./index.types";
import { DEFAULT_QGRID_SERVER_URL, QGRID_PROVIDER_NAME } from "./qgrid.constant";
import { assertImageInputFitsJsonTransport, bytesToBase64 } from "./utils";

function imageInputUrl(file: ImageModelV3File): string {
  if (file.type === "url") {
    if (!/^https:\/\//i.test(file.url)) {
      throw new Error("qgrid.image: reference image URLs must use HTTPS");
    }
    return file.url;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.mediaType)) {
    throw new Error("qgrid.image: reference images must be PNG, JPEG, or WebP");
  }
  const data = typeof file.data === "string" ? file.data : bytesToBase64(file.data);
  return `data:${file.mediaType};base64,${data}`;
}

export function createQgridImage(
  modelId: QgridImageModel,
  config?: QgridImageProviderConfig,
): ImageModelV3 {
  if (modelId !== "openai/gpt-image-2") {
    throw new Error(`qgrid.image: unsupported image model ${modelId}`);
  }
  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL;
  const projectName = config?.projectName ?? process.env.QGRID_PROJECT_NAME;

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    maxImagesPerCall: 1,

    async doGenerate(options) {
      if (options.mask !== undefined) {
        throw new Error("qgrid.image: masks are not supported by the subscription Images endpoint");
      }
      if (options.n !== 1) {
        throw new Error(
          "qgrid.image: only one image per call is supported; omit maxImagesPerCall so AI SDK can batch n images",
        );
      }
      if (!options.prompt?.trim()) {
        throw new Error("qgrid.image: a non-empty text prompt is required");
      }
      if ((options.files?.length ?? 0) > 5) {
        throw new Error("qgrid.image: at most five reference images are supported");
      }
      const qgridOptions = (options.providerOptions.qgrid ?? {}) as QgridImageProviderOptions;
      if (
        qgridOptions.tokenName !== undefined &&
        (typeof qgridOptions.tokenName !== "string" ||
          !/^openai\/.+/.test(qgridOptions.tokenName.trim()))
      ) {
        throw new Error(
          "qgrid.image: tokenName must be a non-empty OpenAI token name with the openai/ prefix",
        );
      }
      if (qgridOptions.logger !== undefined && typeof qgridOptions.logger !== "boolean") {
        throw new Error("qgrid.image: logger must be a boolean");
      }
      if (qgridOptions.outputFormat !== undefined && qgridOptions.outputFormat !== "png") {
        throw new Error("qgrid.image: the subscription Images endpoint supports PNG output only");
      }
      if (
        qgridOptions.quality !== undefined &&
        !["low", "medium", "high"].includes(qgridOptions.quality)
      ) {
        throw new Error("qgrid.image: quality must be low, medium, or high");
      }
      if (
        qgridOptions.background !== undefined &&
        !["auto", "opaque", "transparent"].includes(qgridOptions.background)
      ) {
        throw new Error("qgrid.image: background must be auto, opaque, or transparent");
      }
      if (options.size !== undefined && !/^[1-9]\d*x[1-9]\d*$/.test(options.size)) {
        throw new Error("qgrid.image: size must be positive integer WIDTHxHEIGHT");
      }

      const imageUrls = (options.files ?? []).map(imageInputUrl);
      assertImageInputFitsJsonTransport(imageUrls);
      const input: QgridInputPart[] = [
        { type: "text", text: options.prompt, text_elements: [] },
        ...imageUrls.map((url) => ({ type: "image" as const, url })),
      ];
      const warnings: Awaited<ReturnType<ImageModelV3["doGenerate"]>>["warnings"] = [];
      for (const feature of ["seed", "aspectRatio"] as const) {
        if (options[feature] !== undefined) {
          warnings.push({
            type: "unsupported",
            feature,
            details:
              "The subscription Images endpoint does not support this setting. Describe the desired result in the prompt.",
          });
        }
      }
      for (const feature of [
        ...(options.size !== undefined ? ["size"] : []),
        ...(qgridOptions.quality !== undefined ? ["providerOptions.qgrid.quality"] : []),
      ]) {
        warnings.push({
          type: "compatibility",
          feature,
          details:
            "This is a hint only. The subscription backend may choose a different size or quality; inspect the returned generation metadata.",
        });
      }

      const timestamp = new Date();
      const headers = new Headers();
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (value !== undefined) headers.set(key, value);
      }
      headers.set("Content-Type", "application/json");
      const response = await qgridFetch(
        `${serverUrl}/api/qgrid/query`,
        {
          method: "POST",
          headers,
          signal: options.abortSignal,
          body: JSON.stringify({
            args: {
              prompt: options.prompt,
              model: modelId,
              imageGeneration: true,
              imageGenerationOptions: {
                ...(options.size !== undefined ? { size: options.size } : {}),
                ...(qgridOptions.quality !== undefined ? { quality: qgridOptions.quality } : {}),
                ...(qgridOptions.background !== undefined
                  ? { background: qgridOptions.background }
                  : {}),
                ...(qgridOptions.outputFormat !== undefined
                  ? { outputFormat: qgridOptions.outputFormat }
                  : {}),
              },
              ...(imageUrls.length ? { input } : {}),
              ...(projectName ? { projectName } : {}),
              ...(qgridOptions.tokenName !== undefined
                ? { tokenName: qgridOptions.tokenName }
                : {}),
              ...(qgridOptions.logger === false ? { logger: false } : {}),
            },
          }),
        },
        { operation: "query", serverUrl },
      );
      if (!response.ok) {
        throw new Error(`qgrid ${response.status}: ${await response.text().catch(() => "")}`);
      }
      const data = (await response.json()) as QueryOutput;
      const images = data.content?.filter((item) => item.type === "image") ?? [];
      const image = images[0];
      if (images.length !== 1 || !image?.data || image.generation?.route !== "codex-images") {
        throw new Error(
          "qgrid.image: expected one image from the direct subscription Images route; update the qgrid server and SDK together",
        );
      }
      const usage = image.generation.usage;
      return {
        images: [image.data],
        warnings,
        response: {
          timestamp,
          modelId: image.generation.model ?? data.model,
          headers: Object.fromEntries(response.headers),
        },
        ...(usage
          ? {
              usage: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                totalTokens: usage.total_tokens,
              },
            }
          : {}),
        providerMetadata: {
          qgrid: {
            images: [
              {
                ...(data.requestLogId !== undefined ? { requestLogId: data.requestLogId } : {}),
                generation: image.generation,
                ...(image.revisedPrompt !== null && image.revisedPrompt !== undefined
                  ? { revisedPrompt: image.revisedPrompt }
                  : {}),
              },
            ],
          },
        },
      };
    },
  };
}
