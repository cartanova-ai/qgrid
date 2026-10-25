import { describe, expect, it } from "vitest";

import { GrokProtocolError } from "./grok-backend-protocol";
import { GROK_BUILD_VERSION } from "./grok-constants";
import { GrokHttpError } from "./grok-direct-client";
import { GrokInvalidRequestError } from "./grok-dispatcher";
import {
  decodeGrokImages,
  GrokContentPolicyError,
  GrokMediaClient,
  GrokMediaDeliveryError,
  GrokMediaTimeoutError,
  summarizeGrokVideoStatus,
} from "./grok-media-client";

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeFetch(respond: (sent: Sent, init: RequestInit | undefined) => Promise<Response>) {
  const calls: Sent[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const sent: Sent = {
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    };
    calls.push(sent);
    return respond(sent, init);
  };
  return { impl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

function codedError(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

const imageResponse = {
  data: [{ b64_json: JPEG.toString("base64"), mime_type: "image/jpeg" }],
  usage: { cost_in_usd_ticks: 500_000_000 },
};

const AUTH = { bearer: "jwt", sessionId: "sess-1" };

describe("GrokMediaClient images", () => {
  it("sends the U0-verified generation body with the media fingerprint", async () => {
    const { impl, calls } = fakeFetch(async () => json(imageResponse));
    const client = new GrokMediaClient({ fetch: impl });
    const result = await client.generateImages(AUTH, {
      model: "",
      prompt: "red square",
      aspectRatio: "1:1",
    });
    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent?.url).toBe("https://api.x.ai/v1/images/generations");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers).toEqual({
      "content-type": "application/json",
      "user-agent": `xai-grok-build/${GROK_BUILD_VERSION}`,
      authorization: "Bearer jwt",
      "x-grok-session-id": "sess-1",
      "x-grok-client-version": GROK_BUILD_VERSION,
      "x-grok-client-identifier": "grok-shell",
    });
    expect(sent?.headers["content-encoding"]).toBeUndefined();
    expect(sent?.headers["x-xai-token-auth"]).toBeUndefined();
    // Key order matters for byte-level parity with grok-build.
    expect(JSON.stringify(sent?.body)).toBe(
      JSON.stringify({
        model: "grok-imagine-image-2.0",
        prompt: "red square",
        n: 1,
        aspect_ratio: "1:1",
        resolution: "1k",
        response_format: "b64_json",
      }),
    );
    expect(result.usage?.cost_in_usd_ticks).toBe(500_000_000);
  });

  it("maps SDK option names and keeps response_format b64_json", async () => {
    const { impl, calls } = fakeFetch(async () => json(imageResponse));
    await new GrokMediaClient({ fetch: impl }).generateImages(AUTH, {
      model: "grok-imagine-image-2.0",
      prompt: "p",
      n: 3,
      resolution: "2k",
      quality: "medium",
      outputFormat: "png",
    });
    expect(calls[0]?.body).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "p",
      n: 3,
      resolution: "2k",
      response_format: "b64_json",
      quality: "medium",
      output_format: "png",
    });
  });

  it("decodes b64 bytes with mime type, sniffing when mime_type is absent", () => {
    const decoded = decodeGrokImages({
      data: [
        { b64_json: JPEG.toString("base64"), mime_type: "image/jpeg", respect_moderation: true },
        { b64_json: PNG.toString("base64"), revised_prompt: "a red square" },
      ],
      usage: { cost_in_usd_ticks: 7 },
    });
    expect(Buffer.from(decoded.images[0]!.bytes).equals(JPEG)).toBe(true);
    expect(decoded.images[0]).toMatchObject({ mediaType: "image/jpeg", respectModeration: true });
    expect(Buffer.from(decoded.images[1]!.bytes).equals(PNG)).toBe(true);
    expect(decoded.images[1]).toMatchObject({ mediaType: "image/png", revisedPrompt: "a red square" });
    expect(decoded.costInUsdTicks).toBe(7);
  });

  it("rejects n outside 1..3 before any request", async () => {
    const { impl, calls } = fakeFetch(async () => json(imageResponse));
    const client = new GrokMediaClient({ fetch: impl });
    await expect(client.generateImages(AUTH, { model: "", prompt: "p", n: 4 })).rejects.toThrow(
      RangeError,
    );
    await expect(client.generateImages(AUTH, { model: "", prompt: "p", n: 0 })).rejects.toThrow(
      RangeError,
    );
    expect(calls).toHaveLength(0);
  });

  it("turns respect_moderation false into a content-policy error", async () => {
    const { impl } = fakeFetch(async () =>
      json({ data: [{ b64_json: JPEG.toString("base64"), respect_moderation: false }] }),
    );
    await expect(
      new GrokMediaClient({ fetch: impl }).generateImages(AUTH, { model: "", prompt: "p" }),
    ).rejects.toBeInstanceOf(GrokContentPolicyError);
  });

  it("rejects invalid base64 and malformed bodies as protocol errors", async () => {
    const bad = fakeFetch(async () => json({ data: [{ b64_json: "not base64!" }] }));
    await expect(
      new GrokMediaClient({ fetch: bad.impl }).generateImages(AUTH, { model: "", prompt: "p" }),
    ).rejects.toBeInstanceOf(GrokProtocolError);
    const empty = fakeFetch(async () => json({ data: [] }));
    await expect(
      new GrokMediaClient({ fetch: empty.impl }).generateImages(AUTH, { model: "", prompt: "p" }),
    ).rejects.toBeInstanceOf(GrokProtocolError);
  });

  it("wraps 403 into GrokHttpError kind entitlement", async () => {
    const { impl, calls } = fakeFetch(async () =>
      json({ code: "forbidden", error: "Imagine is not available on this tier" }, 403),
    );
    const error = await new GrokMediaClient({ fetch: impl })
      .generateImages(AUTH, { model: "", prompt: "p" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect(error).toMatchObject({
      status: 403,
      classification: { kind: "entitlement", message: "Imagine is not available on this tier" },
    });
    expect(calls).toHaveLength(1);
  });

  it("aborts on the read timeout and on the total timeout", async () => {
    const stalled = fakeFetch(async (_, init) => hang(init));
    const readError = await new GrokMediaClient({
      fetch: stalled.impl,
      timeouts: { imageReadMs: 20, imageTotalMs: 1_000 },
    })
      .generateImages(AUTH, { model: "", prompt: "p" })
      .catch((e: unknown) => e);
    expect(readError).toBeInstanceOf(GrokMediaTimeoutError);
    expect(readError).toMatchObject({ phase: "read", timeoutMs: 20 });
    expect(stalled.calls).toHaveLength(1);

    // A body that keeps trickling resets the read timer but not the total budget.
    const trickle = fakeFetch(async (_, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setInterval(() => controller.enqueue(new Uint8Array([32])), 5);
          init?.signal?.addEventListener("abort", () => {
            clearInterval(timer);
            controller.error(init.signal?.reason);
          });
        },
      });
      return new Response(body, { status: 200 });
    });
    const totalError = await new GrokMediaClient({
      fetch: trickle.impl,
      timeouts: { imageReadMs: 30, imageTotalMs: 80 },
    })
      .generateImages(AUTH, { model: "", prompt: "p" })
      .catch((e: unknown) => e);
    expect(totalError).toBeInstanceOf(GrokMediaTimeoutError);
    expect(totalError).toMatchObject({ phase: "total" });
    expect(trickle.calls).toHaveLength(1);
  });

  it("propagates the caller's abort reason", async () => {
    const { impl } = fakeFetch(async (_, init) => hang(init));
    const controller = new AbortController();
    const pending = new GrokMediaClient({ fetch: impl }).generateImages(AUTH, {
      model: "",
      prompt: "p",
      signal: controller.signal,
    });
    const reason = new Error("client went away");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("sends edits as JSON with image/images url objects", async () => {
    const { impl, calls } = fakeFetch(async () => json(imageResponse));
    const client = new GrokMediaClient({ fetch: impl });
    await client.editImages(AUTH, {
      model: "",
      prompt: "make it blue",
      images: ["data:image/png;base64,AAAA"],
    });
    await client.editImages(AUTH, {
      model: "grok-imagine-image",
      prompt: "merge",
      aspectRatio: "16:9",
      images: ["https://example.com/a.png", "https://example.com/b.png"],
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.x.ai/v1/images/edits",
      "https://api.x.ai/v1/images/edits",
    ]);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "make it blue",
      n: 1,
      resolution: "1k",
      response_format: "b64_json",
      image: { url: "data:image/png;base64,AAAA" },
    });
    expect(calls[1]?.body).toEqual({
      model: "grok-imagine-image",
      prompt: "merge",
      n: 1,
      aspect_ratio: "16:9",
      resolution: "1k",
      response_format: "b64_json",
      images: [{ url: "https://example.com/a.png" }, { url: "https://example.com/b.png" }],
    });
    await expect(client.editImages(AUTH, { model: "", prompt: "p", images: [] })).rejects.toThrow(
      GrokInvalidRequestError,
    );
    expect(calls).toHaveLength(2);
  });
});

describe("GrokMediaClient retry safety", () => {
  it("does not re-issue a POST that failed after send", async () => {
    const { impl, calls } = fakeFetch(async () => {
      throw codedError("ECONNRESET");
    });
    const error = await new GrokMediaClient({ fetch: impl })
      .generateImages(AUTH, { model: "", prompt: "p" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokMediaDeliveryError);
    expect(error).not.toBeInstanceOf(GrokHttpError);
    expect(calls).toHaveLength(1);
  });

  it("treats a body read failure after the response as delivered", async () => {
    const { impl, calls } = fakeFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(codedError("ECONNREFUSED"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await new GrokMediaClient({ fetch: impl })
      .startVideo(AUTH, { model: "", prompt: "p" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokMediaDeliveryError);
    expect(calls).toHaveLength(1);
  });

  it("surfaces a pre-send connect failure as a transient GrokHttpError", async () => {
    const { impl, calls } = fakeFetch(async () => {
      throw codedError("ECONNREFUSED");
    });
    const error = await new GrokMediaClient({ fetch: impl })
      .startVideo(AUTH, { model: "", prompt: "p" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect(error).toMatchObject({ status: 0, classification: { kind: "transient" } });
    expect(calls).toHaveLength(1);
  });

  it("maps any GET network failure to a transient GrokHttpError", async () => {
    const { impl } = fakeFetch(async () => {
      throw codedError("ECONNRESET");
    });
    const error = await new GrokMediaClient({ fetch: impl })
      .getVideo(AUTH, "req-1")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrokHttpError);
    expect(error).toMatchObject({ classification: { kind: "transient" } });
  });
});

describe("GrokMediaClient video", () => {
  it("starts a video with grok-build field names and returns the request id", async () => {
    const { impl, calls } = fakeFetch(async () => json({ request_id: "req-1" }));
    const client = new GrokMediaClient({ fetch: impl });
    const started = await client.startVideo(AUTH, {
      model: "",
      prompt: "a cat",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "720p",
      image: "https://example.com/first.png",
      lastFrame: "https://example.com/last.png",
      referenceImages: ["https://example.com/ref.png"],
      mode: "reference-to-video",
    });
    expect(started.request_id).toBe("req-1");
    const [sent] = calls;
    expect(sent?.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(sent?.headers["user-agent"]).toBe(`xai-grok-build/${GROK_BUILD_VERSION}`);
    expect(JSON.stringify(sent?.body)).toBe(
      JSON.stringify({
        model: "grok-imagine-video-1.5",
        prompt: "a cat",
        image: { url: "https://example.com/first.png" },
        duration: 6,
        aspect_ratio: "16:9",
        resolution: "720p",
        reference_images: [{ url: "https://example.com/ref.png" }],
        last_frame: { url: "https://example.com/last.png" },
      }),
    );
  });

  it("rejects reference-to-video without references and bad durations without a request", async () => {
    const { impl, calls } = fakeFetch(async () => json({ request_id: "x" }));
    const client = new GrokMediaClient({ fetch: impl });
    await expect(
      client.startVideo(AUTH, { model: "", prompt: "p", mode: "reference-to-video" }),
    ).rejects.toThrow(GrokInvalidRequestError);
    await expect(client.startVideo(AUTH, { model: "", prompt: "p", duration: 16 })).rejects.toThrow(
      GrokInvalidRequestError,
    );
    expect(calls).toHaveLength(0);
  });

  it("polls GET /videos/{id} and returns the upstream URL unchanged", async () => {
    const url = "https://vidgen.x.ai/output/abc.mp4?sig=XYZ&exp=1";
    const replies = [
      new Response("", { status: 202 }),
      json({ status: "pending", progress: 40 }),
      json({ status: "done", video: { url, duration: 6 }, usage: { cost_in_usd_ticks: 9 } }),
    ];
    const { impl, calls } = fakeFetch(async () => replies.shift() ?? json({}, 500));
    const client = new GrokMediaClient({ fetch: impl });
    const first = await client.getVideo(AUTH, "req/1");
    const second = await client.getVideo(AUTH, "req/1");
    const done = await client.getVideo(AUTH, "req/1");
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/videos/req%2F1");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["x-grok-session-id"]).toBe("sess-1");
    expect(first.status).toBe("pending");
    expect(summarizeGrokVideoStatus(second)).toEqual({ status: "pending", mimeType: "video/mp4" });
    expect(summarizeGrokVideoStatus(done)).toEqual({
      status: "done",
      url,
      mimeType: "video/mp4",
      usageTicks: 9,
    });
  });

  it("summarizes failures, expiry, nested file_output and moderation", async () => {
    expect(
      summarizeGrokVideoStatus({ status: "failed", error: { code: "x", message: "boom" } }),
    ).toMatchObject({ status: "failed", error: "boom" });
    expect(summarizeGrokVideoStatus({ status: "expired" })).toMatchObject({ status: "failed" });
    expect(summarizeGrokVideoStatus({ status: "done" })).toMatchObject({ status: "failed" });
    expect(
      summarizeGrokVideoStatus({
        status: "done",
        video: { file_output: { public_url: "https://files.x.ai/v.mp4" } },
      }),
    ).toMatchObject({ status: "done", url: "https://files.x.ai/v.mp4" });
    // A top-level file_output is not where @ai-sdk/xai looks for the URL.
    expect(
      summarizeGrokVideoStatus({
        status: "done",
        file_output: { public_url: "https://files.x.ai/v.mp4" },
      }),
    ).toMatchObject({ status: "failed" });

    const { impl } = fakeFetch(async () =>
      json({ status: "done", video: { url: "https://x/v.mp4", respect_moderation: false } }),
    );
    await expect(
      new GrokMediaClient({ fetch: impl }).getVideo(AUTH, "req-1"),
    ).rejects.toBeInstanceOf(GrokContentPolicyError);
  });

  it("classifies a poll 401 and a poll timeout", async () => {
    const unauthorized = fakeFetch(async () => json({ error: "expired token" }, 401));
    await expect(
      new GrokMediaClient({ fetch: unauthorized.impl }).getVideo(AUTH, "req-1"),
    ).rejects.toMatchObject({ classification: { kind: "auth" } });
    const stalled = fakeFetch(async (_, init) => hang(init));
    await expect(
      new GrokMediaClient({ fetch: stalled.impl, timeouts: { videoPollMs: 20 } }).getVideo(
        AUTH,
        "req-1",
      ),
    ).rejects.toBeInstanceOf(GrokMediaTimeoutError);
  });
});
