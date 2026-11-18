import { describe, expect, it, vi } from "vitest";
import {
  type OpenAITranscriptionStream,
  type OpenAITranscriptionStreamEvent,
} from "../../utils/providers/openai/openai-voice-client";
import { CommitPolicy, type StreamOutEvent, TranscribeStreamSession } from "./transcribe-stream";

const RATE = 24_000;
const frame = (amp: number, ms = 100, rate = RATE) =>
  new Int16Array(Math.round((rate * ms) / 1000)).fill(Math.round(amp * 32767));

describe("CommitPolicy", () => {
  it("commits after a pause that follows enough speech", () => {
    const p = new CommitPolicy();
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push(p.push(frame(0.2))); // 2 s speech
    for (let i = 0; i < 6; i++) out.push(p.push(frame(0))); // 0.6 s pause
    expect(out.slice(0, -1).every((d) => d === "none")).toBe(true);
    expect(out.at(-1)).toBe("commit");
  });

  it("does not end a segment on a pause before minimum speech", () => {
    const p = new CommitPolicy();
    for (let i = 0; i < 5; i++) p.push(frame(0.2)); // 0.5 s speech
    const out = Array.from({ length: 10 }, () => p.push(frame(0)));
    expect(out).not.toContain("commit");
  });

  it("forces a commit at the length cap during continuous speech", () => {
    const p = new CommitPolicy();
    const out = Array.from({ length: 200 }, () => p.push(frame(0.2)));
    expect(out.indexOf("commit")).toBe(199); // the 20th second
  });

  it("clears a buffer that holds only quiet", () => {
    const p = new CommitPolicy();
    const out = Array.from({ length: 10 }, () => p.push(frame(0)));
    expect(out.indexOf("clear")).toBe(9);
  });

  it("commits a short speech tail at a long pause instead of waiting for the cap", () => {
    const p = new CommitPolicy();
    for (let i = 0; i < 8; i++) p.push(frame(0.2)); // 0.8 s, under the minimum
    const out = Array.from({ length: 20 }, () => p.push(frame(0)));
    expect(out.indexOf("commit")).toBe(19); // 2 s of quiet
  });
});

function fakeUpstream() {
  const calls: string[] = [];
  let onEvent: (e: OpenAITranscriptionStreamEvent) => void = () => {};
  const opens = vi.fn(async (handler: (e: OpenAITranscriptionStreamEvent) => void) => {
    onEvent = handler;
    const stream: OpenAITranscriptionStream = {
      model: "gpt-live-transcribe",
      append: async () => void calls.push("append"),
      commit: async () => void calls.push("commit"),
      clear: async () => void calls.push("clear"),
      close: () => void calls.push("close"),
    };
    return stream;
  });
  return { opens, calls, send: (e: OpenAITranscriptionStreamEvent) => onEvent(e) };
}

async function speak(session: TranscribeStreamSession, speechMs: number, pauseMs: number, rate = RATE) {
  for (let i = 0; i < speechMs / 100; i++) await session.audio(frame(0.2, 100, rate), rate);
  for (let i = 0; i < pauseMs / 100; i++) await session.audio(frame(0, 100, rate), rate);
}

describe("TranscribeStreamSession", () => {
  it("maps upstream items to segments with session-relative times", async () => {
    const up = fakeUpstream();
    const out: StreamOutEvent[] = [];
    const session = new TranscribeStreamSession(up.opens, (e) => out.push(e));
    await session.start();

    // 16 kHz input is resampled; times stay in audio milliseconds.
    // A live model streams deltas before the commit; the commit ack confirms the item.
    await speak(session, 1000, 0, 16_000);
    up.send({ type: "delta", itemId: "a", text: "안녕" });
    await speak(session, 1000, 600, 16_000);
    up.send({ type: "committed", itemId: "a" });
    up.send({ type: "completed", itemId: "a", text: "안녕하세요." });
    // gpt-transcribe sends its deltas only after the ack, while the next segment is open.
    await speak(session, 2000, 600, 16_000);
    await speak(session, 500, 0, 16_000);
    up.send({ type: "committed", itemId: "b" });
    up.send({ type: "delta", itemId: "b", text: "다음" });
    up.send({ type: "completed", itemId: "b", text: "다음 안건입니다." });

    expect(up.calls.filter((c) => c === "commit")).toHaveLength(2);
    expect(out).toEqual([
      { event: "delta", data: { segmentId: "s0", text: "안녕" } },
      { event: "segment", data: { segmentId: "s0", text: "안녕하세요.", startMs: 0, endMs: 2600 } },
      { event: "delta", data: { segmentId: "s1", text: "다음" } },
      { event: "segment", data: { segmentId: "s1", text: "다음 안건입니다.", startMs: 2600, endMs: 5200 } },
    ]);
    expect(session.segments.map((s) => s.text)).toEqual(["안녕하세요.", "다음 안건입니다."]);
  });

  it("clears quiet-only audio instead of committing it", async () => {
    const up = fakeUpstream();
    const session = new TranscribeStreamSession(up.opens, () => {});
    await session.start();
    await speak(session, 0, 5000);
    expect(up.calls).toContain("clear");
    expect(up.calls).not.toContain("commit");
  });

  it("reopens the upstream when it closes mid-stream and keeps going", async () => {
    const up = fakeUpstream();
    const out: StreamOutEvent[] = [];
    const session = new TranscribeStreamSession(up.opens, (e) => out.push(e));
    await session.start();
    up.send({ type: "closed", error: new Error("session limit") });
    await vi.waitFor(() => expect(up.opens).toHaveBeenCalledTimes(2));
    expect(out[0]).toEqual({
      event: "error",
      data: { message: "upstream session ended: session limit; reconnecting", fatal: false },
    });

    await speak(session, 2000, 600);
    up.send({ type: "committed", itemId: "c" });
    up.send({ type: "completed", itemId: "c", text: "다시 연결됐습니다." });
    expect(out.at(-1)).toMatchObject({ event: "segment", data: { text: "다시 연결됐습니다." } });
  });

  it("stop commits the tail and waits for its transcript before closing", async () => {
    const up = fakeUpstream();
    const out: StreamOutEvent[] = [];
    const session = new TranscribeStreamSession(up.opens, (e) => out.push(e));
    await session.start();
    await speak(session, 2000, 0); // speech still running when the client stops

    const stopped = session.stop(5_000);
    await vi.waitFor(() => expect(up.calls).toContain("commit"));
    expect(up.calls).not.toContain("close");
    up.send({ type: "committed", itemId: "d" });
    up.send({ type: "completed", itemId: "d", text: "마지막 문장." });
    await stopped;

    expect(up.calls.at(-1)).toBe("close");
    expect(out.at(-1)).toMatchObject({ event: "segment", data: { text: "마지막 문장.", endMs: 2000 } });
  });

  it("drops frames while reconnecting instead of opening a session per frame", async () => {
    const up = fakeUpstream();
    const out: StreamOutEvent[] = [];
    let fail = false;
    const opens = vi.fn(async (handler: (e: OpenAITranscriptionStreamEvent) => void) => {
      if (fail) throw new Error("upstream down");

      return up.opens(handler);
    });
    const session = new TranscribeStreamSession(opens, (e) => out.push(e));
    await session.start();
    fail = true;
    up.send({ type: "closed", error: new Error("dropped") });
    await speak(session, 2000, 0); // 20 frames during the outage
    expect(opens.mock.calls.length).toBeLessThanOrEqual(2);
    expect(up.calls).not.toContain("append");
    expect(session.audioMs).toBe(2000); // the clock keeps counting dropped audio
  });
});
