import { generateSpeech } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid } from "./index";

// MPEG frame header so AI SDK detects audio/mpeg.
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);

function mockSpeak() {
  const fetchMock = vi.fn(async () =>
    Response.json({ audio: mp3.toString("base64"), mimeType: "audio/mpeg", tokenName: "grok/main", requestLogId: 3 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("qgrid.speech with AI SDK generateSpeech", () => {
  it("maps voice, language and outputFormat to the speak body and returns audio bytes", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    const fetchMock = mockSpeak();
    const result = await generateSpeech({
      model: qgrid.speech("grok/grok-tts", { projectName: "voice" }),
      text: "Hello",
      voice: "ara",
      language: "en",
      outputFormat: "mp3",
      providerOptions: { qgrid: { tokenName: "grok/main" } },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://qgrid.example/api/qgrid/speak");
    expect(JSON.parse(String(init.body))).toEqual({
      params: {
        model: "grok/grok-tts",
        text: "Hello",
        voice: "ara",
        language: "en",
        format: "mp3",
        projectName: "voice",
        tokenName: "grok/main",
      },
    });
    expect(Buffer.from(result.audio.uint8Array)).toEqual(mp3);
    expect(result.audio.mediaType).toBe("audio/mpeg");
    expect(result.warnings).toEqual([]);
    expect(result.providerMetadata.qgrid).toEqual({ mediaType: "audio/mpeg", tokenName: "grok/main", requestLogId: 3 });
  });

  it("omits unset fields so server defaults apply, and warns on unsupported settings", async () => {
    const fetchMock = mockSpeak();
    const result = await generateSpeech({
      model: qgrid.speech("grok/grok-tts"),
      text: "Hello",
      outputFormat: "flac",
      speed: 1.2,
      instructions: "calm",
      providerOptions: { xai: { sampleRate: 24000 } },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).params).toEqual({ model: "grok/grok-tts", text: "Hello", format: "mp3" });
    expect(result.warnings.map((w) => ("feature" in w ? w.feature : w.message))).toEqual([
      "outputFormat",
      "instructions",
      "speed",
      "providerOptions.xai.sampleRate",
    ]);
  });

  it("rejects over-long text before transport", async () => {
    const fetchMock = mockSpeak();
    await expect(generateSpeech({ model: qgrid.speech("grok/grok-tts"), text: "a".repeat(15_001), maxRetries: 0 }))
      .rejects.toThrow("limited to 15000 characters");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
