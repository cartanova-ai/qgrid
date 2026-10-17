import { PNG } from "pngjs";
import { z } from "zod";

import { ImageGenerationMetadata } from "../../../application/qgrid/qgrid.types";
import { isJsonObject, type JsonValue, jsonString } from "../common/provider-types";
import {
  CHATGPT_CODEX_RESPONSES_URL,
  imageMimeType,
  OpenAIProtocolError,
  type OpenAINormalizedEvent,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";

const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4096 * 4096;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXT_PART_TYPES = new Set(["input_text", "output_text", "text"]);

/** Request body for the standalone Codex images endpoint; controls are forwarded only when set. */
type StandaloneImageBody = {
  model: "gpt-image-2";
  prompt: string;
  background?: JsonValue;
  quality?: JsonValue;
  size?: JsonValue;
  images?: Array<{ image_url: string }>;
};

function imageUrlOf(value: JsonValue | undefined): string | undefined {
  return jsonString(value) ?? (isJsonObject(value) ? jsonString(value.url) : undefined);
}

export function buildStandaloneImageRequest(options: OpenAIResponsesOptions) {
  if (options.outputSchema || options.tools?.length) {
    throw new OpenAIProtocolError(
      "Standalone image generation does not support tools or structured output",
    );
  }

  if (!options.imageGeneration) {
    throw new OpenAIProtocolError("Standalone images require image generation to be enabled");
  }

  const controls = options.imageGeneration === true ? {} : options.imageGeneration;

  if (options.model !== "gpt-image-2" && controls.background !== "transparent") {
    throw new OpenAIProtocolError(
      "Standalone images require an explicit transparent background request",
    );
  }

  if (controls.output_format && controls.output_format !== "png") {
    throw new OpenAIProtocolError("Standalone image generation only supports PNG output");
  }

  const text: string[] = [];
  const images: Array<{ image_url: string }> = [];

  if (options.instructions) text.push(`System instructions:\n${options.instructions}`);

  for (const item of options.history) {
    if (!isJsonObject(item)) {
      throw new OpenAIProtocolError(
        "Unsupported conversation item for standalone image generation",
      );
    }

    if (item.type === "reasoning") continue;

    const result = jsonString(item.result);

    if (item.type === "image_generation_call" && result !== undefined) {
      images.push({
        image_url: `data:${imageMimeType(result, item.output_format)};base64,${result}`,
      });
      continue;
    }

    const role = jsonString(item.role);

    if (item.type !== "message" && role === undefined) {
      throw new OpenAIProtocolError(
        "Unsupported conversation item for standalone image generation",
      );
    }

    const speaker = role ?? "user";
    const content = jsonString(item.content);

    if (content !== undefined) {
      text.push(`${speaker}:\n${content}`);
      continue;
    }

    if (!Array.isArray(item.content)) {
      throw new OpenAIProtocolError("Unsupported message content for standalone image generation");
    }

    for (const part of item.content) {
      if (!isJsonObject(part)) {
        throw new OpenAIProtocolError("Unsupported message part for standalone image generation");
      }

      const partType = jsonString(part.type);
      const partText = jsonString(part.text);

      if (partType !== undefined && TEXT_PART_TYPES.has(partType) && partText !== undefined) {
        text.push(`${speaker}:\n${partText}`);
      } else if (part.type === "input_image" || part.type === "image_url") {
        const url = imageUrlOf(part.image_url);

        if (url === undefined || !/^(https:\/\/|data:image\/)/i.test(url)) {
          throw new OpenAIProtocolError("Image references must be HTTPS URLs or image data URLs");
        }

        images.push({ image_url: url });
      } else {
        throw new OpenAIProtocolError("Unsupported message part for standalone image generation");
      }
    }
  }

  if (images.length > 5)
    throw new OpenAIProtocolError("Standalone image editing supports at most 5 reference images");

  if (!text.some((part) => part.trim())) throw new OpenAIProtocolError("Image prompt is empty");

  const body: StandaloneImageBody = { model: "gpt-image-2", prompt: text.join("\n\n") };

  if (controls.background) body.background = controls.background;

  if (controls.quality) body.quality = controls.quality;

  if (controls.size) body.size = controls.size;

  if (images.length) body.images = images;

  return {
    url: CHATGPT_CODEX_RESPONSES_URL.replace(
      /\/responses$/,
      `/images/${images.length ? "edits" : "generations"}`,
    ),
    body,
  };
}

interface PngDimensions {
  width: number;
  height: number;
}

function inspectGeneratedPng(base64: string, requireTransparency: boolean): PngDimensions {
  if (base64.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new OpenAIProtocolError("Invalid or oversized generated PNG");
  }

  const bytes = Buffer.from(base64, "base64");

  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new OpenAIProtocolError("Image generation did not return a PNG");
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);

  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new OpenAIProtocolError("Generated PNG dimensions exceed the decoding limit");
  }

  let image: PNG;

  try {
    image = PNG.sync.read(bytes);
  } catch {
    throw new OpenAIProtocolError("Image generation returned an invalid PNG");
  }

  if (!requireTransparency) return { width: image.width, height: image.height };
  // An alpha channel alone can still be fully opaque or have no visible content.
  let transparent = false;
  let visible = false;

  for (let i = 3; i < image.data.length; i += 4) {
    transparent ||= image.data[i] === 0;
    visible ||= image.data[i]! > 0;

    if (transparent && visible) return { width: image.width, height: image.height };
  }

  throw new OpenAIProtocolError(
    "Image generation did not return visible content on a transparent background",
  );
}

export async function readStandaloneImageResponse(
  response: Response,
  requireTransparency: boolean,
): Promise<OpenAINormalizedEvent[]> {
  if (!response.body) throw new OpenAIProtocolError("Image response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenAIProtocolError("Image response exceeded the size limit");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const schema = z.object({
    data: z
      .array(z.object({ b64_json: z.string().min(1), revised_prompt: z.string().nullish() }))
      .min(1)
      .max(16),
    quality: z.string().optional(),
    model: z.string().optional(),
    background: z.string().optional(),
    usage: ImageGenerationMetadata.shape.usage,
  });

  let parsed: z.infer<typeof schema>;

  try {
    parsed = schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new OpenAIProtocolError("Invalid standalone image response");
  }

  const background = parsed.background ?? (requireTransparency ? "transparent" : undefined);

  return parsed.data.map((item, index) => {
    const dimensions = inspectGeneratedPng(item.b64_json, requireTransparency);

    const generation: ImageGenerationMetadata = {
      route: "codex-images",
      model: parsed.model ?? "gpt-image-2",
      size: `${dimensions.width}x${dimensions.height}`,
    };

    if (background) generation.background = background;

    if (parsed.quality) generation.quality = parsed.quality;

    if (index === 0 && parsed.usage) generation.usage = parsed.usage;

    const event: OpenAINormalizedEvent = {
      type: "image",
      base64: item.b64_json,
      mimeType: "image/png",
      generation,
    };

    if (item.revised_prompt) event.revisedPrompt = item.revised_prompt;

    return event;
  });
}
