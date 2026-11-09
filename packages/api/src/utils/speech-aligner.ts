import { existsSync } from "node:fs";

import type * as Ort from "onnxruntime-node";

import { type CharTimestamps } from "./speech-alignment";

/**
 * In-process forced alignment of a known script to its speech, used for OpenAI realtime speech,
 * which carries no timing. The model is MMS-FA (Meta's CTC forced aligner, 1,130 languages,
 * CC-BY-NC 4.0) quantized to int8 ONNX: it scores every 20 ms frame of 16 kHz audio against 28
 * letters, and a Viterbi pass walks the script's letters through those scores in order.
 *
 * The model file (`QGRID_ALIGNER_MODEL`) and `onnxruntime-node` ship only in the Docker image; any
 * other install lacks them and the caller reports the error as `timestampsError`.
 */

const SAMPLE_RATE = 16_000;
const SAMPLES_PER_FRAME = 320;
const BLANK = 0;

// Model output ids 4..30, in this order (vocab of the HF conversion of torchaudio MMS_FA).
const LETTERS = "aienoutsrmkldghybpwcvjzf'qx";
const LETTER_ID = new Map([...LETTERS].map((letter, i) => [letter, i + 4]));

// Extra emission column with log-probability 0: it matches any sound. Wrapped around the script it
// absorbs speech that is not in it (a spoken preamble); over digits and other unspellable text it
// takes however they were read (a penalty made long numbers push their neighbours away instead).
const STAR = 31;
const WINDOW_SAMPLES = 30 * SAMPLE_RATE;
const CONTEXT_SAMPLES = 2 * SAMPLE_RATE;
const IDLE_UNLOAD_MS = 10 * 60_000;

// Viterbi back-pointers take frames x (2 x tokens + 1) bytes; 100 MB covers about 5 minutes of
// ordinary speech.
const MAX_TRELLIS_CELLS = 100_000_000;

export class SpeechAlignerUnavailableError extends Error {}

// Revised Romanization per syllable, without cross-syllable sound changes (enough for timing).
const INITIAL = "g kk n d tt r m b pp s ss _ j jj ch k t p h".split(" ");
const MEDIAL = "a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i".split(" ");
const FINAL = "_ k k k n n n t l k m l l l p l m p p t t ng t t k t p t".split(" ");
const syllable = (part: string) => (part === "_" ? "" : part);

function romanizeHangul(char: string): string | undefined {
  const code = char.codePointAt(0)! - 0xac00;

  if (code < 0 || code > 11171) return undefined;

  return (
    syllable(INITIAL[Math.floor(code / 588)]!) +
    MEDIAL[Math.floor((code % 588) / 28)]! +
    syllable(FINAL[code % 28]!)
  );
}

/**
 * The model letters a character is read as: "" when silent (spaces, punctuation), undefined when
 * spoken but not spellable in the model's alphabet (digits, currency signs, other scripts).
 */
function lettersOf(char: string): string | undefined {
  const plain = char
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'");

  if (plain !== "" && [...plain].every((letter) => LETTER_ID.has(letter))) return plain;
  const hangul = romanizeHangul(char);

  if (hangul !== undefined) return hangul;

  // ponytail: other scripts fall back to the star; port uroman when they need letter-level timing.
  return /[\p{L}\p{N}$€£¥%&@#+=]/u.test(char) ? undefined : "";
}

/** Model token ids for a script, with the characters (code point indices) each token covers. */
export function scriptTargets(chars: string[]) {
  const ids: number[] = [];
  const owners: number[][] = [];
  // A run of unspellable characters inside one word ("21", "3:30") is a single star.
  let starRun = false;

  chars.forEach((char, i) => {
    const letters = lettersOf(char);

    if (letters === undefined) {
      if (starRun) owners.at(-1)!.push(i);
      else {
        ids.push(STAR);
        owners.push([i]);
      }

      starRun = true;

      return;
    }

    if (letters !== "" || /\s/.test(char)) starRun = false;

    for (const letter of letters) {
      ids.push(LETTER_ID.get(letter)!);
      owners.push([i]);
    }
  });

  return { ids, owners };
}

/** Frame-wise log-softmax over the model classes plus the star column. */
function emissionRows(logits: Float32Array, frames: number, classes: number): Float64Array[] {
  return Array.from({ length: frames }, (_, t) => {
    const row = new Float64Array(classes + 1);
    let max = -Infinity;

    for (let c = 0; c < classes; c++) max = Math.max(max, logits[t * classes + c]!);
    let sum = 0;

    for (let c = 0; c < classes; c++) sum += Math.exp(logits[t * classes + c]! - max);
    const logSum = max + Math.log(sum);

    for (let c = 0; c < classes; c++) row[c] = logits[t * classes + c]! - logSum;
    row[STAR] = 0;

    return row;
  });
}

/** CTC Viterbi forced alignment: the [startFrame, endFrame) span of each target token. */
export function forcedAlign(emissions: Float64Array[], targets: number[]): Array<[number, number]> {
  const frames = emissions.length;
  const states = 2 * targets.length + 1;

  if (frames < targets.length) throw new Error("speech is too short for its script");

  if (frames * states > MAX_TRELLIS_CELLS) {
    const limitSec = Math.floor((MAX_TRELLIS_CELLS / states) * (SAMPLES_PER_FRAME / SAMPLE_RATE));

    throw new Error(
      `speech is too long to align: this script can be timed in up to ${limitSec} s of audio`,
    );
  }

  const label = (s: number) => (s % 2 === 0 ? BLANK : targets[(s - 1) / 2]!);
  const back = new Uint8Array(frames * states);
  let previous = new Float64Array(states).fill(-Infinity);

  previous[0] = emissions[0]![BLANK]!;
  previous[1] = emissions[0]![label(1)]!;

  for (let t = 1; t < frames; t++) {
    const current = new Float64Array(states).fill(-Infinity);

    for (let s = 0; s < states; s++) {
      let best = previous[s]!;
      let step = 0;

      if (s >= 1 && previous[s - 1]! > best) [best, step] = [previous[s - 1]!, 1];

      // Skipping the blank between two tokens is allowed unless they repeat the same label.
      if (s >= 2 && s % 2 === 1 && label(s) !== label(s - 2) && previous[s - 2]! > best) {
        [best, step] = [previous[s - 2]!, 2];
      }

      if (best === -Infinity) continue;
      current[s] = best + emissions[t]![label(s)]!;
      back[t * states + s] = step;
    }

    previous = current;
  }

  let s = previous[states - 1]! >= previous[states - 2]! ? states - 1 : states - 2;
  const spans = targets.map((): [number, number] => [Infinity, -Infinity]);

  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const span = spans[(s - 1) / 2]!;
      span[0] = Math.min(span[0], t);
      span[1] = Math.max(span[1], t + 1);
    }

    s -= back[t * states + s]!;
  }

  return spans;
}

const seconds = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Per-character timing from token spans: a star's span is split evenly over its characters; inside
 * a word each timed character runs until the next one starts, untimed characters (punctuation)
 * take zero length after the previous one, and whitespace takes the pause between words.
 */
export function charTimestamps(
  chars: string[],
  owners: number[][],
  spans: Array<[number, number]>,
  secondsPerFrame: number,
  durationSec: number,
): CharTimestamps {
  const timed: Array<[number, number] | undefined> = chars.map(() => undefined);

  spans.forEach(([start, end], k) => {
    const covered = owners[k]!;
    const width = (end - start) / covered.length;

    covered.forEach((i, n) => {
      const part: [number, number] = [start + width * n, start + width * (n + 1)];
      const previous = timed[i];
      timed[i] = previous ? [Math.min(previous[0], part[0]), Math.max(previous[1], part[1])] : part;
    });
  });

  const graphTimes: Array<[number, number]> = chars.map(() => [0, 0]);
  let wordEnd = 0;

  for (let i = 0; i < chars.length;) {
    if (/\s/.test(chars[i]!)) {
      let j = i;

      while (j < chars.length && /\s/.test(chars[j]!)) j++;
      const next = timed.slice(j).find(Boolean);
      const nextStart = next ? next[0] * secondsPerFrame : durationSec;

      for (let k = i; k < j; k++)
        graphTimes[k] = [seconds(wordEnd), seconds(Math.max(wordEnd, nextStart))];
      i = j;
      continue;
    }

    let j = i;

    while (j < chars.length && !/\s/.test(chars[j]!)) j++;
    const word = Array.from({ length: j - i }, (_, n) => i + n);
    const timedInWord = word.filter((k) => timed[k]);
    let cursor = timedInWord.length > 0 ? timed[timedInWord[0]!]![0] * secondsPerFrame : wordEnd;

    for (const k of word) {
      const span = timed[k];

      if (!span) {
        graphTimes[k] = [seconds(cursor), seconds(cursor)];
        continue;
      }

      const nextTimed = timedInWord[timedInWord.indexOf(k) + 1];
      const end = (nextTimed === undefined ? span[1] : timed[nextTimed]![0]) * secondsPerFrame;
      graphTimes[k] = [seconds(span[0] * secondsPerFrame), seconds(end)];
      cursor = end;
    }

    wordEnd = cursor;
    i = j;
  }

  return { graphChars: chars, graphTimes };
}

/** PCM16 little-endian mono at `sampleRate` to 16 kHz float samples (linear interpolation). */
function to16kFloat(pcm: Uint8Array, sampleRate: number): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const inputLength = Math.floor(pcm.byteLength / 2);
  const ratio = sampleRate / SAMPLE_RATE;
  const output = new Float32Array(Math.floor(inputLength / ratio));

  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, inputLength - 1);
    const a = view.getInt16(left * 2, true);
    const b = view.getInt16(right * 2, true);
    output[i] = (a + (b - a) * (position - left)) / 32768;
  }

  return output;
}

function normalized(samples: Float32Array): Float32Array {
  const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
  const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / samples.length;
  const std = Math.sqrt(variance) || 1;

  return samples.map((x) => (x - mean) / std);
}

interface LoadedModel {
  ort: typeof Ort;
  session: Ort.InferenceSession;
}

let model: Promise<LoadedModel> | undefined;
let inFlight = 0;
let idleTimer: NodeJS.Timeout | undefined;

/** Loads the session on first use; it is released after IDLE_UNLOAD_MS without requests. */
async function loadModel(): Promise<LoadedModel> {
  const path = process.env.QGRID_ALIGNER_MODEL;

  if (!path || !existsSync(path)) {
    throw new SpeechAlignerUnavailableError(
      "speech aligner model is not installed (set QGRID_ALIGNER_MODEL)",
    );
  }

  model ??= openModel(path);

  try {
    return await model;
  } catch (error) {
    model = undefined;
    throw error;
  }
}

async function openModel(path: string): Promise<LoadedModel> {
  let ort: typeof Ort;

  try {
    ort = await import("onnxruntime-node");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new SpeechAlignerUnavailableError(
      `speech aligner runtime onnxruntime-node failed to load: ${reason}`,
    );
  }

  return { ort, session: await ort.InferenceSession.create(path) };
}

function scheduleUnload(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight > 0 || !model) return;
    const releasing = model;
    model = undefined;
    void releasing.then(({ session }) => session.release()).catch(() => undefined);
  }, IDLE_UNLOAD_MS);
  idleTimer.unref();
}

/** Model emissions for the whole clip, computed in 30 s windows with 2 s of context per side. */
async function emissionsFor(loaded: LoadedModel, samples: Float32Array): Promise<Float64Array[]> {
  const rows: Float64Array[] = [];

  for (let start = 0; start < samples.length; start += WINDOW_SAMPLES) {
    const from = Math.max(0, start - CONTEXT_SAMPLES);
    const to = Math.min(samples.length, start + WINDOW_SAMPLES + CONTEXT_SAMPLES);
    const chunk = normalized(samples.subarray(from, to));

    const output = await loaded.session.run({
      input_values: new loaded.ort.Tensor("float32", chunk, [1, chunk.length]),
    });

    const logits = output.logits!;
    // SAFETY: the MMS-FA export emits `logits` as float32 [batch, frames, classes].
    const [, frames, classes] = logits.dims as [number, number, number];
    const skip = (start - from) / SAMPLES_PER_FRAME;
    const keep = Math.ceil(Math.min(WINDOW_SAMPLES, samples.length - start) / SAMPLES_PER_FRAME);
    // SAFETY: float32 tensors expose their data as Float32Array.
    const windowRows = emissionRows(logits.data as Float32Array, frames, classes);

    rows.push(...windowRows.slice(skip, skip + keep));
  }

  return rows;
}

/**
 * Per-character timing of `script` in PCM16 mono speech. Throws SpeechAlignerUnavailableError when
 * the model or runtime is missing, and Error when the script has nothing to align or the audio is
 * too short or too long.
 */
export async function alignSpeech(
  pcm: Uint8Array,
  sampleRate: number,
  script: string,
): Promise<CharTimestamps> {
  const chars = Array.from(script);
  const { ids, owners } = scriptTargets(chars);

  if (!ids.some((id) => id !== STAR)) throw new Error("script has no letters to align");
  // Counted before the model is awaited, so the idle unload cannot release it under this request.
  inFlight++;

  try {
    const loaded = await loadModel();
    const samples = to16kFloat(pcm, sampleRate);
    const emissions = await emissionsFor(loaded, samples);
    const durationSec = pcm.byteLength / 2 / sampleRate;
    const secondsPerFrame = samples.length / SAMPLE_RATE / emissions.length;
    // Edge stars, unless the script already starts or ends with one (repeated labels need a blank).
    const lead = ids[0] === STAR ? [] : [STAR];
    const tail = ids.at(-1) === STAR ? [] : [STAR];
    const targets = [...lead, ...ids, ...tail];
    const spans = forcedAlign(emissions, targets).slice(lead.length, lead.length + ids.length);

    return charTimestamps(chars, owners, spans, secondsPerFrame, durationSec);
  } finally {
    inFlight--;
    scheduleUnload();
  }
}
