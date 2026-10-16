import { describe, expect, it } from "vitest";

import { GrokModelCatalog } from "./grok-models";

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
      known: true,
    });
    expect(catalog.resolve("grok-4.5").id).toBe("grok-4.5");
    expect(catalog.resolve(undefined).id).toBe("grok-4.7");
  });

  it("forwards an unlisted id with every effort instead of rejecting it", () => {
    const catalog = new GrokModelCatalog();
    expect(catalog.resolve("grok/grok-composer-2.5")).toEqual({
      id: "grok-composer-2.5",
      contextWindow: undefined,
      efforts: ["xhigh", "high", "medium", "low"],
      defaultEffort: "high",
      known: false,
    });
    expect(catalog.validateEffort("grok-composer-2.5", "low")).toBe("low");
    expect(catalog.validateEffort("grok-composer-2.5", "max")).toBeUndefined();
    expect(catalog.models.has("grok-composer-2.5")).toBe(false);
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
      known: true,
    });
    expect(catalog.validateEffort("grok-4.8", "xhigh")).toBeUndefined();
    // A non-responses backend is not merged; the id is forwarded unlisted.
    expect(catalog.resolve("legacy").known).toBe(false);
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
