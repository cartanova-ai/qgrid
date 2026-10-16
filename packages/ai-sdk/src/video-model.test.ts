import { experimental_generateVideo as generateVideo } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid, QgridVideoTimeoutError, resumeQgridVideo } from "./index";

const JOB = "AAAAAAAAAAAAAAAAAAAAAA";
const VIDEO_URL = "https://vidgen.x.ai/xai-vidgen-bucket/abc/video.mp4";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";

type Call = { url: string; params: Record<string, unknown>; signal: AbortSignal | null | undefined };

function mockServer(statuses: Array<Record<string, unknown> | Response>) {
  const calls: Call[] = [];
  let poll = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const params = JSON.parse(String(init.body)).params as Record<string, unknown>;
    calls.push({ url, params, signal: init.signal });
    if (url.endsWith("/videoStart")) {
      return Response.json({ jobHandle: JOB, model: "grok/grok-imagine-video-1.5", requestLogId: 77 });
    }
    const next = statuses[Math.min(poll++, statuses.length - 1)]!;
    return next instanceof Response ? next : Response.json(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const pending = { status: "pending", mimeType: "video/mp4", requestLogId: 77 };
const done = {
  status: "done",
  url: VIDEO_URL,
  mimeType: "video/mp4",
  durationSec: 6,
  costInUsdTicks: 2_500_000_000,
  costUsd: 0.25,
  requestLogId: 77,
};

// experimental_generateVideo downloads URL results; a stub keeps the test off the network.
const download = vi.fn(async () => ({ data: new Uint8Array([0, 0, 0, 0x18]), mediaType: "video/mp4" }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  download.mockClear();
});

describe("qgrid.video with AI SDK experimental_generateVideo", () => {
  it("starts, polls with the same projectName, and returns the upstream URL", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    const { calls } = mockServer([pending, pending, done]);
    const result = await generateVideo({
      model: qgrid.video("grok/grok-imagine-video-1.5", { projectName: "studio" }),
      prompt: { image: `data:image/png;base64,${png}`, text: "A cat walks" },
      duration: 6,
      aspectRatio: "16:9",
      resolution: "1280x720",
      providerOptions: {
        xai: {
          pollIntervalMs: 1,
          lastFrame: "https://example.com/last.png",
          referenceImageUrls: ["https://example.com/ref.png"],
          mode: "reference-to-video",
        },
        qgrid: { tokenName: "grok/main" },
      },
      download,
    });

    expect(calls.map((c) => c.url)).toEqual([
      "https://qgrid.example/api/qgrid/videoStart",
      "https://qgrid.example/api/qgrid/videoStatus",
      "https://qgrid.example/api/qgrid/videoStatus",
      "https://qgrid.example/api/qgrid/videoStatus",
    ]);
    expect(calls[0]!.params).toEqual({
      model: "grok/grok-imagine-video-1.5",
      prompt: "A cat walks",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
      image: `data:image/png;base64,${png}`,
      lastFrame: "https://example.com/last.png",
      referenceImages: ["https://example.com/ref.png"],
      mode: "reference-to-video",
      projectName: "studio",
      tokenName: "grok/main",
    });
    for (const call of calls.slice(1)) {
      expect(call.params).toEqual({ jobHandle: JOB, projectName: "studio" });
    }
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ url: new URL(VIDEO_URL) }));
    expect(result.video.mediaType).toBe("video/mp4");
    expect(result.providerMetadata.xai).toEqual({
      videoUrl: VIDEO_URL,
      duration: 6,
      costInUsdTicks: 2_500_000_000,
    });
    expect(result.providerMetadata.qgrid).toEqual({ jobHandle: JOB, requestLogId: 77, costUsd: 0.25 });
  });

  it("returns the @ai-sdk/xai video shape from doGenerate", async () => {
    mockServer([done]);
    const model = qgrid.video("grok/grok-imagine-video");
    const result = await model.doGenerate({
      prompt: "A cat",
      n: 1,
      aspectRatio: undefined,
      resolution: undefined,
      duration: undefined,
      fps: 24,
      seed: undefined,
      image: undefined,
      providerOptions: { xai: { lastFrame: "https://example.com/last.png", keyframes: [] } },
    });
    expect(result.videos).toEqual([{ type: "url", url: VIDEO_URL, mediaType: "video/mp4" }]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ feature: "providerOptions.xai.keyframes" }),
      expect.objectContaining({ feature: "fps" }),
      expect.objectContaining({ feature: "providerOptions.xai.lastFrame" }),
    ]);
  });

  it("aborts polling through the call's abortSignal", async () => {
    const { calls } = mockServer([pending]);
    const controller = new AbortController();
    const promise = generateVideo({
      model: qgrid.video("grok/grok-imagine-video-1.5"),
      prompt: "A cat",
      providerOptions: { xai: { pollIntervalMs: 50 } },
      abortSignal: controller.signal,
      maxRetries: 0,
      download,
    });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    controller.abort(new Error("user cancelled"));
    await expect(promise).rejects.toThrow("user cancelled");
    const polls = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls.length).toBe(polls);
    // Polls run on a signal linked to the caller's (plus the poll deadline).
    expect(calls[1]!.signal?.aborted).toBe(true);
    expect(calls[1]!.signal?.reason).toEqual(new Error("user cancelled"));
  });

  it("aborts a hung status request at the poll deadline with QgridVideoTimeoutError", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal!;
            signals.push(signal);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    );
    const startedAt = Date.now();
    const error = await resumeQgridVideo(JOB, { pollIntervalMs: 1, pollTimeoutMs: 50 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QgridVideoTimeoutError);
    expect((error as QgridVideoTimeoutError).jobHandle).toBe(JOB);
    expect(Date.now() - startedAt).toBeLessThan(50 + 250);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("aborts a status body stalled past the poll deadline with QgridVideoTimeoutError", async () => {
    // 200 headers arrive, then the body never completes; fetch errors the body with the abort reason.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal!;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":'));
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const error = await resumeQgridVideo(JOB, { pollIntervalMs: 1, pollTimeoutMs: 50 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QgridVideoTimeoutError);
    expect((error as QgridVideoTimeoutError).jobHandle).toBe(JOB);
  });

  it("times out with the job handle and resumes it by handle", async () => {
    mockServer([pending]);
    const error = await generateVideo({
      model: qgrid.video("grok/grok-imagine-video-1.5", { projectName: "studio" }),
      prompt: "A cat",
      providerOptions: { xai: { pollIntervalMs: 5, pollTimeoutMs: 30 } },
      maxRetries: 0,
      download,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QgridVideoTimeoutError);
    expect((error as QgridVideoTimeoutError).jobHandle).toBe(JOB);

    const { calls } = mockServer([pending, done]);
    const resumed = await resumeQgridVideo(JOB, {
      serverUrl: "https://resume.example",
      projectName: "studio",
      pollIntervalMs: 1,
    });
    expect(calls.map((c) => c.params)).toEqual([
      { jobHandle: JOB, projectName: "studio" },
      { jobHandle: JOB, projectName: "studio" },
    ]);
    expect(calls[0]!.url).toBe("https://resume.example/api/qgrid/videoStatus");
    expect(resumed.videos).toEqual([{ type: "url", url: VIDEO_URL, mediaType: "video/mp4" }]);
  });

  it("tolerates transient poll failures but fails on terminal errors", async () => {
    mockServer([new Response("bad gateway", { status: 502 }), done]);
    const ok = await resumeQgridVideo(JOB, { pollIntervalMs: 1 });
    expect(ok.videos).toHaveLength(1);

    mockServer([new Response("video job not found", { status: 404 })]);
    await expect(resumeQgridVideo(JOB, { pollIntervalMs: 1 })).rejects.toThrow("qgrid videoStatus 404");

    mockServer([{ status: "failed", mimeType: "video/mp4", error: "content policy" }]);
    await expect(resumeQgridVideo(JOB, { pollIntervalMs: 1 })).rejects.toThrow(
      "video generation failed: content policy",
    );
  });

  it.each([
    [{ duration: 20 }, "duration must be an integer from 1 to 15"],
    [{ providerOptions: { xai: { mode: "edit-video", videoUrl: "https://x/v.mp4" } } }, "not supported by qgrid"],
    [{ providerOptions: { xai: { mode: "reference-to-video" } } }, "needs providerOptions.xai.referenceImageUrls"],
    [{ providerOptions: { xai: { referenceImageUrls: Array(6).fill("https://e/r.png") } } }, "at most 5"],
    [{ providerOptions: { xai: { referenceImageUrls: ["http://e/r.png"] } } }, "https URLs or PNG/JPEG/WebP data URLs"],
    [{ providerOptions: { xai: { resolution: "4k" } } }, "invalid providerOptions.xai"],
    [
      {
        prompt: { image: new Uint8Array(4 * 1024 * 1024).fill(1), text: "A cat" },
        providerOptions: { xai: { lastFrame: `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024).toString("base64")}` } },
      },
      "above the qgrid server limit of 7.00 MiB",
    ],
  ])("rejects %j before transport", async (extra, message) => {
    const { fetchMock } = mockServer([done]);
    await expect(generateVideo({
      model: qgrid.video("grok/grok-imagine-video-1.5"),
      prompt: "A cat",
      maxRetries: 0,
      download,
      ...extra,
    })).rejects.toThrow(String(message));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
