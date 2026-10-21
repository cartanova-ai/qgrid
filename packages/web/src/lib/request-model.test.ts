import { describe, expect, it } from "vitest";

import { requestModelDisplay } from "./request-model";

describe("requestModelDisplay", () => {
  const base = {
    status: "succeeded",
    requestedModel: "openai/gpt-5.6-luna",
    servedModel: "openai/gpt-5.6-luna",
    imageCostMethod: null,
  };

  it("shows the requested model and logged image model for hosted output", () => {
    expect(
      requestModelDisplay({
        ...base,
        imageCostMethod: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    ).toEqual({
      label: "openai/gpt-5.6-luna → openai/gpt-image-2",
    });
  });

  it("preserves the response model for standalone transparent images", () => {
    expect(
      requestModelDisplay({
        ...base,
        servedModel: "openai/gpt-image-2",
        imageCostMethod: "estimated:gpt-image-2:reported-usage:public-prices:conservative",
      }),
    ).toEqual({
      label: "openai/gpt-5.6-luna → openai/gpt-image-2",
    });
  });

  it("preserves ordinary requests and shows the recorded models of a running request", () => {
    expect(requestModelDisplay(base)).toEqual({
      label: "openai/gpt-5.6-luna",
    });
    expect(
      requestModelDisplay({
        ...base,
        status: "running",
        requestedModel: "grok/grok-4.7",
        servedModel: "grok/grok-4.7-build",
      }),
    ).toEqual({ label: "grok/grok-4.7 → grok/grok-4.7-build" });
    expect(
      requestModelDisplay({ ...base, status: "running", servedModel: null }),
    ).toEqual({ label: "openai/gpt-5.6-luna" });
  });

  it("does not repeat the model when an image request has no separate requested model", () => {
    expect(
      requestModelDisplay({
        ...base,
        requestedModel: null,
        servedModel: "openai/gpt-image-2",
        imageCostMethod: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    ).toEqual({ label: "openai/gpt-image-2" });
  });
});
