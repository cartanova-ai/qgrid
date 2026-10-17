/**
 * OpenAI subscription realtime voice: per-model live verification matrix (plan §3.4, D6).
 *
 * Runs the production OpenAIVoiceClient (the class OpenAIDispatcher uses) against the real
 * backend for every candidate model id and writes a Markdown matrix. The dispatcher, frame, and
 * SDK layers above the client are covered by unit tests; this script proves the upstream contract
 * and decides which ids ship. It consumes subscription quota; run it deliberately.
 *
 *   OPENAI_LIVE=1 pnpm tsx scripts/live-openai-voice-matrix.ts
 *
 * Environment:
 *   OPENAI_LIVE          must be "1"; otherwise the script prints the plan and exits 0
 *   VOICE_AUTH_FILE      Codex auth store (default ~/.codex/auth.json); the token is never printed
 *   VOICE_AUDIO_DIR      directory with hello.wav, ko.wav, long60.wav (default /tmp/choco-pi/audio)
 *   VOICE_STT_MODELS     comma-separated override of the STT candidates
 *   VOICE_TTS_MODELS     comma-separated override of the TTS candidates
 *   VOICE_OUT            Markdown output path (default scripts/out/openai-voice-matrix.md)
 *   VOICE_STT_DEADLINE_MS  override the /calls deadline (e.g. 1500 forces the direct-socket fallback)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  OPENAI_REALTIME_VOICES,
  OPENAI_SPEECH_MODELS,
  OPENAI_TRANSCRIPTION_MODELS,
} from "../packages/api/src/utils/providers/openai/openai-realtime-protocol";
import { OpenAIVoiceClient } from "../packages/api/src/utils/providers/openai/openai-voice-client";

const authSchema = z.object({
  tokens: z.object({ access_token: z.string().min(1), account_id: z.string().min(1) }),
});

type Row = { model: string; caseName: string; pass: boolean; ms: number; detail: string };

const EXPECTED = {
  hello: "Hello, this is a subscription transcription test for qgrid.",
  ko: "안녕하세요 큐그리드 음성 인식 테스트입니다",
  long60Words: 154,
};

const TTS_TEXTS = {
  short: "Hello from qgrid.",
  mixed:
    "큐그리드는 구독 토큰을 여러 공급자에 분배하는 프록시입니다. It routes OpenAI, Anthropic and Grok traffic through one API, logs every request, and tracks quota thresholds so a team never hits a hard limit mid-sprint. 오늘 배포는 오후 3시에 시작합니다.",
  symbols:
    "Build 42 finished in 3.5 seconds; see https://qgrid.dev/docs and the SDK README for the API.",
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Word error rate via Levenshtein on word tokens. */
function wer(expected: string, actual: string): number {
  const a = words(expected);
  const b = words(actual);
  const dp: number[][] = [];

  for (let i = 0; i <= a.length; i++)
    dp.push(Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const up = (dp[i - 1]?.[j] ?? 0) + 1;
      const left = (dp[i]?.[j - 1] ?? 0) + 1;
      const diag = (dp[i - 1]?.[j - 1] ?? 0) + cost;
      const row = dp[i];

      if (row) row[j] = Math.min(up, left, diag);
    }
  }

  return a.length === 0 ? 0 : (dp[a.length]?.[b.length] ?? 0) / a.length;
}

function normalize(text: string): string {
  return words(text).join(" ");
}

type Timed<T> = { value: T; ms: number } | { error: Error; ms: number };

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const started = Date.now();

  try {
    return { value: await fn(), ms: Date.now() - started };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      ms: Date.now() - started,
    };
  }
}

const errorMeta = z.object({ status: z.number().optional(), code: z.string().optional() });

function describeError(error: Error): string {
  const meta = errorMeta.safeParse(error);

  const status =
    meta.success && meta.data.status !== undefined ? ` (HTTP ${meta.data.status})` : "";

  const code = meta.success && meta.data.code !== undefined ? ` [${meta.data.code}]` : "";

  return `${error.name}${status}${code}: ${error.message}`.slice(0, 160);
}

function list(env: string | undefined, fallback: readonly string[]): string[] {
  return (env?.split(",") ?? [...fallback]).map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const sttModels = list(process.env.VOICE_STT_MODELS, OPENAI_TRANSCRIPTION_MODELS);
  const ttsModels = list(process.env.VOICE_TTS_MODELS, OPENAI_SPEECH_MODELS);
  const out = process.env.VOICE_OUT ?? "scripts/out/openai-voice-matrix.md";

  if (process.env.OPENAI_LIVE !== "1") {
    console.log(
      `Dry run. Would verify STT ${sttModels.join(", ")} and TTS ${ttsModels.join(", ")} → ${out}. Set OPENAI_LIVE=1.`,
    );

    return;
  }

  const authFile = process.env.VOICE_AUTH_FILE ?? path.join(os.homedir(), ".codex", "auth.json");
  const auth = authSchema.parse(JSON.parse(await readFile(authFile, "utf8")));
  const credentials = { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id };
  const audioDir = process.env.VOICE_AUDIO_DIR ?? "/tmp/choco-pi/audio";
  const hello = new Uint8Array(await readFile(path.join(audioDir, "hello.wav")));
  const ko = new Uint8Array(await readFile(path.join(audioDir, "ko.wav")));
  const long60 = new Uint8Array(await readFile(path.join(audioDir, "long60.wav")));

  const sttDeadlineMs = process.env.VOICE_STT_DEADLINE_MS
    ? Number(process.env.VOICE_STT_DEADLINE_MS)
    : undefined;

  const client = new OpenAIVoiceClient(sttDeadlineMs === undefined ? {} : { sttDeadlineMs });
  const rows: Row[] = [];

  const record = (row: Row) => {
    rows.push(row);
    console.log(
      `${row.pass ? "pass" : "FAIL"} ${row.model} ${row.caseName} ${row.ms}ms ${row.pass ? "" : row.detail}`,
    );
  };

  const sttCase = async (
    model: string,
    caseName: string,
    request: { audio: Uint8Array; language?: string; prompt?: string },
    judge: (text: string) => string | undefined,
  ) => {
    const result = await timed(() =>
      client.transcribe(credentials, { ...request, mediaType: "audio/wav", model }),
    );

    if ("error" in result) {
      record({ model, caseName, pass: false, ms: result.ms, detail: describeError(result.error) });

      return;
    }

    const failure = judge(result.value.text);
    const via = result.value.transport === "realtime-ws" ? " via fallback" : "";

    record({
      model,
      caseName,
      pass: failure === undefined,
      ms: result.ms,
      detail: (failure ?? `"${result.value.text.slice(0, 80)}"`) + via,
    });
  };

  const werJudge =
    (expected: string, limit: number, dropLastWord = false) =>
    (text: string) => {
      // "qgrid" is a coined name no ASR can know without a prompt; the no-prompt cases judge the
      // sentence without it, and en-lang-prompt checks that the prompt steers the spelling.
      const keep = words(expected).length - 1;

      const trim = (value: string) =>
        dropLastWord ? words(value).slice(0, keep).join(" ") : value;

      const rate = wer(trim(expected), trim(text));

      return rate <= limit ? undefined : `WER ${(rate * 100).toFixed(0)}%: "${text.slice(0, 100)}"`;
    };

  for (const model of sttModels) {
    await sttCase(model, "en-4s", { audio: hello }, werJudge(EXPECTED.hello, 0.1, true));
    await sttCase(model, "ko-auto", { audio: ko }, werJudge(EXPECTED.ko, 0.34, false));
    await sttCase(model, "en-60s", { audio: long60 }, (text) => {
      const count = words(text).length;

      return Math.abs(count - EXPECTED.long60Words) <= 15
        ? undefined
        : `${count} words (expected ~${EXPECTED.long60Words})`;
    });
    await sttCase(
      model,
      "en-lang-prompt",
      { audio: hello, language: "en", prompt: "qgrid, Codex" },
      werJudge(EXPECTED.hello, 0.1),
    );
  }

  const ttsCase = async (model: string, caseName: string, text: string, voice?: string) => {
    const result = await timed(() =>
      client.speak(credentials, { text, model, voice, format: "pcm" }),
    );

    if ("error" in result) {
      record({ model, caseName, pass: false, ms: result.ms, detail: describeError(result.error) });

      return;
    }

    const { audio, transcript, usage } = result.value;
    const seconds = audio.byteLength / 48_000;
    const expectedSeconds = Math.max(0.6, words(text).length / 3.4);
    let failure: string | undefined;

    if (usage.audioTokens <= 0) failure = "no audio tokens";
    else if (seconds < 0.8 * expectedSeconds)
      failure = `audio ${seconds.toFixed(1)}s < 0.8×${expectedSeconds.toFixed(1)}s`;
    else if (normalize(transcript) !== normalize(text))
      failure = `transcript differs: "${transcript.slice(0, 100)}"`;

    record({
      model,
      caseName,
      pass: failure === undefined,
      ms: result.ms,
      detail: failure ?? `${seconds.toFixed(1)}s audio, ${usage.audioTokens} audio tokens`,
    });
  };

  for (const model of ttsModels) {
    await ttsCase(model, "short", TTS_TEXTS.short);
    await ttsCase(model, "mixed-ko-en", TTS_TEXTS.mixed);
    await ttsCase(model, "digits-url", TTS_TEXTS.symbols);

    for (const voice of OPENAI_REALTIME_VOICES)
      await ttsCase(model, `voice-${voice}`, TTS_TEXTS.short, voice);
  }

  const byModel = new Map<string, Row[]>();

  for (const row of rows) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);

  const lines = [
    `# OpenAI realtime voice matrix — ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Run through the production `OpenAIVoiceClient` with the user's ChatGPT subscription token. An id ships only when every row passes.",
    "",
    "| Model | Verdict | Cases |",
    "| --- | --- | --- |",
    ...[...byModel].map(
      ([model, cases]) =>
        `| \`${model}\` | ${cases.every((r) => r.pass) ? "**ships**" : "dropped"} | ${cases.filter((r) => r.pass).length}/${cases.length} |`,
    ),
    "",
    "| Model | Case | Result | Latency | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| \`${r.model}\` | ${r.caseName} | ${r.pass ? "pass" : "FAIL"} | ${r.ms} ms | ${r.detail.replace(/\|/g, "\\|")} |`,
    ),
    "",
  ];

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, lines.join("\n"));
  console.log(`\nwrote ${out}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
