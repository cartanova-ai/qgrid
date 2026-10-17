import { describe, expect, it, vi } from "vitest";

import { CODEX_CLI_ORIGINATOR } from "./openai-backend-protocol";
import type { OpenAIWebSocketFactory, OpenAIWebSocketLike } from "./openai-direct-client";
import {
  buildOpenAIRealtimeHeaders,
  buildSpeechSession,
  buildTranscriptionSession,
  decodeWav,
  OPENAI_REALTIME_CALLS_URL,
  OPENAI_REALTIME_WS_URL,
  prepareRealtimeInput,
  resampleLinear,
  UnsupportedAudioError,
  wrapPcmAsWav,
} from "./openai-realtime-protocol";
import { OpenAIVoiceClient, OpenAIVoiceInputError } from "./openai-voice-client";

// Wire fixtures below are the shapes Codex sends (codex-rs/codex-api/src/endpoint/
// realtime_websocket/methods_v2.rs) and the server events observed live on 2026-10-17.

type Listener = (...args: never[]) => void;

class MockSocket implements OpenAIWebSocketLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  closed?: { code?: number; reason?: string };
  terminated = false;

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);

    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );

    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
  }

  message(event: object): void {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }

  sentEvents(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function mockedWebSocket() {
  const sockets: MockSocket[] = [];
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  const factory: OpenAIWebSocketFactory = (url, options) => {
    const socket = new MockSocket();
    sockets.push(socket);
    calls.push({ url, headers: (options.headers ?? {}) as Record<string, string> });

    return socket;
  };

  return { factory, sockets, calls };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 24 kHz mono PCM16 sine, `seconds` long, as a WAV file. */
function sineWav(seconds: number, sampleRate = 24_000, channels = 1): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const pcm = new Uint8Array(frames * channels * 2);
  const view = new DataView(pcm.buffer);

  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000);

    for (let c = 0; c < channels; c++) view.setInt16((i * channels + c) * 2, sample, true);
  }

  const wav = wrapPcmAsWav(pcm, sampleRate);

  if (channels !== 1) {
    const header = new DataView(wav.buffer);
    header.setUint16(22, channels, true);
    header.setUint32(28, sampleRate * 2 * channels, true);
    header.setUint16(32, 2 * channels, true);
  }

  return wav;
}

const credentials = { accessToken: "access", accountId: "acct" };

function callsResponse(callId = "rtc_u23_test"): Response {
  return new Response("v=0", {
    status: 201,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      location: `/v1/realtime/calls/${callId}`,
      "x-codex-primary-used-percent": "88",
    },
  });
}

describe("openai realtime protocol", () => {
  it("builds the Codex header set without OpenAI-Beta or openai-alpha", () => {
    const headers = buildOpenAIRealtimeHeaders(credentials, {
      threadId: "thread",
      sessionId: "session",
    });

    expect(headers).toMatchObject({
      Authorization: "Bearer access",
      "ChatGPT-Account-Id": "acct",
      originator: CODEX_CLI_ORIGINATOR,
      "x-session-id": "thread",
      "voice-session-id": "session",
      "session-id": "session",
      "thread-id": "thread",
    });
    expect(headers["User-Agent"]).toMatch(/^codex_cli_rs\//);
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("openai-beta");
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("openai-alpha");
  });

  it("serializes the transcription session exactly as methods_v2.rs does", () => {
    expect(JSON.stringify(buildTranscriptionSession({ model: "gpt-4o-mini-transcribe" }))).toBe(
      '{"type":"transcription","audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":"gpt-4o-mini-transcribe"}}}}',
    );

    expect(
      buildTranscriptionSession({ model: "gpt-transcribe", language: "en", prompt: "qgrid", manualCommit: true }),
    ).toEqual({
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-transcribe", language: "en", prompt: "qgrid" },
          turn_detection: null,
        },
      },
    });
  });

  it("serializes the conversational session with Codex's audio block and no tools", () => {
    const session = buildSpeechSession({ instructions: "repeat", voice: "marin" });

    expect(session).toEqual({
      type: "realtime",
      instructions: "repeat",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          noise_reduction: { type: "near_field" },
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: {
            type: "server_vad",
            interrupt_response: true,
            create_response: true,
            silence_duration_ms: 500,
          },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
      },
    });
    expect(session).not.toHaveProperty("tools");
  });

  it("decodes PCM16 WAV, downmixes stereo and resamples to 24 kHz", () => {
    const stereo48k = sineWav(0.5, 48_000, 2);
    const decoded = decodeWav(stereo48k);

    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.samples.length).toBe(24_000);
    const pcm = prepareRealtimeInput(stereo48k, "audio/wav");
    expect(pcm.byteLength).toBe(12_000 * 2);
  });

  it("rejects non-PCM16 and compressed inputs with UnsupportedAudioError", () => {
    expect(() => prepareRealtimeInput(new Uint8Array([1, 2, 3]), "audio/mpeg")).toThrow(
      UnsupportedAudioError,
    );
    const wav = sineWav(0.1);
    new DataView(wav.buffer).setUint16(34, 8, true); // 8-bit
    expect(() => prepareRealtimeInput(wav, "audio/wav")).toThrow(/PCM16/);
  });

  it("accepts raw PCM with rate/channels parameters", () => {
    const stereo16k = new Uint8Array(16_000 * 2 * 2); // 1 s stereo 16 kHz silence
    const pcm = prepareRealtimeInput(stereo16k, "audio/pcm;rate=16000;channels=2");
    expect(pcm.byteLength).toBe(24_000 * 2);
  });

  it("resampleLinear keeps endpoints and length ratio", () => {
    const out = resampleLinear(Int16Array.from([0, 1000, 2000, 3000]), 8_000, 16_000);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(1000);
  });
});

describe("OpenAIVoiceClient.transcribe", () => {
  it("posts Codex's /calls body, attaches the sideband, streams PCM and returns the transcript", async () => {
    const fetchMock = vi.fn(async () => callsResponse());
    const ws = mockedWebSocket();

    const client = new OpenAIVoiceClient({
      fetch: fetchMock as unknown as typeof fetch,
      webSocketFactory: ws.factory,
    });

    const result = client.transcribe(credentials, {
      audio: sineWav(2.5),
      mediaType: "audio/wav",
      model: "gpt-transcribe",
      language: "en",
      prompt: "qgrid",
    });

    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENAI_REALTIME_CALLS_URL);
    expect(url).not.toContain("intent=");
    const body = JSON.parse(String(init.body)) as { sdp: string; session: unknown };
    expect(body.sdp).toMatch(/^v=0\r\n/);
    expect(body.session).toEqual(buildTranscriptionSession({ model: "gpt-transcribe" }));

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access");
    expect(headers["ChatGPT-Account-Id"]).toBe("acct");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(ws.calls[0]?.url).toBe(`${OPENAI_REALTIME_WS_URL}?call_id=rtc_u23_test`);
    expect(ws.calls[0]?.headers.Authorization).toBe("Bearer access");
    expect(ws.calls[0]?.headers["x-session-id"]).toBe(headers["x-session-id"]);

    const socket = ws.sockets[0]!;
    socket.emit("open");
    await tick();
    await tick();

    const events = socket.sentEvents();
    expect(events[0]).toEqual({
      type: "session.update",
      session: buildTranscriptionSession({
        model: "gpt-transcribe",
        language: "en",
        prompt: "qgrid",
        manualCommit: true,
      }),
    });

    const appends = events.filter((event) => event.type === "input_audio_buffer.append");
    expect(appends).toHaveLength(3); // 2.5 s → 1 s, 1 s, 0.5 s
    expect(Buffer.from(String(appends[0]?.audio), "base64").byteLength).toBe(48_000);
    expect(events.at(-1)).toEqual({ type: "input_audio_buffer.commit" });

    socket.message({ type: "session.updated", session: {} });
    socket.message({ type: "input_audio_buffer.committed" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hello from qgrid.",
    });

    await expect(result).resolves.toMatchObject({
      text: "Hello from qgrid.",
      durationSec: 2.5,
      callId: "rtc_u23_test",
    });
    expect((await result).quotaHeaders.get("x-codex-primary-used-percent")).toBe("88");
    expect(socket.closed?.code).toBe(1000);
  });

  it("maps a non-201 /calls answer to an OpenAIProtocolError with the server detail", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: "Field `sdp` must be a string" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );

    const client = new OpenAIVoiceClient({
      fetch: fetchMock as unknown as typeof fetch,
      webSocketFactory: mockedWebSocket().factory,
    });

    await expect(
      client.transcribe(credentials, { audio: sineWav(0.2), mediaType: "audio/wav" }),
    ).rejects.toMatchObject({ name: "OpenAIProtocolError", status: 400, message: /must be a string/ });
  });

  it("surfaces a server error event and terminates the socket", async () => {
    const ws = mockedWebSocket();

    const client = new OpenAIVoiceClient({
      fetch: (async () => callsResponse()) as unknown as typeof fetch,
      webSocketFactory: ws.factory,
    });

    const result = client.transcribe(credentials, { audio: sineWav(0.2), mediaType: "audio/wav" });
    await tick();
    const socket = ws.sockets[0]!;
    socket.emit("open");
    await tick();
    socket.message({ type: "error", error: { type: "invalid_request_error", code: "invalid_model", message: "nope" } });

    await expect(result).rejects.toMatchObject({ code: "invalid_model", message: "nope" });
    expect(socket.terminated).toBe(true);
  });

  it("rejects unsupported input before any network call", async () => {
    const fetchMock = vi.fn();

    const client = new OpenAIVoiceClient({
      fetch: fetchMock as unknown as typeof fetch,
      webSocketFactory: mockedWebSocket().factory,
    });

    await expect(
      client.transcribe(credentials, { audio: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" }),
    ).rejects.toBeInstanceOf(OpenAIVoiceInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the sideband closes before the transcript (the 30 s teardown case)", async () => {
    const ws = mockedWebSocket();

    const client = new OpenAIVoiceClient({
      fetch: (async () => callsResponse()) as unknown as typeof fetch,
      webSocketFactory: ws.factory,
    });

    const result = client.transcribe(credentials, { audio: sineWav(0.2), mediaType: "audio/wav" });
    await tick();
    const socket = ws.sockets[0]!;
    socket.emit("open");
    await tick();
    socket.emit("close", 1006, Buffer.from(""));

    await expect(result).rejects.toMatchObject({ message: /closed before the transcript/ });
  });
});

describe("OpenAIVoiceClient.speak", () => {
  it("opens the direct socket with ?model=, sends the Codex session, collects audio and usage", async () => {
    const ws = mockedWebSocket();
    const client = new OpenAIVoiceClient({ webSocketFactory: ws.factory });

    const result = client.speak(credentials, {
      text: "Hello from qgrid.",
      model: "gpt-realtime-2.1-mini",
      voice: "cedar",
      instructions: "warm",
    });

    await tick();
    expect(ws.calls[0]?.url).toBe(`${OPENAI_REALTIME_WS_URL}?model=gpt-realtime-2.1-mini`);
    expect(ws.calls[0]?.headers.originator).toBe(CODEX_CLI_ORIGINATOR);
    const socket = ws.sockets[0]!;
    socket.emit("open");
    await tick();

    const events = socket.sentEvents();
    expect(events.map((event) => event.type)).toEqual([
      "session.update",
      "conversation.item.create",
      "response.create",
    ]);
    const session = events[0]?.session as { audio: { output: { voice: string } }; instructions: string };
    expect(session.audio.output.voice).toBe("cedar");
    expect(session.instructions).toMatch(/Style: warm$/);
    expect(events[1]).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello from qgrid." }],
      },
    });

    const pcm = Buffer.alloc(4800, 1);
    socket.message({ type: "response.created" });
    socket.message({ type: "response.output_audio.delta", delta: pcm.subarray(0, 2400).toString("base64") });
    socket.message({ type: "response.output_audio.delta", delta: pcm.subarray(2400).toString("base64") });
    socket.message({ type: "response.output_audio_transcript.done", transcript: "Hello from qgrid." });
    socket.message({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_tokens: 30, output_tokens: 62, output_token_details: { text_tokens: 30, audio_tokens: 32 } },
      },
    });

    const speech = await result;
    expect(speech.mediaType).toBe("audio/wav");
    expect(speech.audio.byteLength).toBe(44 + 4800);
    expect(decodeWav(speech.audio).samples.length).toBe(2400);
    expect(speech.transcript).toBe("Hello from qgrid.");
    expect(speech.usage).toEqual({ textTokens: 30, audioTokens: 32, inputTokens: 30, outputTokens: 62 });
  });

  it("rejects voices outside the Codex v2 list and empty text before connecting", async () => {
    const ws = mockedWebSocket();
    const client = new OpenAIVoiceClient({ webSocketFactory: ws.factory });

    await expect(client.speak(credentials, { text: "hi", voice: "ara" })).rejects.toBeInstanceOf(
      OpenAIVoiceInputError,
    );
    await expect(client.speak(credentials, { text: "  " })).rejects.toBeInstanceOf(OpenAIVoiceInputError);
    expect(ws.sockets).toHaveLength(0);
  });

  it("treats a response.done without audio as an upstream failure", async () => {
    const ws = mockedWebSocket();
    const client = new OpenAIVoiceClient({ webSocketFactory: ws.factory });
    const result = client.speak(credentials, { text: "hi" });
    await tick();
    const socket = ws.sockets[0]!;
    socket.emit("open");
    await tick();
    socket.message({ type: "response.done", response: { status: "completed", usage: {} } });

    await expect(result).rejects.toMatchObject({ message: /no audio/ });
  });

  it("reports a 401 handshake so the dispatcher can refresh once", async () => {
    const ws = mockedWebSocket();
    const client = new OpenAIVoiceClient({ webSocketFactory: ws.factory });
    const result = client.speak(credentials, { text: "hi" });
    await tick();
    ws.sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });

    await expect(result).rejects.toMatchObject({ status: 401 });
  });
});

