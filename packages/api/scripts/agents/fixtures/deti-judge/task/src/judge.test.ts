import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { judgeAttempt } from "./judge.ts";

/**
 * 판정 갈래 회귀 (GEN-380) — 특히 **오답 종류가 섞였을 때 하강**하는지.
 *
 * 섞인 답을 near 로 구제하면 안내가 틀린다: "다른 단어를 써볼까요?" 는 자리만 옮기면 되는 타일까지
 * 버리라는 말이 된다. 그런 답은 짚지 말고 rung 을 내려 도움을 주는 게 이 프로젝트의 결정이다.
 */

const j = (built: string, answer: string) => judgeAttempt(built.split(" "), answer.split(" "));
const jh = (
  built: string,
  answer: string,
  hints: Record<string, { msg: string; target: string | null }>,
) => judgeAttempt(built.split(" "), answer.split(" "), hints);

describe("judgeAttempt — 오답 종류가 섞이면 하강", () => {
  test("자리 문제 + 단어 문제가 섞이면 far (실제 리포트 케이스)", () => {
    // good 은 정답에 있는 단어라 '옮기면 되는' 자리 문제, knowing 은 정답에 없어 '바꿔야 하는' 단어 문제.
    assert.equal(j("knowing to good", "good to know").kind, "far");
  });

  test("단어 문제만이면 near — '다른 단어' 로 안내", () => {
    const r = j("good to known", "good to know");
    assert.equal(r.kind, "near");
    assert.equal(r.hintMsg, "여기, 다른 단어를 써볼까요?");
  });

  test("자리 문제만이면 near — '자리를 옮기기' 로 안내", () => {
    // 멀티셋이 같으면 ① 오배치가 먼저 잡으므로, 여기서는 멀티셋이 다르면서 자리 문제만인 경우를 본다.
    assert.equal(j("to good know", "good to know").kind, "near");
  });
});

describe("judgeAttempt — 기존 갈래 회귀", () => {
  test("완전 일치는 exact", () => {
    assert.equal(j("good to know", "good to know").kind, "exact");
  });

  test("같은 단어들의 순서만 어긋나면 near(오배치) — 어긋난 자리를 짚는다", () => {
    const r = j("to good know", "good to know");
    assert.equal(r.kind, "near");
    assert.ok(r.wrong.length > 0);
  });

  test("순수 재배열은 near — 옮길 덩어리만 짚는다", () => {
    const r = j("waiting I here was", "I was waiting here");
    assert.equal(r.kind, "near");
    assert.equal(r.hintMsg, "이 위치가 아니에요.");
  });

  test("여분 타일은 near — 뺄 자리를 짚는다", () => {
    const r = j("your you spot", "your spot");
    assert.equal(r.kind, "near");
    assert.equal(r.extra.length, 1);
  });

  test("누락은 near — 빠진 자리를 짚는다", () => {
    const r = j("good know", "good to know");
    assert.equal(r.kind, "near");
    assert.equal(r.missing.length, 1);
  });

  test("완전히 다른 답은 far", () => {
    assert.equal(j("what is this thing", "good to know").kind, "far");
  });
});

describe("judgeAttempt — 힌트는 겨냥한 자리에서만 뜬다 (GEN-383)", () => {
  const KNOWING = { msg: "-ing 가 아니라 원형이에요", target: "know" };

  test("겨냥한 정답 토큰 자리에 놓였으면 힌트를 띄운다", () => {
    const r = jh("good to knowing", "good to know", { knowing: KNOWING });
    assert.equal(r.kind, "near");
    assert.equal(r.hintMsg, KNOWING.msg);
  });

  test("무관한 자리에 놓였으면 그 힌트를 띄우지 않는다 — 리포트 케이스", () => {
    // 정답은 그 자리에 am. knowing 은 know 를 겨냥한 오답이라 여기선 그냥 틀린 단어다.
    const r = jh("how knowing i", "how am i", { knowing: KNOWING });
    assert.notEqual(r.hintMsg, KNOWING.msg);
  });

  test("대상이 기록되지 않은 구형 데이터는 어간으로 폴백한다", () => {
    const legacy = { msg: "-ing 가 아니라 원형이에요", target: null };
    assert.equal(jh("good to knowing", "good to know", { knowing: legacy }).hintMsg, legacy.msg);
    assert.notEqual(jh("how knowing i", "how am i", { knowing: legacy }).hintMsg, legacy.msg);
  });

  test("닫힌 부류(관사·be동사)도 폴백이 잡는다", () => {
    const art = { msg: "모음 앞이라 an 이에요", target: null };
    assert.equal(jh("a apple please", "an apple please", { a: art }).hintMsg, art.msg);
  });
});

describe("어간 폴백 — 묵음 e 동사 (GEN-383)", () => {
  const H = (msg: string) => ({ msg, target: null });
  test("leaves ↔ leave 를 같은 낱말로 본다", () => {
    const h = { leaves: H("does 뒤엔 원형 leave를 써요") };
    assert.equal(jh("does it leaves", "does it leave", h).hintMsg, h.leaves.msg);
  });
  test("piled ↔ pile", () => {
    const h = { pile: H("지난 일이라 piled를 써요") };
    assert.equal(jh("i pile those", "i piled those", h).hintMsg, h.pile.msg);
  });
  test("tries ↔ try", () => {
    const h = { tries: H("원형 try 예요") };
    assert.equal(jh("he tries hard", "he try hard", h).hintMsg, h.tries.msg);
  });
  test("무관한 낱말은 여전히 안 붙는다", () => {
    const h = { anything: H("긍정문엔 something을 써요") };
    assert.notEqual(jh("i want anything now", "i want coffee now", h).hintMsg, h.anything.msg);
  });
});
