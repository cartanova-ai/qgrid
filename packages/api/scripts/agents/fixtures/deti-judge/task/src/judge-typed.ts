import { judgeAttempt, type Judgement } from "./judge.ts";

/**
 * 타이핑 드릴 판정 진입점 — 타일 대신 문장을 키보드로 직접 치는 모드.
 *
 * 입력은 공백으로 토큰화해 워드뱅크 판정(`judgeAttempt`)에 그대로 넘긴다. 대소문자는 판정 쪽에서
 * 무시한다.
 */
export function judgeTyped(input: string, l2: string): Judgement {
  const built = input.trim().split(/\s+/).filter(Boolean);
  const answer = l2.split(" ");
  return judgeAttempt(built, answer);
}
