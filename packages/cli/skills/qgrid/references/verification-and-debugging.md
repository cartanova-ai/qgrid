# Verification And Debugging

Use this reference to choose tests, smoke scripts, and first debugging targets for qgrid changes.

## Contents

- Package scripts
- Targeted test matrix
- Smoke scripts
- Common error triage
- Debugging rules

## Keep Tests Lightweight

Cover user-visible flows with a small real-provider E2E suite. Keep focused tests for costs, validation, cancellation, transactions, and actual regressions that a successful live request cannot prove. Remove obsolete behavior and duplicate assertions; do not delete distinct contracts just because their tests use mocks or are long. Call counts matter when they detect duplicate generation or logging, not merely an internal implementation choice.

Prefer existing checks and fixtures. Do not add a generic harness, blanket coverage target, snapshot suite, or configuration-only test layer. After the relevant checks pass, repeat only for a new edit, failure, or concrete unresolved risk. Keep production fixes separate from test cleanup and never weaken a test to hide a discovered defect.

## Package Scripts

The commands in this section apply only inside the qgrid source repository. In a downstream
project, use that project's configured task and tool runner.

Root:

- `mise run check`: qgrid docs consistency, oxlint (including the vendored anti-slop rules in `tools/oxlint/anti-slop`, loaded by `.oxlintrc.json`), and oxfmt check for the repo. `mise run format` applies the auto-fixable rules, such as the blank-line spacing rule.
- `mise run test`: DB-free API tests, SDK tests, and CLI packaging tests. No provider credentials are needed; the OAuth relay test opens a local loopback listener.
- `mise run build`: recursive package build.
- `mise run dev`: parallel package dev servers.

API package `qgrid-api`:

- `mise exec -- pnpm --filter qgrid-api test:unit`: DB-free tests with per-file isolation. Add a test path to select a file.
- `mise exec -- pnpm --filter qgrid-api test:db`: model/transaction suites requiring a prepared local PostgreSQL test template. Missing DB is a failure, not a skip.
- `mise exec -- pnpm --filter qgrid-api test`: both suites, unit first.
- `mise exec -- pnpm --filter qgrid-api test:watch`: DB-free watch mode; use `test:db --watch` for DB tests.
- `mise exec -- pnpm --filter qgrid-api test:coverage`: both suites, with separate `coverage/unit` and `coverage/db` reports.
- `mise exec -- pnpm --filter qgrid-api build`: Sonamu build, run as `NODE_ENV=production sonamu build`. Sonamu 0.11 sets `NODE_ENV=development` when it is unset and the web `vite build` child inherits it, which produced a development-mode dashboard bundle in 2.11.0 (SON-567). Keep the explicit `NODE_ENV` until Sonamu fixes it.
- `mise exec -- pnpm --filter qgrid-api sonamu`: run Sonamu CLI. Since Sonamu 0.11 the `sonamu` binary comes from the `@sonamu-kit/cli` devDependency, not from `sonamu` itself.

Sonamu sync after changing models, types, entities, or i18n:

1. Build first (`mise run build` or `sonamu build api`). `sonamu sync` reads models from `dist`, so a stale `dist` silently drops newer `@api` methods from generated services, queries, validators, and `.http` (SON-566).
2. Run `HOT=yes mise exec -- pnpm --dir packages/api sonamu sync`. `HOT=yes` loads `src/sonamu.config.ts`; without it Sonamu needs `dist/sonamu.config.js`, which a failed build deletes. Add `--force` only when `sonamu.lock` cannot be trusted, for example right after a merge.
3. `sync --force` always prints the "자동 생성한 파일에 대한 변경이 감지되었습니다" drift warning for generated files, even when nothing drifted (SON-565). Re-run plain `sync`; it should print `All files are synced!`.
4. Sonamu lints generated code with type-aware autofix in a temp file at the API root, where relative imports do not resolve. That fix strips the required `as unknown as SDReturnType<K>` casts from `sd.generated.ts` (SON-564). The `.oxlintrc.json` override for `**/.sonamu-oxlint-*.ts` turns that rule off; keep it until Sonamu fixes the temp-file location.

AI SDK package `@cartanova/qgrid-ai-sdk`:

- `mise exec -- pnpm --filter @cartanova/qgrid-ai-sdk test`.
- `mise exec -- pnpm --filter @cartanova/qgrid-ai-sdk build`.
- `mise exec -- pnpm --filter @cartanova/qgrid-ai-sdk e2e`.
- `mise exec -- pnpm --filter @cartanova/qgrid-ai-sdk e2e:tools-output`.
- `mise exec -- pnpm --filter @cartanova/qgrid-ai-sdk e2e:logger`.

CLI package `@cartanova/qgrid-cli`:

- `mise exec -- pnpm --filter @cartanova/qgrid-cli build`.
- `mise exec -- pnpm --filter @cartanova/qgrid-cli bundle` builds the API first and copies the server bundle.

Web package `qgrid-web`:

- `mise exec -- pnpm --filter qgrid-web dev`.
- `mise exec -- pnpm --filter qgrid-web preview`.

The old v1 SDK package (`packages/sdk`) has been removed from the repository; all public-SDK verification goes through `packages/ai-sdk`.

## Targeted Test Matrix

Choose by affected area:

| Area | Primary tests |
|---|---|
| AI SDK provider request/response mapping | `packages/ai-sdk/src/index.test.ts` |
| AI SDK logger integration | `packages/ai-sdk/src/logger.test.ts` |
| qgrid provider routing and strict schema | `packages/api/src/application/qgrid/qgrid.dispatcher.test.ts` |
| full-history and cache-affinity routing | `packages/api/src/application/qgrid/conv-routing.test.ts` |
| tool-call emulation | `packages/api/src/application/qgrid/tool-emulation.test.ts`, `tool-emulation-schema.test.ts` |
| request-log run lifecycle | `packages/api/src/application/qgrid/qgrid-run-lifecycle.test.ts` |
| qgrid frame API behavior | `packages/api/src/application/qgrid/qgrid.frame.test.ts` |
| token subscriber and LISTEN/NOTIFY handling | `packages/api/src/application/qgrid/token-subscriber.test.ts` |
| token defaults/validation | `packages/api/src/application/token/token.model.test.ts`, `token.types.test.ts` |
| weighted routing selector | `packages/api/src/utils/providers/common/smooth-weighted-round-robin.test.ts` |
| token weight migration/trigger split | `packages/api/src/application/qgrid/token-weight-migration.test.ts`, `token-trigger-setup.test.ts` |
| boot order and startup migrations | `packages/api/src/server-bootstrap.test.ts`, `startup-migrations.test.ts` |
| request log queries/legacy normalization | `packages/api/src/application/request-log/request-log.model.test.ts` |
| OpenAI dispatcher routing/quota | `packages/api/src/utils/providers/openai/openai-dispatcher.test.ts` |
| OpenAI protocol, direct HTTPS, and SSE | `packages/api/src/utils/providers/openai/openai-backend-protocol.test.ts`, `openai-direct-client.test.ts`, `openai-sse.test.ts` |
| OpenAI direct PKCE OAuth | `packages/api/src/utils/providers/openai/openai-oauth.test.ts` |
| OpenAI quota parser | `packages/api/src/utils/providers/openai/openai-quota.test.ts` |
| Anthropic dispatcher token/quota/session behavior | `packages/api/src/utils/providers/anthropic/anthropic-dispatcher.test.ts` |
| Anthropic Claude args/env/session isolation | `packages/api/src/utils/providers/anthropic/claude-session.test.ts` |
| Anthropic stream-json parsing/structured output | `packages/api/src/utils/providers/anthropic/stream-json-adapter.test.ts` |
| Anthropic model constants/1M suffix | `packages/api/src/utils/providers/anthropic/anthropic-constants.test.ts` |
| Anthropic quota parser | `packages/api/src/utils/providers/anthropic/anthropic-quota.test.ts` |
| shared cost accounting | `packages/api/src/utils/providers/common/model-cost.test.ts` |
| TTFT tracker | `packages/api/src/utils/providers/common/ttft.test.ts` |

Run focused Vitest files from the owning package when possible, then broaden if the change crosses package boundaries.

## Smoke Scripts

Real-provider E2E requires a prepared isolated qgrid server, a registered token, and explicit opt-in. It consumes subscription quota; do not run it against production as part of routine checks. Never report mocked tests as live-provider verification.

The default entry point is `packages/ai-sdk/e2e/e2e.ts` (`mise exec -- pnpm --dir packages/ai-sdk e2e`). It checks text, streaming, and tool-plus-structured output, and follows each returned `requestLogId` to the persisted parent and steps. Set `QGRID_REAL_PROVIDER_ACCEPTANCE=1`, `QGRID_URL`, and `QGRID_MODEL` explicitly. A comma-separated model list explicitly selects multiple provider runs. Each run uses a unique project label; no production logs are deleted. Exact prose, token counts, costs, and timing are not acceptance criteria.

CI runs the DB-free tests plus existing package and empty-DB boot checks. Live E2E remains an explicit command; unavailable credentials or infrastructure mean unverified, not passed.

OpenAI direct qgrid API:

- `scripts/smoke-test-openai.ts`
- Requires qgrid server and active OpenAI token.
- Uses `QGRID_URL`, default `http://localhost:44900`.
- Covers health, text generation, structured output, and qgrid-native tool-call content.

Anthropic qgrid path:

- `packages/api/scripts/smoke-test-anthropic.ts`
- Requires active Anthropic OAuth token.
- Uses `QGRID_URL`, `QGRID_ANTHROPIC_MODEL`, `QGRID_ANTHROPIC_MODELS`.
- Optional flags include `--full`, `--legacy-full`, and `--structured-stream-probe`.

AI SDK structured output:

- `scripts/qgrid-structured-ai-sdk-smoke.ts`
- Uses local `packages/ai-sdk/src/index`.
- Env: `QGRID_URL`, `SMOKE_MODEL`, `SMOKE_CASES`, `SMOKE_REPEAT`.
- Uses AI SDK 6 `streamText` with `Output.object`; useful for structured-output regressions.

AI SDK tools plus structured output:

- `packages/ai-sdk/e2e/tools-structured-output.ts`
- Focused regression probe for direct structured answers while tools are available, including OpenAI tuple output, streamed JSON, and streaming tool follow-up. The non-streaming tool execution happy path lives in the default E2E suite.
- Uses the same explicit opt-in, server, and model selection as default E2E. Runs once per mode by default; set `QGRID_ACCEPTANCE_REPEATS` only for an intentional repeated probe.

Image generation:

- `packages/api/e2e/image-generation.ts`
- Human-initiated only.
- Requires active OpenAI token with image entitlement and applicable migration.
- For 2.9.8 chat, verify the actual browser POST and served bundle, not only a direct function test. A globally installed CLI on port 44900 can serve stale assets while repository tests pass; identify the listening process and its executable before assuming a rebuild or refresh affects it.
- Cover auto text-only replies and the single server-side `generate_image` function for ordinary generation and transparent editing. Zero selected references must create a fresh image despite older history; positive counts must select only the last N conversation images in order, up to five. Explicit raw `true` must retain its image-required hosted behavior for non-transparent chat-model requests. Verify driver usage stays separate from image usage and auto text replies are not image logs.
- Verify extension, decoded bytes, and natural dimensions in chat image previews. A format request in prose is not evidence: the 2026-09-29 hosted-route WebP probe returned PNG from a prompt-only request and WebP from explicit `outputFormat: "webp"`. Auto chat and standalone output remain PNG-only and must reject explicit non-PNG options.
- Requires `QGRID_REAL_PROVIDER_ACCEPTANCE=1`, explicit `QGRID_URL` and `QGRID_OPENAI_MODEL`. Optional `QGRID_TOKEN_NAME` pins a subscription token. `QGRID_IMAGE_SMOKE_CASES` selects named cases; the default covers eight images plus text, rejected inputs, and cancellation. Optional `batch`, `logger-off`, and `cancel-direct` cover SDK batching, no-log calls, and cancellation during direct Images requests. Never replay generations automatically.
- Set `QGRID_IMAGE_E2E_OUTPUT` for PNGs and sanitized usage/cost/log evidence; `QGRID_IMAGE_E2E_PROJECT` groups test logs. Use an isolated DB and access-only test token, with notifications and keepalive disabled. For final acceptance, build the current API and cold-start `sonamu start` against that isolated DB rather than relying on HMR. HMR can leave a fresh dispatcher uninitialized; readiness alone does not prove the intended module version. The suite checks readiness before live calls.
- Subscription `response.completed.tool_usage.image_gen` can be present with all-zero usage for text-only or function-tool replies. This metadata alone is not a hosted image execution. Keep the zero-usage regression test and verify auto text against the real backend.
- Run auto text and generation with both Luna and Astra when changing the internal tool schema. Astra's private backend failed with `strict: true` even with bounds removed, while the same schema succeeded with `strict: false`. Keep `strict: false` and server-side validation; do not add a runtime fallback/retry.
- Not part of CI; it consumes ChatGPT subscription quota.

Image failure accounting:

- `packages/api/e2e/image-failure-accounting.ts` calls the real subscription chat model and compares its completed usage with the persisted failed/aborted request and generate step.
- Start a separate built local API with `NODE_OPTIONS=--import=<absolute path>/packages/api/e2e/image-failure-preload.mjs`. This test-only preload intercepts standalone Images requests with HTTP errors, network errors, invalid image responses, cancellation waits, or a synthetic success control. It never forwards Images requests upstream; no production test switch or fallback is added.
- Both processes require `QGRID_REAL_PROVIDER_ACCEPTANCE=1`, `QGRID_IMAGE_E2E_FAULT_FILE`, and `QGRID_IMAGE_E2E_TRACE_FILE`. The preload requires `HOST=127.0.0.1` and an isolated `SONAMU_DB_NAME` starting with `qgrid_e2e_`. The runner also requires `QGRID_URL`, `QGRID_TOKEN_NAME`, and `QGRID_IMAGE_E2E_OUTPUT`.
- Verify one completed driver step and exact input/output/cache usage and cost on failure; parent status and original errors stay failed/aborted, image cost stays unknown, and `logger: false` creates no records. The success control must not double-count driver usage. Trace files retain only completed model/usage metadata, never credentials or image bytes.

Other scripts under `scripts/smoke-test-*` and `scripts/debug-*` are ad hoc probes. Read the script header and env vars before running.

## Common Error Triage

Generated SSE handlers missing a newly added event field:

- Sonamu's service generator reads runtime stream-decorator schemas. A stale API `dist` can keep the old event shape even with `sonamu sync --force`.
- Run `mise exec -- pnpm --dir packages/api sonamu build api`, then `HOT=yes mise exec -- pnpm --dir packages/api sonamu sync --force`. Check the generated handler type and web typecheck; do not hand-edit generated services.

Dashboard throws `Module "" has been externalized for browser compatibility. Cannot access ".custom"` on load:

- The web bundle was built in development mode. `qs` → `side-channel` → `object-inspect` reads `require("./util.inspect").custom`; its `browser` field maps that file to `false`, which Vite turns into a throwing proxy outside production. Rebuild with `NODE_ENV=production` (the API `build` script sets it). A correct client bundle has no "externalized for browser compatibility" string.

`Missing Sonamu dotenv file`:

- Sonamu 0.11 refuses to start, including `sonamu build`, unless `packages/api/.env` or `.env.<NODE_ENV>` exists. The contents may be empty. CI creates an empty `packages/api/.env` before `mise run build`.

`sd.generated.ts` fails `tsc` with `Partial<MergedDictionary>[K] & {}` not assignable to `SDReturnType<K>`:

- The generated casts were stripped by Sonamu's post-generation lint (SON-564). Confirm the `.oxlintrc.json` override is present and re-run `HOT=yes ... sonamu sync --force`.

`NO_OPENAI_WORKERS`:

- The request path returns this only when there is no active OpenAI token candidate; there is no queue and no busy state.
- Check active OpenAI tokens and credential state (`OpenAIDispatcher.countActiveTokens()`).
- If tokens were recently changed, inspect `TokenSubscriber` status and reconcile behavior.

`NO_ACTIVE_WORKERS`:

- OpenAI token metadata exists but active tokens were deactivated.
- Check token `active` state and token subscriber event handling.

`SERVER_BUSY`:

- Removed with the permit/queue layer. Current builds never emit this error; seeing it means an old server build.

`QuotaThresholdExceededError` or `quota_threshold gate: all_exceeded`:

- All eligible tokens are above their `quota_threshold`.
- Check token thresholds and provider usage/rate-limit APIs.
- Lookup failures are fail-open, so all-exceeded means qgrid got usable over-threshold signals.

`Direct LLM API fallback not implemented`:

- Model likely lacks `openai/` or `anthropic/` prefix.
- Do not silently route prefix-less Claude model names to Anthropic.

`No anthropic tokens available`:

- Anthropic token pool is empty.
- Check active Anthropic tokens, subscriber reconcile, and token provider values.

`Claude session closed without result`:

- Claude child exited without a result line.
- Check stderr suffix in the error, spawn args, OAuth token validity, `CLAUDE_CONFIG_DIR` isolation, and CLI version.

`error_max_structured_output_retries`:

- Claude Code structured output failed after retries.
- Treat as a real error, not a recoverable partial result.
- Check schema strictness and `stream-json-adapter` behavior.

`qgrid: imageGeneration and imageGenerationOptions were removed from language-model options`:

- Either removed key makes `generateText` and `streamText` fail before transport. Use `generateImage` with `qgrid.image()` and flat `QgridImageProviderOptions` for image output.

`unsupported` warning with `feature: "image input"`:

- The language adapter dropped image parts: all of them on `anthropic/` models, and assistant-message images on any model. User-message images on `openai/` and `grok/` models are sent as image input; `grok/` also drops `http:` URLs. Reference-image editing belongs in `generateImage`'s `prompt: { text, images }`.

`image generation is not supported on the Anthropic route`:

- Image generation is OpenAI/Codex-only.

`qgrid.image: expected one image from the direct subscription Images route`:

- Image-provider version-skew guard. Each call requires exactly one image with `generation.route: "codex-images"`. Check that the server supports the explicit image model and update the server and SDK together.

`reference image input is too large for JSON transport`:

- AI SDK reference-image guard. The client passed a base64 image data URL large enough to likely exceed qgrid's JSON request body transport. Compress or resize the image before calling `generateImage` or an `openai/` language model with image input, preferably as WebP/JPEG.

`qgrid query transport failed: response headers timed out`:

- The AI SDK's request-scoped Undici `headersTimeout` for non-stream Anthropic generation expired. The message includes the effective transport budget, which is `providerOptions.qgrid.timeoutMs + 60_000`. Check whether the qgrid server stayed alive and whether its provider timeout/error response was delayed beyond that budget.

`qgrid query transport failed: connection refused`:

- The qgrid process was not accepting connections at the configured server origin. This is distinct from a long-running provider response; check the qgrid process, port, and `QGRID_URL`.

OpenAI `ImageGenerationError` kinds:

- `gate`: capability/model check failed before the turn.
- `not_called`: model completed but did not call an image tool for explicit `imageGeneration: true`. Auto mode permits text-only completion when no image tool was attempted.
- `incomplete`: image tool was attempted but no completed base64 image was produced.

`OpenAI refresh failed`:

- Inspect response body for refresh token death codes.
- If refresh token rotated but DB save failed, treat the token as at risk and require re-registration.

`re-login required`:

- Anthropic usage refresh failed and qgrid could not recover with stored refresh token.

## Debugging Rules

- Start from the package-specific tests before running smoke scripts.
- For provider issues, identify route by model prefix first.
- For cache issues, inspect opaque affinity, serialized history/prefix, provider route, and usage semantics before assuming provider cache failure.
- For dashboard metric issues, verify qgrid-standard usage fields before changing UI formulas.
- For Sonamu shape changes, verify API generated files and web consumers together.
