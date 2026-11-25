import {
  OPENAI_REALTIME_SAMPLE_RATE,
  resampleLinear,
} from "../../utils/providers/openai/openai-realtime-protocol";
import {
  type OpenAITranscriptionStream,
  type OpenAITranscriptionStreamEvent,
} from "../../utils/providers/openai/openai-voice-client";

const RATE = OPENAI_REALTIME_SAMPLE_RATE;
const ms = (samples: number) => (samples / RATE) * 1000;

export type CommitPolicyOptions = {
  /** Speech needed in a segment before a pause may end it. */
  minSpeechMs: number;
  /** Quiet that ends a segment once it has enough speech. */
  pauseMs: number;
  /** Quiet that ends a segment with any speech at all, so a short tail does not wait for the cap. */
  longPauseMs: number;
  /** Segment length that forces a commit even mid-speech. gpt-live-transcribe reads only about the
   * first 30 s of one committed buffer. */
  maxMs: number;
  /** Quiet-only audio after which the buffer is cleared instead of committed. */
  idleMs: number;
  /** Frame RMS (0..1) below which a frame counts as quiet. */
  silenceRms: number;
};

export const DEFAULT_COMMIT_POLICY: CommitPolicyOptions = {
  minSpeechMs: 1500,
  pauseMs: 600,
  longPauseMs: 2000,
  maxMs: 20_000,
  // Short, so leading quiet neither eats into maxMs nor shifts the segment start (probe 2026-11-18:
  // a 5 s idle window let 3 s of lead-in push a sentence past the cap).
  idleMs: 1000,
  silenceRms: 0.01,
};

export type CommitDecision = "none" | "commit" | "clear";

/**
 * gpt-live-transcribe rejects server VAD, so the server decides where segments end: after a pause
 * that follows enough speech, or at the length cap. A buffer holding only quiet is cleared rather
 * than committed so that it neither costs a transcript nor pushes later speech past the model's
 * first-30-seconds window.
 */
export class CommitPolicy {
  private segmentSamples = 0;
  private speechSamples = 0;
  private quietRun = 0;
  private readonly options: CommitPolicyOptions;

  constructor(options: Partial<CommitPolicyOptions> = {}) {
    this.options = { ...DEFAULT_COMMIT_POLICY, ...options };
  }

  get hasSpeech(): boolean {
    return this.speechSamples > 0;
  }

  push(samples: Int16Array): CommitDecision {
    let sq = 0;

    for (const v of samples) sq += (v / 32768) ** 2;
    const quiet = Math.sqrt(sq / Math.max(1, samples.length)) < this.options.silenceRms;
    this.segmentSamples += samples.length;
    this.quietRun = quiet ? this.quietRun + samples.length : 0;

    if (!quiet) this.speechSamples += samples.length;

    if (this.speechSamples === 0)
      return ms(this.segmentSamples) >= this.options.idleMs ? "clear" : "none";

    if (ms(this.segmentSamples) >= this.options.maxMs) return "commit";

    if (ms(this.quietRun) >= this.options.longPauseMs) return "commit";

    return ms(this.speechSamples) >= this.options.minSpeechMs &&
      ms(this.quietRun) >= this.options.pauseMs
      ? "commit"
      : "none";
  }

  reset(): void {
    this.segmentSamples = 0;
    this.speechSamples = 0;
    this.quietRun = 0;
  }
}

export type StreamOutEvent =
  | { event: "delta"; data: { segmentId: string; text: string } }
  | { event: "segment"; data: { segmentId: string; text: string; startMs: number; endMs: number } }
  | { event: "error"; data: { message: string; fatal: boolean } };

export type StreamSegment = {
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  /** Wall-clock ms from sending the commit to receiving the final text; request log only. */
  commitToTextMs?: number;
};

/** Opens (or reopens) the upstream stream; events must be routed to `onEvent`. */
export type OpenUpstream = (
  onEvent: (event: OpenAITranscriptionStreamEvent) => void,
) => Promise<OpenAITranscriptionStream>;

type PendingSegment = {
  index: number;
  startMs: number;
  /** First frame above the silence threshold; reported as the segment start. */
  speechStartMs?: number;
  endMs?: number;
  /** Date.now() when the commit went upstream. */
  committedAt?: number;
  text?: string;
};

/** Consecutive failed reopen attempts before the session gives up. */
const MAX_REOPEN_FAILURES = 3;

/**
 * One client stream: audio in, segment events out. Times are milliseconds of audio received in
 * this session, so the client can place segments on its own recording clock.
 *
 * Segments bind to upstream items by the item id on input_audio_buffer.committed, which the
 * upstream acknowledges in commit order. Deltas can name an item before its commit (live models
 * stream while audio arrives); those are tentatively the open segment until the ack confirms it.
 */
export class TranscribeStreamSession {
  private upstream: OpenAITranscriptionStream | undefined;
  private reconnecting = false;
  private readonly policy: CommitPolicy;
  private receivedSamples = 0;
  private nextIndex = 0;
  /** The open (uncommitted) segment, created when its first audio reaches the upstream. */
  private current: PendingSegment | undefined;
  private readonly bySegment = new Map<number, PendingSegment>();
  private readonly itemToSegment = new Map<string, number>();
  /** Segments committed on the current upstream whose commit is not yet acknowledged, in order. */
  private awaitingAck: number[] = [];
  private stopped = false;
  private finished: (() => void) | undefined;
  readonly segments: StreamSegment[] = [];

  constructor(
    private readonly openUpstream: OpenUpstream,
    private readonly emit: (out: StreamOutEvent) => void,
    policy: Partial<CommitPolicyOptions> = {},
  ) {
    this.policy = new CommitPolicy(policy);
  }

  get audioMs(): number {
    return ms(this.receivedSamples);
  }

  async start(): Promise<void> {
    this.upstream = await this.openUpstream((event) => this.onUpstream(event));
  }

  /** Mono PCM16 at `sampleRate`. Frames that arrive while the upstream reconnects are dropped. */
  async audio(pcm: Int16Array, sampleRate: number): Promise<void> {
    if (this.stopped) return;
    const samples = resampleLinear(pcm, sampleRate, RATE);

    if (samples.length === 0) return;
    const startSample = this.receivedSamples;
    this.receivedSamples += samples.length;
    const upstream = this.upstream;

    if (!upstream) return;

    if (!this.current) {
      this.current = { index: this.nextIndex++, startMs: Math.round(ms(startSample)) };
      this.bySegment.set(this.current.index, this.current);
    }

    await upstream.append(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    const decision = this.policy.push(samples);

    if (this.current.speechStartMs === undefined && this.policy.hasSpeech)
      this.current.speechStartMs = Math.round(ms(startSample));

    if (decision === "commit") await this.commit();
    else if (decision === "clear") this.clearIdle();
  }

  /** Ends the current segment now (client-side boundary, e.g. the speaker changed). */
  async commit(): Promise<void> {
    const segment = this.current;

    if (!segment || !this.policy.hasSpeech) return;
    segment.endMs = Math.round(ms(this.receivedSamples));
    this.current = undefined;
    this.policy.reset();
    const upstream = this.upstream;

    if (!upstream) {
      this.bySegment.delete(segment.index);

      return;
    }

    this.awaitingAck.push(segment.index);
    segment.committedAt = Date.now();
    await upstream.commit();
  }

  /**
   * Commits what is left and waits up to `graceMs` for the outstanding transcripts, then closes.
   */
  async stop(graceMs = 10_000): Promise<void> {
    if (this.stopped) return;
    await this.commit().catch(() => undefined);
    this.stopped = true;

    if (this.upstream && this.outstanding() > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        this.finished = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    this.upstream?.close();
    this.upstream = undefined;
  }

  /** The client went away: drop everything without waiting. */
  abort(): void {
    this.stopped = true;
    this.upstream?.close();
    this.upstream = undefined;
  }

  /** The quiet-only buffer never reaches the model; a new segment starts with the next audio. */
  private clearIdle(): void {
    const idle = this.current;

    if (idle) {
      this.bySegment.delete(idle.index);
      this.current = undefined;
    }

    this.policy.reset();
    void this.upstream?.clear().catch(() => undefined);
  }

  private outstanding(): number {
    let n = 0;

    for (const s of this.bySegment.values()) if (s.endMs !== undefined && s.text === undefined) n++;

    return n;
  }

  private onUpstream(event: OpenAITranscriptionStreamEvent): void {
    switch (event.type) {
      case "delta": {
        let index = this.itemToSegment.get(event.itemId);

        if (index === undefined && this.current) {
          index = this.current.index;
          this.itemToSegment.set(event.itemId, index);
        }

        if (index !== undefined && event.text)
          this.emit({ event: "delta", data: { segmentId: `s${index}`, text: event.text } });

        return;
      }

      case "committed": {
        const index = this.awaitingAck.shift();

        if (index !== undefined) this.itemToSegment.set(event.itemId, index);

        return;
      }

      case "completed":
      case "failed": {
        const index = this.itemToSegment.get(event.itemId);
        const segment = index === undefined ? undefined : this.bySegment.get(index);

        if (!segment) return;
        segment.text = event.type === "completed" ? event.text.trim() : "";

        if (event.type === "failed")
          this.emit({ event: "error", data: { message: event.message, fatal: false } });

        if (segment.text) {
          const out = {
            segmentId: `s${segment.index}`,
            text: segment.text,
            startMs: segment.speechStartMs ?? segment.startMs,
            endMs: segment.endMs ?? Math.round(ms(this.receivedSamples)),
          };

          this.segments.push(
            segment.committedAt === undefined
              ? out
              : { ...out, commitToTextMs: Date.now() - segment.committedAt },
          );
          this.emit({ event: "segment", data: out });
        }

        this.bySegment.delete(segment.index);

        if (this.stopped && this.outstanding() === 0) this.finished?.();

        return;
      }

      case "error":
        // Committing an empty buffer is the one routine error; nothing to tell the client.
        if (event.code !== "input_audio_buffer_commit_empty")
          this.emit({ event: "error", data: { message: event.message, fatal: false } });

        return;
      case "closed":
        this.upstream = undefined;

        if (this.stopped) {
          this.finished?.();

          return;
        }

        void this.reopenAfterClose(event.error);
    }
  }

  /**
   * The upstream session ended while the client is still streaming (a session limit or a dropped
   * socket). Audio sent to the old session but not yet transcribed is lost, and frames are dropped
   * until a new session opens. Only this loop opens sessions, with backoff between failures.
   */
  private async reopenAfterClose(error: Error | undefined): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    for (const s of this.bySegment.values())
      if (s.text === undefined) this.bySegment.delete(s.index);

    this.awaitingAck = [];
    this.itemToSegment.clear();
    this.current = undefined;
    this.policy.reset();
    this.emit({
      event: "error",
      data: {
        message: `upstream session ended${error ? `: ${error.message}` : ""}; reconnecting`,
        fatal: false,
      },
    });

    try {
      for (let failures = 0; !this.stopped && !this.upstream;) {
        try {
          const reopened = await this.openUpstream((event) => this.onUpstream(event));

          // The client stopped while the session was opening.
          if (this.stopped) reopened.close();
          else this.upstream = reopened;
        } catch (e) {
          failures++;

          if (failures >= MAX_REOPEN_FAILURES) {
            this.stopped = true;
            this.emit({
              event: "error",
              data: {
                message: `could not reconnect: ${e instanceof Error ? e.message : String(e)}`,
                fatal: true,
              },
            });

            return;
          }

          await new Promise((r) => setTimeout(r, 1000 * failures));
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }
}
