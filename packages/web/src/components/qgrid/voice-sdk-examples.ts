// The @cartanova/qgrid-ai-sdk call that matches what each voice panel sends, shown beside the
// panel: its imports and the call. Shapes follow the README examples.

const literal = (value: string) => JSON.stringify(value);

const QGRID_IMPORT = 'import { qgrid } from "@cartanova/qgrid-ai-sdk";';

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

  return [
    'import { generateSpeech } from "ai";',
    QGRID_IMPORT,
    "",
    "const speech = await generateSpeech({",
    ...lines,
    "});",
  ].join("\n");
}

export type SttExampleOptions = { model: string; prompt?: string };

export function sttExample(options: SttExampleOptions): string {
  const openai = options.model.startsWith("openai/");

  const lines = [
    `  model: qgrid.transcription(${literal(options.model)}),`,
    ...(openai
      ? ["  // OpenAI takes PCM16 WAV or raw PCM.", '  audio: await readFile("recording.wav"),']
      : ['  audio: await readFile("recording.mp3"),']),
  ];

  if (options.prompt) {
    lines.push(`  providerOptions: { openai: { prompt: ${literal(options.prompt)} } },`);
  }

  return [
    'import { readFile } from "node:fs/promises";',
    'import { transcribe } from "ai";',
    QGRID_IMPORT,
    "",
    "const transcript = await transcribe({",
    ...lines,
    "});",
  ].join("\n");
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
    'import { createQgridRealtime } from "@cartanova/qgrid-ai-sdk/realtime";',
    'import { experimental_useRealtime } from "@ai-sdk/react";',
    "",
    "// Module scope: a new model or sessionConfig object starts a new session.",
    'const model = createQgridRealtime("openai/gpt-live-1");',
    `const sessionConfig = { ${config.join(", ")} };`,
    "",
    "const realtime = experimental_useRealtime({",
    "  model,",
    '  api: { session: "/api/live" },',
    "  sessionConfig,",
    "});",
    "",
    "// Server: POST /api/live",
    QGRID_IMPORT,
    "",
    'const answer = await qgrid.realtime("openai/gpt-live-1").doCreateWebRTCSession({',
    "  sdp,",
    "  sessionConfig: {",
    ...config.map((entry) => `    ${entry},`),
    "    providerOptions: {",
    "      qgrid: {",
    ...qgrid,
    "      },",
    "    },",
    "  },",
    "});",
  ].join("\n");
}
