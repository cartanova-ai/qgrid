import { PNG } from "pngjs";
import { z } from "zod";

import { ImageGenerationMetadata } from "../../../application/qgrid/qgrid.types";
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

export function buildStandaloneImageRequest(options: OpenAIResponsesOptions) {
  if (options.outputSchema || options.tools?.length) {
    throw new OpenAIProtocolError(
      "Transparent image generation does not support tools or structured output",
    );
  }
  const controls = options.imageGeneration;
  if (!controls || controls === true || controls.background !== "transparent") {
    throw new OpenAIProtocolError(
      "Standalone images require an explicit transparent background request",
    );
  }
  if (controls.output_format && controls.output_format !== "png") {
    throw new OpenAIProtocolError("Transparent image generation only supports PNG output");
  }
  const text: string[] = [];
  const images: Array<{ image_url: string }> = [];
  if (options.instructions) text.push(`System instructions:\n${options.instructions}`);
  for (const item of options.history) {
    if (item.type === "reasoning") continue;
    if (item.type === "image_generation_call" && typeof item.result === "string") {
      images.push({
        image_url: `data:${imageMimeType(item.result, item.output_format)};base64,${item.result}`,
      });
      continue;
    }
    if (item.type !== "message" && typeof item.role !== "string") {
      throw new OpenAIProtocolError(
        "Unsupported conversation item for transparent image generation",
      );
    }
    if (typeof item.content === "string") {
      text.push(`${item.role ?? "user"}:\n${item.content}`);
      continue;
    }
    if (!Array.isArray(item.content)) {
      throw new OpenAIProtocolError("Unsupported message content for transparent image generation");
    }
    for (const part of item.content) {
      if (!part || typeof part !== "object") {
        throw new OpenAIProtocolError("Unsupported message part for transparent image generation");
      }
      if (
        ["input_text", "output_text", "text"].includes(part.type) &&
        typeof part.text === "string"
      ) {
        text.push(`${item.role ?? "user"}:\n${part.text}`);
      } else if (part.type === "input_image" || part.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url !== "string" || !/^(https:\/\/|data:image\/)/i.test(url)) {
          throw new OpenAIProtocolError("Image references must be HTTPS URLs or image data URLs");
        }
        images.push({ image_url: url });
      } else {
        throw new OpenAIProtocolError("Unsupported message part for transparent image generation");
      }
    }
  }
  if (images.length > 5)
    throw new OpenAIProtocolError("Transparent image editing supports at most 5 reference images");
  if (!text.some((part) => part.trim())) throw new OpenAIProtocolError("Image prompt is empty");
  return {
    url: CHATGPT_CODEX_RESPONSES_URL.replace(
      /\/responses$/,
      `/images/${images.length ? "edits" : "generations"}`,
    ),
    body: {
      model: "gpt-image-2",
      prompt: text.join("\n\n"),
      background: "transparent",
      ...(controls.quality ? { quality: controls.quality } : {}),
      ...(controls.size ? { size: controls.size } : {}),
      ...(images.length ? { images } : {}),
    },
  };
}

// Decode before accepting the result: an alpha channel alone can still be fully opaque.
export function inspectTransparentPng(base64: string): { width: number; height: number } {
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
    usage: ImageGenerationMetadata.shape.usage,
  });
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new OpenAIProtocolError("Invalid standalone image response");
  }
  return parsed.data.map((item, index) => {
    const dimensions = inspectTransparentPng(item.b64_json);
    return {
      type: "image",
      base64: item.b64_json,
      mimeType: "image/png",
      ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
      generation: {
        route: "codex-images",
        model: "gpt-image-2",
        background: "transparent",
        size: `${dimensions.width}x${dimensions.height}`,
        ...(parsed.quality ? { quality: parsed.quality } : {}),
        ...(index === 0 && parsed.usage ? { usage: parsed.usage } : {}),
      },
    };
  });
}
