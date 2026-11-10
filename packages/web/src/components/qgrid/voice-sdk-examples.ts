// The @cartanova/qgrid-ai-sdk call that matches what each voice panel sends, shown beside the
// panel. Only the call itself; shapes follow the README examples.

const literal = (value: string) => JSON.stringify(value);

export type TtsExampleOptions = {
  model: string;
  text: string;
  voice: string;
  instructions?: string;
  speed?: number;
  withTimestamps: boolean;
};

export function ttsExample(options: TtsExampleOptions): string {
  const openai = options.model.startsWith("openai/");

  const lines = [
    `  model: qgrid.speech(${literal(options.model)}),`,
    `  text: ${literal(options.text)},`,
    `  voice: ${literal(options.voice)},`,
  ];

  if (options.instructions) lines.push(`  instructions: ${literal(options.instructions)},`);

  if (options.speed !== undefined) lines.push(`  speed: ${options.speed},`);
  lines.push(`  outputFormat: ${literal(openai ? "wav" : "mp3")},`);

  if (options.withTimestamps) lines.push("  providerOptions: { qgrid: { withTimestamps: true } },");

  return ["generateSpeech({", ...lines, "})"].join("\n");
}

export type SttExampleOptions = { model: string; prompt?: string };

export function sttExample(options: SttExampleOptions): string {
  const openai = options.model.startsWith("openai/");

  const lines = [
    `  model: qgrid.transcription(${literal(options.model)}),`,
    openai ? "  audio, // PCM16 WAV or raw PCM bytes" : "  audio, // audio file bytes",
  ];

  if (options.prompt) {
    lines.push(`  providerOptions: { openai: { prompt: ${literal(options.prompt)} } },`);
  }

  return ["transcribe({", ...lines, "})"].join("\n");
}

export type LiveExampleOptions = {
  voice: string;
  instructions?: string;
  delegation: { model: string; effort: string; webSearch: boolean };
  logged: boolean;
  /** The session continues earlier turns (the "Continue" button). */
  continues: boolean;
};

export function liveExample(options: LiveExampleOptions): string {
  const config = [`voice: ${literal(options.voice)}`];

  if (options.instructions) config.push(`instructions: ${literal(options.instructions)}`);
  const { model, effort, webSearch } = options.delegation;

  const qgrid = [
    "        delegation: {",
    `          model: ${literal(model)},`,
    `          effort: ${literal(effort)},`,
    `          webSearch: ${webSearch},`,
    "        },",
  ];

  if (!options.logged) qgrid.push("        logger: false,");

  if (options.continues) qgrid.push("        history, // earlier turns, at most 128");

  return [
    "// Browser",
    "experimental_useRealtime({",
    '  model: createQgridRealtime("openai/gpt-live-1"),',
    '  api: { session: "/api/live" },',
    `  sessionConfig: { ${config.join(", ")} },`,
    "})",
    "",
    "// Server: POST /api/live",
    'qgrid.realtime("openai/gpt-live-1").doCreateWebRTCSession({',
    "  sdp,",
    "  sessionConfig: {",
    ...config.map((entry) => `    ${entry},`),
    "    providerOptions: {",
    "      qgrid: {",
    ...qgrid,
    "      },",
    "    },",
    "  },",
    "})",
  ].join("\n");
}

export type CodeToken = {
  text: string;
  kind?: "string" | "number" | "boolean" | "brace" | "comment";
};

const TOKEN = /("(?:[^"\\]|\\.)*")|(\/\/[^\n]*)|\b(true|false)\b|\b(\d+(?:\.\d+)?)\b|([{}[\]()])/g;

/** Splits example code into the token kinds the JSON view colors. */
export function codeTokens(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;

  for (const match of code.matchAll(TOKEN)) {
    if (match.index > last) tokens.push({ text: code.slice(last, match.index) });
    const [text, string, comment, boolean, number] = match;

    const kind = string
      ? "string"
      : comment
        ? "comment"
        : boolean
          ? "boolean"
          : number
            ? "number"
            : "brace";

    tokens.push({ text, kind });
    last = match.index + text.length;
  }

  if (last < code.length) tokens.push({ text: code.slice(last) });

  return tokens;
}
