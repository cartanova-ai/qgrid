import { describe, expect, it } from "vitest";

import { buildChatHistory, chatGeneratedImages } from "./chat-image-generation";

describe("qgrid_chat image history", () => {
  it("preserves uploaded and generated images in follow-up history", () => {
    const messages = [
      { role: "user" as const, text: "Change hair", images: ["uploaded"] },
      { role: "assistant" as const, text: "", images: ["generated"] },
    ];
    const history = buildChatHistory(messages, true);
    expect(history).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "Change hair" }, { type: "input_image", image_url: "uploaded" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: expect.stringContaining("Previously generated") }, { type: "input_image", image_url: "generated" }] },
    ]);
    expect(JSON.stringify(buildChatHistory(messages, false))).not.toContain("input_image");
  });

  it("renders all returned images with their MIME types and legacy PNG fallback", () => {
    expect(chatGeneratedImages([
      { type: "text", text: "done" },
      { type: "image", data: "png" },
      { type: "image", data: "jpeg", mediaType: "image/jpeg" },
      { type: "image", data: "webp", mediaType: "image/webp" },
    ])).toEqual([
      "data:image/png;base64,png",
      "data:image/jpeg;base64,jpeg",
      "data:image/webp;base64,webp",
    ]);
  });
});
