// deti 드릴 판정 — packages/web/src/components/short/play/core-session.ts 의 판정 부분 발췌(2026-11-05).
// 워드뱅크 타일 배열(built)과 정본 토큰 배열(answer)을 비교한다. 두 배열 모두 cleanTokens 로 정제된 토큰이어야 한다.
import { SD } from "./i18n.ts";

export type DrillHint = { msg: string; target: string | null };

// ── near/far 판정 (GEN-297, 확장 GEN-302) ──
// 니어미스(짚기·자가수정, 하강 아님) 네 갈래 — 그 외 = 파미스(하강):
//   C  치환:   hint 붙은 near-miss distractor(전치사·3인칭s·관사 등)를 골랐다 → 그 hint 문구로 짚기.
//   ① 오배치: 정답 토큰만 썼고(멀티셋 동일) 위치 어긋남 ≤2 → wrong(built 위치) 짚기.
//   ② 누락:   답이 정답의 서브시퀀스이고 빠진 개수 ≤2 → missing(answer 위치) 빈자리 표기.
//   B  여분:   정답이 built 의 서브시퀀스이고 여분 ≤2 → extra(built 위치) "빼세요" 짚기(②의 대칭).
export type MissKind = "exact" | "near" | "far";

// 토큰 멀티셋 카운트.
function tokenCounts(arr: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of arr) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

// 니어미스 예산 — 최대 이만큼의 단일 토큰 편집(치환/삽입/삭제)으로 정답이 되면 near.
export const NEAR_BUDGET = 2;

// 토큰 배열 편집거리(Levenshtein). NEAR_BUDGET 초과가 확정되면 조기 종료(성능·의미 둘 다).
export function editDistance(a: string[], b: string[], cap = NEAR_BUDGET): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1; // 길이차만으로 예산 초과
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1; // 이 행의 최소가 이미 예산 초과 → 조기 종료
    prev = cur;
  }
  return prev[b.length] ?? cap + 1;
}

// ── 그룹 재배열 정규화 (GEN-345) ──
// 의미보존 그룹 재배열("at three thirty on Thursday" ↔ "on Thursday at three thirty")은
//   부사구 두 개가 통째로 이동한 것뿐이라 완벽히 맞는 문장인데, 편집거리로는 여러 토큰 이동 =
//   NEAR_BUDGET 초과 → far 직행이 된다. 재배열 자체를 거리에서 걷어내고(정규화) 정렬 후 남은
//   잔차(누락·치환·여분)가 0 이면 순수 재배열이므로 near 로 착지시킨다. 잔차가 남으면 구제하지
//   않는다 — 위치 이동과 빈 자리 채우기를 한꺼번에 시키면 안내가 오히려 헷갈린다.
//
// 하층(이 카드)은 far→near 구제까지만 담당. 상층(GEN-344)이 "이동한 청크가 위치자유 태그를
//   가지면 near→pass 승격"을 판단하므로, 정렬 결과(어떤 연속 청크가 통째로 이동했는가)를
//   ReorderAlignment 로 노출해 344 가 그대로 소비한다.

// 재배열로 통째 이동한 연속 청크 — 344 가 태그 조회에 쓴다. 토큰은 소문자(judge 내부 정규화 기준).
export type RearrangedChunk = {
  tokens: string[]; // 청크 토큰(소문자)
  builtRange: [number, number]; // 유저 입력 내 [start, endExclusive)
  answerRange: [number, number]; // 정본 내 [start, endExclusive)
  moved: boolean; // 자리를 옮겨야 하는 청크인가(제자리=안정 청크는 false) — UI 는 이동 청크만 묶어 표기
};

// 재배열 정규화 정렬 결과 — near/far 판정과 GEN-344(상층)가 공유하는 훅.
export type ReorderAlignment = {
  reordered: boolean; // 매칭 청크가 정본 대비 순서 어긋남(진짜 재배열)
  chunks: RearrangedChunk[]; // 매칭된 연속 청크(정본 순서로 정렬)
  missing: number[]; // 매칭 안 된 정본 위치(누락 잔차)
  extra: number[]; // 매칭 안 된 입력 위치(여분 잔차)
  residual: number; // 잔차 편집량 ≈ max(누락, 여분)
};

// 아직 소비되지 않은 위치들에서 built↔answer 최장 연속 공통 블록을 찾는다(그리디 앵커).
function longestUnusedBlock(
  built: string[],
  answer: string[],
  usedB: boolean[],
  usedA: boolean[],
): { len: number; bStart: number; aStart: number } {
  let best = { len: 0, bStart: -1, aStart: -1 };
  for (let i = 0; i < built.length; i++) {
    if (usedB[i]) continue;
    for (let j = 0; j < answer.length; j++) {
      if (usedA[j] || built[i] !== answer[j]) continue;
      let len = 0;
      while (
        i + len < built.length &&
        j + len < answer.length &&
        !usedB[i + len] &&
        !usedA[j + len] &&
        built[i + len] === answer[j + len]
      )
        len++;
      if (len > best.len) best = { len, bStart: i, aStart: j };
    }
  }
  return best;
}

// 재배열을 편집거리에서 분리(정규화)하는 청크 정렬.
//   1) 유저 입력을 정본에 최장 연속 청크부터 그리디로 매칭(위치 순서 무관 — 재배열 허용).
//   2) 매칭 청크들의 정본 순서 대비 입력 순서가 어긋나면 reordered=true(진짜 재배열).
//   3) 매칭 안 된 정본 위치=누락, 입력 위치=여분 → 잔차만 남는다.
//   built/answer 는 judgeAttempt 에서 이미 소문자로 정규화된 배열을 받는다(가정: 대소문자 무시).
export function alignReorder(built: string[], answer: string[]): ReorderAlignment {
  const usedB = built.map(() => false);
  const usedA = answer.map(() => false);
  const raw: { bStart: number; aStart: number; len: number }[] = [];
  for (;;) {
    const blk = longestUnusedBlock(built, answer, usedB, usedA);
    if (blk.len < 1) break;
    for (let k = 0; k < blk.len; k++) {
      usedB[blk.bStart + k] = true;
      usedA[blk.aStart + k] = true;
    }
    raw.push({ bStart: blk.bStart, aStart: blk.aStart, len: blk.len });
  }
  // 정본 순서로 정렬한 청크 목록(344 소비용).
  const sorted = raw.toSorted((x, y) => x.aStart - y.aStart);
  // 이동 청크 판별(GEN-345 후속) — 정본 순서로 정렬한 청크들의 built 시작 위치에서 최장 증가
  //   부분열(LIS)이 '제자리(안정)' 청크다. LIS 에 못 든 청크가 = 자리를 옮겨야 하는 이동 청크.
  //   (스왑이면 한쪽만 이동 청크로 잡혀 "이 덩어리만 옮기면 됨"이 명확해진다.)
  const starts = sorted.map((c) => c.bStart);
  const n = starts.length;
  const lisLen = starts.map(() => 1);
  const lisPrev = starts.map(() => -1);
  let lisEnd = -1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if ((starts[j] ?? 0) < (starts[i] ?? 0) && (lisLen[j] ?? 0) + 1 > (lisLen[i] ?? 0)) {
        lisLen[i] = (lisLen[j] ?? 0) + 1;
        lisPrev[i] = j;
      }
    }
    if (lisEnd < 0 || (lisLen[i] ?? 0) > (lisLen[lisEnd] ?? 0)) lisEnd = i;
  }
  const stable = new Set<number>();
  for (let k = lisEnd; k >= 0; k = lisPrev[k] ?? -1) stable.add(k);
  const chunks: RearrangedChunk[] = sorted.map((c, i) => ({
    tokens: answer.slice(c.aStart, c.aStart + c.len),
    builtRange: [c.bStart, c.bStart + c.len],
    answerRange: [c.aStart, c.aStart + c.len],
    moved: !stable.has(i),
  }));
  // 재배열 감지 — 이동 청크가 하나라도 있으면 순서가 어긋난 것(LIS 가 전체를 덮으면 제자리).
  const reordered = chunks.some((c) => c.moved);
  const missing = answer.flatMap((_, i) => (usedA[i] ? [] : [i]));
  const extra = built.flatMap((_, i) => (usedB[i] ? [] : [i]));
  const residual = Math.max(missing.length, extra.length);
  return { reordered, chunks, missing, extra, residual };
}

/**
 * 예상 오류 (GEN-397 ②③) — **우리가 미리 준비해 둔 틀린 배열.**
 *
 * `answer` 안의 `right` 연속 구간을 `wrong` 으로 갈아끼운 것이 곧 "그 함정에 빠진 답"이다.
 * 데이터 계약은 `drill-content.types` 쪽에 적어 뒀다(칩을 늘리지 않는 이유 포함).
 */
export type ExpectedError = { wrong: string[]; right: string[]; kind: string; hint: string };

/**
 * `wrong`/`right` 의 **공통 접두·접미 길이** (GEN-400) — 하이라이트를 좁히기 위한 것.
 *
 * LLM 이 예상 오류를 쓸 때 **맥락 앵커로 앞뒤 토큰을 끼워 넣는다**: `you say always` ↔
 * `you always say` 에서 `you` 는 양쪽에 같은 자리로 들어있다. 그런데 판정이 그 시퀀스를 통째로
 * 칠하면 제자리인 `you` 까지 빨개져 **"단어 3개가 틀렸다"** 로 읽힌다. 실제로 맞바꿀 건 둘뿐이다.
 *
 * **구제 판정은 건드리지 않는다** — 칠하는 범위만 줄인다. 전부 공통이면(=같은 배열) 짚을 자리가
 * 없어지므로 트림하지 않는다.
 */
export function trimCommonEdges(wrong: string[], right: string[]): { head: number; tail: number } {
  const w = wrong.map((t) => t.toLowerCase());
  const r = right.map((t) => t.toLowerCase());
  let head = 0;
  while (head < w.length && head < r.length && w[head] === r[head]) head++;
  let tail = 0;
  while (
    tail < w.length - head &&
    tail < r.length - head &&
    w[w.length - 1 - tail] === r[r.length - 1 - tail]
  )
    tail++;
  // 남는 게 없으면(양쪽이 같음) 트림하지 않는다 — 하이라이트가 사라지면 안 된다.
  if (head >= w.length) return { head: 0, tail: 0 };
  return { head, tail };
}

/** `answer` 의 `at` 위치부터 `seq` 가 그대로 이어지는가(소문자 비교 전제). */
function runsAt(answer: string[], seq: string[], at: number): boolean {
  return seq.every((s, k) => answer[at + k] === s);
}

/**
 * 답안이 **준비된 오류 하나로 전부 설명되는가.**
 *
 * `answer` 에서 `right` 가 나오는 자리를 전부 시도해, 그 구간만 `wrong` 으로 바꾼 배열이 답안과
 * **완전히 일치**하면 그 오류를 반환한다. 부분 일치·다른 자리 추가 오류는 전부 null 이다 —
 * 그게 남용 방지의 전부이고, 임계값이 없어서 조용히 느슨해질 여지가 없다(GEN-380 경계 유지).
 *
 * 여러 오류가 동시에 맞으면 **먼저 선언된 것**을 쓴다(데이터 순서 = 저자 의도 순서).
 */
export function matchExpectedError(
  builtRaw: string[],
  answerRaw: string[],
  errors: ExpectedError[] | undefined,
): { error: ExpectedError; at: number } | null {
  if (!errors || errors.length === 0) return null;
  const lc = (a: string[]): string[] => a.map((t) => t.toLowerCase());
  const built = lc(builtRaw);
  const answer = lc(answerRaw);
  for (const e of errors) {
    const right = lc(e.right);
    const wrong = lc(e.wrong);
    if (right.length === 0 || wrong.length === 0) continue;
    if (built.length !== answer.length - right.length + wrong.length) continue;
    for (let i = 0; i + right.length <= answer.length; i++) {
      if (!runsAt(answer, right, i)) continue;
      const expected = [...answer.slice(0, i), ...wrong, ...answer.slice(i + right.length)];
      // `at` 은 **매칭된 자리**다 — 첫 등장이 아니라. `right` 가 여러 번 나오는 문장에서
      //   ("say it again say it") 하이라이트가 엉뚱한 자리를 짚지 않게 하려는 것.
      if (expected.every((t, k) => t === built[k])) return { error: e, at: i };
    }
  }
  return null;
}

export type Judgement = {
  kind: MissKind;
  wrong: number[]; // 오배치(built 위치)·hint 붙은 치환 타일 위치
  missing: number[]; // 누락(answer 위치, 빈자리)
  extra: number[]; // 여분(built 위치, 빼야 할 타일)
  hintMsg: string | null; // near-miss distractor hint 문구(C) — 있으면 그대로 노출
  rearranged?: RearrangedChunk[]; // 재배열 정규화로 감지된 이동 청크(GEN-345) — GEN-344 소비용
  passNote?: string; // pass-with-note 승격 시 안내 문구 전체(GEN-344) — 그대로 노출
};

// 위치자유 담화표지 목록(GEN-344) — 부사구(부가어)와 안내 문구를 구분하기 위한 판별용. 소문자 표면.
//   여기 없으면 부사구(시간·장소·방법)로 간주해 "순서 바꿔도" 문구를 쓴다. 판정(pass 여부)엔 무관.
const FREE_MARKER_PHRASES = new Set([
  "by the way",
  "anyway",
  "anyhow",
  "though",
  "actually",
  "honestly",
  "to be honest",
  "incidentally",
  "for what it's worth",
  "come to think of it",
]);

// 위치자유 재배열 판정(GEN-344) — 잔차 0 재배열이 "위치자유 태그(부가어) 청크의 이동만으로 설명되는가".
//   재배열 청크(정본 순서 정렬) 중 모든 토큰이 free 인 청크를 위치자유(부가어)로 보고, 그 청크를
//   빼면 나머지(비태그=논항 등) 청크가 정본 순서 그대로(입력 순서 단조증가) 유지되면 → 이동의 원인이
//   오직 위치자유 부가어뿐이므로 pass-with-note. 반환값은 UX 안내 문구(담화표지/부사구 분기). 아니면 null.
function freeReorderNote(chunks: RearrangedChunk[], freeGroups: [number, number][]): string | null {
  // 청크가 위치자유 '구' 범위 전체와 정확히 일치할 때만 free 청크로 인정 — 구는 통째로만 이동
  //   가능하고 구 내부를 쪼갠 재배열(three→thirty three)은 청크가 구 전체와 안 맞아 탈락(near).
  const isFree = (c: RearrangedChunk): boolean =>
    freeGroups.some((g) => g[0] === c.answerRange[0] && g[1] === c.answerRange[1]);
  const freeChunks = chunks.filter(isFree);
  if (freeChunks.length === 0) return null;
  // 비태그(논항 등) 청크가 입력(built) 순서상 단조증가면(정본 순서=answerRange 정렬 기준) 순서 보존.
  const nonFree = chunks.filter((c) => !isFree(c));
  for (let i = 1; i < nonFree.length; i++) {
    if ((nonFree[i]?.builtRange[0] ?? 0) < (nonFree[i - 1]?.builtRange[0] ?? 0)) return null;
  }
  // 안내 문구 — 담화표지면 "어느 쪽에 붙여도", 부사구(시간·장소·방법)면 "순서를 바꿔도".
  const phrase = (freeChunks[0]?.tokens ?? []).join(" ");
  if (FREE_MARKER_PHRASES.has(phrase)) return SD("drill.judge.freePhrase")(phrase);
  return SD("drill.judge.flexibleOrder");
}

/**
 * 닫힌 부류 묶음 (GEN-383 폴백) — 서로 자리를 다투는 기능어들. 구형 데이터엔 오답의 대상(`for`)이
 * 없어서, 힌트를 "무관한 자리"에서 막으려면 유사도 판정이 필요하다. 형태 변화(어간 공유)와
 * 이 표만으로 힌트가 달리는 오답 대부분(관사·전치사·be동사·3인칭s·-ing)이 덮인다.
 */
const CLOSED_CLASS: string[][] = [
  ["a", "an", "the"],
  ["is", "am", "are", "was", "were", "be", "been", "being"],
  ["in", "on", "at", "to", "for", "of", "with", "by", "from", "about"],
  ["do", "does", "did", "done"],
  ["have", "has", "had"],
  ["this", "that", "these", "those"],
  ["much", "many", "few", "little"],
];

/**
 * 굴절 어미를 걷어낸 대략적 어간. 정밀 형태소 분석이 아니라 "같은 낱말의 변형인가"만 본다.
 *
 * 어미를 떼고 **끝의 묵음 e 도 함께 정규화**한다. 안 그러면 `leaves→leav` 와 `leave→leave` 가
 * 어긋나 같은 낱말이 남남이 된다(piled/pile, moves/move … 묵음 e 동사가 전부 샌다).
 * `ies→y` 도 같은 이유(tries/try).
 */
function stemOf(w: string): string {
  const t = w.toLowerCase().replace(/[^a-z']/g, "");
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  for (const suf of ["ing", "ed", "es", "s"]) {
    if (t.length > suf.length + 2 && t.endsWith(suf))
      return t.slice(0, -suf.length).replace(/e$/, "");
  }
  return t.replace(/e$/, "");
}

/**
 * 이 오답이 **그 자리**의 정답 토큰을 겨냥한 것인가.
 *
 * 힌트 문구는 "그 자리에 들어갈 단어 대신 이걸 넣었다"는 전제 위에 쓰였다. 대상을 안 보고
 * 표면형만으로 발화하면 엉뚱한 자리에서도 뜬다 — `am` 자리에 `knowing` 을 넣었는데 "-ing 가
 * 아니라 원형" 류 힌트가 떴던 게 그 예다(GEN-383). 대상이 기록돼 있으면 그것으로, 없으면
 * 어간·닫힌부류로 폴백한다.
 */
export function hintAppliesAt(hint: DrillHint, answerToken: string): boolean {
  const ans = answerToken.toLowerCase();
  if (hint.target) return hint.target.toLowerCase() === ans;
  return false;
}

/** 대상이 기록되지 않은 구형 데이터용 — 형태적으로 같은 낱말/부류인지. */
function looksRelated(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (stemOf(x) === stemOf(y)) return true;
  return CLOSED_CLASS.some((g) => g.includes(x) && g.includes(y));
}

export function judgeAttempt(
  builtRaw: string[],
  answerRaw: string[],
  hints?: Record<string, DrillHint>,
  freeGroups?: [number, number][],
  // 준비된 오류(GEN-397). 인자가 길어졌지만 전부 스텝에서 오는 재료라 묶는 건 별건으로 둔다 —
  //   판정 시그니처를 바꾸면 호출부 4곳이 한꺼번에 흔들려 회귀 위험이 크다.
  expected?: ExpectedError[],
): Judgement {
  // 대소문자 무시(GEN-299) — 워드뱅크 타일은 소문자로 표시돼 "The"(문장 첫)와 "the"(중간)를
  // 구분할 수 없다. 판정도 대소문자를 무시해야 순서가 맞는데 틀렸다고 나오지 않는다.
  const built = builtRaw.map((t) => t.toLowerCase());
  const answer = answerRaw.map((t) => t.toLowerCase());
  const none = { wrong: [] as number[], missing: [] as number[], extra: [] as number[] };
  if (built.length === answer.length && built.every((t, i) => t === answer[i])) {
    return { kind: "exact", ...none, hintMsg: null };
  }
  // 예상 오류(GEN-397) — **거리보다 먼저 본다.** 준비해 둔 오류와 일치하면 그건 "많이 틀린 답"이
  //   아니라 "정확히 그 함정에 빠진 답"이므로, 편집거리가 예산을 넘어도(다중 토큰 함정·어순) 짚어
  //   준다. 일치는 **답안 전체가 그 오류 하나로 설명될 때만** 성립하므로(matchExpectedError),
  //   다른 오류가 섞인 답은 여기서 안 걸리고 아래 갈래를 거쳐 GEN-380 대로 하강한다.
  const hit = matchExpectedError(builtRaw, answerRaw, expected);
  // ⚠️ **위치자유 재배열이 예상 오류를 이긴다**(GEN-344 우선). 자유 부가어 구를 옮긴 답은 완벽히
  //   맞는 영어라 통과시켜야 하는데(`in the restaurant on the second floor` ↔ 뒤바꿔도 자연스럽다),
  //   그걸 어순 오류로 선언해 두면 **정답을 틀렸다고 하게 된다**. 데이터에 실제로 그런 항목이
  //   있었다(실측 1건). 데이터는 언제든 다시 그럴 수 있으므로 판정에서 막는다.
  const freeAlign = hit ? alignReorder(built, answer) : null;
  const freePass =
    freeAlign?.reordered === true &&
    freeAlign.residual === 0 &&
    freeGroups !== undefined &&
    freeGroups.length > 0 &&
    freeReorderNote(freeAlign.chunks, freeGroups) !== null;
  if (hit && !freePass) {
    // 갈아끼운 구간이 built 에서 그 오류가 차지하는 자리다. 단 **양쪽 공통 앵커는 빼고** 짚는다
    //   (GEN-400) — 제자리인 토큰까지 칠하면 틀린 개수가 부풀어 보인다.
    const edge = trimCommonEdges(hit.error.wrong, hit.error.right);
    const from = hit.at + edge.head;
    const to = hit.at + hit.error.wrong.length - edge.tail; // exclusive
    return {
      kind: "near",
      wrong: Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k),
      missing: [],
      extra: [],
      hintMsg: hit.error.hint,
    };
  }
  // C 치환(GEN-302) — hint 붙은 near-miss distractor 를 골랐으면 그 hint 로 짚어준다.
  //   단 '교정 액션이 오답으로 귀결되면 안 된다'(GEN-302 후속): hint 만 있으면 무조건 near 로
  //   짚던 걸 전체 편집거리 ≤ NEAR_BUDGET 일 때로 게이트한다. 이러면 앞의 hint 를 고쳐도
  //   여전히 near/exact 로 수렴(near→near→exact)하고, 뒤가 완전히 틀려 거리가 크면 C 가 안 뜨고
  //   ①②B 도 성립 안 해 곧장 far(하강)로 간다.
  //   hint 조회는 원문(cleanWord 그대로) 기준 — hints 키가 그 형태다.
  //   길이 동일(=치환)일 때만 — hint 는 '정답 자리에 다른 단어를 잘못 넣은' 치환을 짚는 것이다.
  //   여분(built 이 더 긺)으로 hinted distractor 를 하나 더 넣은 경우엔 hint 가 아니라 아래 B 여분이
  //   "빼주세요"로 짚어야 맞다(hint 를 띄우면 '단어를 바꿔라'로 오도). 누락(더 짧음)도 ② 가 담당.
  if (hints && built.length === answer.length) {
    // **그 자리의 정답 토큰을 겨냥한 오답일 때만** 힌트를 띄운다(GEN-383). 예전엔 표면형만 보고
    //   발화해, 아무 상관 없는 자리에 놓아도 "-ing 가 아니라 원형" 같은 문구가 떴다.
    const hinted = builtRaw.flatMap((t, i) => {
      const h = hints[t];
      if (!h) return [];
      const ans = answerRaw[i] ?? "";
      const ok = h.target ? hintAppliesAt(h, ans) : looksRelated(t, ans);
      return ok ? [i] : [];
    });
    if (hinted.length > 0 && editDistance(built, answer) <= NEAR_BUDGET) {
      const key = builtRaw[hinted[0] ?? 0] ?? "";
      return {
        kind: "near",
        wrong: hinted,
        missing: [],
        extra: [],
        hintMsg: hints[key]?.msg ?? null,
      };
    }
  }
  const a = tokenCounts(answer);
  const b = tokenCounts(built);
  let sameMultiset = built.length === answer.length;
  if (sameMultiset) {
    for (const [t, c] of b) {
      if ((a.get(t) ?? 0) !== c) {
        sameMultiset = false;
        break;
      }
    }
  }
  // ① 오배치(개수 같음 + 위치 어긋남 ≤2)
  if (sameMultiset) {
    const wrong = built.flatMap((t, i) => (t === answer[i] ? [] : [i]));
    if (wrong.length <= 2) return { kind: "near", wrong, missing: [], extra: [], hintMsg: null };
  }
  // ①' 치환(GEN-340 후속) — 길이는 같은데 다른 단어를 ≤NEAR_BUDGET 개 넣음(can↔could 처럼 근접 치환).
  //   hint 없이도 near 로 처리 — 정답과 다른 위치를 짚어 재시도(틀린 게 아니라 표현 차이일 수 있어
  //   far 하강 대신). hint 붙은 근접 오답은 위 C 에서 이미 처리, 여기선 태그 안 된 소량 치환을 구제.
  //   메시지는 '순서'(오배치)가 아니라 '다른 단어'로 — 순서가 아니라 단어 자체가 다르기 때문.
  if (built.length === answer.length) {
    const wrong = built.flatMap((t, i) => (t === answer[i] ? [] : [i]));
    // 두 종류가 섞였으면 짚지 않고 하강한다(GEN-380). 어긋난 자리의 토큰이 정답 어딘가에 있으면
    //   **자리 문제**(옮기면 됨), 정답에 아예 없으면 **단어 문제**(바꿔야 함)다. 둘이 같이 있는데
    //   "다른 단어를 써볼까요?" 한 줄로 뭉뚱그리면 **틀린 안내**가 된다 — 옮기기만 하면 되는 타일까지
    //   버리라는 말이 되기 때문. 예: 정답 `good to know` / 답 `knowing to good` 에서 good 은 자리만
    //   틀렸는데 교체를 종용하게 된다. 이런 답은 near 로 구제하지 말고 rung 을 내려 도움을 준다.
    const kinds = new Set(wrong.map((i) => (a.has(built[i] ?? "") ? "move" : "swap")));
    if (wrong.length > 0 && wrong.length <= NEAR_BUDGET && kinds.size <= 1) {
      return {
        kind: "near",
        wrong,
        missing: [],
        extra: [],
        // 자리 문제만이면 '옮기기', 단어 문제만이면 '바꾸기' — 지시가 어긋나지 않게 문구를 가른다.
        hintMsg: kinds.has("move") ? SD("drill.judge.move") : SD("drill.judge.word"),
      };
    }
  }
  // ② 누락(답이 정답의 서브시퀀스 + 빠진 개수 ≤2) — 빠진 answer 위치를 짚어준다.
  if (built.length < answer.length && answer.length - built.length <= 2) {
    const missing: number[] = [];
    let bi = 0;
    for (let ai = 0; ai < answer.length; ai++) {
      if (bi < built.length && built[bi] === answer[ai]) bi++;
      else missing.push(ai);
    }
    if (bi === built.length) return { kind: "near", wrong: [], missing, extra: [], hintMsg: null };
  }
  // B 여분(정답이 built 의 서브시퀀스 + 여분 ≤2, GEN-302) — 빼야 할 built 위치를 짚어준다.
  if (built.length > answer.length && built.length - answer.length <= 2) {
    const extra: number[] = [];
    let ai = 0;
    for (let bi = 0; bi < built.length; bi++) {
      if (ai < answer.length && built[bi] === answer[ai]) ai++;
      else extra.push(bi);
    }
    if (ai === answer.length) return { kind: "near", wrong: [], missing: [], extra, hintMsg: null };
  }
  // 그룹 재배열 정규화(GEN-345) — 위 갈래(순서 유지 전제)를 모두 통과하지 못한 뒤에만 시도한다.
  //   재배열을 거리에서 걷어내고 남은 잔차가 0(순수 재배열)이면 far→near 로 구제한다. 재배열 없는
  //   순수 누락/치환은 위에서 이미 처리됐고 여기선 reordered=false 라 발동 안 함 → 기존 동작 불변.
  //   상층(GEN-344)은 반환된 rearranged 청크의 위치자유 태그를 보고 near→pass 를 판단한다.
  const align = alignReorder(built, answer);
  if (align.reordered) {
    // pass-with-note 승격(GEN-344) — 재배열이 위치자유 부가어(담화표지·부사구) 이동만으로 설명되고
    //   잔차 0 이면, 유저 답도 완벽히 맞는 영어다 → exact 로 통과시키되 안내를 붙인다. 태그 없거나
    //   (freeGroups 빈 배열) 논항 이동·구 내부 뒤섞임이면 아래 GEN-345 near 로 안전하게 떨어진다.
    if (align.residual === 0 && freeGroups && freeGroups.length > 0) {
      const note = freeReorderNote(align.chunks, freeGroups);
      if (note) return { kind: "exact", ...none, hintMsg: null, passNote: note };
    }
    // 그룹 재배열 정규화 near 구제(GEN-345) — **잔차 0(순수 재배열)일 때만.**
    //   누락·잉여까지 겹치면 "위치도 옮기고 빈 자리도 채우라"는 두 가지를 한 번에 시키는 셈이라
    //   오히려 헷갈린다. 그런 답은 구제하지 말고 far 로 떨어뜨려 rung 을 내리는 편이 자연스럽다.
    if (align.residual === 0) {
      return {
        kind: "near",
        wrong: [],
        missing: [],
        extra: [],
        // 화면에 옮길 청크가 이미 짚여 있다(rearranged) → "무엇이" 아니라 "여기가 아니다"만 말한다.
        hintMsg: SD("drill.judge.position"),
        rearranged: align.chunks,
      };
    }
  }
  return { kind: "far", ...none, hintMsg: null };
}
