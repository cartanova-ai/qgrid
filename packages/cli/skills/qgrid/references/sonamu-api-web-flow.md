# Sonamu API And Web Flow

Use this reference for dashboard/API changes.

qgrid dashboard work is usually a Sonamu API/model/generated-client/web change, not an isolated React change.

## Full path to inspect

1. Entity and model definitions in `packages/api/src/application/**`.
2. API frame/model methods decorated with `@api` or `@stream`.
3. Generated Sonamu files such as `packages/api/src/application/sonamu.generated*`.
4. Web API consumers and generated client/types.
5. Dashboard routes/components in `packages/web/src/**`.

## Common patterns

- Entity fields live in `*.entity.json`.
- Model methods live in `*.model.ts`.
- API frame methods for qgrid live in `qgrid.frame.ts`.
- i18n generated files may change when entity labels or static data change.
- Web components under `packages/web/src/components/qgrid` consume generated API shapes.
- The main dashboard sidebar version should stay synced to `packages/cli/package.json`. `packages/web/vite.config.ts` reads that package version and exposes it as `__QGRID_CLI_VERSION__`; `Sidebar.tsx` displays it.
- Runtime settings use the curated `listSettings`, `setSetting`, and `resetSetting` API methods. Do not expose the model's generic `save` or `del` methods: they bypass the settings schema validation, process-local cache update, and runtime change handler.
- The Slack bot token is returned to the authenticated settings dashboard for its reveal toggle. Preserve the deployment authentication boundary when changing this response; do not describe the value as masked unless the API contract is changed to match.

## Migration workflow

Sonamu entity definitions are the source of truth for managed database schema.
These commands apply only inside the qgrid source repository. Downstream projects must use
their own configured task and tool runner.

1. Change the relevant `*.entity.json` files.
2. Run `mise exec -- pnpm --dir packages/api sonamu migrate status` and inspect `preparedCodes`.
3. Run `mise exec -- pnpm --dir packages/api sonamu migrate generate`.
4. Inspect the generated, table-scoped migration files without rewriting them by hand.
5. Apply them through Sonamu's migration target flow or qgrid's startup migration runner.
6. Re-run migration status and require `pending: []` and `preparedCodes: []`.

Do not hand-author a migration that Sonamu can derive from entity changes. If generation cannot represent the required operation, stop and make the exception explicit before changing migration code or database state. Never delete or edit a migration that has already shipped to another environment.

## Request log dashboard

Request log changes usually touch:

- `request-log.entity.json`
- `request-log.model.ts`
- `request-log.types.ts`
- `request-log-step.*`
- `qgrid-run-lifecycle.ts`
- `RequestLogTable.tsx`
- `routes/requests/show.tsx`

Check list and detail views. Avoid loading large text columns in list views unless intentionally needed.

For new request logs, the existing `requested_model_name` and `model_name` fields store full `provider/model` values; there is no separate request-log provider column. A running parent stores the requested id and keeps `model_name = NULL`, but the dashboard must treat `status` as authoritative and render only an explicit running state until the request finishes. Completed rows keep the existing requested-to-serving fallback display. If an error/aborted row has only a requested model, show that value explicitly as requested rather than as a serving model or an unknown placeholder. Legacy prefixless rows remain valid and are not backfilled.

Provider-qualified ids widen `model_name` and `requested_model_name` from 50 to 255 characters on both the parent and step entities. Generate and inspect the Sonamu migration, and apply it before starting the new server. The width migration must not rewrite legacy model values or add a provider column. Keep generated API/web types synchronized through Sonamu rather than editing them by hand.

Image-generation request logs add `is_image_generation`, `image_cost_usd`, and `image_cost_method`. The list view displays driver plus image cost as the total cost cell; the detail view shows driver cost and image cost separately and renders generated image data URLs from response/tool-step content.

In 2.9.8, list and detail model labels show requested model to image model for generated-image results, using an image serving model or the model recorded in `image_cost_method`. The cost fallback is an estimate, not an upstream version guarantee. Preserve the actual driver in stored `model_name` for auto turns and older hosted-route rows. Do not hardcode a display version or render an image-generation/assumption badge. Auto text-only replies are not marked `is_image_generation`.

The list header ends its filter row with a reload button (2.10.2+) that calls the generated hooks' `refresh()` for the list and the total-cost query with the current filters; it does not refetch the token/project/model filter options, and TanStack Query's `isRefreshing` disables it while a reload is in flight.

Structured output visibility: the list has an `Fmt` column (`voice/stt`, `voice/tts` or `voice/live` when `media_kind` is `stt`, `tts` or `live`, `video` when it is `video`, otherwise `img` when `is_image_generation` is true, otherwise `json` when `is_structured` is true, otherwise `text`) and a `broken` badge driven by `response_json_ok = false`; there is no broken-JSON list filter. At review time, all 114,647 succeeded structured rows had `response_json_ok = true` and zero false rows existed; the unindexed zero-result lookup scanned 1,286,016 rows and took about 3 seconds. Before reinstating the filter, validate the failure-signal semantics and index the predicate. The detail page shows a dark Response Type panel (zod expression by default, `type` declaration via toggle) rendered server-side from the stored `json_schema`. Plain-text rows render no panel. Rows written by pre-2.7.2 servers show `text`.

Media rows (2.15.5+): `startMediaRun` writes the nullable `media_kind` column (`image`, `video`, `stt`, `tts`) at `createRun`; text runs keep it NULL, and media rows written before the column stay NULL and show their old `Fmt` label (no backfill). Speech rows store browser-playable audio (`audio/wav`, `audio/mpeg`) in `response` as `<audio src="data:...;base64,..."></audio>`, the same inline pattern image rows use, and the detail page renders it as an `<audio controls>` player; OpenAI `pcm` output is wrapped as WAV for the log copy only, while Grok `pcm`/`mulaw`/`alaw` keep the `[audio <mime> <bytes> bytes]` placeholder. The audio is stored once, not repeated in the `speech` step result. Speech `ttft_ms` is time to the first audio byte measured from the same start as `duration_ms`: the first `response.output_audio.delta` for OpenAI realtime, response-header arrival for Grok `/tts` (not streamed, so it is close to the full duration). `finishRun` takes an explicit `ttft_ms` for runs without generate steps and otherwise derives it from the first generate step. STT rows record no TTFT; since 2.16.0 their browser-playable input audio is embedded the same way in `user_prompt` (the detail page renders the USER panel through the same media parser), and other input types keep the placeholder. Inline audio grows the request-log table with every logged voice call; `logger: false` skips it. Voice step results keep word timing (`words`: TTS output words, or the words heard in the STT input; 2.17.0+). The detail page fetches that one step (subset `A`) only for `tts` rows and renders the RESPONSE clip with the shared `TimedPlayer` (highlighted, clickable words); `stt` rows show the input audio as a plain player (2.19.0+, by user decision 2026-11-09: timing on the user prompt read as wrong). `live` rows (2.19.2+) title the system prompt Instructions, hide the empty User panel, and show `response` as the Conversation; the Voice playground (`/voice?tab=tts|stt|live`, listed as TTS, STT and Live Conversation under Voice in the sidebar, with an in-page tab bar only on narrow screens; panels stay mounted so switching keeps state) runs Live Conversation on the browser's own `RTCPeerConnection` with an `oai-events` data channel, calls `QgridService.liveCall` with the offer, builds its transcript from the data channel's `turn.*` events, and ends with `session.close` on that channel (see `openai-codex-runtime.md`).

Voice playground (2.15.5+): the sidebar's Playground section links `/voice`, a dashboard-only test page with Text to speech and Speech to text panels that call the generated `QgridService.useSpeakMutation` / `useTranscribeMutation` with project name `qgrid_voice`; no API was added. Voice lists are web constants: OpenAI's 10 realtime presets and the 28 Grok `/tts` voices (9 female, 19 male) listed for the subscription token on 2026-11-06; the server still validates them. Instructions and the STT prompt are shown only for `openai/` models; in their place Grok TTS shows a Speed slider (0.7-1.5 in 0.05 steps, 2.18.0+), sent as `speed` only when it is not 1, and the history row title carries the speed. STT sends no `language`: a 2026-11-09 run (6 OpenAI STT models × auto/en/ko × 6 synthetic learner clips) found `en` no better than auto and `ko` translating English audio into Korean on gpt-4o-transcribe and whisper-1. The STT model list keeps only `openai/gpt-4o-transcribe` (default), `openai/gpt-4o-mini-transcribe`, and the unmeasured `grok/grok-voice-transcribe-2.0`; the server still accepts the other ids. The page is one card with Text to speech / Speech to text tabs; both panels stay mounted (the inactive one is hidden) so form state and history survive tab switches. Each result is prepended to an in-memory history row (removable, lost on reload) with a request-log link that opens in a new tab so the history is kept. TTS voices are chips (Grok split Female/Male) above the text: a name selects the voice, and ▶ plays a bundled sample from `packages/web/public/voice-samples/{openai,grok}/<voice>.mp3` without a request (and selects it; pressing again stops). Each of the 38 samples introduces itself ("I'm <Voice>. Nice to meet you. How's it going?"), regenerated on 2026-11-09 through qgrid (`grok/grok-tts`, `openai/gpt-realtime-2.1-mini`) and checked with STT; re-encoded to 40 kbps mono MP3 (about 640 KB, shipped in the CLI bundle via `web-dist`). Do not trust the OpenAI speech self-transcript as a verbatim check: one ballad take carried an audible "Okay, let's read that line aloud exactly as written." preamble that two STT models heard while `response.output_audio_transcript.done` showed only the script. A voice added upstream needs a sample file or its ▶ fails to load. STT recordings and uploads are numbered clips so one clip run through several models reads as a comparison. A "Word timing" checkbox (default on, 2.17.0+) sends `withTimestamps`; TTS rows and STT rows with word timing (Grok, or OpenAI through the qgrid aligner, 2.19.0+) then render the clip with its words under the player (`TimedPlayer`), highlight the word being spoken (animation-frame polling with a `timeupdate` fallback when frames are throttled), and show the timing source (Grok TTS, qgrid aligner, or the failure). Clicking a word plays from its start. For OpenAI models, recordings (MediaRecorder webm/opus) and uploads are decoded with `AudioContext` at 24 kHz, mixed to mono, and sent as PCM16 WAV (`voice-audio.ts`), because the OpenAI transcription route accepts only WAV or raw PCM; Grok gets the original file (2.19.0+), which keeps a compressed upload far under the 19 MiB inline limit. Results link to their request log.

Tool contract visibility: the detail page renders a Tools panel between Response Type and Steps for requests whose `tools` is non-empty. It starts collapsed and its header shows the tool count plus a responsive, truncated name list built from the detail subset — collapsed views issue no extra query. Expanding fires `toolsView` once and caches it for that request id, since a stored tool contract never changes. Each card shows the name, the full description, the parameter count, and a compact display-only zod shape; enum values past the sixth collapse to `/* +N */`, with the full shape reachable through hover and keyboard focus. All JSON Schema conversion happens server-side — the web renders completed strings and holds no schema logic.

Chat token targeting: the dashboard chat panel can pin a conversation to one account. It defaults to automatic distribution and lists only active tokens whose provider matches the selected model, sending the choice as `tokenName` so the request lands on exactly that account with no fallback. Changing either the model or the token resets the existing conversation coordinates, because a thread's prompt cache belongs to the account that built it. A selection that disappears — deactivated or deleted — is cleared automatically, but the selection is preserved while the token list is still loading so a slow fetch does not silently reset the user's choice.

OpenAI chat uses one non-stream POST with `imageGeneration: "auto"` per turn, allowing image generation or an ordinary text response. The server registers one `generate_image` function and directly calls subscription Images for ordinary or transparent output. The driver sees full text and image history, writes the image prompt, and chooses the last 0–5 conversation images to include; zero starts a fresh image. Keep the removed image-generation checkbox, background checkbox, automatic-generation label, and client decision tool out of the UI. Replay full text and image history, including generated images as user visual references. Abort in-flight requests when chat unmounts.

Clicking an attached or generated image opens a preview with extension, decoded byte size, natural width/height, original-size viewing, and download. Attachment metadata describes the existing resized JPEG conversion sent by chat; generated image bytes are preserved. Do not label attachment preview metadata as the original upload's metadata.

Token credential previews must tolerate missing `accessToken` rather than reading `.length` unconditionally. Legacy system-keychain credentials display `System Keychain`; this display compatibility does not enable an Antigravity runtime.

Chat model presets: the model `<select>` lists the served subset of `QgridSupportedModel` grouped by provider (`MODEL_PRESET_GROUPS` in `ChatWidget.tsx`), newest first, and defaults to `anthropic/claude-fable-5-1`. Ids that the ChatGPT-subscription Codex route no longer serves (`gpt-5.4` and `gpt-5.4-mini` retired 2026-08-31 with `gpt-5.6-terra` / `gpt-5.6-luna` as replacements; `gpt-5.2` and `gpt-5.3-codex` removed earlier), `gpt-5.3-codex-spark` (rejected on the ChatGPT-account Codex route and absent from its catalog as of 2026-09-29), `gpt-5.5` (retires from the Codex/ChatGPT route on 2026-10-14; replacements `gpt-6.1-sol` / `gpt-6-luna`), the retired `claude-opus-4` / `claude-sonnet-4` (2026-06-15) and `claude-opus-4-1` (2026-08-05; Claude Code silently serves `claude-opus-5-5` instead), `claude-sonnet-4-5` (deprecated 2026-09-30, retirement 2026-11-30, replacement `claude-sonnet-5-5`), and the catalog-less `claude-sonnet-4-7` stay in the SDK type and price table (legacy request-log cost) but are excluded here. web does not depend on ai-sdk, so a new model must be added in both places. `openai/gpt-6-astra`, `openai/gpt-6.1-sol`, `openai/gpt-6.1-terra`, `openai/gpt-6-sol`, and `openai/gpt-6-luna` are included in the OpenAI group and `anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5`, and `anthropic/claude-haiku-5-5` in the Anthropic group; adding them does not change the default model.

The monit tab's vitals strip shows per-provider in-flight counts, an in-flight sparkline, token chips with quota gauges (fed by the dispatcher's 60-second rate-limits cache; `resetsAt` arrives as ms epoch), and a 1-hour per-provider request/error/cache-hit stats line polled separately every 30 seconds.

Quota controls match provider policy: Anthropic edits its 5-hour threshold and shows a fixed 100%
weekly cap; OpenAI edits its weekly primary-window threshold. Grok has only a fixed 100% weekly cap
and no threshold editor. Disabling the Anthropic threshold does not disable weekly exhaustion checks.

Current-turn input images render in the detail view under the user prompt from `request_logs.input_images` (subset `A` only, not the list subset). Logs created before that column fall back to the first synthetic `image_generation` step's `tool_args.inputImages`. Keep the prompt itself text-only, redact large base64 in request JSON views, and avoid rendering duplicate input previews for multi-output image turns.

## Verification

After API shape changes:

- Regenerate or inspect generated Sonamu files according to repo workflow.
- Run targeted API tests.
- Check web consumers compile against generated types.
- Verify dashboard display for null/legacy values when changing stored request log fields.
