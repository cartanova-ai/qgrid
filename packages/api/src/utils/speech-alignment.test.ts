import { describe, expect, it } from "vitest";

import { alignScriptToWords, wordsFromCharTimestamps } from "./speech-alignment";

const spanOf = (alignment: ReturnType<typeof alignScriptToWords>, script: string, word: string) => {
  const from = script.indexOf(word);
  const times = alignment.audioTimestamps.graphTimes;

  return [times[from]![0], times[from + word.length - 1]![1]];
};

describe("alignScriptToWords", () => {
  it("spreads each heard word over its characters and gives spaces the pause", () => {
    const script = "Hi there.";
    const result = alignScriptToWords(
      script,
      [
        { text: "Hi", start: 0.1, end: 0.3 },
        { text: "there", start: 0.5, end: 1.0 },
      ],
      1.2,
    );

    expect(result.matchedWords).toBe(2);
    expect(result.audioTimestamps.graphChars.join("")).toBe(script);
    expect(result.audioTimestamps.graphTimes[0]).toEqual([0.1, 0.2]);
    expect(result.audioTimestamps.graphTimes[2]).toEqual([0.3, 0.5]); // the space
    expect(spanOf(result, script, "there.")).toEqual([0.5, 1.0]);
  });

  it("skips a spoken preamble, keeps a mis-heard name in place, and fills a dropped word", () => {
    const script = "I'm Carina. Nice to meet you.";
    const heard = [
      { text: "Okay,", start: 0.0, end: 0.3 },
      { text: "let's", start: 0.3, end: 0.5 },
      { text: "read", start: 0.5, end: 0.7 },
      { text: "I'm", start: 1.0, end: 1.2 },
      { text: "Karina,", start: 1.2, end: 1.7 },
      { text: "nice", start: 2.0, end: 2.3 },
      { text: "meet", start: 2.5, end: 2.8 },
      { text: "you.", start: 2.8, end: 3.1 },
    ];

    const result = alignScriptToWords(script, heard, 3.3);

    expect(result).toMatchObject({ matchedWords: 4, scriptWords: 6 });
    expect(spanOf(result, script, "I'm")).toEqual([1.0, 1.2]);
    expect(spanOf(result, script, "Carina.")).toEqual([1.2, 1.7]);
    // "to" was not heard: it takes the gap between "nice" and "meet".
    expect(spanOf(result, script, "to")).toEqual([2.3, 2.5]);
    expect(spanOf(result, script, "you.")).toEqual([2.8, 3.1]);
  });

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
