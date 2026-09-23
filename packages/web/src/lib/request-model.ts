type RequestModelFields = {
  status: string;
  requestedModel: string | null;
  servedModel: string | null;
  imageCostMethod: string | null;
};

export function requestModelDisplay({
  status,
  requestedModel,
  servedModel,
  imageCostMethod,
}: RequestModelFields): { label: string; assumedImageModel: boolean } {
  if (status === "running") return { label: "실행 중", assumedImageModel: false };

  const assumedImageModel = /^assumed:([^:]+):/.exec(imageCostMethod ?? "")?.[1];
  const sourceModel = requestedModel ?? servedModel;
  if (assumedImageModel && sourceModel) {
    const imageModel = `openai/${assumedImageModel}`;
    return {
      label: sourceModel === imageModel ? imageModel : `${sourceModel} → ${imageModel}`,
      assumedImageModel: servedModel !== imageModel,
    };
  }

  return {
    label:
      requestedModel && servedModel && requestedModel !== servedModel
        ? `${requestedModel} → ${servedModel}`
        : (servedModel ?? requestedModel ?? "—"),
    assumedImageModel: false,
  };
}
