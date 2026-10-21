# AI SDK Provider Contract

Use this reference before changing `packages/ai-sdk`.

## Active public surface

`packages/ai-sdk` is the active public SDK package. The old v1 SDK (`@cartanova/qgrid-sdk`) has been removed from the repository.

qgrid's custom provider implements `LanguageModelV3` through `qgrid()` and `ImageModelV3` through `qgrid.image()`. General usage should follow the AI SDK docs and normal AI SDK APIs such as `generateText`, `streamText`, `generateImage`, tools, structured output, and telemetry. Do not re-document generic AI SDK usage in qgrid-specific docs unless the behavior differs. qgrid docs and this skill should focus on qgrid-specific config, `providerOptions.qgrid`, request logging, runtime routing, cache/session behavior, and provider limitations.

## Explicit image model

Use `generateImage({ model: qgrid.image("openai/gpt-image-2"), prompt })` for explicit image generation. The image factory returns `ImageModelV3`, accepts `serverUrl` and `projectName`, and sends the existing query endpoint `model: "openai/gpt-image-2", imageGeneration: true`. These image-generation fields are internal wire inputs, not public language-model options. The server calls subscription Codex Images directly, without a chat driver. `qgrid()` / `generateText` handles text, tools, and structured output. Dashboard auto-image mode registers an internal `generate_image` function, which calls the same subscription Images endpoints for ordinary or transparent output after the chat model chooses a prompt and references. Do not add a public SDK image-tool factory.

Reference editing uses AI SDK `prompt: { text, images }`, with up to five references. Omitted references use `images/generations`; supplied references use `images/edits`. The new direct interface returns PNG only; unsupported output formats and masks fail before generation. `n` is handled through AI SDK batching with `maxImagesPerCall: 1`; callers cannot override this to send a multi-image backend request. `seed` and `aspectRatio` produce unsupported warnings. Size and quality are hints, never exact-output guarantees; prompt for the intended ratio and preserve observed settings.

`gpt-image-2` is the Codex wire request identifier, not proof that the serving weights are Images 2.0. OpenAI announced Images 2.5 in Codex; private-route probes accepted even nonexistent model IDs, so Flare/Sunburst selection is not established. Standalone metadata preserves a reported model, otherwise it falls back to the requested identifier. Do not describe that fallback as an observed serving version. GPT Image 2 and 2.5 have the same published token rates; per-image fallback prices remain GPT Image 2 estimates when usage is absent.

Use `QgridImageProviderOptions` with `satisfies` on `providerOptions.qgrid`. Options are flat: `quality`, `background`, `outputFormat: "png"`, `tokenName`, and `logger`. Standard `size` belongs at the `generateImage` top level. Do not send chat effort, thinking, tools, or structured output to the image model.

Map image response usage into standard `generateImage().usage`. Preserve per-image generation metadata and request-log IDs under `providerMetadata.qgrid.images[]`: AI SDK 6 merges that array and discards arbitrary provider-level keys. The raw query's top-level usage/cost remain zero chat-driver accounting; server logs price the separate image usage using the existing API-price estimator. Do not duplicate image price calculation in the SDK or count aggregate usage once per output. Without reported image usage, keep standard usage unknown and preserve the server's existing per-image cost fallback. `logger: false`, token targeting, project labeling, and cancellation still apply.

For tool calling, qgrid intentionally follows the AI SDK interface while implementing provider calls through qgrid structured-output emulation. Read `tool-calling-and-multiturn.md` before changing tool behavior, `stopWhen`/multi-step behavior, or tool-call request logs.

Main files:

- `packages/ai-sdk/src/index.ts`: `qgrid()` provider implementation.
- `packages/ai-sdk/src/image-model.ts`: `qgrid.image()` provider implementation.
- `packages/ai-sdk/src/index.types.ts`: public config/options/types.
- `packages/ai-sdk/src/utils.ts`: prompt/history/tool conversion.
- `packages/ai-sdk/src/logger.ts`: telemetry logger integration.
- `packages/ai-sdk/src/qgrid.constant.ts`: defaults and warnings.

## Provider config

`qgrid(modelId, config)` supports:

- `serverUrl`: default `process.env.QGRID_URL`, then `http://localhost:44900`.
- `defaultEffort`: default `low`. `qgrid()` is overloaded on the model id prefix, so this is typed `QgridOpenAIEffort` (`low | medium | high | xhigh | max | ultra`) for `openai/*` and `QgridAnthropicEffort` (`low | medium | high | xhigh | max`) for `anthropic/*`.
- `projectName`: default `process.env.QGRID_PROJECT_NAME`.

Strongly recommend setting `QGRID_PROJECT_NAME` in the environment for real workloads. The config-level `projectName` override is valid, but the env var is the preferred project-wide default. It is stored as `request_logs.project_name` and makes high-volume request logs usable: operators can filter by project/workflow, identify which task produced which request, compare token/cache/cost/TTFT metrics by workload, and debug noisy callers without scanning prompts manually.

Use camelCase `projectName` in TypeScript and qgrid API payloads. `project_name` is the database/Sonamu request-log field name, not an AI SDK provider option.

Setup agents should treat a missing project label as an actionable configuration gap. When installing or wiring qgrid for a local app, inspect the target app's env/config. If neither `QGRID_PROJECT_NAME` nor qgrid provider/logger config `projectName` is present, ask the user for a stable project or workflow name, then add it using the project's normal env/config pattern. A repo or package name is an acceptable default only when it is clearly the user's intended workload label.

## Provider options

qgrid-specific behavior is controlled through `providerOptions.qgrid`. Explain these options precisely because they are qgrid's extension point beyond normal AI SDK usage.

AI SDK declares the outer `providerOptions` as a generic JSON record, so it does not infer qgrid-specific keys or literal values. qgrid exports `QgridProviderOptions` for the inner `providerOptions.qgrid` value. Import it and put the `satisfies` check at that inner boundary:

```ts
import { generateText } from "ai";
import { qgrid, type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const result = await generateText({
  model: qgrid("anthropic/claude-fable-5"),
  prompt,
  providerOptions: {
    qgrid: {
      effort: "high",
    } satisfies QgridProviderOptions,
  },
});
```

Do not write `providerOptions: { ... } satisfies QgridProviderOptions`: the exported type describes the nested qgrid options object, not AI SDK's outer provider-name map. Use this typed pattern in qgrid setup guidance and examples so misspelled keys and invalid option values fail at compile time.

Language-model `providerOptions.qgrid` supports:

- `tokenName`: strict active-token targeting for both providers. Include the provider prefix and
  match it to the model (`anthropic/yds` with `anthropic/*`, for example). Missing, inactive, or
  over-threshold targets fail without falling back to another token. An explicitly empty value is
  rejected by the SDK before transport; omission keeps weighted round-robin routing.
- `logger`: request-log switch. Omitted or `true` is the default and enables qgrid logging; `false` guarantees that generation creates zero qgrid request-log rows.
- `sessionKey`: source for model-scoped opaque OpenAI prompt-cache affinity. Disabled for Anthropic models.
- `thinking`: optional boolean for both providers. Omission preserves existing model behavior. True enables thinking with the normal request effort → config `defaultEffort` → default resolution; it does not guarantee thinking tokens on every response. False ignores both efforts, including in request logging, and rejects unsupported or unverified model/runtime combinations. Generate, stream, tool continuation, and structured output carry the same boolean. Update SDK and server together: older servers can ignore the field. No `defaultThinking` or public `effort: "none"` is exposed. Haiku/Sonnet 5.5 off requires Claude Code >=2.1.295; Sonnet uses `between_tools` and may retain thinking blocks between tools.
- `effort`: provider-specific vocabulary. OpenAI (ChatGPT-subscription Codex route): `low | medium | high | xhigh | max | ultra`, where GPT-6 Astra, GPT-6 Sol, GPT-5.6 Sol, and Terra support `ultra`, and GPT-6 Luna and GPT-5.6 Luna support through `max`; `none`/`minimal` are not public effort values; use `thinking: false` for verified off-capable models. Anthropic (Claude Code `--effort`): `low | medium | high | xhigh | max`. The server resolves the value per provider and model (`providers/common/effort.ts`): anything outside the provider set, or above the Codex model's supported maximum, is silently dropped and treated as unspecified. With thinking omitted, Anthropic falls back to qgrid's default `low`; OpenAI omits `reasoning.effort` so the backend default applies. With `thinking: true`, OpenAI explicitly falls back to `low` for absent or unsupported effort, including raw API requests. With `thinking: false`, both providers ignore caller/default effort and apply their off policy instead. Invalid effort itself produces no error or metadata, only a debug log; unsupported thinking-off requests still fail explicitly. Use `QgridOpenAIProviderOptions` / `QgridAnthropicProviderOptions` for provider-typed `satisfies`; `QgridProviderOptions` is their union.
- `verbosity`: OpenAI/Codex route only.
- `reasoningSummary`: OpenAI/Codex route only.
- `serviceTier`: OpenAI/Codex route only.
- `timeoutMs`: Anthropic server-side Claude Code process timeout in milliseconds. It must be a positive integer no greater than 30 minutes and defaults to 240 seconds. For non-stream `generateText`, the SDK derives request-scoped Undici `headersTimeout` and `bodyTimeout` values as `timeoutMs + 60_000` without changing the process-global dispatcher.
- `fallbackModels`: deprecated, ignored compatibility field. The provider emits a standard unsupported-option warning when supplied; remove it from callers. It is not Claude Code's upstream Fable safety-refusal fallback.

`imageGeneration` and `imageGenerationOptions` are not public SDK options. Language-model generation and streaming reject either key before transport, directing callers to `generateImage` with `qgrid.image()`. Use flat `QgridImageProviderOptions`; do not add deprecated language-model shims for the removed fields.

`providerOptions.qgrid` does not currently support `projectName` or `project_name`. Prefer `QGRID_PROJECT_NAME` for the default project label; use config `projectName` only when a caller needs to override that default.

AI SDK's standard top-level `timeout` is still the overall client-side budget. AI SDK converts it
to the `abortSignal` in `LanguageModelV3CallOptions`, so a custom provider cannot recover the
original numeric duration. Do not infer or duplicate that timeout. Use
`providerOptions.qgrid.timeoutMs` for the server-side Claude Code limit. The SDK also uses that
explicit value to keep its own non-stream HTTP transport budget 60 seconds above the server
limit; this prevents Undici's 300-second default from cutting off long Anthropic requests first.
Recommend setting the AI SDK timeout high enough to include network and server overhead. Client
cancellation and non-streaming HTTP disconnects propagate separately through `AbortSignal`.

Transport failures preserve their root category in the public error message. In particular,
`UND_ERR_HEADERS_TIMEOUT` reports the effective transport budget and `ECONNREFUSED` reports a
connection refusal instead of leaving both as an undifferentiated `fetch failed`.

## Request logging

Request logging is enabled by default. Opt out per generation with the typed qgrid option:

```ts
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt,
  providerOptions: {
    qgrid: {
      logger: false,
    } satisfies QgridProviderOptions,
  },
});
```

`logger: false` affects observability only. Generation, streaming, AI SDK client tool execution, multi-step continuation, and OpenAI cache affinity continue normally. When `createQgridLogger` is also installed, it reads the same option and suppresses its external-provider telemetry lifecycle for that generation; qgrid provider calls are always skipped by the telemetry integration to prevent double logging.

For raw qgrid query/stream payloads, the corresponding input is top-level `logger?: boolean`, also defaulting to `true`. The old `logMode` input has been removed. Because the wire schema accepts unknown keys, a legacy payload containing `logMode` is accepted but the field is ignored. It must not appear in new code. Migrate callers as follows:

- Omitted logging mode or `"auto"`: remove it; omit `logger` or send `logger: true`.
- `"run"`: remove it; the server now infers a continued tool run from `runContext`, tool results, and the provider finish reason.
- `"none"`: replace it with `logger: false`.

## OpenAI/Codex Fast mode

qgrid supports Codex Fast mode per request through `providerOptions.qgrid.serviceTier`. Pass `"fast"`; qgrid forwards it as `service_tier: "priority"` in the direct OpenAI Responses request.

```ts
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt,
  providerOptions: {
    qgrid: {
      serviceTier: "fast",
    } satisfies QgridProviderOptions,
  },
});
```

Fast mode contract:

- It is OpenAI/Codex-only. Do not send it to `anthropic/*` models.
- It works on both `generateText` and `streamText`; it is not an image-model option.
- Omit `serviceTier` for normal/default routing. qgrid's current API accepts `"fast"` and `"flex"`; callers should not send Codex's normalized `"priority"` value directly.
- qgrid forwards this selection to the subscription backend; sending it does not by itself prove the upstream serving tier. Do not assume that public API Flex discounts or availability apply to the subscription route. Omitting `serviceTier` does not select `flex`.
- Fast mode changes upstream service-tier routing only. It does not change token weights or client concurrency.
- Do not promise a fixed latency improvement. Verify TTFT, duration, throughput, and quota consumption with a workload-specific A/B test.
- Since 2.10.7, native request logs retain the requested tier and show fast requests with a filled blue lightning icon. New OpenAI query/stream costs use the verified Fast API rates for supported current models. See `request-log-run-lifecycle.md` and `prompt-cache-and-usage.md` for storage and pricing semantics.

## Request construction

The language provider sends `POST /api/qgrid/query` for generate and `prepareStream` plus SSE for stream.

Payload responsibilities:

- Extract current prompt, system prompt, and history from AI SDK prompt messages.
- Convert AI SDK function tools to qgrid tools.
- Send `jsonSchema` whenever the response format top-level schema is `object`, including requests that also contain tools.
- Send `history` as JSON string when prior messages exist.
- Send `projectName` when configured.
- Send `tokenName` when configured so generate and stream use the same strict target.
- Send `logger: false` when the per-call option disables request logging; otherwise rely on the server default.
- Preserve and resend `runContext` for tool-call follow-ups.
- Let the server infer single-turn completion versus an open tool-call run. Logging-disabled tool calls still use the SDK's local pending-call correlation and continue without a request-log id.
- Derive/store/resend opaque OpenAI affinity coordinates by `sessionKey`.
- For `openai/` and `grok/` language models, send user-message image/file parts as image input: the current turn goes in qgrid `input` (text + image data/HTTP URLs) and earlier user turns as history `input_image`. The same JSON-transport size guard applies. `grok/` keeps only `https:` and `data:` URLs (the backend cannot fetch `http:`) and sniffs bytes sent as `image/*`; other providers use the shared extractor. Drop assistant image parts, and all image parts for `anthropic/` models (the Claude Code path is text-only), and report each drop as an AI SDK `unsupported` warning (`feature: "image input"`) in `warnings`, not only on the console.
- The separate image provider converts `generateImage` prompt references to qgrid `input` and rejects oversized inline reference images before transport. Callers should compress/resize large reference photos, preferably to WebP/JPEG.

Tools and `jsonSchema` can be used together as of qgrid 2.5.4. On OpenAI the
server composes them into one strict action envelope enforced by constrained
decoding; on Anthropic (SON-532) the same envelope contract is rendered as text
at the end of the system prompt and the reply is validated by `parseEnvelope`.
`toolChoice` is not part of the current qgrid wire contract and must not be
described as supported.

Before provider dispatch, qgrid validates caller output schemas and every tool
input schema with an iterative preflight. Output/tool schema serialization, tool
names, descriptions, JSON escaping, and composition framing share an aggregate
512 KiB UTF-8 budget. Schema JSON values are limited to 20,000 in aggregate, and
each schema is limited to depth 128. Malformed, unsupported top-level output, or
over-budget schemas fail with HTTP 400 before request-log creation or stream ID
allocation. On OpenAI the fully composed and strictified schema is checked again
against the 512 KiB budget. Anthropic performs only this syntax/complexity
preflight — no strictify, no argv ceiling (the old 64 KiB `--json-schema` limit
is gone; large schema contracts ride the system-prompt file branch).

OpenAI normalizes positional tuple schemas in supported positive schema
positions and enforces their positional constraints. Tuples in negative,
conditional, or otherwise non-normalizable schema positions fail with HTTP 400
instead of being rewritten with changed semantics. References from those
positions fail for the same reason because definitions are normalized globally.
Tuple nodes must explicitly declare `type: "array"`; express nullable tuples
with an `anyOf` array/null branch. These normalization restrictions are
OpenAI-only: the Anthropic route injects the schema verbatim as prompt text, so
positional tuples and arbitrary `$ref` forms pass through unchanged.

On OpenAI, structured schemas accept only local root-relative JSON Pointer
`$ref` values targeting the document root or a chain of `$defs`/`definitions`
entry roots. References into properties, tuple internals, conditionals, or
literal values fail with HTTP 400 because normalization can move or rewrite
those targets. Resource IDs, anchors, external refs, dynamic refs, and recursive refs are also
rejected.

When tools are present, qgrid sends tool definitions to the server as `tools`; it does not send them to OpenAI or Anthropic as native provider tools. The server converts them into a strict structured-output schema and maps the model's structured result back into AI SDK `tool-call` content.

SDK image generation uses `ImageModelV3`, independently of AI SDK language-model tools. Pass references through `generateImage`'s `prompt: { text, images }`; the image provider wraps inline image bytes as data URLs and accepts HTTPS reference URLs. This supports image generation/editing, not general vision chat. Raw/server image flags remain available for dashboard chat and internal routing; they are not part of `QgridProviderOptions`.

## Response mapping

Cancelling the returned provider stream aborts its HTTP request and releases the SSE reader; caller abort signals propagate through the same request-local cancellation path. Normal completion and error events also release the reader. OpenAI affinity coordinates are swept for expiration on insertion and bounded to the most recently issued 1,000 entries; eviction keeps full-history generation functional.

Since 2.10.0, `generateText` exposes the parent request-log ID at `result.providerMetadata?.qgrid?.requestLogId`. For `streamText`, consume the stream first, then read `(await result.providerMetadata)?.qgrid?.requestLogId`. The raw query response and stream `done` event carry optional top-level `requestLogId`.

Update both server and SDK to use this metadata. The field is omitted when logging is disabled or an older server does not return it. Tool-run steps share the parent ID; `runContext.requestLogId` remains separate continuation state. This does not expose external-provider telemetry logger IDs or add IDs to stream delta/error events.

Language-model response content maps to AI SDK content:

- qgrid `text` -> AI SDK text content.
- qgrid `tool-call` -> AI SDK tool-call content.

The image provider maps direct Images output to standard AI SDK `image`/`images` and image `usage`, preserving generation metadata under `providerMetadata.qgrid.images[]`. It supports PNG output only. Raw/server hosted Responses output can be PNG/JPEG/WebP; preserve its actual MIME type in raw content and request-log data URLs.

`finishReason` maps `tool-calls` when qgrid returns tool calls.

For tools plus structured output, qgrid serializes the final schema-constrained
`answer` as JSON text. AI SDK then parses and validates that text into
`Output.object`'s `output`. This path requires both server and SDK 2.5.4 or later.

The image provider requires exactly one output from route `codex-images` per call and rejects text-only, hosted-route, or multiple-image responses with a server/SDK version-skew guard.

For a successful Fable refusal fallback (Fable 5 or 5.1):

- `response.modelId` and `providerMetadata.qgrid.model` are the actual serving model, an Opus model such as `claude-opus-5` or `claude-opus-4-8`.
- `providerMetadata.qgrid.requestedModel` remains the requested Fable model, for example `claude-fable-5-1`.
- `providerMetadata.qgrid.modelFallbacks` preserves the refusal route and optional category/explanation.
- `providerMetadata.qgrid.costSource` reports whether cost came from Claude Code or qgrid's pricing table. Prefer the provider-reported combined cost for this path.

Do not expose the requested Fable model as `response.modelId` after Opus served the answer, and do not map this upstream safety behavior onto the deprecated `providerOptions.qgrid.fallbackModels` option.

Usage maps qgrid standard usage into AI SDK V3 usage:

- `inputTokens.total = input_tokens`
- `inputTokens.cacheRead = cache_read_input_tokens`
- `inputTokens.cacheWrite = cache_creation_input_tokens`
- `inputTokens.noCache = max(input - cacheRead - cacheWrite, 0)`
- `outputTokens.total = output_tokens`

## Anthropic sessionKey guard

Do not store or replay `sessionKey` affinity coordinates for `anthropic/*` models. Anthropic fresh-spawn runtime uses its own prefix-cache behavior.

## Logger integration

`createQgridLogger` records external provider calls into qgrid request logs. It skips qgrid provider calls to avoid double-logging, and it skips any external-provider generation whose `providerOptions.qgrid.logger` is `false`. This makes `logger: false` a single opt-out that produces zero native or telemetry request logs without changing the model call itself. When changing logger behavior, preserve stale-run fallback because AI SDK telemetry lacks a reliable error hook for all failure modes.

For external providers, the logger reads AI SDK's provider-neutral `onStart.output.responseFormat`. JSON output modes send `isStructured: true` plus the serialized schema when present; ordinary text sends `isStructured: false` and `jsonSchema: null`. A succeeded structured run also sends `responseJsonOk`, based only on whether the final response text parses as JSON. Qgrid does not duplicate caller-side Zod/schema validation. These lifecycle fields are optional on the server so older SDK clients remain compatible.

## OpenAI voice models

`qgrid.transcription("openai/<id>")` and `qgrid.speech("openai/<id>")` share the Grok voice factories; the `openai/` prefix selects the realtime route and switches the option namespace to `providerOptions.openai`, whose schemas are copied field-for-field from `@ai-sdk/openai` (`openAITranscriptionModelOptions`, `openaiSpeechModelOptionsSchema`, vercel/ai `fce9210`). Honored: transcription `language`, `prompt` (`gpt-realtime-whisper` rejects `prompt` with HTTP 400 from the server; `whisper-1` accepts it but the upstream ignores it); speech `voice`, `instructions`/`openai.instructions`, `outputFormat` `wav` (default) or `pcm`. Every other set key emits the AI SDK `unsupported` warning; `language` on speech reuses the official provider's warning text and an unknown `outputFormat` falls back to `wav` with a warning (the official provider falls back to `mp3`). `providerOptions.qgrid.tokenName` must carry the `openai/` prefix. Transcription input must be PCM16 WAV or raw PCM; `segments` is empty, `durationInSeconds` is computed server-side from the audio, `language` echoes the request. Speech `providerMetadata.qgrid.mediaType` is `audio/wav` or `audio/pcm;rate=24000`. Keep model unions equal to the server's candidate lists and prune both from the live matrix (`openai-codex-runtime.md`, "Realtime voice").
