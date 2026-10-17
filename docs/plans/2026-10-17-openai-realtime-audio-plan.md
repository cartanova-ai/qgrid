# OpenAI subscription audio (realtime STT/TTS) plan

**Status:** Research complete; decisions D1–D6 settled by the user (§1.3). Implemented 2026-10-17 (U1–U7); shipped ids per the matrix in `docs/diagnosis/2026-10-17-openai-realtime-audio-probe.md`: STT gpt-4o-mini-transcribe, gpt-4o-transcribe, gpt-transcribe; TTS gpt-realtime-2.1-mini. Revision 2 (2026-10-17): GPT-Image-2.5 work removed from scope (D5); per-model live verification is an explicit unit (U7) whose output is the shipped model list (§3.4, D6). Every "verified" claim cites a file in the Codex clone, the `@ai-sdk/openai` clone, qgrid, or a live probe run on 2026-10-17 with the user's ChatGPT OAuth token. Anything not shown by those sources is marked **unverified**.

**Baseline:** qgrid working tree at `530b74e4`; `openai/codex` main @ 2026-10-17 (clone `/tmp/choco-pi/codex/codex`); `vercel/ai` @ `fce9210` (2026-10-16, `packages/openai/src`); OpenAI model catalog page `developers.openai.com/api/docs/models` fetched 2026-10-17. Probe scripts: `/tmp/choco-pi/audio/probe*.cjs` (not committed; §7 ports the useful ones).

**Workflow:** `task-inline` — one implementation unit; write scopes overlap (OpenAI provider, frame, ai-sdk, docs). Units below are ordered steps inside that unit, not parallel agents.

---

## 1. Objective, scope, decisions

### 1.1 Objective

Add OpenAI subscription speech-to-text and text-to-speech to qgrid alongside the existing Grok voice route, so that:

1. `qgrid.transcription("openai/<id>")` and `qgrid.speech("openai/<id>")` work from `@cartanova/qgrid-ai-sdk`;
2. requests presented to OpenAI mirror Codex's realtime wire shape (headers, URL, session JSON, event names) as far as a one-shot server-side client can;
3. the AI SDK surface matches `@ai-sdk/openai`'s transcription/speech option names and result fields, so code written for the official provider ports with mechanical changes (same contract style as the Grok/xai parity in `packages/ai-sdk/src/transcription-model.ts:22-49`);
4. the set of model ids actually exposed is decided by per-model live verification after implementation, not by the catalog (§3.4, U7).

### 1.2 Exclusions

- No REST `POST https://chatgpt.com/backend-api/transcribe` route (Route A). Verified working (probe, 200 for wav/mp3/webm, Korean auto-detect, 9 MiB mp3 OK, 24 MiB → 500 "Error in ASR API"), but it is a ChatGPT-web endpoint Codex removed in PR #16114 (2026-03-29), ignores `model`/`language`/`prompt`, returns no model/duration, and retains uploads 30 days (`asset_ttl`). Excluded by D1.
- No WebRTC/RTP media stack in qgrid. Consequence for TTS in §2.3.
- No `/backend-api/codex/audio/transcriptions`, `/audio/speech`, `gpt-4o-mini-tts`, `gpt-transcribe` via `/codex/responses`, or Responses `input_audio`: all verified unavailable on subscription (404 / "not supported when using Codex with a ChatGPT account" / "Audio input is not available").
- No streaming transcription (`@ai-sdk/openai` `doStream` / `providerOptions.openai.streaming`); the qgrid `TranscriptionModelV3` surface is generate-only, as for Grok.
- No diarization (`gpt-4o-transcribe-diarize`, `responseFormat: diarized_json`): not probed; realtime transcription sessions expose no diarization field.
- No compressed audio input in the first cut (mp3/webm/ogg): realtime sessions take PCM16 only and qgrid has no decoder dependency. Rejected with 400; follow-up item.
- No GPT-Image-2.5 work of any kind (guard, docs, ids). Evidence that the subscription image route ignores the model id is kept in §4 for reference only (D5).

### 1.3 Decisions (settled)

| # | Decision | Outcome | Binds |
|---|---|---|---|
| D1 | STT transport | Realtime transcription session, Codex `/realtime/calls` + sideband WS shape. Route A excluded. | §2.2, U2 |
| D2 | TTS transport | Realtime conversational session over the direct WS (`?model=`), Codex V2 session payload minus tools. The only non-Codex path; feature-flagged. | §2.3, U2, risk R1 |
| D3 | Fidelity | Mirror Codex HEAD headers, URL, query, session JSON, outbound event names. Deviations enumerated in §2.4 only. | §2, golden test U2 |
| D4 | SDK interface | Option names/semantics follow `@ai-sdk/openai` (`providerOptions.openai`), with `unsupported` warnings for fields the realtime route cannot honor. | §3, U4 |
| D5 | GPT-Image-2.5 | Out of scope now. No guard, no doc change. §4 retained as evidence for a later decision. | §4 |
| D6 | Model list | Implement against the candidate list, then verify every id live per §3.4; ship only ids that pass; record pass/fail per id in `docs/diagnosis/2026-10-17-openai-realtime-audio-probe.md`. | §3.4, U7 |

---

## 2. Upstream contract (Codex-faithful)

### 2.1 Why two transports

Codex has two realtime transports (`codex-rs/core/src/realtime_conversation.rs`):

- `ConversationStartTransport::Websocket` — direct `wss://api.openai.com/v1/realtime`. `realtime_api_key()` (`realtime_conversation.rs:1931-1955`) errors `"realtime conversation requires API key auth"` for ChatGPT auth; the provider is built with `to_api_provider(Some(AuthMode::ApiKey))` (`:1375`). **Not a Codex subscription path.** Live probe nevertheless shows the server accepts a ChatGPT bearer there (probe11/12: `session.created` for `?model=gpt-realtime-2.1-mini` and `?intent=transcription`).
- `Webrtc` / `ExistingCall` — `POST {CHATGPT_CODEX_BASE_URL}/realtime/calls` (`model-provider-info/src/lib.rs:80` = `https://chatgpt.com/backend-api/codex`; `client.rs:178,740-774`; `codex-api/src/endpoint/realtime_call.rs:129-209`), then a sideband WS to `OPENAI_REALTIME_API_BASE_URL = https://api.openai.com/v1` (`realtime_websocket/methods.rs:63`) → `wss://api.openai.com/v1/realtime?call_id=<rtc_…>` (`methods.rs:1380-1415`) with the same auth headers (`client.rs:528 sideband_websocket_auth_headers`). **This is the Codex subscription path.**

Live comparison (probe15–17):

| | `/calls` + sideband | direct WS |
|---|---|---|
| STT completion events | yes, 6 model ids; `session.update` on the sideband switches model/language/prompt | yes |
| 60 s clip (2.9 MB PCM, sent as a burst) | completed 3.7 s after open (154 words) | 5.2 s |
| Lifetime with no ICE connection | **torn down ≈30 s after create** (25 s idle OK; 31 s → WS error; attach at +30 s fails) | none observed |
| TTS `response.output_audio.delta` on WS | **never** (2 runs; transcript events and audio-token billing present) — media is on RTP | yes (76 800 B PCM for "Hello from qgrid.") |

### 2.2 STT: transcription session via `/realtime/calls` (D1)

1. `POST https://chatgpt.com/backend-api/codex/realtime/calls`
   - Headers (§2.5), `Content-Type: application/json`. **No** `intent=quicksilver&architecture=avas` query — V2 (`RealtimeEventParser::RealtimeV2`) omits it (`realtime_call.rs:213-224`); with it the server demands `session.type=quicksilver` (probe5).
   - Body: `{"sdp": "<offer>", "session": <transcription session>}` where the session is the exact Codex V2 transcription shape (`methods_v2.rs:145-167`, serde `skip_serializing_if` → keys absent, not null): 
     `{"type":"transcription","audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"transcription":{"model":"<id>"}}}}`
   - Success: `201`, `Location: /v1/realtime/calls/rtc_…` (call id = last segment, `realtime_call.rs:281 is_realtime_call_id_segment`), body `text/plain` SDP answer (ignored). Response carries `x-codex-primary-used-percent`, `x-codex-plan-type`, etc. (probe15) — feed to the existing quota tracker.
2. Open `wss://api.openai.com/v1/realtime?call_id=<id>` with the §2.5 headers. Must finish before the 30 s teardown; hard deadline **25 s from the POST**.
3. Send `session.update` with the same session plus the per-request fields: `transcription.language`, `transcription.prompt`, and `turn_detection: null` (deviation §2.4-b). Verified accepted (probe15 #2: `session.updated` then correct text).
4. Send `input_audio_buffer.append {audio:<base64 PCM16 24 kHz mono>}` in 1 s chunks (48 000 B), then `input_audio_buffer.commit`. Codex frame event name: `protocol.rs:53-54`.
5. Resolve on `conversation.item.input_audio_transcription.completed` (`transcript`); collect `…transcription.delta` for logging only. Fail on `error` or socket close.

Model ids verified in this exact flow (probe8): `gpt-4o-mini-transcribe` (Codex default, `methods_v2.rs:37`), `gpt-4o-transcribe`, `gpt-transcribe`, `gpt-live-transcribe`, `gpt-realtime-whisper`, `whisper-1`. All are in the OpenAI catalog except `whisper-1`, which is in `@ai-sdk/openai`'s `OpenAITranscriptionModelId`. Not advertised by `/backend-api/codex/models` (text models only).

### 2.3 TTS: conversational session via direct WS (D2)

No audio reaches the sideband on the `/calls` path, and qgrid has no RTP stack, so TTS uses `wss://api.openai.com/v1/realtime?model=<id>` with §2.5 headers (minus `x-session-id` semantics that assume a thread; keep the header anyway with a fresh UUID).

1. `session.update` with the Codex V2 conversational session (`methods_v2.rs:82-144`) minus `tools`/`tool_choice`:
   `{"type":"realtime","instructions":"<see below>","output_modalities":["audio"],"audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"noise_reduction":{"type":"near_field"},"transcription":{"model":"gpt-4o-mini-transcribe"},"turn_detection":{"type":"server_vad","interrupt_response":true,"create_response":true,"silence_duration_ms":500}},"output":{"format":{"type":"audio/pcm","rate":24000},"voice":"<voice>"}}}`
2. `conversation.item.create {item:{type:"message",role:"user",content:[{type:"input_text",text:<input>}]}}` (`methods_v2.rs:39-60`), then `response.create` (`protocol.rs:77-78`).
3. Concatenate `response.output_audio.delta`; resolve on `response.done`; record `response.usage.output_token_details.audio_tokens` and `rate_limits.updated`.
4. `instructions` default: `"Repeat the user text verbatim. Do not add, omit, or translate anything."` plus the caller's `providerOptions.openai.instructions` appended as style guidance. Verified verbatim for a short English sentence (probe9/12: transcript `"Hello from qgrid."`); **unverified** for long or multilingual input (risk R4).

Models: `gpt-realtime-2.1-mini` (qgrid default), `gpt-realtime-2.1`, `gpt-realtime-1.5` (Codex default, `realtime_conversation.rs:112`). `-2.1-mini` and `-1.5` verified (probe8); `-2.1` **unverified** for audio output (session creation only). Voices: Codex V2 list `alloy ash ballad coral echo sage shimmer verse marin cedar`, default `marin` (`protocol/src/protocol.rs:368-379, 408`). Only `marin` verified live.

Output is PCM16 24 kHz mono. The server supports `audio/pcm`, `audio/pcmu`, `audio/pcma` output formats only; `mp3`/`opus` are not realtime output formats (§3.2 handles the mapping).

### 2.4 Deviations from Codex (exhaustive)

a. **Synthetic SDP offer.** Codex sends a real browser/TUI WebRTC offer; qgrid sends a fixed minimal Opus offer (one `m=audio` section, `a=setup:actpass`, dummy fingerprint). Accepted in every probe. Risk R2.
b. **Explicit commit.** Codex transcription mode omits `turn_detection` (server VAD). qgrid sets `turn_detection: null` and sends `input_audio_buffer.commit` so a one-shot clip is transcribed as one item.
c. **TTS over direct WS** (§2.3). Risk R1.
d. **No `tools`/`tool_choice`, no `x-codex-turn-metadata`, no `x-oai-attestation`** (Codex adds the latter only when an attestation provider is configured, `client.rs:903-915`).
e. **Headers `session-id`/`thread-id`** carry qgrid request-log ids rather than a Codex thread.

### 2.5 Header set

From `login/src/auth/default_client.rs:456-470`, `realtime_conversation.rs:1957-1998`, `codex-api/src/requests/headers.rs:5-14`, `client.rs:528-532`; identical on the POST and both WebSockets:

| Header | Value | Source |
|---|---|---|
| `Authorization` | `Bearer <ChatGPT access_token>` | auth provider |
| `ChatGPT-Account-Id` | account id from the token store | auth provider |
| `originator` | `codex_cli_rs` (`CODEX_CLI_ORIGINATOR`, `openai-backend-protocol.ts:19`) | default_headers |
| `User-Agent` | existing qgrid Codex UA builder | default_headers |
| `x-session-id` | thread/request UUID | realtime_request_headers |
| `voice-session-id` | fresh UUID per request | realtime_request_headers |
| `session-id`, `thread-id` | request-log ids | build_session_headers |

**Not sent:** `OpenAI-Beta` (V2 sends none; the server answers `beta_api_shape_disabled` when `realtime=v1` is present — probe10), `openai-alpha` (V1/V3 only).

---

## 3. AI SDK interface parity with `@ai-sdk/openai`

Source of truth: `/tmp/choco-pi/ai/packages/openai/src/transcription/openai-transcription-model-options.ts`, `…/speech/openai-speech-model-options.ts`, `…/speech/openai-speech-model.ts`. Namespace is `providerOptions.openai` (not `qgrid`), mirroring how Grok uses `providerOptions.xai`.

### 3.1 Transcription (`qgrid.transcription("openai/<id>")`)

Candidate model id union `QgridOpenAITranscriptionModel` (final list set by U7): `openai/whisper-1 | openai/gpt-4o-mini-transcribe | openai/gpt-4o-transcribe | openai/gpt-transcribe | openai/gpt-live-transcribe | openai/gpt-realtime-whisper`, plus the official dated snapshots `gpt-4o-mini-transcribe-2025-03-20`, `gpt-4o-mini-transcribe-2025-12-15` and `gpt-4o-transcribe-diarize` as U7 candidates only (the pre-implementation probe did not cover them).

| `providerOptions.openai` field (official schema) | qgrid behavior |
|---|---|
| `language: string` | sent as `transcription.language` (ISO-639-1 as in official) |
| `prompt: string` | sent as `transcription.prompt` |
| `temperature` | `unsupported` warning (no realtime field) |
| `include`, `timestampGranularities`, `responseFormat`, `chunkingStrategy`, `streaming` | `unsupported` warning, value ignored |

Schema: copy the official zod object field-for-field (same names, types, bounds) so unknown-key errors match; honored set = `{language, prompt}`. Result: `{ text, segments: [], language: options.language ?? undefined, durationInSeconds: <computed from PCM length>, warnings, response: { timestamp, modelId, headers } }`. The realtime route returns no language/duration; `durationInSeconds` is computed client-side from decoded sample count (document as computed), `language` echoes the request or is `undefined` — never guessed.

Accepted `mediaType`: `audio/wav`, `audio/x-wav`, `audio/wave` (PCM16 only; other WAV encodings → 400), `audio/pcm`, `audio/l16` (assume 24 kHz mono unless `;rate=` / `;channels=` params are present). Others → 400 with "realtime transcription requires PCM16; mp3/webm/ogg are not yet supported" (official provider accepts them; recorded as an `unsupported` deviation in README).

### 3.2 Speech (`qgrid.speech("openai/<id>")`)

Candidate model id union `QgridOpenAISpeechModel` (final list set by U7): `openai/gpt-realtime-2.1-mini | openai/gpt-realtime-2.1 | openai/gpt-realtime-1.5`, with `gpt-realtime-2`, `gpt-realtime-mini`, `gpt-live-1` from the catalog as U7 candidates. The official ids (`gpt-4o-mini-tts`, `tts-1*`) are unavailable on subscription (verified) and are rejected at the factory with that message.

| Call option / `providerOptions.openai` | official | qgrid |
|---|---|---|
| `text` | required | `conversation.item.create` input_text |
| `voice` | default `alloy` | default `marin`; must be in the V2 list; otherwise `unsupported` warning + default (official passes any string through — deviation, documented) |
| `outputFormat` | `mp3` default; `mp3 opus aac flac wav pcm` | `wav` default (PCM16 24 kHz with RIFF header); `pcm` → raw; anything else → `unsupported` warning "Using wav instead." (mirrors the official warning text pattern `speech/openai-speech-model.ts:79-86`) |
| `instructions` (`nullish`) | sent | appended to the verbatim system instruction (§2.3) |
| `speed` (`0.25–4.0`) | sent | `unsupported` warning |
| `language` | `unsupported` warning (`:105-110`) | same warning, same text |

Result: `{ audio: Uint8Array, warnings, request: { body }, response: { timestamp, modelId, headers }, providerMetadata: { openai: { audioTokens, textTokens } } }`. `providerMetadata` is an addition the official provider lacks; keep it namespaced under `openai`.

### 3.3 Factory guards

`qgrid.transcription()`/`qgrid.speech()` already accept only Grok ids via `assertGrokModelId` (`image-model.ts:50-75`). Replace with a prefix dispatcher: `grok/` → existing path with `providerOptions.xai`; `openai/` → new path with `providerOptions.openai`. Unknown prefix or an official-but-unavailable id → thrown error naming the supported list.

### 3.4 Per-model verification protocol (D6)

Run after U1–U4 against the user's token, once per candidate id, through qgrid itself (server + `@cartanova/qgrid-ai-sdk`), not through raw probes. Each STT id gets the same four inputs; each TTS id gets the same four texts. An id ships only if every row passes; partial passes are recorded and the id is dropped.

STT inputs: (1) 4 s English wav 24 kHz (`hello.wav`); (2) 5 s Korean wav (`ko.wav`) with `language` unset; (3) 60 s English wav (`long60.wav`); (4) 4 s English with `language: "en"` and a `prompt` — asserts the `session.updated` echo carries both. Pass = word-error ≤ 10 % against the known source text, completion within the 25 s deadline, no `error` event.

TTS texts: (1) `"Hello from qgrid."`; (2) 300-char mixed Korean+English paragraph; (3) a sentence containing digits, a URL and an acronym; (4) same as (1) once per voice in the V2 list. Pass = `audio_tokens > 0`, PCM length ≥ 0.8 × expected, `response.output_audio_transcript.done` equals the input after whitespace/punctuation normalization (fidelity criterion for the "realtime model repeating text" approach), every listed voice accepted.

Outputs: a matrix in `docs/diagnosis/2026-10-17-openai-realtime-audio-probe.md` (id × case → pass/fail, latency, tokens, first error message) and the final unions in `index.types.ts` / server constants. Failing ids are listed in the README as "not available on subscription (verified <date>)" so they are not re-added without a new run.

---

## 4. GPT-Image-2.5 Sunburst / Flare: evidence only (D5, no work)

Evidence (probe13/14, 2026-10-17): `POST /backend-api/codex/images/generations` returned 200 with identical `output_tokens: 343` for `gpt-image-2`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst-2026-09-08`, **and `gpt-image-totally-fake-9`**; no `model` in the response; requested `1024x1024` overridden to `1536x1024`. Hosted Responses `image_generation` tool with `model` set to flare/sunburst/fake/omitted all echoed `"model":"gpt-image-2-codex"` in `response.completed.tools`. Codex HEAD hard-codes `IMAGE_MODEL = "gpt-image-2"` (`ext/image-generation/src/tool.rs:65`). Official ids and snapshots (`gpt-image-2.5-{sunburst,flare}[-2026-09-08]`) publish the same $30/M image-token rate as `gpt-image-2`.

Conclusion: the subscription route serves one fixed model and ignores the id. Exposing `openai/gpt-image-2.5-*` would be a label with no effect. By D5 nothing is implemented now; if revisited, the re-check is: send a nonsense id — a 400 means model selection has become real.

---

## 5. Implementation units (sequential, one `task-inline` run)

| Unit | Scope (write) | Content | Done when |
|---|---|---|---|
| U1 | `packages/api/src/utils/providers/openai/openai-realtime-protocol.ts` (new) | Typed `SessionUpdateSession` (transcription + conversational), outbound event builders, inbound event union, header builder, voice/model constants with Codex source refs, synthetic SDP constant, PCM helpers (WAV parse, downmix, resample to 24 kHz — port of Codex `convert_pcm16`). | Unit tests: serialized JSON byte-equal to §2.2/§2.3 fixtures; header map equals §2.5 table. |
| U2 | `openai-voice-client.ts` (new), `openai-dispatcher.ts`, `openai-constants.ts` | `transcribe()` per §2.2 with 25 s deadline; `speak()` per §2.3 behind `OPENAI_REALTIME_TTS_ENABLED` (default on; flag exists to disable fast if gated). One 401 → refresh → single retry, as the Responses path does. Map WS `error` events to qgrid upstream errors; no retry on 4xx; no silent transport fallback. Parse `x-codex-*` quota headers from the `/calls` response. | Mocked `fetch`/`WebSocket` tests for success, 401-refresh, deadline, server `error`, early close. |
| U3 | `qgrid.frame.ts`, `qgrid.types.ts`, provider dispatcher | Route `openai/` STT/TTS ids to U2; keep `grok/` untouched; media size limit `MEDIA_MAX_INLINE_BYTES` unchanged; request-log fields (`provider`, model, audio tokens, transport = `realtime-calls` / `realtime-ws`). | Existing Grok tests green; new frame tests for both providers. |
| U4 | `packages/ai-sdk/src/{index.types,transcription-model,speech-model}.ts`, README(.ko) | §3 interface with the candidate unions; README parity table listing honored / warned / rejected options vs `@ai-sdk/openai`. | `readme-examples.test.ts` and model tests green; type tests for the unions. |
| U5 | `packages/api/scripts/` (or existing smoke location per `verification-and-debugging.md`) | Live verification script gated by `OPENAI_LIVE=1` implementing §3.4 end-to-end through the running qgrid server and SDK; emits the matrix as Markdown; reads the token as the server does; never prints it. | Full matrix runs for one id locally. |
| U6 | `packages/cli/skills/qgrid/references/{openai-codex-runtime,ai-sdk-provider-contract,decision-rationale}.md` (canonical) and the `.agents/skills/qgrid` mirror; `docs/qgrid-doc-map.json` (add the new U1/U2 code files to the `provider-runtimes` topic); this plan's `.ko.md` | §2 contract summary with the comparison table and 30 s teardown; link this plan from `decision-rationale.md` as the Grok plan is. No image-doc changes (D5). | Skill mirror identical to canonical; references match code constants; doc map still parses. |
| U7 | `docs/diagnosis/2026-10-17-openai-realtime-audio-probe.md` (new), then the unions in `index.types.ts`, server model constants, README model tables | Run U5 for every candidate id in §3.1/§3.2; write the matrix; prune failing ids from code and docs; list them as verified-unavailable. | Every shipped id has a full passing row dated in the diagnosis doc; every candidate has a row. |

Order: U1 → U2 → U3 → U4 → U5 → U7 → U6. U7 is the acceptance gate for D1/D2/D6; U6 documents the post-U7 state.

---

## 6. Risks

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | TTS path is not a Codex subscription path; Codex code says the WS transport needs an API key. Could be gated any time. | `realtime_conversation.rs:1931-1955`; works today (probe12). | Feature flag; precise 401/403 → 503 with message; no fallback; smoke test in CI-by-hand before releases. |
| R2 | Synthetic SDP may be validated more strictly; `/calls` create latency (0.9–6.7 s observed) eats the 30 s budget. | probe15–17. | 25 s deadline from POST; fail fast, do not retry create; cap input at inline limit (≈2.4 min PCM) which still completed in <4 s. |
| R3 | Quota attribution unknown. `x-codex-primary-used-percent` rose 87→88 during probing; realtime `rate_limits.updated` shows a separate 15 M-token bucket. | probe15/9. | Log both; measure before/after a fixed batch in U7; document as unconfirmed until measured. |
| R4 | TTS fidelity: a conversational model may paraphrase or translate long/multilingual text. | Only one short English sentence verified. | U7 adds a 300-char Korean+English case; README states "realtime model repeating text, not a TTS model". |
| R5 | Audio input formats narrower than official provider (PCM16 only). | §3.1. | Documented deviation; follow-up: optional decoder. |
| R6 | Server may start rejecting `whisper-1` or snapshot-less ids on realtime. | Accepted today (probe8). | Model list is data, not logic; one-line removal. |
| R7 | Ids that passed raw probes fail through qgrid (encoding, deadline, header or token-selection differences). | Raw probes bypassed qgrid's token selection and media limits. | U7 runs through the server, not probes; failures prune the list instead of blocking the release. |

---

## 7. Acceptance ledger

| Claim | How verified |
|---|---|
| STT via `/calls` + sideband returns correct text for 6 model ids | U7 smoke; probe8/15 today |
| STT honors `language`/`prompt` via sideband `session.update` | probe15 #2 today; U7 asserts `session.updated` echo |
| 60 s clip completes inside the 30 s window | probe17 (3.7 s); U7 repeats |
| TTS returns PCM audio bytes with `audio_tokens > 0` | probe12 (76 800 B, 32 tokens); U7 repeats |
| No `OpenAI-Beta`, no `intent=quicksilver` on V2 | probe5/10 negative results; U1 golden test |
| Every shipped model id passes all §3.4 cases through qgrid; every failing candidate is listed as unavailable | U7 matrix in the diagnosis doc |
| Official `@ai-sdk/openai` option names parse without schema errors and produce documented warnings | U4 tests, README table |

---

## 8. Follow-ups (out of scope)

- Compressed audio input decoding (mp3/ogg/webm) for STT.
- Streaming transcription surface if the qgrid SDK adopts `TranscriptionModelV4`/`doStream`.
- Real WebRTC client to make TTS Codex-faithful.
- Re-probe `/backend-api/transcribe` (Route A) if a non-PCM one-shot route is wanted later.
