# OpenAI Direct Codex Runtime

Use this reference before changing OpenAI transport, concurrency, routing, prompt-cache affinity, OAuth, quota lookup, image generation, or cancellation.

## Source files

- Dispatcher and token routing: `packages/api/src/utils/providers/openai/openai-dispatcher.ts`.
- Direct client and transport interface: `openai-direct-client.ts`.
- Request, identity headers, and normalized events: `openai-backend-protocol.ts`.
- SSE decoding: `openai-sse.ts`.
- Direct PKCE OAuth and refresh: `openai-oauth.ts`, `openai-refresh.ts`, `openai-callback-relay.ts`.
- Direct quota lookup: `openai-quota.ts`.
- Provider integration and history: `packages/api/src/application/qgrid/qgrid.dispatcher.ts`, `conv-routing.ts`.

## Thinking control

`providerOptions.qgrid.thinking` reaches the Responses builder as a boolean. False overrides request/default effort and sends `reasoning: { effort: "none" }` without a reasoning summary. True and omission keep the existing effort and summary policy. `none` belongs only to the internal wire type, not the public effort enum.

The 2026-10-10 subscription probe accepted off for `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5`. `gpt-6-astra` and `gpt-6.1-sol` explicitly rejected it. Other model IDs are unverified for off and are rejected locally only when false is requested. Model-access failures are not evidence of mandatory thinking. Validate terminal success and response settings, not HTTP 200 alone: errors can arrive within SSE. The same policy applies to text-model requests driving image generation, not to the image model itself.

## Adding an OpenAI model

Use this checklist whenever a model is added. A public API release does not by itself prove
availability or identical limits on qgrid's ChatGPT-subscription route.

1. Fetch the official model page and pricing table. Record the exact ID, Standard input/output,
   cache-read and cache-write prices, long-context threshold and multipliers, modalities,
   structured-output support, and reasoning restrictions. Do not infer pricing from a related model.
2. Inspect the current Codex model catalog (`~/.codex/models_cache.json`) for the exact slug,
   `supported_reasoning_levels`, and `context_window`. Separate public API specifications from
   subscription catalog values. Catalog availability is not a successful generation test.
3. Add pricing and the subscription `maxEffort` to `OPENAI_COSTS` in
   `packages/api/src/utils/providers/common/model-cost.ts`. Preserve existing historical model
   rows. The shared calculator also prices request logs; no separate dashboard price table is needed.
4. Add `openai/<slug>` to `QgridSupportedModel` in `packages/ai-sdk/src/index.types.ts` and
   `MODEL_PRESET_GROUPS` in `packages/web/src/components/qgrid/ChatWidget.tsx`. The web package
   does not import the SDK model union. Keep existing defaults unless a default change is requested.
5. Verify model ID and effort propagation through SDK generation/streaming, provider dispatch,
   Responses construction, and returned model metadata. New models use the existing OpenAI
   route; do not add a second transport or enable built-in tools automatically.
6. Update the root and AI SDK README model lists, type snippets, capability/pricing tables,
   and affected skill contracts. Sync the canonical skill to its checked mirror.
7. Test prices, cache accounting, the long-context boundary, reasoning levels, and SDK request
   propagation. Run relevant provider tests, API/web/SDK type checks, SDK build, and `mise run check`.
   Report mocked tests separately from any live smoke test. Model registration does not authorize
   a release, version bump, deployment, or remote migration.

### GPT-6 Astra, Sol, Luna, and GPT-6.1 Sol

`openai/gpt-6-astra` uses the existing text generation, streaming and structured-output paths.
The model supports image input, but qgrid keeps its existing SDK restriction: image parts are
forwarded only for opt-in `imageGeneration` reference-image requests, not general vision chat.
Standard API-equivalent prices per million tokens are input $10, cached input $1, cache write
$12.50, and output $50. Above 272,000 input tokens, the full request uses 2x input/cache rates and
1.5x output rates. These are qgrid's cost estimates, not subscription billing amounts or Fast-tier prices.

Sources: [model specification](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[pricing](https://developers.openai.com/api/docs/pricing), checked 2026-09-07. The public model page
lists a 1,050,000-token context window, 922,000 maximum input and 128,000 maximum output, with effort
through `max`. The Codex subscription catalog checked on the same date lists `context_window=272000`
and `low | medium | high | xhigh | max | ultra`; qgrid therefore permits `ultra` on this route.
Do not present the public 1.05M context as a verified subscription-route limit.

`openai/gpt-6-sol` and `openai/gpt-6-luna` (released 2026-09-22) use the same paths. Standard prices per
million tokens: Sol input $2, cached input $0.20, cache write $2.50, output $10; Luna input $0.10, cached
input $0.01, cache write $0.125, output $0.50. Both apply the same 272K long-context multipliers. The Codex
subscription catalog checked 2026-09-23 lists `context_window=272000` for both, effort through `ultra` for
Sol and through `max` for Luna, and default `medium`. Sources: [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and [pricing](https://developers.openai.com/api/docs/pricing).
The same check confirmed no price changes for Astra, GPT-5.6 Sol/Terra/Luna, or GPT-5.5.
Live generation with qgrid's exact request shape and identity headers (`codex_cli_rs/0.147.0`) succeeded for
both on 2026-09-23, while Codex CLI 0.154.0 received `400 The 'gpt-6-sol' model is not supported when using Codex
with a ChatGPT account` and its catalog fetch omitted both models until 0.156.1. The backend gate is therefore tied
to something the newer CLI sends, not to the User-Agent version alone; a Codex CLI failure does not imply a qgrid failure.

`openai/gpt-6.1-sol` (released 2026-09-29 at DevDay) uses the same paths. Standard prices per million tokens:
input $2, cached input $0.10, cache write $2.50, output $10, with the same 272K multipliers; only cached input
differs from GPT-6 Sol. The Codex subscription catalog fetched 2026-09-30 with `client_version=0.159.2` lists
`context_window=272000`, effort through `ultra`, default `low`, and text+image input. The
[model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) separately lists 1.05M context, 922K
maximum input, 128K maximum output, effort through `max`, and a 2026-04-30 knowledge cutoff. Live generation with
qgrid's exact request shape and `codex_cli_rs/0.147.0` headers succeeded on 2026-09-30, while Codex CLI 0.157.1
received `400 The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account` and 0.159.2
succeeded; the pinned User-Agent version did not need to change. The catalog now labels GPT-6 Sol
"Previous generation workhorse model" without a retirement date. Ultrafast (`service_tier: "ultrafast"`, $60 /
$6 / $300) is a public-API tier for GPT-6 Astra only; the subscription catalog exposes just the `fast` tier.

## Existing OpenAI model pricing and limits

Checked 2026-09-23 against the official [Standard pricing table](https://developers.openai.com/api/docs/pricing)
and the local Codex subscription catalog. Prices are USD per million tokens:

| Model | Input | Cached input | Cache write | Output | Codex context | Maximum Codex effort |
|---|---:|---:|---:|---:|---:|---|
| GPT-6 Astra | 10 | 1 | 12.50 | 50 | 272K | ultra |
| GPT-6.1 Sol | 2 | 0.10 | 2.50 | 10 | 272K | ultra |
| GPT-6 Sol | 2 | 0.20 | 2.50 | 10 | 272K | ultra |
| GPT-6 Luna | 0.10 | 0.01 | 0.125 | 0.50 | 272K | max |
| GPT-5.6 Sol | 4 | 0.40 | 5 | 20 | 272K | ultra |
| GPT-5.6 Terra | 2 | 0.20 | 2.50 | 12 | 272K | ultra |
| GPT-5.6 Luna | 0.20 | 0.02 | 0.25 | 1.20 | 272K | max |
| GPT-5.5 | 5 | 0.50 | Not published | 30 | 272K | xhigh |

GPT-5.3-Codex-Spark has a 128K catalog context and effort through `xhigh`; its token pricing
remains an explicitly documented generic estimate. Retired model pricing rows remain for legacy logs.
The catalog does not establish a maximum output size. GPT-5.6 public API specifications list 1.05M
context, 922K maximum input and 128K maximum output; do not conflate them with the subscription limits.
Codex default effort is `low` for GPT-6.1 Sol and GPT-5.6 Sol, `medium` for GPT-6 Astra/Sol/Luna, GPT-5.6 Terra/Luna and GPT-5.5, and `high` for Spark.
GPT-5.5 retires from the Codex/ChatGPT route on 2026-10-14 (the API-key route is unaffected); it stays in the SDK type and price table but is excluded from chat presets.
The SDK default remains `low` regardless of the backend default.

[Sol's model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) guarantees promotional
pricing at least through 2026-11-21. That is not an announced expiration date. Keep the latest verified
rates until another official rate is published; never guess a future reversion. Above 272K input,
GPT-6, GPT-5.6 and GPT-5.5 apply 2x input/cache and 1.5x output to the full request.

Changing the price table affects new calculations and legacy estimates that resolve rates on read.
It does not rewrite persisted request-log costs or backfill historical records. Report a historical
recalculation as a separate data change; do not silently include it in a pricing update.

## Private backend boundary

OpenAI requests go directly to `https://chatgpt.com/backend-api/codex/responses` with an HTTPS `POST`. The response is an SSE stream. Qgrid sends the subscription bearer token, ChatGPT account id, content negotiation fields, and Codex CLI `originator` and `User-Agent` identity headers.

This is a private ChatGPT backend, not a documented public API. Its URL, accepted fields, required headers, event shapes, quota response, and availability can change without notice. Unit tests use mocked HTTP/SSE fixtures. Do not describe those tests as live provider verification.

`QGRID_OPENAI_TRANSPORT=https|websocket` selects the transport once when dispatcher configuration is resolved; WebSocket is the default and other values fail fast. WebSocket mode scheme-swaps the Responses HTTPS URL to `wss` and reuses one connection for sequential requests with the same prompt-cache affinity. Requests without cache affinity use one connection each. HTTPS remains available but does not preserve prompt-cache connection affinity. Qgrid does not replay ambiguous requests. Only a definitively rejected 401 handshake may refresh credentials and reconnect once.

The active HTTPS/SSE request receives the composed caller/timeout signal. Qgrid never replays a POST after a transport, 429, or 5xx failure because acceptance is ambiguous. A 401 may refresh credentials and retry once because the backend rejected that attempt.

## Request and stream behavior

Every request sends `store: false`, `stream: true`, full Responses-format history, and `include: ["reasoning.encrypted_content"]`. Optional reasoning, verbosity, service tier, structured-output schema, image generation, and `prompt_cache_key` fields are added when requested.

`normalizeOpenAISSE` handles chunk boundaries and converts private backend events into qgrid's normalized text, output-item, image, usage, completion, and error events. The HTTPS transport may retry a failure only before any visible event. It refreshes credentials once on a pre-event 401. Once output is visible, an error is returned rather than replaying a request that may already have produced output.

The caller's `AbortSignal` is passed through token selection (including a pending quota lookup) and `fetch`. Cancellation aborts active transport work.

## Token routing

Execution is stateless per request, the same model as the Anthropic runtime: select a token, send the request. There is no concurrency cap, no permit, and no queue — transport is a single HTTPS/WS request, so nothing local is scarce, and upstream limits surface as backend responses (429 etc.), which qgrid does not retry.

Selection picks among active, quota-eligible tokens: a cache-affinity-preferred token is used when eligible; otherwise smooth weighted round-robin (token weights set relative share; affinity hits do not advance weighted state). If every active token is over its quota threshold, the request fails with `QuotaThresholdExceededError`; with no active tokens it fails with `NO_OPENAI_WORKERS`.

Quota lookup failures fail open. A successful lookup over a token's configured threshold excludes that token until the cached usage is refreshed.

A quota HTTP 401 uses the same per-token refresh path as generation, then retries the GET once. Explicit permanent refresh error codes (string or nested `error.code`) mark the credentials as requiring re-login and deactivate the token through the shared auth-death path. Other lookup failures do not prove an expired login. In-flight quota lookups and cached results are scoped to a metadata generation; a subscriber credential update takes precedence over an older refresh result.

## Full-history replay and cache affinity

Qgrid no longer retains an OpenAI provider thread. It sends the full conversation history on every turn. The AI SDK derives a model-scoped opaque value from `sessionKey`; the server validates and forwards it as `prompt_cache_key`.

The legacy `threadCoord` and `runContext` shape remains for compatibility, but it carries cache affinity rather than a process or provider-thread address. Do not infer worker lifetime, thread presence, or delta-only replay from `workerId`, `threadId`, or `epoch`.

Stable affinity can improve provider prompt-cache reuse only when the serialized prefix remains stable. System prompt, tool/schema framing, message order, and model changes can still prevent a cache hit. Image generation sends full input and retains no provider conversation state.

## OAuth, identity, refresh, and quota

OpenAI browser login is implemented directly with authorization-code PKCE:

1. Generate verifier, SHA-256 challenge, and state.
2. Open a loopback callback relay on a port OpenAI registered for the Codex CLI client.
3. Build the OpenAI authorize URL with Codex CLI-compatible client, scope, originator, and simplified-flow fields.
4. Validate pending state on callback.
5. Exchange the code directly at `https://auth.openai.com/oauth/token`.
6. Parse account id and plan claims, then store access, refresh, and id tokens.

The redirect URI is not qgrid's own server address. OpenAI matches the Codex CLI client's redirect URIs by exact string and registers only `http://localhost:1455/auth/callback` and `http://localhost:1457/auth/callback`. Sending qgrid's configurable port instead makes `/oauth/authorize` fail with `invalid_authorize_request`, which the browser renders as a generic "Authentication Error / error_code: unknown_error" page before any login screen.

Loopback dashboards use automatic completion: `openai-callback-relay.ts` binds `127.0.0.1:1455` (falling back to `1457`) for the login window and 302-forwards only `code` and `state` to qgrid's own `/auth/callback` route. Both ports being busy — typically a running `codex login` — fails the local login start with a message naming them.

Remote dashboards use manual completion because the browser's `localhost` is not the qgrid server. Qgrid signs the authorize request with the registered `http://localhost:1455/auth/callback` URI without opening a server relay and returns `mode: "code"`. After login the browser may show a connection failure at that loopback URL; the user copies the full address-bar URL into the dashboard. `oauthComplete` validates the cached state, extracts only `code` and `state`, and performs the same token exchange and account replacement as the automatic callback.

Refresh posts the stored refresh token directly to the token endpoint, deduplicates concurrent refreshes, and persists rotated credentials. Generation sends Codex CLI identity headers built by `buildCodexIdentityHeaders`.

Quota is fetched directly from `https://chatgpt.com/backend-api/wham/usage` with the same identity headers. Qgrid normalizes the primary usage window and caches it for 60 seconds. This private response format has the same stability warning as the Responses endpoint.

## Usage and images

OpenAI usage reports total input, cached input, output, reasoning, and total tokens for the request. Preserve cached input as a subset of input; do not add it to input again when computing cache-hit rate.

Image generation is opt-in and non-stream at the AI SDK interface. The backend still delivers its response through SSE. `imageGenerationOptions.outputFormat` maps to the hosted tool's `output_format` (`png`, `jpeg`, or `webp`); omission retains PNG. Returned bytes determine the MIME type when recognizable, with the reported format as fallback. Preserve that type through qgrid content, AI SDK file parts, and request-log image data URLs. The standalone transparent route remains PNG-only and rejects other output formats. Recorded image cost remains an estimate based on qgrid's configured public image price table because this route does not expose exact image-tool billing.

### Transparent image route

Explicit `imageGeneration: true` with `imageGenerationOptions.background: "transparent"` switches from hosted Responses to Codex `images/generations` or `images/edits`. The same selected subscription token, cancellation deadline, in-flight tracking, and one definitive 401 refresh apply. Use JSON content negotiation; do not reuse the Responses SSE Accept header. Never replay an ambiguous generation or fall back to opaque output/IS-Net. This explicit route runs `gpt-image-2` directly, so actual model metadata differs from the requested driver ID and ordinary driver usage stays zero. Image response usage and actual settings are preserved on `generation`; usage belongs to the first output only. Costs remain explicitly estimated from public prices.

The image request adapter preserves text/system context and reference images (maximum five), rejects unsupported structured/tool requests before generation, and validates PNG contents with pngjs. Both a fully transparent pixel and visible content are required. Invalid, opaque, empty, or oversized results fail. Returned dimensions come from the decoded PNG; qgrid never silently resizes. A 2026-09-08 live request returned 1254x1254/medium for requested 1024x1024/high. Do not promise exact size/quality enforcement. See `openai-image-generation.ts` and opt-in `transparent`/`transparent-edit` cases in the image smoke script.

### Automatic dashboard chat images (2.9.8)

Raw `QueryInput.imageGeneration` accepts boolean or `"auto"`; the public AI SDK option remains boolean. OpenAI dashboard chat sends `"auto"` through one non-stream POST per turn. The dispatcher offers native `image_generation` plus a qgrid-defined Responses function, `generate_transparent_image`, reserved for transparent backgrounds. It executes that function server-side against standalone Codex Images using the same selected token and abort signal, without another GPT request. The client must not implement a `request_image_generation` decision loop.

Auto mode accepts text-only completion when no image tool was attempted. Explicit `true` still requires an image, and an attempted image tool that returns no complete image still fails. Caller tools and `outputSchema` are incompatible with auto mode. The transparent function and native image tool must not be mixed in one response; at most one transparent call is allowed.

Auto transparent turns preserve the Responses driver model and token usage; image model, settings, and usage remain separate generation metadata. Do not apply the explicit standalone route's zero-driver accounting to auto turns. Full image history is replayed on each turn without reusable provider conversation state. Global image-tool opt-in remains unchanged outside chat to preserve regular callers' tool framing and cache behavior.

The 2026-09-29 hosted-route probe returned PNG for a prompt-only WebP request and WebP for explicit `imageGenerationOptions.outputFormat: "webp"`. Verify bytes rather than model claims. The standalone transparent endpoint still returns PNG; no format conversion is added. See `output/webp-prompt-probe-2026-09-29/verification.md` and `docs/solutions/architecture-patterns/qgrid-native-auto-image-generation-2.9.8.md`.
