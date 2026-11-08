import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeTyped } from "./judge-typed.ts";

test("judgeTyped — 정확히 치면 exact", () => {
  assert.equal(judgeTyped("good to know", "good to know").kind, "exact");
});

test("judgeTyped — 대소문자는 무시한다", () => {
  assert.equal(judgeTyped("Good To Know", "good to know").kind, "exact");
});

test("judgeTyped — 한 단어가 빠지면 near + missing", () => {
  const r = judgeTyped("good know", "good to know");
  assert.equal(r.kind, "near");
  assert.deepEqual(r.missing, [1]);
});
