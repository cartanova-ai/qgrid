# Live experiment results

Date: 2026-09-12 (Asia/Seoul)

## Policy finding and experiment stop

After the live test, Google's current [Antigravity terms, section 6](https://antigravity.google/terms)
and [FAQ](https://antigravity.google/docs/faq/) were checked. They explicitly prohibit third-party
software access using Antigravity authentication and identify account suspension or termination
as possible consequences. Google's [2026-02-27 announcement](https://github.com/google-gemini/gemini-cli/discussions/20632)
also describes actual enforcement against third-party tools and proxies.

The experiment server was stopped and port 45117 was confirmed closed. No further model calls
were made after this finding. Credential files were not deleted and OAuth consent was not revoked.
The results below establish technical response behavior only, not permission to operate this path.
The earlier research should have surfaced this policy before the live-account test.

- Branch: `codex/antigravity-direct-http`
- Reference server: CLIProxyAPI 7.2.158, commit `5b278561`
- Endpoint: `http://127.0.0.1:45117`
- Authentication: fresh Antigravity Google OAuth, completed interactively by the user.
- No existing agy Keychain credentials were imported. No Gemini API key was configured.
- Credit fallback, alternate-model fallback, and extra retry rounds were disabled.

## Observed results

| Check | Result |
| --- | --- |
| OAuth callback and credential save | Passed |
| Authenticated `/v1/models` | Returned model IDs after login |
| `gemini-3.1-flash-lite`, non-stream | Returned the exact `QGRID_AG_OK` marker |
| Non-stream usage | 11 prompt tokens, 6 completion tokens, 17 total |
| `gemini-3.1-flash-lite`, SSE | Deltas reconstructed the exact marker and terminated with `[DONE]` |

The server uses `-local-model`, so the advertised list comes from its embedded
catalog and is not itself proof that every listed model is available upstream.
The successful Flash-Lite generation requests are stronger evidence for that
specific requested model ID. This probe does not independently attest the
underlying serving model or measure the account's quota decrement.

This establishes that this account can make short non-streaming and streaming
Antigravity requests through CLIProxyAPI's direct HTTP path without spawning agy.
Flash-Lite was absent from the agy 1.2.2 model list previously inspected, but this
direct transport accepted the requested `gemini-3.1-flash-lite` ID.

## Not established by this experiment

- Multi-account selection and isolation (only one account was authenticated).
- Structured output, tool calls, cancellation, long prompts, or sustained load.
- Refresh-token rotation and expiry recovery.
- qgrid SDK/server integration; this remains a standalone experiment.
- Google support guarantees or compatibility of future endpoint changes.

OAuth credentials and server config remain in ignored `data/` and are not part
of this report. The existing agy-based qgrid worktree was not changed.
