/**
 * `QgridService.totalCost` 응답 중 합계에서 빠진 요청 수.
 * `unknownCostCount` 는 생성 클라이언트가 재동기화되기 전에도 컴파일되도록 optional 로 받는다.
 */
export type TotalCostSummary = {
  usd: number;
  unknownImageCostCount: number;
  unknownCostCount?: number;
};

/** 비용을 몰라 합계에 들어가지 않은 요청 수(가격 없는 이미지 + provider 비용 없는 음성/영상). */
export function unpricedRequestCount(cost: TotalCostSummary): number {
  return cost.unknownImageCostCount + (cost.unknownCostCount ?? 0);
}

/** 합계 옆에 붙일 짧은 표시. 빠진 요청이 없으면 null. */
export function unpricedRequestLabel(cost: TotalCostSummary): string | null {
  const count = unpricedRequestCount(cost);

  return count > 0 ? `+${count} unpriced` : null;
}

/** 표시에 붙일 설명. 이미지와 그 외 요청을 나눠 보여준다. */
export function unpricedRequestTitle(cost: TotalCostSummary): string | null {
  if (unpricedRequestCount(cost) === 0) return null;
  const media = cost.unknownCostCount ?? 0;

  return `Total excludes requests with unknown cost: ${cost.unknownImageCostCount} image, ${media} voice/video.`;
}
