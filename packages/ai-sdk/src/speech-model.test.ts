import { experimental_generateSpeech as generateSpeech } from "ai";
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
    expect(result.warnings.map((w) => (w.type === "other" ? w.message : w.feature))).toEqual([
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

describe("qgrid.speech with openai/ models", () => {
  it("maps voice, instructions and outputFormat; warns like @ai-sdk/openai for language and speed", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    const wav = Buffer.from("RIFF0000WAVEfmt ");
    const fetchMock = vi.fn(async () =>
      Response.json({ audio: wav.toString("base64"), mimeType: "audio/wav", tokenName: "openai/main" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateSpeech({
      model: qgrid.speech("openai/gpt-realtime-2.1-mini"),
      text: "Hello",
      voice: "cedar",
      language: "en",
      speed: 1.2,
      outputFormat: "mp3",
      providerOptions: { openai: { instructions: "warm", speed: 1.5 } },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://qgrid.example/api/qgrid/speak");
    expect(JSON.parse(String(init.body))).toEqual({
      params: {
        model: "openai/gpt-realtime-2.1-mini",
        text: "Hello",
        voice: "cedar",
        format: "wav",
        instructions: "warm",
      },
    });
    expect(result.audio.uint8Array).toEqual(new Uint8Array(wav));
    expect(result.warnings).toEqual([
      expect.objectContaining({ feature: "outputFormat", details: expect.stringContaining("Using wav instead") }),
      expect.objectContaining({ feature: "language", details: expect.stringContaining("do not support language selection") }),
      expect.objectContaining({ feature: "speed" }),
      expect.objectContaining({ feature: "providerOptions.openai.speed" }),
    ]);
  });

  it("prefers the top-level instructions over openai.instructions and passes pcm through", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    const fetchMock = vi.fn(async () =>
      Response.json({ audio: Buffer.from([0, 0]).toString("base64"), mimeType: "audio/pcm;rate=24000", tokenName: "openai/main" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateSpeech({
      model: qgrid.speech("openai/gpt-realtime-2.1-mini"),
      text: "Hello",
      instructions: "calm",
      outputFormat: "pcm",
      providerOptions: { openai: { instructions: "ignored" } },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).params).toMatchObject({ format: "pcm", instructions: "calm" });
    expect(result.warnings).toEqual([]);
    expect(result.providerMetadata.qgrid).toMatchObject({ mediaType: "audio/pcm;rate=24000" });
  });
});
