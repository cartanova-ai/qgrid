import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeTyped } from "./judge-typed.ts";

// 신고 #10 — 지문을 그대로 쳤는데 "여기 빠진 자리가 있어요"
test("hidden: 물음표가 붙은 지문을 그대로 치면 exact", () => {
  assert.equal(judgeTyped("how do I get there", "How do I get there?").kind, "exact");
});
test("hidden: 소문자로 쳐도 exact", () => {
  assert.equal(judgeTyped("how do i get there", "How do I get there?").kind, "exact");
});
test("hidden: 입력에도 물음표를 붙이면 exact", () => {
  assert.equal(judgeTyped("how do I get there?", "How do I get there?").kind, "exact");
});
test("hidden: 마침표·쉼표가 섞인 지문", () => {
  assert.equal(judgeTyped("yes it works", "Yes, it works.").kind, "exact");
});
test("hidden: 내부 아포스트로피는 유지된다", () => {
  assert.equal(judgeTyped("i'm fine", "I'm fine.").kind, "exact");
});
test("hidden: 앞뒤·중간 공백이 어긋나도 exact", () => {
  assert.equal(judgeTyped("  how  do I get there ", "How do I get there?").kind, "exact");
});
test("hidden: 진짜 누락은 여전히 짚는다", () => {
  const r = judgeTyped("how do get there", "How do I get there?");
  assert.equal(r.kind, "near");
  assert.deepEqual(r.missing, [2]);
});
