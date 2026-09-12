# Antigravity Direct HTTP Runtime

This branch implements `antigravity/*` through Google OAuth and the internal
Cloud Code HTTP/SSE backend. It does not execute agy or require a host Keychain.
The separate `codex/antigravity` worktree preserves the agy implementation.

## Source and scope

- `antigravity-oauth.ts`: consent URL, token exchange, account/project discovery,
  onboarding when required, and refresh.
- `antigravity-http.ts`: text/history/system request mapping, HTTP and SSE,
  usage accounting, aborts, and sanitized errors.
- `antigravity-dispatcher.ts`: named OAuth accounts, weighted selection,
  exact targeting, per-account model/quota cache, and refresh coordination.
- `antigravity-constants.ts`: qgrid-supported model/effort catalog.

Public protocol reference: CLIProxyAPI 7.2.158 (5b278561), MIT licensed:
https://github.com/router-for-me/CLIProxyAPI/tree/v7.2.158/internal/auth/antigravity
https://github.com/router-for-me/CLIProxyAPI/tree/v7.2.158/internal/runtime/executor

## User decision and provider policy

On 2026-09-12 the user explicitly selected direct HTTP development after reviewing
Google's third-party access restrictions. This supersedes the old agy-only
instruction for this branch; it does not authorize unrelated credential access.
Do not describe successful calls as evidence of provider permission or future
account safety. Never extract credentials from the user's agy Keychain.

## Authentication and account lifecycle

`oauthStartAntigravity(name)` creates a five-minute random state using the existing
qgrid OAuth state store. Google redirects to `http://localhost:51121/oauth-callback`;
the user pastes that full URL back into the dashboard, including code and state.
`oauthComplete` validates the stored state, exchanges the code, discovers the Google
account ID/email and Antigravity project, and replaces that account's registration.

`QGRID_ANTIGRAVITY_CLIENT_SECRET` must be supplied to the server environment.
Do not commit its value or OAuth tokens. `AntigravityCredentials` stores accessToken,
refreshToken, expiresAt, accountId, accountEmail, and projectId in the existing
credentials JSON column. No entity/schema migration was needed.

The token pool has no singleton name. Rows retain active, reauth_required, weight,
quota_threshold, and ord semantics. Credentials are refreshed near expiry or once
on a 401 before output starts. Refresh is deduplicated per token per process;
credential persistence uses a compare-and-swap UPDATE so a concurrent relogin or
delete is never overwritten/recreated. Only invalid_grant marks reauth_required
and deactivates that account through the shared auth-death path.

## Request contract

The runtime uses direct HTTPS, no CLI process. Caller text history is replayed
using qgrid's existing cold-history serialization. Caller system and structured
output/tool-envelope instructions are sent as systemInstruction. Tools remain
qgrid client-side emulation; no native Google tools or paid-credit fallback fields
are enabled. Text inputs only; images fail explicitly.

SSE reconstructs UTF-8 and event boundaries, excludes thought text from answer
content, and requires STOP. Safety/MAX_TOKENS or a truncated stream is an error.
Native function-call output is rejected. The caller's AbortSignal and timeout
cover generation; control-plane lookups also receive the request signal.

promptTokenCount already includes cached input: never add cachedContentTokenCount
again. Output includes candidatesTokenCount plus thoughtsTokenCount. Costs are
API-equivalent estimates, not subscription invoices.

## Models and quotas

The account's `fetchAvailableModels` response determines whether the requested
model/effort is advertised. For base models, select the matching effort-specific
ID, then base ID, then tiered ID. Keep the requested model distinct from the serving
modelVersion when supplied. An advertised ID can still fail with upstream capacity
or availability errors; do not silently alias it to another model.

Model catalogs/quota are cached by token ID and access token for 60 seconds.
The selected model's quotaInfo gates weighted routing. Exact tokenName never
falls back to a different account. The dashboard uses `retrieveUserQuotaSummary`, whose Gemini buckets explicitly
identify their window. Weekly maps to sevenDay/10080 minutes, and a five-hour
bucket maps to fiveHour/300 minutes. Never infer the window from time remaining.
Quota summaries are cached per account and access token for 60 seconds.
Plan labels remain deferred.

## Verification

- Unit tests: antigravity-http.test.ts, antigravity-oauth.test.ts,
  antigravity-dispatcher.test.ts and common/effort.test.ts.
- Public SDK live acceptance: packages/ai-sdk/e2e/antigravity-http.ts, explicitly gated
  by QGRID_REAL_PROVIDER_ACCEPTANCE=1. It sends up to six short model requests.
- Local integration uses a separate PostgreSQL DB and qgrid server; do not point
  experimental imports or test database setup at the production DB.
- Fixture-backed multi-account tests do not substitute for two real authenticated
  accounts. Native OAuth onboarding/refresh edge cases need continued validation.
