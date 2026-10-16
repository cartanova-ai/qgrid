# Provider Runtime Differences

Use this reference when comparing OpenAI, Anthropic, and Grok behavior, debugging provider-specific bugs, or reviewing cross-provider changes. Sources: `packages/api/src/utils/providers/{openai,anthropic,grok}/*`, `packages/api/src/application/qgrid/qgrid.dispatcher.ts`, and `references/grok-runtime.md`.

| Topic | OpenAI via Codex | Anthropic via Claude Code | Grok via grok-build fingerprint |
|---|---|---|---|
| Process lifetime | No child process; direct HTTPS/SSE or WebSocket request | Fresh `claude` process per request | No child process; direct HTTPS/SSE request |
| Worker pool | None; in-memory token pool only | None; in-memory token pool only | None; in-memory token/account pool only |
| Worker id | Legacy coordinate field carries token id | `tokenId` | Legacy coordinate field carries token id |
| Epoch | Legacy compatibility value; not a process generation | Always `0` | `-1`; not a process generation |
| Request concurrency | Uncapped; stateless request per call | Uncapped; fresh process per request | Uncapped by default; optional `QGRID_GROK_MAX_INFLIGHT_PER_TOKEN` excludes accounts at the cap |
| Token selection | Smooth weighted RR over quota-eligible tokens; valid affinity may prefer its token | Smooth weighted RR over quota-eligible tokens per request | Smooth weighted RR after quota, on-demand, cooldown, entitlement, and capacity gates; valid affinity may prefer its token |
| Model routing | `openai/*`; qgrid strips provider prefix before provider call | `anthropic/*`; provider canonicalizes model and strips prefix/`[1m]` | `grok/*`; qgrid strips the provider prefix and validates against the seeded/live catalog |
| Prefix-less models | Fallback not implemented | Fallback not implemented | Fallback not implemented |
| Effort vocabulary | Codex catalog levels `low`..`ultra` | Claude Code `--effort` levels `low`..`max` | Catalog levels `low`, `medium`, `high`, `xhigh`; thinking-off is unverified and rejected |
| Unsupported effort | Server drops it before the request; backend default applies | Server drops it; qgrid default `low` applies | Server drops it; catalog default applies |
| Thread/session | No provider thread retained | Fresh Claude `--session-id` per request | No provider thread retained; stable account session/agent ids are fingerprint headers |
| `sessionKey` | AI SDK derives and replays opaque `prompt_cache_key` affinity | AI SDK intentionally disables storage/replay | AI SDK derives and replays account-affine `prompt_cache_key` coordinates |
| Multi-turn | Full Responses-format history is sent on every request | Fresh spawn receives flattened full history through stream-json | Full Responses-format history is sent on every request |
| Cache key | Opaque model-scoped affinity key plus stable serialized prefix | Anthropic prefix cache via Claude Code | Opaque model-scoped affinity key, also used to derive Grok conversation ids |
| Built-in tools | Direct request includes only requested qgrid tools/options | Claude tools disabled via `--tools ""` | Captured proxy supports `web_search`/`x_search`, but qgrid's public tool path remains the shared emulation contract |
| AI SDK tools | Emulated via qgrid structured output schema | Emulated via prompt envelope; not native Claude Code tools | Emulated via the strict qgrid action envelope (D8), not provider-executed function tools |
| Structured output | Strict JSON schema is sent in the direct Responses request | Schema is prompt text; consumer validation owns correctness | Strict JSON schema is sent in the direct Responses request |
| Usage accounting | Input includes cached input | Native categories are summed into total input | Responses reports cached/reasoning/context tokens and `cost_in_usd_ticks` |
| Cost source | qgrid model price fallback | Prefer Claude Code `total_cost_usd`, else qgrid fallback | Provider ticks are authoritative; catalog-seeded fallback when ticks are absent |
| Settings isolation | Per-token credentials in memory | Shared project cwd plus per-token `CLAUDE_CONFIG_DIR` | Per-token OAuth credentials and stable ids in memory |
| Streaming close | `AbortSignal` cancels selection or active transport | Abort kills the fresh child process | `AbortSignal` cancels selection or active SSE; success requires `response.completed` |
| Media/voice | OpenAI image routes only | Explicitly unsupported | Image generation/editing, async video URL jobs, STT, and TTS on `api.x.ai` |

## Routing contract

Provider routing happens in `packages/api/src/application/qgrid/qgrid.dispatcher.ts`.

- `openai/<model>` routes to `OpenAIDispatcher`.
- `anthropic/<model>` routes to `AnthropicDispatcher`.
- `grok/<model>` routes to `GrokDispatcher`.
- models without provider prefix produce "Direct LLM API fallback not implemented".

Do not silently route prefix-less Claude model names such as `claude-sonnet-4-6` to Anthropic. Tests intentionally guard against this.

## Shared contracts

All three providers return `GenerateResult` with:

- `text`
- `tokenName`
- `usage`
- `durationMs`
- optional `ttftMs`
- optional provider cost
- canonical `model`
- `threadCoord`

`qgrid.dispatcher.ts` maps this into `QueryOutput`, applies tool-call emulation, calculates fallback cost, and keeps the legacy `QgridThreadCoord` response shape for opaque OpenAI cache affinity.

OpenAI and Grok receive strictified output schemas from `buildStrictOutputSchema`; Anthropic receives the original schema as prompt text.

Tool calling uses qgrid's shared action-envelope path. It is not native provider tool execution on any public route (`packages/api/src/application/qgrid/qgrid.dispatcher.ts`, `tool-emulation.ts`).
