import { describe, expect, it, vi } from "vitest";

import { extractPromptAndHistory, parseSSE } from "./utils";

it.each(["done", "error", "eof"])("releases the SSE reader after %s", async (terminal) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event: ${terminal}\ndata: {}\n\n`));
      if (terminal === "eof") controller.close();
    },
    cancel,
  });
  for await (const event of parseSSE(body)) {
    expect(event.type).toBe(terminal);
    if (terminal !== "eof") break;
  }
  expect(body.locked).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(terminal === "eof" ? 0 : 1);
});

describe("image generation conversation history", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Draw a circle." }] },
    { role: "assistant", content: [{ type: "file", mediaType: "image/png", data: "aW1hZ2U=" }] },
    { role: "user", content: [{ type: "text", text: "Make that circle blue." }] },
  ] as const;

  it("preserves the generated image when editing the previous assistant result", () => {
    const result = extractPromptAndHistory(structuredClone(messages) as never, { includeImages: true });
    expect(result.imageUrls).toEqual(["data:image/png;base64,aW1hZ2U="]);
    expect(result.history).toContainEqual({
      type: "message", role: "assistant",
      content: [{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }],
    });
  });

  it("keeps assistant images off ordinary text requests", () => {
    const result = extractPromptAndHistory(structuredClone(messages) as never, { includeImages: false });
    expect(result.imageUrls).toEqual([]);
    expect(result.droppedImageCount).toBe(1);
    expect(result.history).toHaveLength(1);
  });
});
