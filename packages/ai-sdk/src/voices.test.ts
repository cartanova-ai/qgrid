import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { QGRID_GROK_VOICES, QGRID_LIVE_VOICES, QGRID_OPENAI_SPEECH_VOICES } from "./voices";

// The server's lists are the source of truth (it validates the OpenAI ones); this catches drift.
const serverTypes = readFile(
  new URL("../../api/src/application/qgrid/qgrid.types.ts", import.meta.url),
  "utf8",
);

async function serverList(start: string, end: string): Promise<string[]> {
  const text = await serverTypes;
  const from = text.indexOf(start);
  const block = text.slice(from, text.indexOf(end, from));

  return [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("voice lists", () => {
  it("stay import-free, so the /voices entry loads in browsers and React Native", async () => {
    const source = await readFile(new URL("./voices.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/^\s*(import|export .* from)\b/m);
  });

  it("match the server's lists", async () => {
    expect(await serverList("export const OPENAI_SPEECH_VOICES", "] as const;")).toEqual([
      ...QGRID_OPENAI_SPEECH_VOICES,
    ]);
    expect(await serverList("export const OPENAI_LIVE_VOICES", "] as const;")).toEqual([
      ...QGRID_LIVE_VOICES,
    ]);
    expect(await serverList("export const GROK_TTS_VOICES", "} as const;")).toEqual([
      ...QGRID_GROK_VOICES.female,
      ...QGRID_GROK_VOICES.male,
    ]);
  });
});
