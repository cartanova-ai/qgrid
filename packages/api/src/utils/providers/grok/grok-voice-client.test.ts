import { describe, expect, it } from "vitest";

import { GROK_STT_DEFAULT_MODEL } from "./grok-constants";
import { GrokHttpError } from "./grok-direct-client";
import { buildGrokVoiceHeaders, type GrokPlatform } from "./grok-headers";
import { GrokVoiceClient } from "./grok-voice-client";

const platform: GrokPlatform = { os: "macos", arch: "aarch64" };
const audio = new Uint8Array([1, 2, 3, 4]);

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { calls, impl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

async function httpError(promise: Promise<unknown>): Promise<GrokHttpError> {
  const error = await rejection(promise);
  if (!(error instanceof GrokHttpError)) throw new Error(`expected GrokHttpError, got ${error}`);
  return error;
}

describe("GrokVoiceClient.transcribe", () => {
  it("posts multipart with model first and file last", async () => {
    const fake = fakeFetch(() => json({ text: "hello", language: "en", duration: 1.5 }));
    const client = new GrokVoiceClient({ fetch: fake.impl, platform });
    await client.transcribe("tok", { audio, mediaType: "audio/mpeg", language: "en" });

    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/stt");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(buildGrokVoiceHeaders({ bearer: "tok", platform }));
    const form = init.body;
    if (!(form instanceof FormData)) throw new Error("expected FormData body");
    expect([...form.keys()]).toEqual(["model", "language", "file"]);
    expect(form.get("model")).toBe(GROK_STT_DEFAULT_MODEL);
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("expected File");
    expect(file.name).toBe("audio.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);

    // The serialized wire body also ends with the file part.
    const wire = await new Response(form).text();
    expect(wire.indexOf('name="model"')).toBeLessThan(wire.indexOf('name="file"'));
    expect(wire).toContain('filename="audio.mp3"');
    expect(wire).toContain("Content-Type: audio/mpeg");
  });

  it("uses the requested model and omits language when absent", async () => {
    const fake = fakeFetch(() => json({ text: "" }));
    const client = new GrokVoiceClient({ fetch: fake.impl, platform });
    await client.transcribe("tok", { audio, mediaType: "audio/wav", model: "m-2" });
    const form = fake.calls[0]!.init.body;
    if (!(form instanceof FormData)) throw new Error("expected FormData body");
    expect([...form.keys()]).toEqual(["model", "file"]);
    expect(form.get("model")).toBe("m-2");
    const file = form.get("file");
    expect(file instanceof File && file.name).toBe("audio.wav");
  });

  it("parses the response, keeps extra fields, and drops empty or null language", async () => {
    const words = [{ text: "hi", start: 0, end: 0.4 }];
    const client = new GrokVoiceClient({
      fetch: fakeFetch(() => json({ text: "hi", language: "en", duration: 0.4, words })).impl,
    });
    expect(await client.transcribe("tok", { audio, mediaType: "audio/mpeg" })).toEqual({
      text: "hi",
      language: "en",
      duration: 0.4,
      words,
    });

    const silent = new GrokVoiceClient({
      fetch: fakeFetch(() => json({ text: "", language: "", duration: 1 })).impl,
    });
    expect(await silent.transcribe("tok", { audio, mediaType: "audio/mpeg" })).toEqual({
      text: "",
      duration: 1,
    });

    const nulls = new GrokVoiceClient({
      fetch: fakeFetch(() => json({ text: "x", language: null, duration: null })).impl,
    });
    expect(await nulls.transcribe("tok", { audio, mediaType: "audio/mpeg" })).toEqual({
      text: "x",
    });
  });

  it("rejects an invalid response body without retrying", async () => {
    const fake = fakeFetch(() => json({ transcript: "no text field" }));
    const client = new GrokVoiceClient({ fetch: fake.impl });
    const error = await httpError(client.transcribe("tok", { audio, mediaType: "audio/mpeg" }));
    expect(error.classification).toMatchObject({ kind: "transient", status: 502 });
    expect(error.classification.shouldRetry).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects empty audio before sending", async () => {
    const fake = fakeFetch(() => json({ text: "" }));
    const client = new GrokVoiceClient({ fetch: fake.impl });
    await expect(
      client.transcribe("tok", { audio: new Uint8Array(), mediaType: "audio/mpeg" }),
    ).rejects.toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
  });

  it("maps 401 to auth", async () => {
    const client = new GrokVoiceClient({
      fetch: fakeFetch(() => json({ error: "unauthorized" }, 401)).impl,
    });
    const error = await httpError(client.transcribe("tok", { audio, mediaType: "audio/mpeg" }));
    expect(error.classification.kind).toBe("auth");
    expect(error.status).toBe(401);
  });

  it("aborts on the total timeout and does not retry", async () => {
    const fake = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new GrokVoiceClient({ fetch: fake.impl, timeoutMs: 20 });
    const error = await httpError(client.transcribe("tok", { audio, mediaType: "audio/mpeg" }));
    expect(error.classification).toMatchObject({ kind: "transient", status: 0 });
    expect(error.classification.shouldRetry).toBe(false);
    expect(error.message).toContain("timed out after 20 ms");
    expect(fake.calls).toHaveLength(1);
  });

  it("rethrows the caller's abort reason", async () => {
    const controller = new AbortController();
    const fake = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new GrokVoiceClient({ fetch: fake.impl });
    const pending = client.transcribe("tok", {
      audio,
      mediaType: "audio/mpeg",
      signal: controller.signal,
    });
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
  });
});

describe("GrokVoiceClient.speak", () => {
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

  it("posts JSON with language and format defaults and returns the audio bytes", async () => {
    const fake = fakeFetch(
      () => new Response(mp3, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    );
    const client = new GrokVoiceClient({ fetch: fake.impl, platform });
    const result = await client.speak("tok", { text: "hello", voice: "ara" });

    expect(result.mediaType).toBe("audio/mpeg");
    expect(result.audio).toEqual(mp3);
    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/tts");
    expect(init.headers).toEqual({
      ...buildGrokVoiceHeaders({ bearer: "tok", platform }),
      "content-type": "application/json",
    });
    expect(typeof init.body === "string" && JSON.parse(init.body)).toEqual({
      text: "hello",
      voice: "ara",
      language: "en",
      format: "mp3",
    });
  });

  it("passes explicit language and format and strips content-type parameters", async () => {
    const fake = fakeFetch(
      () =>
        new Response(mp3, { status: 200, headers: { "content-type": "audio/wav; codecs=1" } }),
    );
    const client = new GrokVoiceClient({ fetch: fake.impl });
    const result = await client.speak("tok", {
      text: "bonjour",
      voice: "eve",
      language: "fr",
      format: "wav",
    });
    expect(result.mediaType).toBe("audio/wav");
    const body = fake.calls[0]!.init.body;
    expect(typeof body === "string" && JSON.parse(body)).toMatchObject({
      language: "fr",
      format: "wav",
    });
  });

  it("falls back to the format's media type when content-type is missing", async () => {
    const client = new GrokVoiceClient({
      fetch: fakeFetch(() => {
        const response = new Response(mp3, { status: 200 });
        response.headers.delete("content-type");
        return response;
      }).impl,
    });
    const result = await client.speak("tok", { text: "hi", voice: "ara" });
    expect(result.mediaType).toBe("audio/mpeg");
  });

  it("rejects a JSON success body instead of returning it as audio", async () => {
    const client = new GrokVoiceClient({ fetch: fakeFetch(() => json({ audio: "x" })).impl });
    const error = await httpError(client.speak("tok", { text: "hi", voice: "ara" }));
    expect(error.classification.status).toBe(502);
    expect(error.classification.shouldRetry).toBe(false);
  });

  it("validates the request before sending", async () => {
    const fake = fakeFetch(() => new Response(mp3));
    const client = new GrokVoiceClient({ fetch: fake.impl });
    await expect(client.speak("tok", { text: "", voice: "ara" })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it("maps 422 to invalid_request with the server message", async () => {
    const client = new GrokVoiceClient({
      fetch: fakeFetch(
        () =>
          new Response("Failed to deserialize the JSON body: missing field `language`", {
            status: 422,
            headers: { "content-type": "text/plain" },
          }),
      ).impl,
    });
    const error = await httpError(client.speak("tok", { text: "hi", voice: "ara" }));
    expect(error.classification.kind).toBe("invalid_request");
    expect(error.classification.message).toContain("missing field `language`");
  });

  it("maps 401 to auth", async () => {
    const client = new GrokVoiceClient({
      fetch: fakeFetch(() => json({ error: { message: "bad token" } }, 401)).impl,
    });
    const error = await httpError(client.speak("tok", { text: "hi", voice: "ara" }));
    expect(error.classification.kind).toBe("auth");
  });

  it("does not retry a POST that failed after send", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    });
    const client = new GrokVoiceClient({ fetch: fake.impl });
    const error = await httpError(client.speak("tok", { text: "hi", voice: "ara" }));
    expect(error.classification).toMatchObject({ kind: "transient", status: 0 });
    expect(error.classification.shouldRetry).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a connect failure before send as transient without a no-retry override", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    });
    const client = new GrokVoiceClient({ fetch: fake.impl });
    const error = await httpError(client.speak("tok", { text: "hi", voice: "ara" }));
    expect(error.classification).toMatchObject({ kind: "transient", status: 0 });
    expect(error.classification.shouldRetry).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it("times out while reading a stalled body", async () => {
    const fake = fakeFetch(({ init }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(mp3);
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    const client = new GrokVoiceClient({ fetch: fake.impl, timeoutMs: 20 });
    const error = await httpError(client.speak("tok", { text: "hi", voice: "ara" }));
    expect(error.message).toContain("timed out");
    expect(fake.calls).toHaveLength(1);
  });
});
