# OpenAI realtime voice live matrix — 2026-10-17

Account: the user’s ChatGPT subscription token from `~/.codex/auth.json` (plan D1/D2). Runner: `scripts/live-openai-voice-matrix.ts` driving the production `OpenAIVoiceClient` (the class `OpenAIDispatcher` uses) directly; the frame/dispatcher/SDK layers above it are covered by unit tests, and no local PostgreSQL was available to run the HTTP path end-to-end. Three runs: run 1 (full), runs 2–3 (STT only, after fixing the judge so the coined word “qgrid” is not counted against models that received no prompt). STT verdicts were identical across runs 2 and 3.

Rule (plan D6): an id ships only when every row passes.

## Verdict

| Kind | Model | Verdict | Why |
| --- | --- | --- | --- |
| STT | `gpt-4o-mini-transcribe` | **ships** | 4/4 |
| STT | `gpt-4o-transcribe` | **ships** | 4/4 |
| STT | `gpt-transcribe` | **ships** | 4/4 |
| STT | `gpt-live-transcribe` | dropped | returns ~75 of 154 words for the 60 s clip; `prompt` does not steer spelling |
| STT | `gpt-realtime-whisper` | dropped | ~75/154 words on 60 s; Korean WER 60 %; server rejects `prompt` (`invalid_value`) |
| STT | `whisper-1` | dropped | transcribes correctly but `prompt` has no effect (“Thread” for “qgrid”) |
| TTS | `gpt-realtime-2.1-mini` | **ships** | 13/13: short, 300-char KO+EN, digits/URL, all 10 voices verbatim |
| TTS | `gpt-realtime-2.1` | dropped | 12/13; voice `shimmer` paraphrased (“Hello there! Hello from qgrid received loud and clear…”) |
| TTS | `gpt-realtime-1.5` | dropped | 6/13; answers the text instead of repeating it on 7 voices |

Cases. STT: `en-4s` (4 s English, no options), `ko-auto` (5 s Korean, no language), `en-60s` (60 s English, 154 words), `en-lang-prompt` (`language: en`, `prompt: "qgrid, Codex"`); pass = WER ≤ 10 % (Korean ≤ 34 % on the synthesized reference), word count within ±15, no error. TTS: `short`, `mixed-ko-en` (300 chars), `digits-url`, `voice-<name>` for the Codex v2 list; pass = audio tokens > 0, PCM length ≥ 0.8× expected, model’s own transcript equals the input after punctuation/whitespace normalization.

Latency: STT 3–6 s for 4 s clips, 5–10 s for 60 s (whisper-1 13 s); TTS 2–5 s. All inside the 25 s `/calls` budget.

## STT rows (run 3)

| Model | Case | Result | Latency | Detail |
| --- | --- | --- | --- | --- |
| `gpt-4o-mini-transcribe` | en-4s | pass | 3379 ms | "Hello, this is a subscription transcription test for Volkgrid." |
| `gpt-4o-mini-transcribe` | ko-auto | pass | 3144 ms | "안녕하세요? 큐그리드 음성 인식 테스트입니다." |
| `gpt-4o-mini-transcribe` | en-60s | pass | 5496 ms | "This is sentence number one of a long subscription transcription test. This is s" |
| `gpt-4o-mini-transcribe` | en-lang-prompt | pass | 13782 ms | "Hello, this is a subscription transcription test for Qgrid." |
| `gpt-4o-transcribe` | en-4s | pass | 3660 ms | "Hello, this is a subscription transcription test for Thgrid." |
| `gpt-4o-transcribe` | ko-auto | pass | 3273 ms | "안녕하세요, 큐그리드 음성 인식 테스트입니다." |
| `gpt-4o-transcribe` | en-60s | pass | 6816 ms | "This is sentence number one of a long subscription transcription test. This is s" |
| `gpt-4o-transcribe` | en-lang-prompt | pass | 4056 ms | "Hello, this is a subscription transcription test for qgrid." |
| `gpt-transcribe` | en-4s | pass | 3304 ms | "Hello, this is a subscription transcription test for the grid." |
| `gpt-transcribe` | ko-auto | pass | 5566 ms | "안녕하세요. 큐그리드 음성 인식 테스트입니다." |
| `gpt-transcribe` | en-60s | pass | 6094 ms | "This is sentence number one of a long subscription transcription test. This is s" |
| `gpt-transcribe` | en-lang-prompt | pass | 4320 ms | "Hello, this is a subscription transcription test for Qgrid." |
| `gpt-live-transcribe` | en-4s | pass | 3658 ms | "Hello, this is a subscription transcription test for the grid." |
| `gpt-live-transcribe` | ko-auto | pass | 3537 ms | "안녕하세요? 휴그리드 음성 인식 테스트입니다." |
| `gpt-live-transcribe` | en-60s | FAIL | 9937 ms | 79 words (expected ~154) |
| `gpt-live-transcribe` | en-lang-prompt | FAIL | 4205 ms | WER 22%: "Hello, this is a subscription transcription test for the grid." |
| `gpt-realtime-whisper` | en-4s | pass | 5190 ms | "Hello, this is a subscription transcription test for the grid." |
| `gpt-realtime-whisper` | ko-auto | FAIL | 4372 ms | WER 60%: "안녕히 가세요 휴그리드 음성 인식 테스트입니다." |
| `gpt-realtime-whisper` | en-60s | FAIL | 9724 ms | 75 words (expected ~154) |
| `gpt-realtime-whisper` | en-lang-prompt | FAIL | 2366 ms | OpenAIProtocolError [invalid_value]: The 'prompt' parameter is not supported for this model. |
| `whisper-1` | en-4s | pass | 4091 ms | "Hello. This is a subscription transcription test for Thread." |
| `whisper-1` | ko-auto | pass | 2860 ms | "안녕하세요. 큐그리드 음성 인식 테스트입니다." |
| `whisper-1` | en-60s | pass | 15401 ms | "This is sentence number 1 of a long subscription transcription test. This is sen" |
| `whisper-1` | en-lang-prompt | FAIL | 5302 ms | WER 11%: "Hello, this is a subscription transcription test for Thread." |

## TTS rows (run 1)

| Model | Case | Result | Latency | Detail |
| --- | --- | --- | --- | --- |
| `gpt-realtime-2.1-mini` | short | pass | 2545 ms | 1.8s audio, 35 audio tokens |
| `gpt-realtime-2.1-mini` | mixed-ko-en | pass | 4292 ms | 18.5s audio, 370 audio tokens |
| `gpt-realtime-2.1-mini` | digits-url | pass | 3203 ms | 10.8s audio, 215 audio tokens |
| `gpt-realtime-2.1-mini` | voice-alloy | pass | 2734 ms | 1.9s audio, 37 audio tokens |
| `gpt-realtime-2.1-mini` | voice-ash | pass | 2433 ms | 1.6s audio, 31 audio tokens |
| `gpt-realtime-2.1-mini` | voice-ballad | pass | 2317 ms | 2.0s audio, 41 audio tokens |
| `gpt-realtime-2.1-mini` | voice-coral | pass | 2480 ms | 1.8s audio, 35 audio tokens |
| `gpt-realtime-2.1-mini` | voice-echo | pass | 2393 ms | 1.6s audio, 32 audio tokens |
| `gpt-realtime-2.1-mini` | voice-sage | pass | 2452 ms | 1.7s audio, 34 audio tokens |
| `gpt-realtime-2.1-mini` | voice-shimmer | pass | 2486 ms | 2.0s audio, 40 audio tokens |
| `gpt-realtime-2.1-mini` | voice-verse | pass | 2291 ms | 1.5s audio, 30 audio tokens |
| `gpt-realtime-2.1-mini` | voice-marin | pass | 2549 ms | 1.4s audio, 28 audio tokens |
| `gpt-realtime-2.1-mini` | voice-cedar | pass | 2413 ms | 1.3s audio, 25 audio tokens |
| `gpt-realtime-2.1` | short | pass | 2655 ms | 1.8s audio, 36 audio tokens |
| `gpt-realtime-2.1` | mixed-ko-en | pass | 6167 ms | 19.8s audio, 396 audio tokens |
| `gpt-realtime-2.1` | digits-url | pass | 5011 ms | 11.6s audio, 232 audio tokens |
| `gpt-realtime-2.1` | voice-alloy | pass | 2335 ms | 1.9s audio, 38 audio tokens |
| `gpt-realtime-2.1` | voice-ash | pass | 2555 ms | 2.1s audio, 43 audio tokens |
| `gpt-realtime-2.1` | voice-ballad | pass | 2767 ms | 3.0s audio, 59 audio tokens |
| `gpt-realtime-2.1` | voice-coral | pass | 2839 ms | 2.7s audio, 54 audio tokens |
| `gpt-realtime-2.1` | voice-echo | pass | 3140 ms | 2.2s audio, 44 audio tokens |
| `gpt-realtime-2.1` | voice-sage | pass | 2619 ms | 2.3s audio, 45 audio tokens |
| `gpt-realtime-2.1` | voice-shimmer | FAIL | 3498 ms | transcript differs: "Hello there! Hello from qgrid received loud and clear. What’s happening on your side today?" |
| `gpt-realtime-2.1` | voice-verse | pass | 3180 ms | 2.3s audio, 46 audio tokens |
| `gpt-realtime-2.1` | voice-marin | pass | 3544 ms | 2.1s audio, 43 audio tokens |
| `gpt-realtime-2.1` | voice-cedar | pass | 2934 ms | 2.1s audio, 42 audio tokens |
| `gpt-realtime-1.5` | short | FAIL | 2897 ms | transcript differs: "Hello from qgrid! Just let me know what you'd like to say next, and I'll speak it aloud exactly as y" |
| `gpt-realtime-1.5` | mixed-ko-en | pass | 5260 ms | 17.4s audio, 349 audio tokens |
| `gpt-realtime-1.5` | digits-url | pass | 3701 ms | 10.2s audio, 204 audio tokens |
| `gpt-realtime-1.5` | voice-alloy | FAIL | 2517 ms | transcript differs: "Hello! It's great to hear from you. How can I assist you today?" |
| `gpt-realtime-1.5` | voice-ash | FAIL | 2415 ms | transcript differs: "Hello! How can I help you today?" |
| `gpt-realtime-1.5` | voice-ballad | pass | 2120 ms | 1.7s audio, 34 audio tokens |
| `gpt-realtime-1.5` | voice-coral | FAIL | 2424 ms | transcript differs: "Hello from qgrid! How can I assist you today?" |
| `gpt-realtime-1.5` | voice-echo | pass | 2321 ms | 1.6s audio, 31 audio tokens |
| `gpt-realtime-1.5` | voice-sage | FAIL | 2596 ms | transcript differs: "Hello! It's nice to hear from you. How can I help you today?" |
| `gpt-realtime-1.5` | voice-shimmer | FAIL | 2542 ms | transcript differs: "Hello! It's great to hear from you. How can I help you today?" |
| `gpt-realtime-1.5` | voice-verse | pass | 2298 ms | 1.7s audio, 34 audio tokens |
| `gpt-realtime-1.5` | voice-marin | pass | 2184 ms | 1.4s audio, 27 audio tokens |
| `gpt-realtime-1.5` | voice-cedar | FAIL | 2497 ms | transcript differs: "Hello! It’s great to hear from you. How can I help you today?" |

## Not exercised

- The HTTP path (`POST /api/qgrid/transcribe`, `/speak` through the frame and dispatcher with a DB-backed token) — no local PostgreSQL. Unit tests cover routing, option mapping and the 401-refresh step; a server-side smoke should be run once a token is registered.
- Candidate ids from the catalog not in the pre-implementation probe (`gpt-4o-mini-transcribe-2025-*`, `gpt-4o-transcribe-diarize`, `gpt-realtime-2`, `gpt-realtime-mini`, `gpt-live-1`): not run; add to `VOICE_STT_MODELS`/`VOICE_TTS_MODELS` when wanted.
- Quota attribution of realtime sessions to the Codex 5 h / weekly windows: not measured.
