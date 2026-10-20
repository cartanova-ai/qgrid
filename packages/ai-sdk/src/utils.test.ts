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

describe("language-model conversation history", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Draw a circle." }] },
    { role: "assistant", content: [{ type: "file", mediaType: "image/png", data: "aW1hZ2U=" }] },
    { role: "user", content: [{ type: "text", text: "Make that circle blue." }] },
  ] as const;

  it("keeps assistant images off ordinary text requests", () => {
    const result = extractPromptAndHistory(structuredClone(messages) as never);
    expect(result.droppedImageCount).toBe(1);
    expect(result.history).toHaveLength(1);
  });

  it("keeps assistant images dropped even when user images are included", () => {
    const result = extractPromptAndHistory(structuredClone(messages) as never, {
      includeImages: true,
    });
    expect(result.droppedImageCount).toBe(1);
    expect(result.imageUrls).toEqual([]);
  });
});
