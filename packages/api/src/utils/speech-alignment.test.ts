import { describe, expect, it } from "vitest";

import { wordsFromCharTimestamps } from "./speech-alignment";

describe("wordsFromCharTimestamps", () => {
  it("groups per-character timing into words spanning first to last character", () => {
    expect(
      wordsFromCharTimestamps({
        graphChars: ["H", "i", " ", "y", "o", "u"],
        graphTimes: [
          [0, 0.1],
          [0.1, 0.2],
          [0.2, 0.3],
          [0.3, 0.4],
          [0.4, 0.5],
          [0.5, 0.6],
        ],
      }),
    ).toEqual([
      { text: "Hi", start: 0, end: 0.2 },
      { text: "you", start: 0.3, end: 0.6 },
    ]);
  });
});
