import { afterEach, describe, expect, it, vi } from "vitest";

import {
  alignSpeech,
  charTimestamps,
  forcedAlign,
  scriptTargets,
  SpeechAlignerUnavailableError,
} from "./speech-aligner";

const BLANK = 0;
const H = 18;
const I = 5;
const STAR = 31;

/** Emission rows (log-probabilities) where each frame strongly favours the given class. */
function frames(...classes: number[]): Float64Array[] {
  return classes.map((favoured) => {
    const row = new Float64Array(32).fill(Math.log(0.001));
    row[favoured] = Math.log(0.97);
    row[STAR] = 0;

    return row;
  });
}

describe("scriptTargets", () => {
  it("spells Latin letters, romanizes Hangul, strips accents, and stars digit runs", () => {
    expect(scriptTargets(Array.from("Hi 쿠마")).ids).toEqual([H, I, 14, 9, 13, 4]);
    expect(scriptTargets(Array.from("café")).ids).toEqual([23, 4, 27, 6]);

    const twentyFirst = scriptTargets(Array.from("21st"));
    expect(twentyFirst.ids).toEqual([STAR, 11, 10]);
    expect(twentyFirst.owners[0]).toEqual([0, 1]);

    // Silent punctuation keeps one star over "3:30"; whitespace ends a run.
    expect(scriptTargets(Array.from("3:30")).owners).toEqual([[0, 2, 3]]);
    expect(scriptTargets(Array.from("1 2")).ids).toEqual([STAR, STAR]);
  });
});

describe("forcedAlign", () => {
  it("walks the script's tokens through the frames in order", () => {
    expect(forcedAlign(frames(BLANK, H, H, I, BLANK), [H, I])).toEqual([
      [1, 3],
      [3, 4],
    ]);
  });

  it("lets a leading star absorb speech before the script", () => {
    // The audio says "hi" twice; the script is the second "hi".
    const emissions = frames(H, I, BLANK, BLANK, H, I);
    const [, h, i] = forcedAlign(emissions, [STAR, H, I]);

    expect([h, i]).toEqual([
      [4, 5],
      [5, 6],
    ]);
  });
});

describe("charTimestamps", () => {
  it("keeps words contiguous, gives spaces the pause, and splits a star over its digits", () => {
    const chars = Array.from("hi, 21");
    const owners = [[0], [1], [4, 5]];
    const spans: Array<[number, number]> = [
      [0, 1],
      [2, 3],
      [6, 10],
    ];

    expect(charTimestamps(chars, owners, spans, 0.1, 1.2).graphTimes).toEqual([
      [0, 0.2], // h runs until i starts
      [0.2, 0.3],
      [0.3, 0.3], // comma: zero length after "i"
      [0.3, 0.6], // space: the pause to the next word
      [0.6, 0.8],
      [0.8, 1],
    ]);
  });
});

describe("alignSpeech", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports a missing model as unavailable", async () => {
    vi.stubEnv("QGRID_ALIGNER_MODEL", "");

    await expect(alignSpeech(new Uint8Array(4800), 24_000, "hi")).rejects.toBeInstanceOf(
      SpeechAlignerUnavailableError,
    );
  });
});
