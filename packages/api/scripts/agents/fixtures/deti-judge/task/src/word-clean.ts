/**
 * 워드뱅크 토큰 정제 — 드릴 판정·출제·인스펙터가 공유하는 정본.
 */

// 구두점(콤마·말줄임표·느낌표·마침표·따옴표 등)은 타일에서 제거.
// em/en 대시는 단어 구분자로 보고 분리(too—I'm → too / I'm). 내부 아포스트로피·하이픈(B-12)은 유지.
const PUNCT_EDGE = /^[.,!?…"'“”‘’()[\];:]+|[.,!?…"'“”‘’()[\];:]+$/gu;

export function cleanWord(w: string): string {
  return w.replace(PUNCT_EDGE, "");
}

/** 워드뱅크/청킹 토큰화 — L2 문장을 타일 단위로. */
export function cleanTokens(l2: string): string[] {
  return l2
    .replace(/[—–]/g, " ")
    .split(/\s+/)
    .map(cleanWord)
    .filter(Boolean);
}
