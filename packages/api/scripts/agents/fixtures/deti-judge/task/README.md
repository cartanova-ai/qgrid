# deti 드릴 판정 모듈 (발췌)

deti 웹의 학습 드릴 판정 로직을 떼어 낸 저장소다. Node 22 이상에서 TypeScript 파일을 그대로 실행한다
(타입 제거 전용 문법만 사용). 의존성 설치는 필요 없다.

- `src/word-clean.ts` — 워드뱅크 토큰 정제. **드릴 판정·출제·인스펙터가 공유하는 정본 토크나이저.**
- `src/judge.ts` — `judgeAttempt(built, answer, hints?, freeGroups?, expected?)`: 타일 배열끼리 비교해
  `exact` / `near`(짚기) / `far`(하강)를 판정한다. 워드뱅크 드릴이 쓰는 진입점.
- `src/judge-typed.ts` — `judgeTyped(input, l2)`: 키보드로 문장을 직접 치는 타이핑 드릴의 진입점.
- `src/i18n.ts` — 판정 문구.

## 테스트

```
npm test        # node --test src/*.test.ts
```

## 화면 문구

`Judgement.missing` 이 비어 있지 않으면 화면은 그 자리를 빈칸으로 짚고 "여기 빠진 자리가 있어요"를 띄운다.
