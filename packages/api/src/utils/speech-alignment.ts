/** A word an STT model heard, with its time span in seconds. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** Per-character timing in the shape Grok TTS returns (`with_timestamps`). */
export interface CharTimestamps {
  graphChars: string[];
  graphTimes: Array<[number, number]>;
}

const normalize = (word: string) =>
  word
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, "");

/**
 * Infers per-character timing for a known script from the words an STT model heard in its audio.
 * Script and heard words are paired by an edit-distance alignment, so a mis-heard word (a name
 * spelled differently, a number written out) still takes the time of the word in its place, and
 * extra heard words (a spoken preamble) are skipped. Script words left unpaired get the gap
 * between their neighbours; each word's span is split over its characters by position, and the
 * whitespace between words takes the pause between them. `durationSec` bounds leading and
 * trailing gaps. `matchedWords` counts script words heard exactly (after normalization).
 */
export function alignScriptToWords(script: string, words: TimedWord[], durationSec: number) {
  const tokens = [...script.matchAll(/\S+/g)].map((m) => ({
    from: m.index,
    to: m.index + m[0].length,
    norm: normalize(m[0]),
  }));

  const heard = words.flatMap((w) => {
    const norm = normalize(w.text);

    return norm === "" ? [] : [{ ...w, norm }];
  });

  const n = tokens.length;
  const m = heard.length;
  const width = m + 1;
  const cost = new Uint32Array((n + 1) * width);

  for (let i = 0; i <= n; i++) cost[i * width] = i;

  for (let j = 0; j <= m; j++) cost[j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = tokens[i - 1]!.norm === heard[j - 1]!.norm;

      cost[i * width + j] = Math.min(
        cost[(i - 1) * width + (j - 1)]! + (same ? 0 : 1),
        cost[(i - 1) * width + j]! + 1,
        cost[i * width + (j - 1)]! + 1,
      );
    }
  }

  // Walk back from the corner; prefer pairing over skipping so each script word keeps a time.
  const spans: Array<[number, number] | undefined> = Array.from({ length: n });
  let matchedWords = 0;

  for (let i = n, j = m; i > 0 || j > 0;) {
    const here = cost[i * width + j]!;
    const same = i > 0 && j > 0 && tokens[i - 1]!.norm === heard[j - 1]!.norm;

    if (i > 0 && j > 0 && here === cost[(i - 1) * width + (j - 1)]! + (same ? 0 : 1)) {
      spans[i - 1] = [heard[j - 1]!.start, heard[j - 1]!.end];

      if (same) matchedWords++;
      i--;
      j--;
    } else if (i > 0 && here === cost[(i - 1) * width + j]! + 1) {
      i--; // script word not heard: filled from its neighbours below
    } else {
      j--; // extra heard word (e.g. a spoken preamble): skipped
    }
  }

  fillGaps(spans, tokens, durationSec);

  // Each character of a word takes its share of the word's span; characters between words (spaces)
  // take the pause from the previous word's end to the next word's start.
  const graphChars: string[] = [];
  const graphTimes: Array<[number, number]> = [];
  let token = 0;
  let previousEnd = 0;

  for (let c = 0; c < script.length;) {
    const char = String.fromCodePoint(script.codePointAt(c)!);

    while (token < n && tokens[token]!.to <= c) token++;
    const current = tokens[token];

    if (current && current.from <= c) {
      const [start, end] = spans[token]!;
      const length = current.to - current.from;
      const offset = c - current.from;

      const span: [number, number] = [
        start + ((end - start) * offset) / length,
        start + ((end - start) * (offset + char.length)) / length,
      ];

      graphTimes.push(span);
      previousEnd = span[1];
    } else {
      const nextStart = current ? spans[token]![0] : durationSec;
      graphTimes.push([previousEnd, Math.max(previousEnd, nextStart)]);
    }

    graphChars.push(char);
    c += char.length;
  }

  return { audioTimestamps: { graphChars, graphTimes }, matchedWords, scriptWords: n };
}

/** Gives unpaired script words a slice of the gap between paired neighbours, by length. */
function fillGaps(
  spans: Array<[number, number] | undefined>,
  tokens: Array<{ from: number; to: number }>,
  durationSec: number,
): void {
  for (let k = 0; k < spans.length;) {
    if (spans[k]) {
      k++;
      continue;
    }

    let last = k;

    while (last + 1 < spans.length && !spans[last + 1]) last++;
    const gapStart = k > 0 ? spans[k - 1]![1] : 0;
    const gapEnd = last + 1 < spans.length ? spans[last + 1]![0] : durationSec;
    const lengths = tokens.slice(k, last + 1).map((t) => t.to - t.from);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let cursor = gapStart;

    lengths.forEach((length, offset) => {
      const width = ((gapEnd - gapStart) * length) / total;
      spans[k + offset] = [cursor, cursor + width];
      cursor += width;
    });

    k = last + 1;
  }
}

/** Words from per-character timing: each run of non-space characters, spanning its first to last. */
export function wordsFromCharTimestamps(timestamps: CharTimestamps): TimedWord[] {
  const words: TimedWord[] = [];
  let current: TimedWord | undefined;

  timestamps.graphChars.forEach((char, i) => {
    const [start, end] = timestamps.graphTimes[i]!;

    if (/\s/.test(char)) {
      current = undefined;

      return;
    }

    if (current) {
      current.text += char;
      current.end = end;
    } else {
      current = { text: char, start, end };
      words.push(current);
    }
  });

  return words;
}
