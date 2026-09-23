import { describe, expect, it } from "vitest";

import { requestModelDisplay } from "./request-model";

describe("requestModelDisplay", () => {
  const base = {
    status: "succeeded",
    requestedModel: "openai/gpt-5.6-luna",
    servedModel: "openai/gpt-5.6-luna",
    imageCostMethod: null,
  };

  it("shows the estimated image model for hosted image output", () => {
    expect(
      requestModelDisplay({
        ...base,
        imageCostMethod: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    ).toEqual({
      label: "openai/gpt-5.6-luna → openai/gpt-image-2",
      assumedImageModel: true,
    });
  });

  it("keeps the observed model for standalone transparent images", () => {
    expect(
      requestModelDisplay({
        ...base,
        servedModel: "openai/gpt-image-2",
        imageCostMethod: "estimated:gpt-image-2:reported-usage:public-prices:conservative",
      }),
    ).toEqual({
      label: "openai/gpt-5.6-luna → openai/gpt-image-2",
      assumedImageModel: false,
    });
  });

  it("preserves ordinary requests and running state", () => {
    expect(requestModelDisplay(base)).toEqual({
      label: "openai/gpt-5.6-luna",
      assumedImageModel: false,
    });
    expect(
      requestModelDisplay({
        ...base,
        status: "running",
        imageCostMethod: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    ).toEqual({ label: "실행 중", assumedImageModel: false });
  });

  it("does not repeat the model when an image request has no separate requested model", () => {
    expect(
      requestModelDisplay({
        ...base,
        requestedModel: null,
        servedModel: "openai/gpt-image-2",
        imageCostMethod: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    ).toEqual({ label: "openai/gpt-image-2", assumedImageModel: false });
  });
});
