# Grok Direct Runtime

Use this reference before changing Grok chat transport, fingerprinting, OAuth, quota routing, media, voice, cost accounting, or retry behavior.

## Source files

- Fingerprint constants and headers: `packages/api/src/utils/providers/grok/grok-constants.ts`, `grok-headers.ts`.
- Chat protocol, transport, models, and dispatch: `grok-backend-protocol.ts`, `grok-direct-client.ts`, `grok-models.ts`, `grok-dispatcher.ts`.
- OAuth, refresh, billing, and settings: `grok-oauth.ts`, `grok-refresh.ts`, `grok-quota.ts`.
- Image/video and voice clients: `grok-media-client.ts`, `grok-voice-client.ts`.
- API limits and endpoints: `packages/api/src/application/qgrid/qgrid.types.ts`, `qgrid.frame.ts`.
- Probe evidence and design decisions: `docs/diagnosis/2026-10-16-grok-live-probe.md`, `docs/plans/2026-10-16-grok-provider-integration-plan.md`.

## Hosts and fingerprint

Grok uses the same xAI subscription OAuth bearer on two hosts, but the header families are not interchangeable (`grok-constants.ts`, `grok-headers.ts`):

| Host | Operations | Identity headers |
| --- | --- | --- |
| `https://cli-chat-proxy.grok.com/v1` | `/responses`, `/settings`, `/models`, `/billing`, `/user` | `grok-shell/1.0.60 (<os>; <arch>)`, client version and identifier, client mode, and the proxy auth headers. `/responses` also sends the captured `x-grok-*` conversation headers, trace context, loop guards, and zstd encoding. |
| `https://api.x.ai/v1` | image generation/editing, video start/status, STT, TTS | Media uses `xai-grok-build/1.0.60`; voice uses the shell user agent. Both send the client version and identifier, but never the proxy auth trio. |

D2 requires the installed grok-build fingerprint. `GROK_BUILD_VERSION` is pinned to `1.0.60` and `GROK_BUILD_COMMIT` to build `01a8e1c591c0`; the golden request came from the installed binary, not the older public source (`grok-constants.ts`, `grok-headers.test.ts`, `docs/diagnosis/2026-10-16-grok-live-probe.md`).

Handle the pin like OpenAI's `CODEX_CLI_VERSION`: keep it as a source constant with no runtime override. To bump it:

1. Edit `GROK_BUILD_VERSION` in `grok-constants.ts`.
2. Run the newly installed grok-build binary through an intercepting proxy and re-capture the redacted golden request fixture.
3. Update `GROK_BUILD_COMMIT` with that binary's build id.
4. Run `grok-headers.test.ts` and the golden fingerprint test before release.

The proxy treats the client version as a floor. The 2026-10-16 probe saw `/settings.min_client_version = 1.0.13`; a lower client received HTTP 426. The dispatcher trips a chat-only fast gate for 10 minutes and reports the bump routine (`docs/diagnosis/2026-10-16-grok-live-probe.md`, `grok-dispatcher.ts`).

## OAuth, credentials, and refresh

Grok login uses OIDC discovery under `https://auth.x.ai`, public client id `b1a00492-073a-47ea-816f-4c329264a828`, S256 PKCE, `referrer=grok-build`, and these frozen scopes: `openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write` (`grok-constants.ts`, `grok-oauth.ts`).

Browser login uses a random `127.0.0.1` callback and accepts either the full callback URL or a pasted bare code. Qgrid exposes this as code-paste completion because it does not serve the random callback. Device login uses `/oauth2/device/code`, polls `/oauth2/token` at the returned interval, and adds five seconds after `slow_down` (`grok-oauth.ts`, `packages/api/src/application/qgrid/qgrid.frame.ts`).

Stored credentials contain OAuth access/refresh tokens, RFC 3339 expiry, issuer, client id, scopes, `userId`, stable session/agent ids, and an optional tier. Registration accepts only an `at+jwt` issued by `auth.x.ai`; the post-login `/user` lookup resolves the account (`grok-types.ts`, `grok-oauth.ts`). `userId` is the token identity key, so signing in again replaces the prior row for the same account while preserving token settings (`packages/api/src/application/token/token.model.ts`).

Refresh starts 300 seconds plus stable 0–60 second per-account jitter before expiry, coalesces concurrent refreshes, persists before publishing credentials, and retains the old refresh token when xAI does not rotate it. Only `invalid_grant` and `invalid_client` require a new login; network errors, 429, 5xx, and unknown OAuth errors remain transient. An upstream 401 permits one forced refresh and one same-token retry (`grok-refresh.ts`, `grok-dispatcher.ts`).

## Quota, billing, and token selection

`/billing?format=credits` is camelCase: qgrid reads `config.creditUsagePercent`, `config.currentPeriod`, and `config.prepaidBalance.val`. The observed period was seven days anchored at subscription start. Results are cached for 60 seconds; lookup failure fails open (`grok-quota.ts`, `grok-dispatcher.ts`, `docs/diagnosis/2026-10-16-grok-live-probe.md`).

D6 excludes accounts when `/settings.on_demand_enabled` is `true`; `null`, `false`, or absence allows routing. Billing does not carry this field. D7 selects eligible accounts through the shared `SmoothWeightedRoundRobin`, using `tokens.weight`; a valid cache-affinity token remains preferred. `QGRID_GROK_MAX_INFLIGHT_PER_TOKEN` optionally excludes accounts at the cap, while omission leaves Grok uncapped (`grok-quota.ts`, `grok-dispatcher.ts`, `packages/api/src/utils/providers/common/smooth-weighted-round-robin.ts`).

## Failure and failover rules

The dispatcher implements the plan §5.4 state machine (`grok-backend-protocol.ts`, `grok-direct-client.ts`, `grok-dispatcher.ts`, `grok-media-client.ts`):

| Condition | State and retry behavior |
| --- | --- |
| 429 with `Retry-After` | Set a request-class cooldown, capped at 120 seconds; fail over within the hop budget. If every candidate is cooling down, wait once for at most 30 seconds, then return a rate-limit error. |
| 429 exhaustion | Block the request class until the billing period ends, or one hour when the end is unavailable; invalidate billing and fail over. |
| 403 | Chat fails permanently without refresh or failover. Public API sets a one-hour entitlement block for that request class and may fail over once. |
| HTTP 426 | Trip the chat-only version gate. Media and voice remain available. |
| 401 | Refresh once and retry the same account; a second 401 marks it for re-authentication and may fail over. |
| `x-should-retry: false` | Return the error without retry or failover. |
| Chat 5xx/connect/idle failure | Fail over only before any event was forwarded and before upstream execution was observed. |
| Media/voice transport failure | Fail over only for a classified pre-send connection failure. Never replay a sent POST or a timeout that may have executed upstream. |

## Chat, tools, usage, and cost

Chat sends complete Responses-format history over HTTPS/SSE. It preserves image data/HTTPS inputs, strict structured output, prompt-cache affinity, reasoning effort, and the fixed include/store fields captured from grok-build. A stream succeeds only after `response.completed` (`grok-backend-protocol.ts`, `grok-direct-client.ts`, `grok-dispatcher.ts`, `docs/diagnosis/2026-10-16-grok-live-probe.md`).

D8 keeps qgrid's shared structured-output tool emulation: caller tools become the strict action envelope, the AI SDK executes returned tool calls, and a follow-up turn replays results. Do not replace this with Grok-native function execution without reopening the cross-provider contract (`packages/api/src/application/qgrid/qgrid.dispatcher.ts`, `tool-emulation.ts`, `tool-emulation-schema.ts`).

Provider `cost_in_usd_ticks` is authoritative, including zero; one tick is `1e-10` USD. If ticks are absent, qgrid uses catalog-seeded language/image prices and marks `costSource: "pricing_table"`; reported ticks use `costSource: "provider"` (`grok-dispatcher.ts`, `packages/api/src/utils/providers/common/model-cost.ts`, `docs/diagnosis/2026-10-16-grok-live-probe.md`).

## Media and voice

Qgrid exposes image generation/editing, asynchronous video start/status, transcription, and speech through `api.x.ai`. Reference images select `/images/edits`; video uses `/videos/generations` and `/videos/{request_id}`; voice uses multipart `/stt` and JSON `/tts` (`grok-media-client.ts`, `grok-voice-client.ts`, `packages/api/src/application/qgrid/qgrid.frame.ts`).

Inline audio, each inline image, and the aggregate inline images in one request are capped at 7 MiB decoded. The server maps Fastify's oversized-body error to HTTP 413 (`packages/api/src/application/qgrid/qgrid.types.ts`, `qgrid.frame.ts`).

Video starts return a random 128-bit in-memory job handle. Handles expire after 24 hours, polling stays pinned to the starting token, and `projectName` must match the owner supplied at start. A started job is already admitted and billed, so `getVideo` polls with `ungated: true`: it checks only credential state (inactive, reauth, refresh failure) and skips the quota-threshold, cooldown, in-flight, on-demand, and ZDR gates that admit new requests. After the upstream poll returns, `videoStatus` re-checks `job.final`, so overlapping polls of a finished job write the request log once and return the same result. D4 returns the upstream `api.x.ai` video URL unchanged; qgrid does not fetch, proxy, or store the bytes (`qgrid.frame.ts`, `grok-media-client.ts`, `packages/ai-sdk/README.md`).

**ZDR and video.** xAI refuses `POST /v1/videos/generations` for Zero Data Retention accounts with HTTP 400 `invalid_request`: "Zero Data Retention teams must provide output.upload_url for video generation." The dispatcher therefore keeps a per-token `zdr` state and excludes `zdr === true` tokens from video only; chat, image, STT, and TTS still route. The primary signal is `codingDataRetentionOptOut` on `GET /user?include=subscription`, re-read on the 60 s prefetch with settings; `x-zero-data-retention: true` on a chat-proxy response confirms it, but its absence never clears it. Unknown state, or a failed `/user` read with no prior value, routes (fail open). If a video start still gets the ZDR 400, the token is marked ZDR, video is entitlement-blocked for an hour, and the start fails over under the media rules. With no eligible video token the caller gets `GrokZdrVideoUnavailableError` (HTTP 503) naming the tokens; usage exposes `zdrVideoExcluded`. Both signals were inferred from one account (plan §11). grok-build's remedy, a user-owned S3 presigned `output.upload_url`, is not implemented (`grok-dispatcher.ts`, `grok-quota.ts`).

## Known gaps and residual risks

- **Verified 2026-10-16:** video generation succeeded through the SDK once the account's data-retention opt-out was off (8 s H.264 mp4 on vidgen.x.ai, $0.64; plan section 11). ZDR accounts are refused upstream and are excluded from the video class (see ZDR and video).
- Node/undici adds headers such as `accept-language` and `sec-fetch-mode` that the captured reqwest client did not send. Transport fingerprinting remains residual risk 10; D1/D2 do not authorize anti-detection work (`docs/plans/2026-10-16-grok-provider-integration-plan.md`, risk 10).
- **Unverified:** The capture pins chat header order. Media header order has not been verified through an installed-binary capture (`grok-headers.ts`, `docs/diagnosis/2026-10-16-grok-live-probe.md`).
- **Observed 2026-10-16, not represented in the catalog fixture:** `grok-composer` ids silently remapped to `grok-4.5-build`. Treat the returned serving model as authoritative; the captured catalog itself lists only the four documented model ids (`docs/diagnosis/2026-10-16-grok-live-probe.md`, `grok-models.ts`).
- `QGRID_GROK_LIVE_TOKEN_ID` is reserved by the plan for opt-in live tests and must stay unset in ordinary/CI runs; no current server runtime behavior depends on it (`docs/plans/2026-10-16-grok-provider-integration-plan.md`, §7).
