# @cartanova/qgrid-ai-sdk

**English** · [한국어](./README.ko.md)

AI SDK v6 custom `LanguageModelV3` / `ImageModelV3` provider for [qgrid](https://github.com/cartanova-ai/Qgrid).

**Without changing your existing AI SDK code, swap a single `model` line to get subscription-token pooling (N tokens × concurrent permits) + the request log dashboard.**

```diff
 import { generateText } from "ai";
-import { openai } from "@ai-sdk/openai";
+import { qgrid } from "@cartanova/qgrid-ai-sdk";

 const { text } = await generateText({
-  model: openai("gpt-6-luna"),
+  model: qgrid("openai/gpt-6-luna"),
   prompt: "What's the weather in Seoul?",
 });
```

If you already use another provider (google, openai, ...) directly, add **a single logger line** to see every agent step (generate, tool-call, reasoning) in the qgrid dashboard.

```diff
 const { text } = await generateText({
   model: google("gemini-3-flash"),
   prompt: "A complex question",
+  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
 });
```

## Install

```bash
pnpm add @cartanova/qgrid-ai-sdk
```

Peer dependencies: `ai@^6.0.0`, `@ai-sdk/provider@^3.0.0`

## Quick start

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-6-luna"),
  prompt: "What's the weather in Seoul?",
});
```

A qgrid server (`http://localhost:44900`) must be running.

The OpenAI server route calls the private ChatGPT Codex Responses backend directly over HTTPS/SSE. That backend is undocumented and may change without notice; qgrid's mocked protocol tests are not live-provider verification.

## Usage
>
> Before you start: all client-side usage is identical to the [AI SDK](https://ai-sdk.dev/docs/ai-sdk-core).

### Text generation

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-6-luna"),
  system: "You are an academic paper summarizer.",
  prompt: paperText,
});
```

### Structured Output
>
> See the [AI SDK structured output guide](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)

```typescript
import { generateText, Output } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { output } = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  system: "Extract the paper metadata.",
  prompt: paperText,
  output: Output.object({
    schema: z.object({
      title: z.string(),
      authors: z.array(z.string()),
      keyFindings: z.array(z.string()),
    }),
  }),
});

console.log(output.title, output.authors);
```

Schemas with a top-level `object` are forwarded to the server. If the top level is not an
`object` (e.g. array), the AI SDK falls back to client-side parsing and a warning is logged.

> **Note for Anthropic models:** enforcement differs by provider. OpenAI/codex constrains
> decoding to the schema, so non-conforming output is rare. The Anthropic route has no
> enforcement mechanism: qgrid delivers your original schema as prompt guidance at the end of
> the system prompt, Claude Code generates plain text, and the server only strips code fences.
> The reply is schema-guided JSON text, **not server-validated JSON** — validation happens in
> this SDK via your zod schema (`Output.object` does this automatically), and a non-conforming
> reply surfaces as an explicit validation error on your side instead of hidden server retries.
> Raw HTTP consumers calling the qgrid API without this SDK must validate the response
> themselves.

### Streaming

```typescript
import { streamText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { textStream } = streamText({
  model: qgrid("openai/gpt-6-luna"),
  prompt: "Explain the benefits of TypeScript",
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

### Tool Calling

```typescript
import { generateText, stepCountIs, tool } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { text } = await generateText({
  model: qgrid("openai/gpt-6-luna"),
  prompt: "What's the weather in Seoul?",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        return { temperature: 22, condition: "sunny" };
      },
    }),
  },
  stopWhen: stepCountIs(3),
});
```

Tool calls work through the qgrid server's structured output emulation.
The AI SDK manages tool execution; qgrid handles only each turn's LLM call.
Executable tools require a bounded `stopWhen` so the AI SDK continues after a
tool-call step and asks the model for the final response.

Tools can be combined with `Output.object`:

```typescript
import { generateText, Output, stepCountIs, tool } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { output } = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt: "Look up Seoul's weather and return a forecast.",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temperature: 22 }),
    }),
  },
  stopWhen: stepCountIs(3),
  output: Output.object({
    schema: z.object({
      city: z.string(),
      summary: z.string(),
    }),
  }),
});
```

qgrid 2.5.4 constrains every model turn with a composed action envelope. Tool-call
turns remain AI SDK tool calls, while the final `answer` is constrained by the
user schema and returned as `output`. Keep a bounded `stopWhen`; otherwise AI SDK
stops after its default first step and cannot produce the final structured output.
This requires both qgrid server 2.5.4 and `@cartanova/qgrid-ai-sdk` 2.5.4. AI SDK
`toolChoice` is not currently transported or enforced; tool selection remains
model-driven.

### Provider Options

All qgrid-specific options go under the `providerOptions.qgrid` namespace. (Not `providerOptions.openai`.)
AI SDK types the outer `providerOptions` as a generic JSON record, so apply the exported
`QgridProviderOptions` type to the nested `qgrid` value with `satisfies`. This preserves
literal inference and catches misspelled or invalid qgrid options at compile time.

```typescript
import { generateText } from "ai";
import { qgrid, type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt: "Analyze this complex problem",
  providerOptions: {
    qgrid: {
      effort: "high",
      reasoningSummary: "concise",
      verbosity: "medium",
    } satisfies QgridProviderOptions,
  },
});
```

| Option | Values | Applies to | Description |
| --- | --- | --- | --- |
| `tokenName` | provider-prefixed token name | both providers | Strictly targets one active token, such as `anthropic/yds`. The prefix must match the model provider; empty, missing, inactive, or over-threshold targets fail without fallback |
| `logger` | `boolean` | both providers | qgrid request logging. Defaults to `true`; `false` disables request-log persistence for this generation without disabling client tools or multi-step continuation |
| `sessionKey` | `string` | OpenAI only | Multi-turn conversation identifier used to derive opaque prompt-cache affinity while replaying full history (see [below](#multi-turn-prompt-cache-sessionkey)) |
| `thinking` | `boolean` | Both providers | Omit to preserve existing model behavior. `true` enables thinking with effort; `false` ignores request effort and config `defaultEffort`. Unsupported models or runtimes return an error |
| `effort` | OpenAI: `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` \| `"ultra"` | OpenAI only (`QgridOpenAIProviderOptions`) | Reasoning depth on the ChatGPT-subscription Codex route. GPT-6 Astra, GPT-6 Sol, and GPT-5.6 Sol/Terra support effort through `"ultra"`; GPT-6 Luna and GPT-5.6 Luna support it through `"max"`; a value the model does not support is silently ignored by the server and the backend default applies. `"none"`/`"minimal"` are not public effort values; use `thinking: false` to disable thinking |
| `effort` | Anthropic: `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | Anthropic only (`QgridAnthropicProviderOptions`) | Claude Code `--effort` levels. Values outside this set are silently ignored and qgrid's default (`"low"`) applies; per-model limits (for example no `"xhigh"` on Sonnet 4.6) are handled by Claude Code |
| `verbosity` | `"low"` \| `"medium"` \| `"high"` | OpenAI only | Response text verbosity |
| `reasoningSummary` | `"auto"` \| `"concise"` \| `"detailed"` \| `"none"` | OpenAI only | Reasoning summary output mode |
| `serviceTier` | `string` | OpenAI only | OpenAI/codex service tier |
| `timeoutMs` | positive integer, max `1_800_000` | Anthropic only | Server-side Claude Code process timeout in milliseconds. The SDK's non-stream HTTP budget is 60 seconds longer. Defaults to 240 seconds |
| `fallbackModels` | `string[]` | deprecated | Ignored compatibility field; emits an unsupported-option warning. Remove it from callers. Unrelated to Claude Code's Fable refusal fallback |

```typescript
await generateText({
  model: qgrid("anthropic/claude-fable-5"),
  prompt,
  providerOptions: {
    qgrid: { tokenName: "anthropic/yds" } satisfies QgridProviderOptions,
  },
});
```

`tokenName` works the same way with `streamText`.

```typescript
providerOptions: {
  qgrid: { thinking: false, effort: "high" } satisfies QgridProviderOptions,
}
```

`thinking: false` ignores `high` in this example and applies to generate, stream, and tool follow-up requests. `true` does not guarantee thinking tokens on every response. **Update the server and SDK together:** older servers may ignore the new field. Disabling support depends on the model and Claude Code runtime. Sonnet 5.5's `between_tools` mode disables pre-answer thinking but can retain thinking blocks between tools; off requests for Haiku 5.5 and Sonnet 5.5 require Claude Code 2.1.295 or newer.

Thinking-off policy snapshot (2026-10-10; Claude Code investigation baseline 2.1.295):

| Provider | Off-capable model IDs in the current policy |
| --- | --- |
| OpenAI | `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` |
| Anthropic | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5` |

Use the usual `openai/` or `anthropic/` prefix with these IDs. Explicitly rejected by the backend: `gpt-6-astra`, `gpt-6.1-sol`, `claude-fable-5`, `claude-fable-5-1`, and `claude-opus-5-5`. Native delivery for Haiku 5.5 and Sonnet 5.5 was verified with Claude Code 2.1.295. For their off requests, the server checks the CLI version and returns an input error if it is older than 2.1.295 or cannot be determined. Other model IDs are unverified for off; model-access failures do not prove mandatory thinking. These restrictions apply only to explicit false.

AI SDK's top-level `timeout` remains the overall client-side budget and is converted to an
`AbortSignal` before the custom provider runs. It does not expose the numeric timeout to qgrid.
Use `providerOptions.qgrid.timeoutMs` when the qgrid server's Claude Code process needs a different
limit. Anthropic `generateText` requests use a request-scoped Undici dispatcher without changing global process
state; its `headersTimeout` and `bodyTimeout` are set to `timeoutMs + 60_000`. For example, a
600-second server limit gets a 660-second HTTP transport budget, allowing the server's explicit
timeout response to arrive before the client transport gives up. A client abort or disconnected
non-streaming HTTP request also terminates the server-side provider execution.

### Multi-turn prompt cache (sessionKey)

For multi-turn conversations, pass a caller-side domain ID (game session ID, chat room ID, ...) as `sessionKey`. The SDK derives a model-scoped opaque affinity key; qgrid sends it as `prompt_cache_key` and replays the complete conversation history on every request. No provider thread or process session is retained.

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-6-luna"),
  prompt: nextTurnPrompt,
  providerOptions: { qgrid: { sessionKey: "game-session-123" } },
});
```

- The SDK's internal affinity-coordinate entry expires after 10 minutes idle; deriving the same affinity key does not depend on that entry.
- Ignored for `anthropic/*` models; Claude Code uses its own prefix-cache behavior.

### Image Generation

Use standard AI SDK `generateImage` with `qgrid.image()` for image generation and reference
editing. This calls the Codex subscription Images endpoint directly, without an Astra/Luna
chat driver. Update the server and SDK together to versions supporting this interface.

`openai/gpt-image-2` is the Codex wire request identifier, not a guarantee of Images 2.0
serving weights. OpenAI announced Images 2.5 in Codex, but Flare/Sunburst selection is not
established on this subscription endpoint. When the response omits its model, metadata falls
back to the requested identifier; that fallback is not evidence of the serving version.

```typescript
import { generateImage } from "ai";
import { qgrid, type QgridImageProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { image, usage, providerMetadata } = await generateImage({
  model: qgrid.image("openai/gpt-image-2", { projectName: "deti" }),
  prompt: "Create a portrait poster",
  providerOptions: {
    qgrid: { background: "opaque" } satisfies QgridImageProviderOptions,
  },
});

image.uint8Array; // Returned PNG bytes
usage.inputTokens; // Image-model input tokens, not chat-model usage
providerMetadata.qgrid?.images[0]; // requestLogId and generation settings/detailed usage
```

Prefer `QGRID_PROJECT_NAME=deti` for the project-wide label. The image factory accepts
`serverUrl` and `projectName`. `providerOptions.qgrid` takes flat image options: `quality`,
`background`, `outputFormat: "png"`, `tokenName`, and `logger`. Standard `size` belongs at
the `generateImage` top level, not inside the provider options.

Reference editing uses the standard image prompt. Pass `Buffer`, `Uint8Array`, base64 image
data, or an HTTPS URL string in `images`. References select `/images/edits`; omitting them selects
`/images/generations`. Compress or resize large reference photos before sending them; oversized
inline image inputs are rejected before transport.

```typescript
const { image } = await generateImage({
  model: qgrid.image("openai/gpt-image-2"),
  prompt: { text: "Keep this character and create a poster", images: [referenceImageBytes] },
});
```

- Up to five PNG/JPEG/WebP references per request; output is PNG. Masks and JPEG/WebP output are unsupported.
- AI SDK splits `n` into one-image calls. Do not override `maxImagesPerCall` to bypass that backend limit.
- `size` and `quality` are hints: the subscription backend can choose different values. Read observed settings from metadata. `aspectRatio` and `seed` are unsupported and return AI SDK warnings; describe the desired ratio in the prompt.
- `usage` contains the image response's token usage. Detailed input categories are preserved under `providerMetadata.qgrid.images[]`. The server records an API-price estimate from this usage, or falls back to per-image pricing when usage is absent. There is no separate chat-driver cost.
- `logger: false` disables request logging only. Cancellation uses standard `abortSignal`.

For transparent output, set the flat option `background: "transparent"` and describe transparency
in the prompt. Remove green-screen or other background instructions and preserve the returned PNG
alpha when saving. Fully opaque, entirely empty, or invalid PNG results fail explicitly; qgrid does
not remove backgrounds or resize output. Apply any final crop/resize policy in the consuming app.

`generateText` and `streamText` use the language-model interface, which has no image-generation
options. Image input (image→text) works on `openai/` models: user-message image parts are sent
to the model. `anthropic/` models and assistant-message images drop image parts and report an
`unsupported` warning in `result.warnings`. Use
`generateImage` references when the intended result is a generated or edited image. Dashboard
`qgrid_chat` registers an internal image tool by default: its chat model decides whether to
generate an image, writes a self-contained prompt, and selects up to five recent conversation
images for editing. The server calls subscription Images directly for ordinary and transparent
output, then combines separate chat and image usage estimates in the request log. Chat may
still return text only. No public SDK image-tool factory is required; automatic chat images
are PNG-only, like `generateImage`.

## Using Grok

qgrid routes `grok/*` models through an xAI subscription token (plans: Plus, Premium, Super, Ultra) registered in the qgrid
dashboard (Grok sign-in). Token names carry the `grok/` prefix, for example `grok/main`. Every
Grok model accepts the same factory config as the other models: `serverUrl` (default
`QGRID_URL`) and `projectName` (default `QGRID_PROJECT_NAME`). Update the server and SDK together.

| Factory | Model ids | AI SDK function |
| --- | --- | --- |
| `qgrid(id)` | `grok/grok-4.7` (default catalog model), `grok/grok-4.7-build-fast`, `grok/grok-4.6`, `grok/grok-4.5`, any other `grok/<id>` | `generateText`, `streamText` |
| `qgrid.image(id)` | `grok/grok-imagine-image`, `grok/grok-imagine-image-2.0`, `grok/grok-imagine-image-quality` | `generateImage` |
| `qgrid.video(id)` | `grok/grok-imagine-video`, `grok/grok-imagine-video-1.5`, `grok/grok-imagine-video-1.5-lite` | `experimental_generateVideo` |
| `qgrid.transcription(id)` | `grok/grok-voice-transcribe-2.0`; OpenAI subscription: `openai/gpt-4o-mini-transcribe`, `openai/gpt-4o-transcribe`, `openai/gpt-transcribe` | `experimental_transcribe` |
| `qgrid.speech(id)` | `grok/grok-tts` (the id only labels the request log); OpenAI subscription: `openai/gpt-realtime-2.1-mini` | `experimental_generateSpeech` |

qgrid forwards a language-model id that is not in its catalog unchanged instead of rejecting it,
as it does for OpenAI; the subscription backend decides. It may serve a different model, so check
the response model in the request log (or the result's response metadata) to see which one ran.

Options use the `@ai-sdk/xai` names under `providerOptions.xai`, so code written for
`@ai-sdk/xai` keeps compiling. qgrid-only settings (`tokenName` with the `grok/` prefix, `logger`)
stay under `providerOptions.qgrid`. Malformed values throw before any request; well-formed
options qgrid cannot honor are dropped with an AI SDK `unsupported` warning.

### Grok text

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text, providerMetadata } = await generateText({
  model: qgrid("grok/grok-4.7"),
  prompt: "Summarize this release note",
  providerOptions: { xai: { reasoningEffort: "high", promptCacheKey: "session-42" } },
});
providerMetadata?.xai?.costInUsdTicks; // 1 tick = 1e-10 USD
```

Grok language models keep user image parts (https URLs or inline bytes) instead of dropping them.

| `providerOptions.xai` key | Language model handling |
| --- | --- |
| `promptCacheKey` | Faithful: the same cache-affinity handle as `providerOptions.qgrid.sessionKey` |
| `serviceTier` | Unsupported: the Grok subscription proxy's handling is unverified (a raw API request with it gets a 400) |
| `parallelToolCalls` | Unsupported: the Grok subscription proxy's handling is unverified (a raw API request with it gets a 400) |
| `reasoningEffort` | Transformed to qgrid `effort`, validated against the model's `low`/`medium`/`high`/`xhigh` set; `none` is unsupported because the route always reasons |
| `store` | Unsupported: qgrid always sends `store: false` |
| `previousResponseId` | Unsupported: qgrid replays conversation history itself |
| `include` | Unsupported: qgrid fixes the include list itself |
| `maxTurns` | Unsupported: qgrid does not run server-side agentic turns |
| `user`, `safetyIdentifier` | Unsupported: qgrid does not forward end-user identifiers |

### Grok media options

| Model | Faithful | Transformed | Unsupported (warning) |
| --- | --- | --- | --- |
| Image | `n` (up to 3 per call), `aspectRatio`, `xai.resolution` (`1k`/`1.5k`/`2k`), `xai.quality`, `xai.aspect_ratio` (used when `aspectRatio` is unset) | reference `images` become `referenceImages` (edit endpoint); `xai.output_format` becomes `outputFormat` and must be `png`, `jpeg`, or `webp` | `size`, `seed`, `mask`, `xai.sync_mode`, `xai.user` |
| Video | `duration` (integer 1-15), `aspectRatio`, `xai.resolution` (`480p`/`720p`/`1080p`), `xai.mode: "reference-to-video"` (the only supported mode; needs `xai.referenceImageUrls`), `xai.pollIntervalMs`, `xai.pollTimeoutMs` | `resolution` `WxH` is mapped as in `@ai-sdk/xai` (`1280x720` to `720p`); prompt `image` becomes the start frame; `xai.referenceImageUrls` (up to 5, not 7) become `referenceImages`; `xai.lastFrame` (qgrid extension, `grok-imagine-video-1.5` only) | `fps`, `seed`, `xai.keyframes`, `xai.storageOptions`, `xai.referenceVoiceIds`, `xai.user`. `xai.mode` `edit-video`/`extend-video` and `xai.videoUrl` throw |
| Transcription | `xai.language` | audio bytes become base64 and `mediaType` loses its parameters (`audio/webm;codecs=opus` to `audio/webm`) | every other `xai` key (`audioFormat`, `sampleRate`, `format`, `diarize`, `keyterm`, ...) |
| Speech | `voice`, `language` | `outputFormat` becomes `format` (`mp3`, `wav`, `pcm`, `mulaw`, `alaw`; anything else falls back to `mp3` with a warning, as in `@ai-sdk/xai`) | `instructions`, `speed`, every `xai` key (`sampleRate`, `bitRate`, `withTimestamps`, ...) |

**Request size.** The qgrid server accepts JSON bodies up to 10 MiB. Inline media travels as
base64, which grows by a third, so the server caps inline audio, each inline image, and all
inline images of one request together (video: `image` + `lastFrame` + references) at 7 MiB
decoded. The SDK rejects larger input before transport; a server 413 surfaces as the same size
error. Compress the input, or pass an https image URL where the option accepts one.

### Grok images

```typescript
import { generateImage } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { images, providerMetadata } = await generateImage({
  model: qgrid.image("grok/grok-imagine-image"),
  prompt: "A lighthouse at dusk, oil painting",
  n: 2,
  aspectRatio: "16:9",
  providerOptions: { xai: { resolution: "2k", quality: "high", output_format: "jpeg" } },
});
images[0].mediaType; // "image/jpeg"
providerMetadata.xai?.images[0]; // revisedPrompt and the call's costInUsdTicks
providerMetadata.qgrid?.images[0]; // mediaType, tokenName, requestLogId, costUsd
```

`generateImage` merges only the `images` arrays of batched calls, so each call's cost rides on
its first image entry.

### Grok video

```typescript
import { experimental_generateVideo as generateVideo } from "ai";
import { qgrid, QgridVideoTimeoutError, resumeQgridVideo } from "@cartanova/qgrid-ai-sdk";

try {
  const { video, providerMetadata } = await generateVideo({
    model: qgrid.video("grok/grok-imagine-video-1.5", { projectName: "studio" }),
    prompt: "A paper boat drifting down a rain gutter",
    duration: 6,
    aspectRatio: "16:9",
    providerOptions: { xai: { resolution: "720p" } },
  });
  providerMetadata.xai?.videoUrl; // the api.x.ai URL
  video.uint8Array; // downloaded by AI SDK in this process, not by qgrid
} catch (error) {
  if (error instanceof QgridVideoTimeoutError) {
    const { videos } = await resumeQgridVideo(error.jobHandle, { projectName: "studio" });
    videos[0]; // { type: "url", url, mediaType: "video/mp4" }
  } else {
    throw error;
  }
}
```

- The model calls `videoStart`, then polls `videoStatus` every 5 s within a 300 s budget (override with `xai.pollIntervalMs` / `xai.pollTimeoutMs`). The budget also cuts off a status request still in flight, so the call ends with `QgridVideoTimeoutError` on time. `abortSignal` stops polling; the upstream job keeps running.
- `projectName` is required to be identical for start and status: the server only answers a job handle to the project that started it. Set it once on the factory or through `QGRID_PROJECT_NAME`; pass the same value to `resumeQgridVideo`.
- The result is `{ type: "url", url, mediaType: "video/mp4" }`, exactly as `@ai-sdk/xai` returns it. The URL points at `api.x.ai` storage; qgrid never fetches, proxies, or stores the video. `experimental_generateVideo` downloads it from the calling process; pass a custom `download` to keep only the URL.
- AI SDK v3 video models only have `doGenerate` (no `doStart`/`doStatus`). `resumeQgridVideo(jobHandle, options)` is the qgrid way to continue a timed-out job; the handle is also in `providerMetadata.qgrid.jobHandle` and on `QgridVideoTimeoutError` / `QgridVideoGenerationError`.
- Video generation was verified live on a non-ZDR account (default clip is 8 s; pass the top-level `duration` option of `experimental_generateVideo` to change it). Zero Data Retention accounts are refused by xAI and are skipped for video.
- Video is not routed to Zero Data Retention accounts: xAI requires an `output.upload_url` for them, which qgrid does not support. When every token is ZDR the call fails with HTTP 503; turn off the data-retention opt-out at xAI or add a non-ZDR account.

### Grok transcription and speech

```typescript
import { readFile } from "node:fs/promises";
import {
  experimental_generateSpeech as generateSpeech,
  experimental_transcribe as transcribe,
} from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const transcript = await transcribe({
  model: qgrid.transcription("grok/grok-voice-transcribe-2.0"),
  audio: await readFile("meeting.mp3"),
  providerOptions: { xai: { language: "en" } },
});
transcript.text;
transcript.durationInSeconds;

const speech = await generateSpeech({
  model: qgrid.speech("grok/grok-tts"),
  text: "Your build is ready.",
  voice: "ara",
  language: "en",
  outputFormat: "mp3",
});
speech.audio.uint8Array;
```

- `experimental_transcribe` detects the audio type from its bytes and falls back to `audio/wav`; the server rejects anything that is not `audio/*`. Transcripts carry no segments (`segments: []`).
- Speech text is limited to 15,000 characters. Unset `voice`, `language` and `outputFormat` use the server defaults `ara`, `en` and `mp3`, the only combination verified live. Other voices, languages (including `@ai-sdk/xai`'s `auto`) and codecs are passed through but unverified. The server's audio MIME type is in `providerMetadata.qgrid.mediaType`; AI SDK's `speech.audio.mediaType` is sniffed from the bytes.

### OpenAI transcription and speech (ChatGPT subscription)

`openai/` voice ids run on OpenAI realtime sessions with the same ChatGPT subscription tokens qgrid uses for Codex: transcription through the Codex `/realtime/calls` flow, speech through a realtime conversational model that repeats the text verbatim (there is no `gpt-4o-mini-tts` or `tts-1` on subscription). Options follow `@ai-sdk/openai` under `providerOptions.openai`; `providerOptions.qgrid.tokenName` must carry the `openai/` prefix.

```typescript
const transcript = await transcribe({
  model: qgrid.transcription("openai/gpt-4o-mini-transcribe"),
  audio: await readFile("meeting.wav"), // PCM16 WAV or raw PCM only
  providerOptions: { openai: { language: "en", prompt: "qgrid, Codex" } },
});

const speech = await generateSpeech({
  model: qgrid.speech("openai/gpt-realtime-2.1-mini"),
  text: "Your build is ready.",
  voice: "marin",
  outputFormat: "wav",
  providerOptions: { openai: { instructions: "Calm and brisk." } },
});
```

| Model | Faithful (`@ai-sdk/openai` names) | Transformed | Unsupported (warning) |
| --- | --- | --- | --- |
| Transcription | `openai.language`, `openai.prompt` | input must be PCM16 WAV (`audio/wav`) or raw PCM (`audio/pcm;rate=…;channels=…`); mp3/webm/ogg are rejected by the server with HTTP 400 until a decoder lands. `durationInSeconds` is computed from the audio sent; `language` echoes the request (the realtime session reports neither); `segments` is empty | `openai.temperature`, `openai.include`, `openai.timestampGranularities`, `openai.responseFormat`, `openai.chunkingStrategy`, `openai.streaming` |
| Speech | `voice` (default `marin`; Codex v2 list `alloy ash ballad coral echo sage shimmer verse marin cedar`, others fail with HTTP 400), `instructions` / `openai.instructions` (style guidance appended to the verbatim-repeat prompt) | `outputFormat` `wav` (default, PCM16 24 kHz) or `pcm`; anything else falls back to `wav` with a warning, as `@ai-sdk/openai` falls back to `mp3` | `language`, `speed`, `openai.speed` |

- Each transcription has a 25 s end-to-end budget (the realtime call is torn down about 30 s after creation); the 7 MiB inline limit (~2.5 min of 24 kHz PCM) completes in a few seconds.
- Speech is a conversational model repeating text, not a TTS model: verbatim fidelity was verified on short English sentences only; the model's own transcript of what it said is logged with the request for comparison.
- Per-model availability is established by the live matrix in the server repository's `docs/diagnosis/2026-10-17-openai-realtime-audio-probe.md`. Verified unavailable or unreliable on 2026-10-17 and therefore not exposed: `gpt-live-transcribe` and `gpt-realtime-whisper` (return roughly half of a 60 s clip), `whisper-1` (ignores `prompt`), `gpt-realtime-2.1` (paraphrased once in 13 runs), `gpt-realtime-1.5` (answers the text instead of repeating it).

## Telemetry Logger

With qgrid server and SDK 2.10.0+, read the parent request-log ID from `result.providerMetadata?.qgrid?.requestLogId` after `generateText`. For `streamText`, consume the stream first, then read `(await result.providerMetadata)?.qgrid?.requestLogId`. Raw API query responses and stream `done` events expose the same ID as top-level `requestLogId`. The field is omitted with `logger: false` or an older server. Tool-run steps share the parent ID; it is not continuation state. This metadata applies to the qgrid provider, not external providers using the telemetry logger below.

To use the same request log dashboard with models that don't go through the qgrid provider (direct google/openai calls), pass `createQgridLogger` to `experimental_telemetry`.

```typescript
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createQgridLogger } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: google("gemini-3-flash"),
  prompt: "Hello",
  experimental_telemetry: createQgridLogger({
    serverUrl: "http://localhost:44900",
  }),
});
```

Parallel calls, run separation, and telemetry activation are handled automatically.

### Logger configuration

```typescript
createQgridLogger({
  serverUrl: string;           // qgrid server address (required)
  projectName?: string;        // request_logs.project_name (default: QGRID_PROJECT_NAME env var)
  tokenName?: string;          // request_logs.token_name (default: "external")
  staleRunTimeoutMs?: number;  // watchdog timeout (default: 30 min, or the AI SDK timeout plus a grace period; 0 disables)
  onLogError?: (error: Error) => void;  // logging-failure callback
});
```

Everything except `serverUrl` is optional. With defaults in place, passing only `serverUrl` works.

The logger records generate/tool-call steps and usage, but not the attached tool definitions
(name/description/inputSchema) — the dashboard's "Tools" section appears only for requests that
go through the qgrid provider.

To opt one generation out of request logging, set `providerOptions.qgrid.logger` to `false`.
The same option works for qgrid-provider calls and for external-provider calls observed by
`createQgridLogger`; tool execution and multi-step continuation still work normally.

```typescript
import { type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: google("gemini-3-flash"),
  prompt: "Do not persist this request",
  providerOptions: {
    qgrid: { logger: false } satisfies QgridProviderOptions,
  },
  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
});
```

External-provider request logs store model names as `provider/modelId`. If the provider reports
a different served model in the AI SDK response metadata, step and final log rows record that
observed model while retaining the requested model separately. This does not alter the AI SDK
runtime `response.modelId`. AI SDK adapter suffixes are normalized to the base provider, for
example `openai.responses` to `openai` and `anthropic.messages` to `anthropic`.

### Using alongside the qgrid provider

The `qgrid()` provider has its own lifecycle, so the logger automatically suppresses itself for qgrid calls. Mixing the qgrid provider and other providers in the same code does not double-log.

## Supported models

```typescript
type QgridSupportedModel =
  // OpenAI (direct private Codex Responses backend)
  | "openai/gpt-6-astra"
  | "openai/gpt-6.1-sol"
  | "openai/gpt-6-sol"
  | "openai/gpt-6-luna"
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  // Anthropic
  | "anthropic/claude-fable-5-1"
  | "anthropic/claude-fable-5"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7"
  | "anthropic/claude-opus-4-8"
  | "anthropic/claude-opus-5"
  | "anthropic/claude-opus-5-5"
  | "anthropic/claude-sonnet-5-5"
  | "anthropic/claude-haiku-5-5"
```

`openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.2`, and `openai/gpt-5.3-codex` remain in the type for backward compatibility, but the ChatGPT-subscription Codex route that qgrid uses no longer serves them. `gpt-5.4` and `gpt-5.4-mini` retired on 2026-08-31 (replacements: `openai/gpt-5.6-terra` and `openai/gpt-5.6-luna`); `gpt-5.2` and `gpt-5.3-codex` were removed from that route earlier. Requests for these ids fail at the backend.

### GPT-6 specifications

| Model | Context (Codex catalog) | Max output (public API) | Input / cached input / cache write / output per 1M tokens |
| --- | ---: | ---: | ---: |
| `openai/gpt-6-astra` | 272K | 128K | $10 / $1 / $12.50 / $50 |
| `openai/gpt-6.1-sol` | 272K | 128K | $2 / $0.10 / $2.50 / $10 |
| `openai/gpt-6-sol` | 272K | 128K | $2 / $0.20 / $2.50 / $10 |
| `openai/gpt-6-luna` | 272K | 128K | $0.10 / $0.01 / $0.125 / $0.50 |

The Codex catalog fetched on 2026-09-23 advertises a 272K context window for Astra, Sol, and Luna. Astra and Sol support reasoning effort through `ultra`; Luna supports it through `max`. The backend default is `medium` for all three, while qgrid's SDK defaults to `low`; select an effort explicitly to override it. The public API model pages for [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), and [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) separately list a 1.05M context window, 922K maximum input, 128K maximum output, and reasoning effort through `max` (no `ultra`). Those public limits do not establish the subscription route's limits. [Standard API pricing](https://developers.openai.com/api/docs/pricing) is used for qgrid's cost estimate: cache writes cost 1.25x the uncached input rate, and input over 272K tokens applies 2x input/cache and 1.5x output rates to the full request. GPT-6 Sol and Luna (released 2026-09-22) are priced at half of GPT-5.6 Sol and Luna; existing model prices were re-verified on 2026-09-23 and did not change. [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) (released 2026-09-29) keeps GPT-6 Sol's prices except cached input at $0.10; the Codex catalog fetched on 2026-09-30 lists a 272K context window, effort through `ultra`, and a `low` backend default, and a live generation through qgrid's request shape succeeded the same day. `openai/gpt-5.5` retires from the Codex/ChatGPT route on 2026-10-14; migrate to `openai/gpt-6.1-sol` or `openai/gpt-6-luna`.

### GPT-5.6 specifications

| Model | Context (Codex catalog) | Max output (public API) | Input / cached input / cache write / output per 1M tokens |
| --- | ---: | ---: | ---: |
| `openai/gpt-5.6-sol` | 272K | 128K | $4 / $0.40 / $5 / $20 |
| `openai/gpt-5.6-terra` | 272K | 128K | $2 / $0.20 / $2.50 / $12 |
| `openai/gpt-5.6-luna` | 272K | 128K | $0.20 / $0.02 / $0.25 / $1.20 |

The Codex catalog fetched on 2026-09-07 advertises a 272K context window for all three models. Sol and Terra support reasoning effort through `ultra`; Luna supports it through `max`. Backend defaults are `low` for Sol and `medium` for Terra and Luna, while qgrid's SDK defaults to `low` for all three. The public API model pages for [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) separately list 1.05M context, 922K maximum input, and 128K maximum output; these do not establish the subscription route's limits.

Qgrid uses [Standard API pricing](https://developers.openai.com/api/docs/pricing) for cost estimates. Sol's listed promotional pricing is available at least through 2026-11-21; no later rate is assumed. Input over 272K tokens applies 2x input/cache and 1.5x output rates to the full request. Cache writes cost 1.25x the uncached input rate.

`anthropic/claude-fable-5` has a 1M context window and 128K max output. Its standard prices per 1M tokens are $10 input, $1 cache read, $12.50 five-minute cache write, $20 one-hour cache write, and $50 output. qgrid preserves Claude's 5m/1h cache-creation breakdown and prices each TTL separately; only legacy responses without that breakdown fall back to the one-hour TTL automatically selected by Claude Code on subscription OAuth. Fable requires always-on adaptive thinking, so qgrid preserves adaptive thinking for this model.

`anthropic/claude-fable-5-1` (released 2026-09-01) shares Fable 5's 1M context window, 128K max output, always-on adaptive thinking, and $10 input / $50 output pricing. Its cache reads cost $0.25 per 1M tokens (0.025x the input price) instead of Fable 5's $1; cache writes stay at $12.50 (5m) and $20 (1h). Fable 5.1's API-level breaking changes (forced `tool_choice` rejection, model-bound thinking blocks) do not affect qgrid, which runs Claude Code with tools disabled and replays history as flattened text in a fresh process.

`anthropic/claude-opus-5` has a default 1M context window and 128K max output. Its prices per 1M tokens are $5 input, $0.50 cache read, $6.25 five-minute cache write, $10 one-hour cache write, and $25 output. Omitting thinking preserves Opus 5's default adaptive behavior. `thinking: false` ignores effort and internally uses low with disabled thinking.

`anthropic/claude-opus-5-5` (released 2026-09-22) has a 1M context window and 128K max output. Its prices per 1M tokens are $4 input, $0.20 cache read (0.05x the input price), $5 five-minute cache write, $8 one-hour cache write, and $20 output. Adaptive thinking is always on and cannot be disabled, so qgrid preserves it and uses `effort` to control depth, as it does for Fable. Opus 5.5's API-level breaking changes (forced `tool_choice` rejection, model-bound thinking blocks) do not affect qgrid for the same reason as Fable 5.1. Opus 5 pricing did not change.

`anthropic/claude-sonnet-5-5` (released 2026-09-28) has a 1M context window and 128K max output at Sonnet 5's base prices: $2 input, $2.50 five-minute cache write, $4 one-hour cache write, and $10 output per 1M tokens. Its cache reads cost $0.10 (0.05x the input price, the same multiplier as Opus 5.5) since Anthropic halved them from $0.20 on 2026-10-07; qgrid prices each request at the rate current when it runs, so logs from before that date keep the $0.20 estimate. Omission preserves adaptive defaults. With Claude Code 2.1.295 or newer, `thinking: false` delivers `between_tools`, disabling pre-answer thinking while allowing thinking blocks between tools.

`anthropic/claude-haiku-5-5` (released 2026-10-07) has a 1M context window and 128K max output, and is the only current Claude model priced by prompt length. For prompts up to 100K tokens it costs $0.10 input, $0.01 cache read, $0.125 five-minute cache write, $0.20 one-hour cache write, and $0.50 output per 1M tokens; once the prompt exceeds 100K tokens, every rate is 5x ($0.50 / $0.05 / $0.625 / $1 / $2.50) and applies to the whole request, which qgrid models with the same whole-request long-context rule it uses for GPT-6. Adaptive thinking is on by default with a `medium` API default effort. Omission preserves adaptive defaults with effort (SDK default `low`). With Claude Code 2.1.295 or newer, `thinking: false` uses native request settings to deliver disabled thinking and low effort. Haiku 5.5 uses the Claude 4.7+ tokenizer, so the same text counts roughly 30% more tokens than on Haiku 4.5.

Claude Code may automatically retry a Fable safety refusal on another Opus model; the current CLI picks Opus 5 or Opus 4.8 by refusal category. In that case, the AI SDK response's `response.modelId` and `providerMetadata.qgrid.model` identify Opus as the actual serving model. `providerMetadata.qgrid.requestedModel` remains Fable, and `providerMetadata.qgrid.modelFallbacks` contains the refusal fallback history. The metadata also exposes `costSource` and the 5m/1h cache-write token split.

`openai/gpt-5.3-codex-spark` remains a research preview without final published per-token rates. qgrid therefore reports its generic fallback estimate rather than presenting that estimate as official pricing.

## Configuration

```typescript
qgrid(modelId, {
  serverUrl?: string;      // qgrid server address (default: QGRID_URL env var, then http://localhost:44900)
  defaultEffort?: ...;     // default effort (default: "low"); typed per provider from the model id prefix
  projectName?: string;    // request_logs.project_name (default: QGRID_PROJECT_NAME env var)
});
```

`qgrid()` is overloaded on the model id prefix, so `defaultEffort` accepts `QgridOpenAIEffort` for `openai/*` models and `QgridAnthropicEffort` for `anthropic/*` models. `providerOptions.qgrid` cannot be linked to the model by the AI SDK types, so `QgridProviderOptions` is the union of `QgridOpenAIProviderOptions` and `QgridAnthropicProviderOptions`; use the provider-specific type with `satisfies` when you know the provider.

If multiple projects/workflows share one qgrid server, set `QGRID_PROJECT_NAME`. It lets you filter request logs by project in the dashboard and compare token/cost/cache metrics per workload. The config-level `projectName` is an override for callers that need a different label.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `QGRID_URL` | qgrid server address | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | request log project name (provider and logger) | (empty) |

## Notes

- Sampling parameters such as `temperature` and `maxOutputTokens` are ignored because the OpenAI private Codex route and the Anthropic Claude Code route do not accept them through qgrid.
- Structured output is server-enforced only for top-level `object` schemas. Top-level `array` falls back to client-side parsing.
- Combining `tools` with `Output.object` requires qgrid server and AI SDK 2.5.4 or later.
- AI SDK/Zod positional tuples emitted as Draft-7 `items: [...]` are normalized
  in supported positive schema positions before OpenAI dispatch and their
  positional constraints are enforced. An omitted tuple tail is treated as
  fixed-length; an explicitly unrestricted `additionalItems: true` tail is
  rejected with HTTP 400. Tuples in negative, conditional, or otherwise
  non-normalizable schema positions are also rejected instead of being
  rewritten with changed semantics. References from those positions are
  rejected for the same reason because definitions are normalized globally.
  Anthropic positional tuple schemas are rejected with HTTP 400 because Claude
  Code cannot preserve their positional semantics. Tuple nodes must explicitly
  declare `type: "array"`; express nullable tuples with an `anyOf` array/null
  branch.
- Structured schemas accept only local root-relative JSON Pointer `$ref` values
  targeting the document root or a chain of `$defs`/`definitions` entry roots.
  References into properties, tuple internals, conditionals, or literal values
  fail with HTTP 400 because normalization can move or rewrite those targets.
  Resource IDs, anchors, external refs, dynamic refs, and recursive refs are
  also rejected.
- Output/tool schema serialization, tool names, descriptions, JSON escaping,
  and composition framing share an aggregate 512 KiB UTF-8 preprocessing
  budget. Schema values also share a 20,000-node budget and have a maximum
  depth of 128 per schema. Invalid or over-budget inputs fail with HTTP 400
  before provider execution.
- On Anthropic routes, the final composed schema must also fit the 64 KiB safe
  single-argument budget used by the Claude Code transport.
- AI SDK `toolChoice` is not currently supported by qgrid.

## Repository testing

Run `mise run test` for DB-free API, SDK, and CLI tests. The OAuth relay test uses a local loopback port; no provider credentials are needed. Run `mise exec -- pnpm --dir packages/api test:db` separately with the prepared PostgreSQL test template. The API's `test` command still runs both suites.

Real-provider E2E is opt-in and requires an isolated qgrid server with registered tokens:

```bash
QGRID_REAL_PROVIDER_ACCEPTANCE=1 QGRID_URL=http://localhost:44900 QGRID_MODEL=openai/gpt-6.1-sol \
  mise exec -- pnpm --dir packages/ai-sdk e2e
```

The default suite checks text, streaming, and tool-plus-structured output, following returned request-log IDs to persisted results. Set an Anthropic model for that route, or use a comma-separated model list to explicitly run both. `e2e:tools-output` is a focused structured-output regression probe; `e2e:logger` checks native logging is not duplicated by telemetry. All live commands consume quota and require the same explicit opt-in/server/model settings. They are not part of ordinary CI, do not retry failures automatically, and do not delete server logs.

Keep new tests focused on observable contracts or concrete regressions. Preserve failure-path, cost, and data-integrity checks; consolidate duplicate happy paths instead of adding more mocks or a new test harness. Missing DB/provider infrastructure means unverified, not passed.

## Requirements

- Node.js >= 20
- AI SDK v6 (`ai@^6.0.0`)
- A running qgrid server
