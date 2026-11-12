import { afterEach, describe, expect, it, vi } from "vitest";

import { createQgridRealtime, qgrid } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const model = () => qgrid.realtime("openai/gpt-live-1");

describe("qgrid.realtime", () => {
  it("exchanges the SDP through liveCall with the server-side qgrid options", async () => {
    vi.stubEnv("QGRID_URL", "https://qgrid.example");
    vi.stubEnv("QGRID_PROJECT_NAME", "app");

    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ sdp: "v=0 answer", callId: "rtc_1", model: "openai/gpt-live-1", voice: "cove", tokenName: "openai/a", requestLogId: 7 }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const answer = await model().doCreateWebRTCSession({
      sdp: "v=0 offer",
      sessionConfig: {
        instructions: "Be brief.",
        voice: "cove",
        providerOptions: {
          qgrid: { delegation: { model: "openai/gpt-6-luna", webSearch: true }, logger: false },
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0]!;

    expect(url).toBe("https://qgrid.example/api/qgrid/liveCall");
    expect(JSON.parse(String(init.body))).toEqual({
      params: {
        model: "openai/gpt-live-1",
        sdp: "v=0 offer",
        voice: "cove",
        instructions: "Be brief.",
        delegation: { model: "openai/gpt-6-luna", webSearch: true },
        logger: false,
        projectName: "app",
      },
    });
    expect(answer).toEqual({ sessionId: "rtc_1", sdp: "v=0 answer", requestLogId: 7 });
  });

  it("surfaces a liveCall failure with its status", async () => {
    vi.stubGlobal("fetch", async () => new Response("unsupported live voice", { status: 400 }));

    await expect(model().doCreateWebRTCSession({ sdp: "v=0" })).rejects.toThrow(
      "qgrid liveCall 400: unsupported live voice",
    );
  });

  it("maps GPT-Live data-channel events to AI SDK events", () => {
    const parse = model().createServerEventParser!();

    expect(parse({ type: "session.started", session: { id: "rtc_1" } })).toMatchObject({
      type: "session-started",
      sessionId: "rtc_1",
    });
    expect(parse({ type: "session.started", session: { id: "rtc_1" } })).not.toHaveProperty("delegationMode");

    // Spoken text comes from the *_transcript.added events; turn.* stay raw (turn.delta skips the
    // first word of each turn).
    expect(
      parse({ type: "input_transcript.added", item: { id: "i1", type: "input_transcript", text: "Top" }, start_ms: 600, end_ms: 800 }),
    ).toMatchObject({ type: "transcript-fragment", speaker: "user", delta: "Top", startMs: 600, endMs: 800 });
    expect(
      parse({ type: "output_transcript.added", item: { id: "o1", type: "output_transcript", text: " Sure," }, start_ms: 3200, end_ms: 3400 }),
    ).toMatchObject({ type: "transcript-fragment", speaker: "assistant", delta: " Sure," });
    expect(parse({ type: "turn.delta", turn_id: "t1", delta: " news" })).toMatchObject({ type: "custom", rawType: "turn.delta" });

    expect(
      parse({ type: "delegation.created", item: { id: "d1", target: "client" }, offset_ms: 3000 }),
    ).toMatchObject({ type: "delegation-created", delegationId: "d1", target: "provider", offsetMs: 3000 });
    expect(parse({ type: "session.usage.updated", usage: { audio_duration_ms: 15_000 } })).toMatchObject({
      type: "session-usage",
      usage: { seconds: 15 },
    });
    // A close without usage reports the last running total.
    expect(parse({ type: "session.closed", reason: "client_request" })).toMatchObject({
      type: "session-closed",
      usage: { seconds: 15 },
      reason: "client_request",
    });
    expect(parse({ type: "error", error: { message: "bad", code: "invalid_value" } })).toMatchObject({
      type: "error",
      message: "bad",
      code: "invalid_value",
    });
  });

  it("sends close and context appends, and rejects the other commands", () => {
    const { serializeClientEvent } = model();

    expect(serializeClientEvent({ type: "session-close" })).toEqual({ type: "session.close" });
    expect(serializeClientEvent({ type: "context-append", content: "3 PM", delegationId: null })).toEqual({
      type: "session.context.append",
      content: [{ type: "input_text", text: "3 PM" }],
    });
    expect(serializeClientEvent({ type: "context-append", content: "done", delegationId: "d1" })).toEqual({
      type: "delegation.context.append",
      delegation_item_id: "d1",
      content: [{ type: "input_text", text: "done" }],
    });
    expect(() => serializeClientEvent({ type: "input-audio-mute" })).toThrow("input-audio-mute");
  });

  it("is GPT-Live only", () => {
    expect(() => createQgridRealtime("openai/gpt-realtime-2.1" as never)).toThrow("expected openai/gpt-live-1");
  });
});
