type RequestModelFields = {
  status: string;
  requestedModel: string | null;
  servedModel: string | null;
  imageCostMethod: string | null;
};

export interface RequestModelDisplay {
  label: string;
}

export function requestModelDisplay({
  status,
  requestedModel,
  servedModel,
  imageCostMethod,
}: RequestModelFields): RequestModelDisplay {
  if (status === "running") return { label: "실행 중" };

  const loggedImageModel = /^(?:assumed|estimated):(gpt-image-[^:]+):/.exec(
    imageCostMethod ?? "",
  )?.[1];

  const imageModel = servedModel?.startsWith("openai/gpt-image-")
    ? servedModel
    : loggedImageModel
      ? `openai/${loggedImageModel}`
      : null;

  if (imageModel) {
    const sourceModel = requestedModel ?? servedModel;

    return {
      label:
        sourceModel && sourceModel !== imageModel ? `${sourceModel} → ${imageModel}` : imageModel,
    };
  }

  return {
    label:
      requestedModel && servedModel && requestedModel !== servedModel
        ? `${requestedModel} → ${servedModel}`
        : (servedModel ?? requestedModel ?? "—"),
  };
}
