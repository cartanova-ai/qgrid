import { describe, expect, it } from "vitest";

import { liveExample, sttExample, ttsExample } from "./voice-sdk-examples";

describe("voice SDK examples", () => {
  it("writes the Grok speech call with speed, timing and mp3", () => {
    const code = ttsExample({
      model: "grok/grok-tts",
      text: 'Say "hi"',
      voice: "ara",
      speed: 1.2,
      withTimestamps: true,
    });

    expect(code).toContain('import { generateSpeech } from "ai";');
    expect(code).toContain('import { qgrid, type QgridGrokVoice } from "@cartanova/qgrid-ai-sdk";');
    expect(code).toContain('voice: "ara" satisfies QgridGrokVoice,');
    expect(code).toContain("const speech = await generateSpeech({");
    expect(code).toContain('model: qgrid.speech("grok/grok-tts"),');
    expect(code).toContain('text: "Say \\"hi\\"",');
    expect(code).toContain("speed: 1.2,");
    expect(code).toContain('outputFormat: "mp3",');
    expect(code).toContain("providerOptions: { qgrid: { withTimestamps: true } },");
  });

  it("writes the OpenAI speech call with instructions and wav, without timing", () => {
    const code = ttsExample({
      model: "openai/gpt-realtime-2.1-mini",
      text: "Hello",
      voice: "marin",
      instructions: "Calm.",
      withTimestamps: false,
    });

    expect(code).toContain('voice: "marin" satisfies QgridOpenAISpeechVoice,');
    expect(code).toContain('instructions: "Calm.",');
    expect(code).toContain('outputFormat: "wav",');
    expect(code).not.toContain("withTimestamps");
  });

  it("writes the transcription call with the OpenAI prompt", () => {
    const code = sttExample({ model: "openai/gpt-transcribe", prompt: "qgrid" });

    expect(code).toContain('import { transcribe } from "ai";');
    expect(code).toContain('model: qgrid.transcription("openai/gpt-transcribe"),');
    expect(code).toContain('audio: await readFile("recording.wav"),');
    expect(code).toContain('providerOptions: { openai: { prompt: "qgrid" } },');
    expect(sttExample({ model: "grok/grok-voice-transcribe-2.0" })).not.toContain("providerOptions");
  });

  it("writes the browser hook and the server SDP exchange with qgrid options", () => {
    const code = liveExample({
      voice: "cove",
      instructions: "Be brief.",
      delegation: { model: "openai/gpt-6-luna", effort: "low", webSearch: true },
      logged: false,
      continues: true,
    });

    expect(code).toContain('import { createQgridRealtime } from "@cartanova/qgrid-ai-sdk/realtime";');
    // The browser hook takes no sessionConfig (a new object per render restarts the session); the
    // server call sets the voice and instructions inline.
    expect(code).not.toContain("const sessionConfig");
    expect(code).toContain('    voice: "cove" satisfies QgridLiveVoice,');
    expect(code).toContain('    instructions: "Be brief.",');
    expect(code).toContain('qgrid.realtime("openai/gpt-live-1").doCreateWebRTCSession({');
    expect(code).toContain('model: "openai/gpt-6-luna",');
    expect(code).toContain("webSearch: true,");
    expect(code).toContain("logger: false,");
    expect(code).toContain("history,");
  });
});
