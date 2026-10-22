// README "Using Grok" examples. `tsc --noEmit` typechecks them against the installed `ai`, vitest
// runs them against a fake qgrid server, and the last test keeps README.md / README.ko.md in sync.
import { readFile as readTextFile } from "node:fs/promises";

import {
  generateSpeech,
  experimental_generateVideo as generateVideo,
  transcribe,
  generateImage,
  generateText,
} from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { qgrid, QgridVideoTimeoutError, resumeQgridVideo } from "./index";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64");
const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
// AI SDK 7 downloads video URLs through its DNS-pinned transport, not global fetch, and refuses
// *.localhost before any lookup. The example therefore stops at AI SDK's own download, offline.
const VIDEO_URL = "https://vidgen.localhost/bucket/video.mp4";
const seen: string[] = [];

function fakeServer(url: string, init: RequestInit): Response {
  const endpoint = url.slice(url.lastIndexOf("/") + 1);
  seen.push(endpoint);
  if (url === VIDEO_URL) {
    return new Response(new Uint8Array([0, 0, 0, 0x18]), { headers: { "content-type": "video/mp4" } });
  }
  const params = JSON.parse(String(init.body)).params as Record<string, unknown> | undefined;
  switch (endpoint) {
    case "generateImages":
      return Response.json({
        model: params?.model,
        tokenName: "grok/main",
        images: Array.from({ length: Number(params?.n) }, () => ({ b64: jpeg, mimeType: "image/jpeg" })),
        usage: { imageCount: Number(params?.n), costInUsdTicks: 1 },
      });
    case "videoStart":
      return Response.json({ jobHandle: "AAAAAAAAAAAAAAAAAAAAAA", model: params?.model });
    case "videoStatus":
      return Response.json({ status: "done", url: VIDEO_URL, mimeType: "video/mp4" });
    case "transcribe":
      return Response.json({ text: "hi", durationSec: 1, model: "grok/grok-voice-transcribe-2.0", tokenName: "grok/main" });
    case "speak":
      return Response.json({ audio: Buffer.from(mp3).toString("base64"), mimeType: "audio/mpeg", tokenName: "grok/main" });
    case "query":
      return Response.json({
        text: "summary",
        model: "grok/grok-4.7",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        durationMs: 1,
        costUsd: 0,
        costSource: "provider",
        providerMetadata: { xai: { costInUsdTicks: 10 } },
      });
    default:
      return new Response("not found", { status: 404 });
  }
}

// The README reads a local file; the example gets fixed bytes instead.
const readFile = async (_path: string) => mp3;

beforeEach(() => {
  seen.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => fakeServer(String(url), init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function grokTextExample() {
  const { text, providerMetadata } = await generateText({
    model: qgrid("grok/grok-4.7"),
    prompt: "Summarize this release note",
    providerOptions: { xai: { reasoningEffort: "high", promptCacheKey: "session-42" } },
  });
  providerMetadata?.xai?.costInUsdTicks; // 1 tick = 1e-10 USD
  return { text, providerMetadata };
}

async function grokImageExample() {
  const { images, providerMetadata } = await generateImage({
    model: qgrid.image("grok/grok-imagine-image"),
    prompt: "A lighthouse at dusk, oil painting",
    n: 2,
    aspectRatio: "16:9",
    providerOptions: { xai: { resolution: "2k", quality: "high", output_format: "jpeg" } },
  });
  images[0].mediaType; // "image/jpeg"
  providerMetadata.xai?.images[0]; // revisedPrompt and the call's costInUsdTicks
  providerMetadata.qgrid?.images[0]; // mediaType, tokenName, requestLogId, costUsd
  return { images, providerMetadata };
}

async function grokVideoExample() {
  try {
    const { video, providerMetadata } = await generateVideo({
      model: qgrid.video("grok/grok-imagine-video-1.5", { projectName: "studio" }),
      prompt: "A paper boat drifting down a rain gutter",
      duration: 6,
      aspectRatio: "16:9",
      providerOptions: { xai: { resolution: "720p" } },
    });
    providerMetadata.xai?.videoUrl; // the api.x.ai URL
    video.uint8Array; // downloaded by AI SDK in this process, not by qgrid
    return { video, providerMetadata };
  } catch (error) {
    if (error instanceof QgridVideoTimeoutError) {
      const { videos } = await resumeQgridVideo(error.jobHandle, { projectName: "studio" });
      videos[0]; // { type: "url", url, mediaType: "video/mp4" }
    } else {
      throw error;
    }
  }
  return undefined;
}

async function grokVoiceExample() {
  const transcript = await transcribe({
    model: qgrid.transcription("grok/grok-voice-transcribe-2.0"),
    audio: await readFile("meeting.mp3"),
    providerOptions: { xai: { language: "en" } },
  });
  transcript.text;
  transcript.durationInSeconds;

  const speech = await generateSpeech({
    model: qgrid.speech("grok/grok-tts"),
    text: "Your build is ready.",
    voice: "ara",
    language: "en",
    outputFormat: "mp3",
  });
  speech.audio.uint8Array;
  return { transcript, speech };
}

describe("README Grok examples", () => {
  it("runs the text example", async () => {
    const { text, providerMetadata } = await grokTextExample();
    expect(text).toBe("summary");
    expect(providerMetadata?.xai?.costInUsdTicks).toBe(10);
  });

  it("runs the image example", async () => {
    const { images } = await grokImageExample();
    expect(images).toHaveLength(2);
    expect(images[0]!.mediaType).toBe("image/jpeg");
  });

  it("runs the video example and downloads the upstream URL outside qgrid", async () => {
    await expect(grokVideoExample()).rejects.toMatchObject({
      name: "AI_DownloadError",
      url: VIDEO_URL,
    });
    expect(seen).toEqual(["videoStart", "videoStatus"]);
  });

  it("runs the transcription and speech example", async () => {
    const { transcript, speech } = await grokVoiceExample();
    expect(transcript.text).toBe("hi");
    expect(speech.audio.uint8Array).toEqual(mp3);
  });

  it.each(["README.md", "README.ko.md"])("%s Grok code blocks match these examples", async (file) => {
    const readme = await readTextFile(new URL(`../${file}`, import.meta.url), "utf8");
    const self = await readTextFile(new URL(import.meta.url), "utf8");
    const start = readme.indexOf(file === "README.md" ? "## Using Grok" : "## Grok 사용");
    const section = readme.slice(start, readme.indexOf("## Telemetry Logger", start));
    const blocks = [...section.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks).toHaveLength(4);
    // Comments differ between languages and the examples add `return` lines; compare the code.
    const normalize = (s: string) =>
      s.split("\n").map((l) => l.replace(/\s*\/\/.*$/, "").trim()).filter(Boolean);
    const source = normalize(self).filter((l) => !l.startsWith("return ")).join("\n");
    for (const block of blocks) {
      const body = normalize(block).filter((l) => !/^(import\b|} from |[A-Za-z_]+,$|experimental_)/.test(l));
      expect(source).toContain(body.join("\n"));
    }
  });
});
