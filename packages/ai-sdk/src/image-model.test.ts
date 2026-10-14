import { generateImage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid, type QgridImageProviderOptions } from "./index";
import { type QueryOutput } from "./index.types";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const imageUsage = {
  input_tokens: 2260,
  output_tokens: 1415,
  total_tokens: 3675,
  input_tokens_details: { image_tokens: 2012, text_tokens: 248 },
  output_tokens_details: { image_tokens: 1415, text_tokens: 0 },
};

function queryOutput(requestLogId: number | undefined = 123): QueryOutput {
  return {
    requestLogId,
    text: "",
    content: [{
      type: "image",
      data: png,
      mediaType: "image/png",
      revisedPrompt: "A red square",
      generation: {
        route: "codex-images",
        model: "gpt-image-2",
        size: "1037x1517",
        quality: "medium",
        background: "opaque",
        usage: imageUsage,
      },
    }],
    model: "gpt-image-2",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    durationMs: 500,
    costUsd: 0,
    costSource: "pricing_table",
  };
}

function mockQuery(result: QueryOutput = queryOutput()) {
  const fetchMock = vi.fn(async () => Response.json(result, { headers: { "x-request-id": "test" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("qgrid.image with AI SDK generateImage", () => {
  it("returns image bytes, actual generation metadata, and image usage through the standard interface", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    vi.stubEnv("QGRID_PROJECT_NAME", "deti");
    const fetchMock = mockQuery();
    const controller = new AbortController();
    const result = await generateImage({
      model: qgrid.image("openai/gpt-image-2"),
      prompt: "A red square",
      abortSignal: controller.signal,
      headers: { "x-test": "preserved" },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://qgrid.example/api/qgrid/query");
    expect(JSON.parse(String(init.body)).args).toEqual({
      prompt: "A red square",
      model: "openai/gpt-image-2",
      projectName: "deti",
      imageGeneration: true,
      imageGenerationOptions: {},
    });
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get("x-test")).toBe("preserved");
    expect(result.image.base64).toBe(png);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.usage).toEqual({ inputTokens: 2260, outputTokens: 1415, totalTokens: 3675 });
    expect(result.providerMetadata.qgrid.images).toEqual([{
      requestLogId: 123,
      revisedPrompt: "A red square",
      generation: expect.objectContaining({ route: "codex-images", size: "1037x1517", usage: imageUsage }),
    }]);
    expect(result.responses[0]).toMatchObject({ modelId: "gpt-image-2", headers: { "x-request-id": "test" } });
  });

  it("sends binary, data URL, and remote reference images for editing with typed image options", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockQuery();
    const result = await generateImage({
      model: qgrid.image("openai/gpt-image-2", { serverUrl: "https://configured.example", projectName: "edit" }),
      prompt: { text: "Make the background transparent", images: [
        Buffer.from(png, "base64"),
        `data:image/png;base64,${png}`,
        "https://example.com/reference.webp",
      ] },
      size: "1024x1536",
      providerOptions: { qgrid: {
        quality: "high",
        background: "transparent",
        outputFormat: "png",
        tokenName: "openai/designer",
        logger: false,
      } satisfies QgridImageProviderOptions },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://configured.example/api/qgrid/query");
    expect(JSON.parse(String(init.body)).args).toEqual({
      prompt: "Make the background transparent",
      model: "openai/gpt-image-2",
      projectName: "edit",
      imageGeneration: true,
      imageGenerationOptions: { size: "1024x1536", quality: "high", background: "transparent", outputFormat: "png" },
      input: [
        { type: "text", text: "Make the background transparent", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${png}` },
        { type: "image", url: `data:image/png;base64,${png}` },
        { type: "image", url: "https://example.com/reference.webp" },
      ],
      tokenName: "openai/designer",
      logger: false,
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: "compatibility", feature: "size" }),
      expect.objectContaining({ type: "compatibility", feature: "providerOptions.qgrid.quality" }),
    ]);
  });

  it("lets AI SDK batch n images and aggregate image usage and per-call log IDs", async () => {
    let requestLogId = 0;
    const fetchMock = vi.fn(async () => Response.json(queryOutput(++requestLogId)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateImage({ model: qgrid.image("openai/gpt-image-2"), prompt: "A square", n: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.images).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 4520, outputTokens: 2830, totalTokens: 7350 });
    expect(result.providerMetadata.qgrid.images).toEqual([
      expect.objectContaining({ requestLogId: 1 }),
      expect.objectContaining({ requestLogId: 2 }),
    ]);
  });

  it("leaves missing image usage unknown instead of returning zero chat usage", async () => {
    const response = queryOutput();
    delete response.requestLogId;
    const image = response.content![0];
    if (image.type === "image") delete image.generation!.usage;
    mockQuery(response);
    const result = await generateImage({ model: qgrid.image("openai/gpt-image-2"), prompt: "A square" });
    expect(result.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
    expect(result.providerMetadata.qgrid.images[0]).not.toHaveProperty("requestLogId");
  });

  it("warns about unsupported seed and aspectRatio without sending them as controls", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockQuery();
    const result = await generateImage({ model: qgrid.image("openai/gpt-image-2"), prompt: "A square", seed: 42, aspectRatio: "3:2" });
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: "unsupported", feature: "seed" }),
      expect.objectContaining({ type: "unsupported", feature: "aspectRatio" }),
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).args.imageGenerationOptions).toEqual({});
  });

  it("rejects masks and overridden multi-image calls before transport", async () => {
    const fetchMock = mockQuery();
    const model = qgrid.image("openai/gpt-image-2");
    await expect(generateImage({ model, prompt: { text: "Erase this", images: [png], mask: png }, maxRetries: 0 })).rejects.toThrow("masks are not supported");
    await expect(generateImage({ model, prompt: "A square", n: 2, maxImagesPerCall: 2, maxRetries: 0 })).rejects.toThrow("only one image per call");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ outputFormat: "webp" }, "PNG output only"],
    [{ tokenName: " " }, "tokenName must be"],
    [{ tokenName: "anthropic/designer" }, "tokenName must be"],
    [{ quality: "auto" }, "quality must be"],
    [{ background: "invalid" }, "background must be"],
    [{ logger: "false" }, "logger must be"],
  ])("rejects invalid image provider options %j before transport", async (options, message) => {
    const fetchMock = mockQuery();
    await expect(generateImage({
      model: qgrid.image("openai/gpt-image-2"),
      prompt: "A square",
      providerOptions: { qgrid: options },
      maxRetries: 0,
    })).rejects.toThrow(String(message));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported model IDs and oversized or too many references", async () => {
    const fetchMock = mockQuery();
    expect(() => qgrid.image("openai/gpt-6-luna" as never)).toThrow("unsupported image model");
    const model = qgrid.image("openai/gpt-image-2");
    await expect(generateImage({ model, prompt: { text: "Edit", images: ["http://example.com/reference.png"] }, maxRetries: 0 })).rejects.toThrow("reference image URLs must use HTTPS");
    await expect(generateImage({ model, prompt: { text: "Edit", images: Array(6).fill(png) }, maxRetries: 0 })).rejects.toThrow("at most five");
    await expect(generateImage({ model, prompt: { text: "Edit", images: [new Uint8Array(6_800_000)] }, maxRetries: 0 })).rejects.toThrow("too large for JSON transport");
    await expect(generateImage({ model, prompt: { text: "Edit", images: [new Uint8Array(3_400_000), new Uint8Array(3_400_000)] }, maxRetries: 0 })).rejects.toThrow("too large for JSON transport");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "codex-responses"])("rejects older servers with route %s", async (route) => {
    const response = queryOutput();
    const image = response.content![0];
    if (image.type === "image") image.generation = route === undefined ? undefined : { route: "codex-responses" };
    mockQuery(response);
    await expect(generateImage({ model: qgrid.image("openai/gpt-image-2"), prompt: "A square", maxRetries: 0 })).rejects.toThrow("update the qgrid server and SDK together");
  });
});
