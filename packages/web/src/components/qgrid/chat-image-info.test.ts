import { describe, expect, it } from "vitest";

import { chatImageInfo, formatImageBytes } from "./chat-image-info";

describe("chat image metadata", () => {
  it.each([["YQ==", 1], ["YWI=", 2], ["YWJj", 3]])("measures decoded bytes for %s", (data, bytes) => {
    expect(chatImageInfo(`data:image/png;base64,${data}`)).toEqual({ extension: "png", bytes });
  });
  it("reports JPEG and WebP extensions", () => {
    expect(chatImageInfo("data:image/jpeg;base64,YQ==")).toEqual({ extension: "jpg", bytes: 1 });
    expect(chatImageInfo("data:image/webp;base64,YQ==")).toEqual({ extension: "webp", bytes: 1 });
  });
  it("formats file sizes without counting the data URL header", () => {
    expect(formatImageBytes(512)).toBe("512 B");
    expect(formatImageBytes(1536)).toBe("1.5 KB");
    expect(formatImageBytes(1572864)).toBe("1.50 MB");
  });
});
