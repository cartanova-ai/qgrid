import { describe, expect, it } from "vitest";

import { groupCatalogModels } from "./ModelOptions";

describe("groupCatalogModels", () => {
  it("groups catalog text models by provider in catalog order", () => {
    const text = [
      { id: "openai/gpt-6.2-astra", provider: "openai" },
      { id: "openai/gpt-6.2-sol", provider: "openai" },
      { id: "anthropic/claude-fable-5-2", provider: "anthropic" },
      { id: "grok/grok-5", provider: "grok" },
    ] as Parameters<typeof groupCatalogModels>[0];

    expect(groupCatalogModels(text)).toEqual([
      { label: "OpenAI", models: ["openai/gpt-6.2-astra", "openai/gpt-6.2-sol"] },
      { label: "Anthropic", models: ["anthropic/claude-fable-5-2"] },
      { label: "Grok", models: ["grok/grok-5"] },
    ]);
  });
});
