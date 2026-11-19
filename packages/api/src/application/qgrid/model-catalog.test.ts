import { describe, expect, it } from "vitest";
import { buildModelCatalog } from "./model-catalog";
import { QGRID_MODELS } from "./qgrid.types";

describe("buildModelCatalog", () => {
  const catalog = buildModelCatalog((provider) => provider === "openai");
  const text = (id: string) => catalog.text.find((m) => m.id === id);
  const stt = (id: string) => catalog.transcription.find((m) => m.id === id);

  it("lists every served text model with its pricing and effort range", () => {
    expect(catalog.text.map((m) => m.id)).toEqual(QGRID_MODELS);
    expect(text("openai/gpt-6.2-astra")).toMatchObject({
      available: true,
      pricing: { input: 8, output: 40, cachedInput: 0.4, fastMultiplier: 2 },
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      imageInput: true,
    });
    expect(text("openai/gpt-6.2-astra")?.pricing.longContext?.threshold).toBe(272_000);
    expect(text("anthropic/claude-sonnet-5-5")).toMatchObject({ available: false, imageInput: false });
    expect(text("anthropic/claude-sonnet-5-5")?.pricing.cacheWrite1h).toBeGreaterThan(0);
    expect(text("grok/grok-4.7")?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("marks transcription prompt support, live drafts and per-minute prices", () => {
    expect(stt("openai/gpt-transcribe")).toMatchObject({
      usdPerMinute: 0.0045,
      prompt: true,
      liveDraft: false,
    });
    expect(stt("openai/whisper-1")?.prompt).toBe(false);
    expect(stt("grok/grok-voice-transcribe-2.0")).toMatchObject({ available: false, prompt: false });
    expect(catalog.transcriptionStream.every((m) => m.provider === "openai")).toBe(true);
    expect(catalog.transcriptionStream.filter((m) => m.liveDraft).map((m) => m.id)).toEqual([
      "openai/gpt-live-transcribe",
    ]);
  });
});
