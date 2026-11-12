// i18n 발췌 — 판정 문구만. 원본: packages/web/src/i18n/ko.ts
const MESSAGES = {
  "drill.judge.flexibleOrder": "시간·장소를 나타내는 말은 순서를 바꿔도 자연스러워요.",
  "drill.judge.move": "여기, 자리를 옮겨볼까요?",
  "drill.judge.word": "여기, 다른 단어를 써볼까요?",
  "drill.judge.position": "이 위치가 아니에요.",
  "drill.judge.freePhrase": (phrase: string) => `"${phrase}"는 어느 쪽에 붙여도 자연스러워요.`,
  "drill.feedback.missing": "여기 빠진 자리가 있어요",
} as const;

export function SD<K extends keyof typeof MESSAGES>(key: K): (typeof MESSAGES)[K] {
  return MESSAGES[key];
}
