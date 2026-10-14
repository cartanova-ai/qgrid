import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { OpenAIDirectClient } from "./openai-direct-client";

function png(alpha: number[] = [0, 255]): string {
  const image = new PNG({ width: 2, height: 1 });
  for (let i = 0; i < 2; i++) image.data.set([255, 0, 0, alpha[i]!], i * 4);
  return PNG.sync.write(image).toString("base64");
}

function result(data = png()) {
  return {
    created: 123, background: "transparent", quality: "medium", size: "2x1",
    data: [{ b64_json: data }],
    usage: { input_tokens: 28, output_tokens: 2, total_tokens: 30 },
  };
}

const options = {
  model: "gpt-5.5", instructions: "Keep the red color.",
  history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Draw a circle." }] }],
  imageGeneration: { background: "transparent", size: "1024x1024", quality: "high" },
};

async function run(fetchImpl: typeof fetch, overrides = {}) {
  const client = new OpenAIDirectClient({
    credentials: { accessToken: "test", accountId: "account" }, fetch: fetchImpl,
  });
  return Array.fromAsync(client.responses({ ...options, ...overrides }));
}

describe("standalone transparent images", () => {
  it("rejects non-PNG formats before a network request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(run(fetchMock, { imageGeneration: { background: "transparent", output_format: "webp" } })).rejects.toThrow("only supports PNG");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a previous JPEG image MIME when switching to transparent editing", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result()));
    await run(fetchMock, { history: [
      { type: "image_generation_call", result: "/9j/", output_format: "jpeg" },
      { role: "user", content: "Remove the background" },
    ] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/images/edits");
    expect(JSON.parse(String(init?.body)).images).toEqual([{ image_url: "data:image/jpeg;base64,/9j/" }]);
  });

  it("uses the Images endpoint and preserves actual metadata without charging a driver", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result()));
    const events = await run(fetchMock);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image-2", background: "transparent", quality: "high", size: "1024x1024",
      prompt: expect.stringContaining("Keep the red color."),
    });
    expect(events[0]).toMatchObject({
      type: "image", generation: {
        route: "codex-images", model: "gpt-image-2", size: "2x1", quality: "medium",
        usage: { input_tokens: 28, output_tokens: 2 },
      },
    });
    expect(events[1]).toMatchObject({ type: "completed", model: "gpt-image-2" });
    expect(events[1]).not.toHaveProperty("usage");
  });

  it("edits with reference images from both history and the latest input", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result()));
    await run(fetchMock, { history: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "Keep this character." },
        { type: "input_image", image_url: "data:image/png;base64,first" },
      ] },
      { type: "message", role: "user", content: [
        { type: "input_text", text: "Use this pose on transparent background." },
        { type: "input_image", image_url: "https://example.com/pose.png" },
      ] },
    ] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      images: [{ image_url: "data:image/png;base64,first" }, { image_url: "https://example.com/pose.png" }],
      prompt: expect.stringContaining("Use this pose"),
    });
  });

  it.each([[255, 255], [0, 0], [254, 255]])("rejects images without a transparent background and visible content (%s)", async (...alpha) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result(png(alpha))));
    await expect(run(fetchMock)).rejects.toThrow(/transparent|visible/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed images without falling back", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result("bm90IHBuZw==")));
    await expect(run(fetchMock)).rejects.toThrow(/PNG/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not silently ignore structured output on the image-only route", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(run(fetchMock, { outputSchema: { schema: { type: "object" } } })).rejects.toThrow(/structured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never replays a rejected generation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ error: { message: "denied" } }, { status: 429 }));
    await expect(run(fetchMock)).rejects.toThrow("denied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes credentials once after a rejected 401", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(Response.json(result()));
    const refresh = vi.fn(async () => ({ accessToken: "new", accountId: "new-account" }));
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "old", accountId: "old-account" }, fetch: fetchMock,
      refreshCredentials: refresh,
    });
    await Array.fromAsync(client.responses(options));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer new" });
  });

  it("forwards cancellation and never retries it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      return Response.json(result());
    });
    const controller = new AbortController();
    const client = new OpenAIDirectClient({ credentials: { accessToken: "a", accountId: "b" }, fetch: fetchMock });
    const pending = Array.fromAsync(client.responses(options, controller.signal));
    const assertion = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects too many references before network I/O", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(run(fetchMock, { history: [{ type: "message", role: "user", content:
      Array.from({ length: 6 }, () => ({ type: "input_image", image_url: "https://example.com/a.png" })),
    }] })).rejects.toThrow("at most 5");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("standalone image model", () => {
  it.each([true, { background: "opaque" }, { background: "auto" }])(
    "generates ordinary PNGs directly without the Responses transport (%j)",
    async (imageGeneration) => {
      const stream = vi.fn();
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
        data: [{ b64_json: png([255, 255]) }],
      }));
      const client = new OpenAIDirectClient({
        credentials: { accessToken: "subscription-token", accountId: "account" },
        fetch: fetchMock,
        transport: { stream },
      });
      const events = await Array.fromAsync(client.responses({
        ...options, model: "gpt-image-2", imageGeneration,
      }));
      expect(stream).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer subscription-token", "ChatGPT-Account-ID": "account",
        Accept: "application/json",
      });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-image-2");
      expect(body.background).toBe(typeof imageGeneration === "object" ? imageGeneration.background : undefined);
      expect(events[0]).toMatchObject({
        type: "image", mimeType: "image/png",
        generation: { route: "codex-images", model: "gpt-image-2", size: "2x1" },
      });
      expect(events[0]).not.toHaveProperty("generation.background");
      expect(events[0]).not.toHaveProperty("generation.quality");
      expect(events[1]).toMatchObject({ type: "completed", model: "gpt-image-2" });
      expect(events[1]).not.toHaveProperty("usage");
    },
  );

  it("edits references and preserves observed settings and aggregate usage once", async () => {
    const usage = {
      input_tokens: 2260, output_tokens: 1415, total_tokens: 3675,
      input_tokens_details: { text_tokens: 248, image_tokens: 2012 },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: "gpt-image-2-codex", quality: "medium", background: "opaque", size: "1024x1536",
      data: [{ b64_json: png([255, 255]), revised_prompt: "A red circle." }, { b64_json: png() }],
      usage,
    }));
    const events = await run(fetchMock, {
      model: "gpt-image-2",
      imageGeneration: { background: "auto", quality: "high", size: "1024x1536", output_format: "png" },
      history: [{ role: "user", content: [
        { type: "input_text", text: "Use these references." },
        { type: "input_image", image_url: "data:image/png;base64,reference" },
        { type: "input_image", image_url: "https://example.com/reference.png" },
      ] }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "gpt-image-2", background: "auto", quality: "high", size: "1024x1536",
      images: [{ image_url: "data:image/png;base64,reference" }, { image_url: "https://example.com/reference.png" }],
    });
    expect(events[0]).toMatchObject({
      type: "image", revisedPrompt: "A red circle.",
      generation: { model: "gpt-image-2-codex", background: "opaque", quality: "medium", size: "2x1", usage },
    });
    expect(events[1]).not.toHaveProperty("generation.usage");
    expect(events[2]).toMatchObject({ type: "completed", model: "gpt-image-2-codex" });
    expect(events[2]).not.toHaveProperty("usage");
  });

  it.each([
    { imageGeneration: false },
    { imageGeneration: undefined },
    { imageGeneration: { output_format: "webp" } },
    { imageGeneration: { output_format: "jpeg" } },
  ])("rejects disabled generation and unsupported output formats before I/O (%j)", async (overrides) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(run(fetchMock, { model: "gpt-image-2", ...overrides })).rejects.toThrow(/enabled|PNG/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates decoded PNG content on the ordinary route", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(result("bm90IHBuZw==")));
    await expect(run(fetchMock, { model: "gpt-image-2", imageGeneration: true })).rejects.toThrow(/PNG/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
