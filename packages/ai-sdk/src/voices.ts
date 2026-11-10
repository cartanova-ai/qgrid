// Voice ids each qgrid voice model takes, default first. Mirrors the server's lists (qgrid.types.ts
// OPENAI_SPEECH_VOICES, OPENAI_LIVE_VOICES, GROK_TTS_VOICES); keep them equal. No imports, so both
// the main entry and the browser /realtime entry export it.

/**
 * `voice` for `qgrid.speech("grok/...")`: the /tts voices xAI lists for subscription tokens
 * (2026-11-06; default `ara`). The server passes other ids through to xAI unchecked.
 */
export const QGRID_GROK_VOICES = {
  female: ["ara", "aurora", "carina", "celeste", "eve", "iris", "liora", "luna", "ursa"],
  male: [
    "altair",
    "atlas",
    "castor",
    "cosmo",
    "helios",
    "helix",
    "kepler",
    "leo",
    "lumen",
    "lux",
    "naksh",
    "orion",
    "perseus",
    "rex",
    "rigel",
    "sal",
    "sirius",
    "zagan",
    "zenith",
  ],
} as const;

export type QgridGrokVoice = (typeof QGRID_GROK_VOICES)[keyof typeof QGRID_GROK_VOICES][number];

/** `voice` for `qgrid.speech("openai/...")` (default `marin`); the server rejects any other with 400. */
export const QGRID_OPENAI_SPEECH_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

export type QgridOpenAISpeechVoice = (typeof QGRID_OPENAI_SPEECH_VOICES)[number];

/**
 * `sessionConfig.voice` for `qgrid.realtime("openai/gpt-live-1")` and `voice` for the HTTP
 * `liveCall` (default `cove`). The server rejects any other: OpenAI would accept the call and never
 * start the session.
 */
export const QGRID_LIVE_VOICES = [
  "cove",
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "aube",
  "bubbie",
  "haetsal",
  "hanul",
  "himari",
  "leher",
  "miko",
  "neer",
  "porto",
  "rindo",
  "rio",
  "rivage",
  "selva",
  "sonna",
  "tinta",
  "viola",
] as const;

export type QgridLiveVoice = (typeof QGRID_LIVE_VOICES)[number];
