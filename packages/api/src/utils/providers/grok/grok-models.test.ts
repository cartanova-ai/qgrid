import { describe, expect, it } from "vitest";

import { GrokModelCatalog, GrokUnknownModelError } from "./grok-models";

const credentials = {
  accessToken: "header.payload.sig",
  userId: "19bfa1b2-a163-9e0c-8de1-832a73e2695e",
};

describe("GrokModelCatalog", () => {
  it("resolves seeded models with or without the grok/ prefix", () => {
    const catalog = new GrokModelCatalog();
    expect(catalog.resolve("grok/grok-4.7")).toEqual({
      id: "grok-4.7",
      contextWindow: 256000,
      efforts: ["xhigh", "high", "medium", "low"],
      defaultEffort: "high",
    });
    expect(catalog.resolve("grok-4.5").id).toBe("grok-4.5");
    expect(catalog.resolve(undefined).id).toBe("grok-4.7");
  });

  it("throws a typed error for unknown models", () => {
    const catalog = new GrokModelCatalog();
    expect(() => catalog.resolve("grok/grok-9")).toThrow(GrokUnknownModelError);
  });

  it("validates efforts per model", () => {
    const catalog = new GrokModelCatalog();
    expect(catalog.validateEffort("grok-4.5", "xhigh")).toBe("xhigh");
    expect(catalog.validateEffort("grok-4.5", "max")).toBeUndefined();
  });

  it("merges GET /models and stores the etag", async () => {
    const catalog = new GrokModelCatalog();
    let url = "";
    const result = await catalog.refresh(credentials, {
      fetch: async (input) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "grok-4.8",
                api_backend: "responses",
                context_window: 500000,
                reasoning_efforts: [
                  { id: "h", value: "high" },
                  { id: "m", value: "medium", default: true },
                ],
              },
              { id: "legacy", api_backend: "chat_completions", context_window: 1000 },
            ],
          }),
          { headers: { "x-models-etag": '"42"' } },
        );
      },
    });
    expect(url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(result).toEqual({ kind: "ok", models: ["grok-4.8"], etag: '"42"' });
    expect(catalog.resolve("grok/grok-4.8")).toEqual({
      id: "grok-4.8",
      contextWindow: 500000,
      efforts: ["high", "medium"],
      defaultEffort: "medium",
    });
    expect(catalog.validateEffort("grok-4.8", "xhigh")).toBeUndefined();
    expect(() => catalog.resolve("legacy")).toThrow(GrokUnknownModelError);
    // Seeds absent from the live list remain.
    expect(catalog.resolve("grok-4.6").id).toBe("grok-4.6");
    expect(catalog.isStale('"42"')).toBe(false);
    expect(catalog.isStale('"43"')).toBe(true);
  });

  it("reports lookup_failed without changing the catalog", async () => {
    const catalog = new GrokModelCatalog();
    const result = await catalog.refresh(credentials, {
      fetch: async () => new Response("{}", { status: 500 }),
    });
    expect(result.kind).toBe("lookup_failed");
    expect(catalog.models.size).toBe(4);
  });
});
