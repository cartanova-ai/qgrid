/** A word with its time span in seconds. */
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
