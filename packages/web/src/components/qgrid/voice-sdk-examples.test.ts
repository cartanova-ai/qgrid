import { describe, expect, it } from "vitest";

import { codeTokens, liveExample, sttExample, ttsExample } from "./voice-sdk-examples";

describe("voice SDK examples", () => {
  it("writes the Grok speech call with speed, timing and mp3", () => {
    const code = ttsExample({
      model: "grok/grok-tts",
      text: 'Say "hi"',
      voice: "ara",
      speed: 1.2,
      withTimestamps: true,
    });

    expect(code.split("\n")[0]).toBe("generateSpeech({");
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

    expect(code).toContain('instructions: "Calm.",');
    expect(code).toContain('outputFormat: "wav",');
    expect(code).not.toContain("withTimestamps");
  });

  it("writes the transcription call with the OpenAI prompt", () => {
    const code = sttExample({ model: "openai/gpt-transcribe", prompt: "qgrid" });

    expect(code).toContain('model: qgrid.transcription("openai/gpt-transcribe"),');
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

    expect(code).toContain('sessionConfig: { voice: "cove", instructions: "Be brief." },');
    expect(code).toContain('qgrid.realtime("openai/gpt-live-1").doCreateWebRTCSession({');
    expect(code).toContain('model: "openai/gpt-6-luna",');
    expect(code).toContain("webSearch: true,");
    expect(code).toContain("logger: false,");
    expect(code).toContain("history,");
  });

  it("colors strings, numbers, booleans, braces and comments, and keeps the text", () => {
    const code = 'f({\n  model: "gpt-6-luna",\n  speed: 1.2,\n  on: true, // note\n})';
    const tokens = codeTokens(code);

    expect(tokens.map((token) => token.text).join("")).toBe(code);
    expect(tokens.filter((token) => token.kind).map((token) => [token.kind, token.text])).toEqual([
      ["brace", "("],
      ["brace", "{"],
      ["string", '"gpt-6-luna"'],
      ["number", "1.2"],
      ["boolean", "true"],
      ["comment", "// note"],
      ["brace", "}"],
      ["brace", ")"],
    ]);
  });
});
