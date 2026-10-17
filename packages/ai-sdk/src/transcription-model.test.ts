import { experimental_transcribe as transcribe } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid } from "./index";

const output = {
  text: "hello world",
  language: "en",
  durationSec: 1.5,
  model: "grok/grok-voice-transcribe-2.0",
  tokenName: "grok/main",
  requestLogId: 5,
};

function mockTranscribe() {
  const fetchMock = vi.fn(async () => Response.json(output, { headers: { "x-request-id": "t" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// MPEG frame header so AI SDK detects audio/mpeg.
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);

describe("qgrid.transcription with AI SDK transcribe", () => {
  it("sends base64 audio with mediaType and maps the transcript", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    vi.stubEnv("QGRID_PROJECT_NAME", "voice");
    const fetchMock = mockTranscribe();
    const result = await transcribe({
      model: qgrid.transcription("grok/grok-voice-transcribe-2.0"),
      audio: mp3,
      providerOptions: { xai: { language: "en", diarize: true }, qgrid: { logger: false } },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://qgrid.example/api/qgrid/transcribe");
    expect(JSON.parse(String(init.body))).toEqual({
      params: {
        model: "grok/grok-voice-transcribe-2.0",
        audio: Buffer.from(mp3).toString("base64"),
        mediaType: "audio/mpeg",
        language: "en",
        projectName: "voice",
        logger: false,
      },
    });
    expect(result.text).toBe("hello world");
    expect(result.segments).toEqual([]);
    expect(result.language).toBe("en");
    expect(result.durationInSeconds).toBe(1.5);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: "unsupported", feature: "providerOptions.xai.diarize" }),
    ]);
    expect(result.providerMetadata.qgrid).toEqual({ tokenName: "grok/main", requestLogId: 5 });
  });

  it("passes base64 strings through and strips media type parameters", async () => {
    const fetchMock = mockTranscribe();
    const model = qgrid.transcription("grok/grok-voice-transcribe-2.0");
    await model.doGenerate({ audio: "AAAA", mediaType: "audio/webm;codecs=opus" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).params).toMatchObject({ audio: "AAAA", mediaType: "audio/webm" });
  });

  it("rejects oversized audio and non-audio media types before transport", async () => {
    const fetchMock = mockTranscribe();
    const model = qgrid.transcription("grok/grok-voice-transcribe-2.0");
    await expect(model.doGenerate({ audio: new Uint8Array(8 * 1024 * 1024), mediaType: "audio/wav" }))
      .rejects.toThrow("above the qgrid server limit of 7.00 MiB");
    await expect(model.doGenerate({ audio: mp3, mediaType: "video/mp4" })).rejects.toThrow("mediaType must be audio/*");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts audio at exactly the 7 MiB inline limit", async () => {
    const fetchMock = mockTranscribe();
    const model = qgrid.transcription("grok/grok-voice-transcribe-2.0");
    await model.doGenerate({ audio: new Uint8Array(7 * 1024 * 1024), mediaType: "audio/wav" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("qgrid.transcription with openai/ models", () => {
  it("sends openai.language and openai.prompt, warns for the other @ai-sdk/openai keys", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    const fetchMock = vi.fn(async () =>
      Response.json({
        text: "Hello from qgrid.",
        language: "en",
        durationSec: 2.5,
        model: "openai/gpt-transcribe",
        tokenName: "openai/main",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await transcribe({
      model: qgrid.transcription("openai/gpt-transcribe"),
      audio: mp3,
      providerOptions: {
        openai: {
          language: "en",
          prompt: "qgrid",
          temperature: 0.2,
          timestampGranularities: ["word"],
          responseFormat: "verbose_json",
        },
        qgrid: { tokenName: "openai/main" },
      },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      params: {
        model: "openai/gpt-transcribe",
        audio: Buffer.from(mp3).toString("base64"),
        mediaType: "audio/mpeg",
        language: "en",
        prompt: "qgrid",
        tokenName: "openai/main",
      },
    });
    expect(result.text).toBe("Hello from qgrid.");
    expect(result.durationInSeconds).toBe(2.5);
    expect(result.warnings.map((warning) => "feature" in warning && warning.feature)).toEqual([
      "providerOptions.openai.temperature",
      "providerOptions.openai.timestampGranularities",
      "providerOptions.openai.responseFormat",
    ]);
  });

  it("rejects a grok/ tokenName for an openai/ model and malformed openai options", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      transcribe({
        model: qgrid.transcription("openai/gpt-4o-transcribe"),
        audio: mp3,
        providerOptions: { qgrid: { tokenName: "grok/main" } },
      }),
    ).rejects.toThrow(/openai\/ prefix/);
    await expect(
      transcribe({
        model: qgrid.transcription("openai/gpt-4o-transcribe"),
        audio: mp3,
        providerOptions: { openai: { temperature: 7 } },
      }),
    ).rejects.toThrow(/invalid providerOptions.openai/);
  });

  it("rejects ids that are neither grok/ nor openai/ at creation", () => {
    expect(() => qgrid.transcription("anthropic/x" as never)).toThrow(/expected grok\/<id> or openai\/<id>/);
  });
});
