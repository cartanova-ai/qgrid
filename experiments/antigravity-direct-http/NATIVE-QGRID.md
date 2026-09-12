# Native qgrid HTTP integration

Updated 2026-09-12. Branch: `codex/antigravity-direct-http`.

This branch now calls Google directly from qgrid. CLIProxyAPI and agy are not
runtime dependencies. The original agy work remains in `codex/antigravity`.

## Implemented

- Google OAuth through Add Token → Login with Google (Antigravity). The full
  localhost callback URL is pasted into the existing OAuth completion form.
- Per-account access/refresh tokens, Google identity and Antigravity project ID.
- Weighted account selection, exact tokenName targeting, per-account model/quota
  caches, and account-specific invalid_grant handling.
- Token refresh with per-process deduplication and compare-and-swap DB persistence.
- Text/system/history translation, native HTTP and SSE parsing, usage accounting,
  cancellation, and explicit errors for incomplete or blocked output.
- Existing qgrid text-schema and client-tool-emulation paths are retained.
- Gemini Flash-Lite 3.1 and 3.5 are included in the qgrid catalog. Google advertised
  3.5 to the test account but a direct 3.5 test returned HTTP 503; availability of
  that model has not been established by a successful generation.
- The dashboard now reads explicit windows from `retrieveUserQuotaSummary` and
  uses the shared 5h/7d rows. The tested free account returned gemini-weekly,
  displayed as 7d. Plan labels remain deferred.

## Verified

- Native qgrid `/api/qgrid/query` → Google, requested `gemini-3.1-flash-lite`:
  returned exactly `QGRID_NATIVE_OK`, 12 input tokens and 119 output tokens
  including 112 reasoning tokens. No CLIProxyAPI process participated.
- Related API unit/integration tests: 223 passed in 10 files. The isolated Vitest
  configuration omitted the unrelated global template-database setup.
- Public SDK unit tests: 133 passed in 5 files.
- API and web TypeScript checks passed; API build passed.
- Repository lint, formatting and documentation consistency passed. Because this
  worktree reuses dependency-directory symlinks, `pnpm_config_verify_deps_before_run=false`
  was used to prevent pnpm from reinstalling those linked directories.
- Local browser: OAuth provider button and Antigravity account weight controls
  were present. No new consent or generation was submitted through the browser.

## Completed live SDK acceptance

After the user explicitly approved the additional calls, the complete
`packages/ai-sdk/e2e/antigravity-http.ts` suite ran successfully against native
qgrid on port 45118, within its maximum of six short generation calls:

- `generateText`: exact `QGRID_SDK_OK` response.
- `streamText`: exact `QGRID_STREAM_OK` response and `stop` finish reason.
- Structured output: schema-validated `{ status: "ok", count: 3 }`.
- Client-tool round trip: `lookup` executed exactly once and the final answer
  matched the tool's returned word.

All four checks passed; the process exited with code 0. This validates the native
qgrid SDK/server/Google chain, independently of the earlier CLIProxyAPI experiment.

## Completed two-account live check

Two distinct Google OAuth account IDs were verified in the isolated local database.
The second account was registered through qgrid's own OAuth start/complete endpoints;
a temporary localhost callback listener forwarded the consent result without logging
the authorization code. The first attempt selected the existing account, exercising
account deduplication; its original display name was restored before registering the
different account. No generation was sent during that failed two-account precheck.

Two exact-target requests then ran concurrently through native qgrid:

| Token name | Requested model | Result | Duration | Input/output tokens |
| --- | --- | --- | --- | --- |
| antigravity/http-test | gemini-3.1-flash-lite | Exact account-1 marker | 1,987 ms | 13 / 124 |
| antigravity/http-test-2 | gemini-3.1-flash-lite | Exact account-2 marker | 4,333 ms | 13 / 150 |

Both response token names and worker IDs matched their explicitly selected database
accounts. This establishes two-account concurrent generation on the same host.
Automatic weighted selection remains covered by mock tests; long-running refresh
and quota exhaustion across two live accounts have not been exercised.

## Timing persistence regression

The HTTP adapter now rounds durationMs and ttftMs to integer milliseconds before
returning provider results. Both streaming and non-streaming regression checks
reproduced the original fractional value and passed after the change. A real
chat-style streaming request then saved a succeeded request log and generate step
with duration_ms=900 and ttft_ms=885 in PostgreSQL.

## Local environment

- qgrid: `http://127.0.0.1:45118`
- PostgreSQL: dedicated `qgrid-antigravity-http-db`, localhost port 45432,
  database `qgrid_antigravity_http`; 41 existing migrations applied.
- Server `.env` contains the separate local DB settings and required
  `QGRID_ANTIGRAVITY_CLIENT_SECRET`. It is ignored and must not be shared.
- The first OAuth credential from this experiment was imported into that local DB;
  the second was added through qgrid's native OAuth flow.
  Neither the original agy Keychain nor the production database was read or changed
  for this import.
- Verification used only this isolated local environment; no deployment was performed.

This implementation follows the user's explicit decision to continue after the
provider-policy discussion. Technical success is not evidence of Google support
or future account safety; see the earlier policy finding in RESULTS.md.
