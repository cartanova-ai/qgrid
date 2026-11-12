import { describe, expect, it } from "vitest";

import { bytesToBase64, encodeWav } from "./voice-audio";

describe("voice audio helpers", () => {
  it("encodes mono PCM16 WAV at 24 kHz and clips out-of-range samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2]));
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe("data");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -32768,
    ]);
  });

  it("base64-encodes byte arrays larger than one chunk", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 256);

    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (ch) => ch.charCodeAt(0));

    expect(decoded).toEqual(bytes);
  });
});
