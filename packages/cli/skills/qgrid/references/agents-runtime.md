# Agents Runtime

Use this reference for qgrid-hosted Pi sessions, caller tools, recovery, and sandbox deployment. The implemented surface is the polling session API. Read `application/agent/agent.frame.ts`, `agent.types.ts`, and `utils/agents/*` under `packages/api/src` before changing its contracts. Design history: `docs/plans/2026-11-08-feat-qgrid-agents-rev3-host-pi-plan.md` (rev3) and the spike that justified it.

## Purpose And Boundaries

Qgrid runs the Pi coding agent on behalf of a caller. The caller supplies instructions, workspace input, tool definitions, and prompts; qgrid owns the session and turn records. Pi can read and change files, run commands, install packages, and use caller tools.

**Pi runs inside the qgrid API process** through the official `@ai-sdk/harness-pi` adapter. The Docker container is only Pi's remote filesystem and shell: every built-in tool call (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`) becomes a Docker exec or file operation. Nothing listens inside the container, no port is published, and no host alias is configured.

Model calls leave from the API process with the session's pinned pool token, exactly like ordinary qgrid OpenAI traffic. Subscription credentials therefore never enter the container; there is no relay and no placeholder. Caller-supplied `env` values are a separate boundary: those values deliberately enter the sandbox. Only the API host gets the Docker socket.

This is separate from the ordinary `qgrid()` language-model path. Pi performs native tool calls; the ordinary provider's structured-output tool emulation does not govern Agents. The Agents API uses the existing deployment authentication boundary; it adds no independent caller authentication.

## Components

| Component | Source | Responsibility |
|---|---|---|
| Docker provider | `utils/agents/docker-sandbox.ts` | Docker Engine access through dockerode, dedicated `qgrid-agents` network, one container per session, `bash -c` exec, files, archive upload, stop/resume/destroy, labeled orphan cleanup, data-root free space |
| Credential store | `utils/agents/credential-store.ts` | Pi `CredentialStore` per pool token: `read` checks token active/quota and returns the OAuth credential with the access JWT's expiry; `modify` refreshes through the dispatcher's existing refresh path under a per-token lock |
| Runner | `utils/agents/session-runner.ts` | Token selection, HarnessAgent + `createPi` per session, turns, continuation, limits, request logs, recovery, container ownership and 60-second sweep |
| Runtime | `utils/agents/runtime.ts` | Settings, isolation probe, runner startup/shutdown, `health().agents` |
| API and persistence | `application/agent/*` | Six polling endpoints; AgentSession and AgentTurn entities with transactional state changes |
| Workspace input | `utils/agents/workspace.ts` | Git clone with an exec-scoped credential helper, archive upload, bounded diff, value redaction |

AgentSession stores the model, pinned token ID/name, instructions, tools, container coordinates, TTLs, and the harness lifecycle state. AgentTurn stores its zero-based session index, prompt, status, parent request-log ID, pending actions/results/delivery markers, logged-step identities, usage, and output. Reserved webhook columns do not implement webhook delivery.

The harness is `@ai-sdk/harness-pi` with `harnessId: "pi"`; the runner creates it with `createPi({ credentials, reattachInProcess: false, thinkingLevel: "medium" })`, `permissionMode: "allow-all"`, and `sandboxConfig.workDir: "."` (the container's `/workspace`). API model ids keep qgrid's `openai/` prefix and are mapped to Pi's `openai-codex/<id>` catalog. Lifecycle state is persisted as the harness returns it (`resume-session` after a turn or stop, `continue-turn` while waiting for caller tools); persist the framework's entire envelope. `responseFormat`/structured output, manual compaction, Pi built-in tool approval, and permission modes other than `allow-all` are unsupported.

## Polling Session API

All paths start with `/api/agent/`. POST bodies use Sonamu's `{ "params": { ... } }` wrapper. GET uses nested query parameters, for example `sessionGet?params[sessionId]=SESSION_ID&params[includeDiff]=true` (URL-encode brackets in clients). Successful calls return HTTP 200, including creation and asynchronous prompt acceptance.

| Method / suffix | Input inside `params` | Output |
|---|---|---|
| POST `sessionCreate` | Required `model`, `instructions` (string, may be empty), `tools` (array, may be empty); optional `projectName`, `workspace`, `env`, positive integer `idleTtlSec` / `retainSec`, `imageProfile: "default"` | `{ sessionId, status, readyMs }`, normally `idle`; waits for the container and the Pi session, does not start a turn |
| POST `sessionPrompt` | `{ sessionId, prompt }`, nonempty prompt | `{ turnId }`; starts a background turn; stopped sessions resume first |
| GET `sessionGet` | `{ sessionId, includeDiff?: boolean }` | `{ session, turn?, workspaceDiff? }`; only the latest turn |
| POST `actionResult` | `{ sessionId, toolCallId, output?: JSON, error?: string }` | `{ accepted: true, turnStatus }`; resumes once all pending actions have results |
| POST `sessionStop` | `{ sessionId }` | `{ status }`, normally `stopped`; cancels an active turn, retains container files |
| POST `sessionDestroy` | `{ sessionId }` | `{ destroyed: true }`; cancels active work and removes the container; retains DB records |

`sessionGet.session` contains `id`, `status`, `model`, nullable `projectName`, ISO `createdAt` / `lastTurnAt`, and optional `stopReason`. `turn` contains `id`, `index`, `status`, `modelCallCount`, `pendingActions`, and optional `resultText`, `errorMessage`, `requestLogId`, `usage`. Pending actions expose only `{ toolCallId, toolName, input, gate, requestedAt }` without saved results. Credentials, token IDs, instructions, and lifecycle state are not exposed. `resultText` is the current/latest assistant text segment, not a transcript of every segment.

`projectName` is optional and otherwise stored as null; set it explicitly for attribution. The API does not expose the runner's internal `tokenId` targeting option. `imageProfile` only accepts `default`; there is no profile selection or arbitrary caller image.

| HTTP status | Relevant error codes / behavior |
|---|---|
| 400 | `invalid_agent_input` or sanitized `invalid_agent_request`, `unsupported_agent_model`, `invalid_tool_name`, `workspace_clone_failed`, `invalid_workspace_archive` |
| 404 | `session_not_found`, `turn_not_found`, `action_not_found` |
| 409 | `session_busy`, `invalid_state`, `action_result_conflict`, `workspace_diff_unavailable`, `unfinished_turn`, `continuation_unavailable` |
| 429 | `limit_exceeded:max_sessions`, `limit_exceeded:disk` |
| 503 | `agents_unavailable`, `agents_shutting_down`, `token_unavailable`, `quota_exceeded`; shared handler adds `Retry-After: 30` |
| 500 | `agent_operation_failed` for unexpected operation failures; raw Docker/Git errors are not returned |

Errors use the shared server error response with a machine-readable `message`. Turn failures after prompt acceptance are polled from `turn.status` and `errorMessage`, not retroactively returned as HTTP errors. Creation failures after the DB insert leave a `failed` session row while removing the container. The public API has no session-list endpoint.

### State Transitions

Session and turn statuses are distinct. A failed turn normally leaves a reusable `idle` session.

| Trigger | Session transition | Turn transition / result |
|---|---|---|
| Create succeeds / fails | `creating → idle` / `failed` | No turn |
| Prompt | `idle → running`; `stopped → idle → running` after restoring the saved state | New `running` turn and parent request log |
| Prompt while busy | `running` / `waiting_action` unchanged | HTTP 409 `session_busy`; no extra turn or log |
| Caller tool boundary committed | `running → waiting_action` | `running → waiting_action` |
| All caller results saved | `waiting_action → running` | Same turn resumes as `running` |
| Normal completion / execution error | `running → idle` | `succeeded` / `failed`; the detached Pi state is saved with the turn |
| Caller stop | Active state → `idle → stopped`; `idle → stopped` directly | Active turn becomes `aborted` (`cancelled`); stop reason `caller` |
| Limit or action timeout | Active state → `idle`, unless abort times out | `failed`, e.g. `limit_exceeded:time`, `limit_exceeded:calls`, `limit_exceeded:disk`, `action_timeout` |
| Abort is not honored in 10 seconds | Active state → `stopped` | Caller cancel stays `aborted`; limit failure stays `failed`; session `stopReason: "abort_timeout"` |
| API restart during a turn | `running → idle` after the container is stopped | `failed` with `server_restart`; the previous turns' conversation is kept |
| Idle sweep | `idle → stopped` | Previous terminal turn unchanged; stop reason `idle` |
| Retention sweep | `stopped` / `failed → destroyed` | Records remain; container removed |
| Destroy | Any retained state → `destroyed` after active cancellation | Active turn aborted; repeated destroy succeeds |
| Startup: incompatible saved state | Any retained state → `destroyed`, `stopReason: "format_change"` | Sessions saved by the pre-rev3 adapter cannot be restored |
| Startup/restore failure | Incomplete creation or failed recovery → `failed` | Active turn, if present, becomes `failed` |

Repeated stop on `stopped` succeeds; stop on `failed`, `destroyed`, or `creating` returns 409. Prompt cannot restart `failed` or `destroyed` sessions. TTL and retention ages both use `last_turn_at` (creation or last turn start/finish), not the time the container was stopped. A 60-second sweep means TTLs are not exact stop deadlines. Only `creating`, `idle`, `running`, and `waiting_action` sessions count toward `maxSessions`. Retained stopped/failed sessions consume disk space and are removed by the `retainSec` sweep.

## Caller Tools And Required Actions

Tool names match `^[a-z][a-z0-9_]{1,63}$`, descriptions must be nonblank, and `inputSchema` must have an object root. Names must be unique and must not collide with Pi's `read`, `write`, `edit`, `bash`, `grep`, `glob`, `find`, or `ls`. Each tool declares `gate` and optional positive integer `timeoutSec` (default 600).

The plan calls the callback contract `required_action`. The implemented polling representation is `turn.pendingActions`; there is no `turn.required_action` event envelope, webhook, or public SSE endpoint yet. Act on pending actions while the turn is `waiting_action`.

| Gate | Caller responsibility |
|---|---|
| `auto` | Execute the tool and submit its result |
| `approval` | Obtain approval before execution; on refusal submit an error such as `approval_denied: <reason>` |
| `report` | Report the proposal without executing it, then submit `output: { "reported": true }` |

Qgrid records and returns the gate; the caller enforces it. Pi's built-in tools run in the container without these gates. Registering an approval tool does not restrict Pi's `bash`, `write`, or `edit`. AI SDK's native `needsApproval` is the candidate replacement for `gate` once streaming exists (plan rev2.6 §8 Q12).

Caller tools are registered without an `execute` function in HarnessAgent. When Pi calls one, the stream ends; the runner calls `suspendTurn()` and transactionally saves the continuation envelope, pending actions, and `waiting_action` status before polling exposes them. After results are saved, it creates a fresh HarnessAgent session with `continueFrom` and calls `continueStream({ toolResultContinuations })`.

`actionResult` first saves the result, then continues when every pending action has a result. Omitted output becomes JSON null for continuation; an `error` takes precedence over output. Idempotency compares the saved `{ output, error }` structurally. The same result returns 200 without executing it again, including after delivery or turn completion; a different result returns 409 `action_result_conflict`. Lookup is limited to the latest turn: once a newer turn exists, an old call ID returns 404 `action_not_found`. A new result on a terminal turn returns 409. Persist caller-side effects and results keyed by session/turn/`toolCallId` before submitting; API result idempotency does not prevent the caller from executing an effect twice.

Unanswered actions time out on the sweep (`action_timeout`). The overall turn time limit includes time spent waiting for the caller and can expire first. Cancelling a turn that is waiting for caller tools leaves Pi's conversation with an unanswered tool call; if the next prompt finds that unfinished turn, it fails with 409 `unfinished_turn` and the caller should destroy the session and create a new one.

## Workspace And Environment Input

- `workspace.git` takes `{ url, ref, token? }`. URL must be HTTPS without embedded credentials, query, or fragment. Ref must be nonempty, contain no whitespace/control characters, and not start with `-`. The implementation runs `git clone --depth 50 -b <ref>` into `/workspace` with a 120-second timeout; use a branch or tag, not an arbitrary commit SHA. The optional token is supplied only to that exec's credential helper through `QGRID_CLONE_TOKEN`, not written into the remote URL or Git config.
- `workspace.archive` is a base64-encoded gzip tar archive uploaded into `/workspace`. Git and archive are mutually exclusive; omitted/empty workspace starts with the image's empty workspace. Gunzip is capped at 64 MiB; the API body limit also bounds the encoded input. Qgrid passes the decompressed tar to Docker `putArchive` without its own entry/path validation. Supply trusted archive contents relative to the workspace root. macOS callers must strip extended attributes (`COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata …`) or Docker rejects the archive.
- `env` maps valid environment-variable names to strings without NUL. It becomes container environment, not a host secret lookup. There is no reserved-name allowlist or denylist. Supply narrowly scoped caller credentials only when the task needs them. For example, `GH_TOKEN: "<SCOPED_GITHUB_TOKEN>"` enables Pi to use `gh pr create`; qgrid does not supply a GitHub token or create a PR itself. A caller-owned `open_pull_request` tool is an alternative.
- The runner masks known caller secret values in polling output and its log writes. This is literal-value redaction, not protection from exfiltration or transformed secrets. On restart the runner reloads caller env from Docker; clone-only tokens are not retained there. Do not rely on masking as sandbox isolation.

`sessionGet(includeDiff: true)` runs bounded `git diff --no-ext-diff --no-textconv` in `/workspace`, with a 10-second timeout and a 1 MiB UTF-8 cap. It returns tracked, unstaged changes only, not staged/untracked files or a full workspace export. It returns 409 when the workspace is unavailable/non-Git or the session is creating, stopped, failed, or destroyed.

## Request Logs And Stable Identities

One turn creates one `request_logs` parent. Each Pi model call creates one `generate` step: the runner opens it on the harness stream's `start-step` and completes it on `finish-step` with usage, duration, finish reason and the served model from `response.modelId` (recorded as `openai/<id>`). A call cut short by an abort or an error is closed with that error. Each caller or built-in tool call creates one `tool_call` step from `tool-call`, completed by `tool-result` / `tool-error`.

- Model-call keys are `call:<turnId>:<n>`, with `response:<response.id>` aliases when known. Opening a call increments `model_call_count`; on startup, unfinished generate steps are closed as `upstream_disconnected`.
- Tool keys are `tool:<toolCallId>`. `agent_turns.logged_steps` maps keys to persistent step IDs so replayed events never allocate duplicate steps.
- Built-in tool output is capped at 4 KiB in the log. Gate metadata belongs to pending actions, not request-log-step columns.
- Usage comes from the harness stream's `finish-step` usage: input tokens include cached tokens; cache-read tokens come from `inputTokenDetails.cacheReadTokens`; cache creation is recorded as zero. Costs use the pricing table and integer micro-USD. Finalization aggregates steps into the parent and turn usage; turn `failed` maps to parent `error`, while `succeeded` and `aborted` keep their names.
- `resultText` is written at every text segment end and at the turn boundary, not per delta.

## Recovery And Cancellation

The runner owns Docker lifetime; HarnessAgent is given the sandbox session and does not stop or destroy the container. Pi's conversation lives in the API process memory while a turn runs. **At every turn boundary the runner detaches the harness session and stores the returned state in `agent_sessions.lifecycle_state`**, so the conversation survives API restarts between turns (smoke S13). Caller-tool pauses store the continuation state the same way. Stopped sessions restore the saved state on the next prompt (`resumeFrom`).

Restart cases:

| Case | Implemented recovery |
|---|---|
| Restart between turns (`idle` / `stopped`) | Next prompt restores the saved conversation; nothing is lost |
| Restart while waiting for caller tools (`waiting_action`) | Pending actions stay exposed; once all results are saved the turn continues from the saved continuation |
| Restart during a model call or a built-in tool (`running`) | The turn cannot continue: it ends `failed` with `server_restart`, the container is stopped so no command outlives the turn, and the session returns to `idle`. Re-prompt to continue; the conversation up to the previous turn is intact (smoke S7/S8) |
| Saved state from the pre-rev3 adapter | Session is destroyed with `stopReason: "format_change"` at startup |

Recovery needs the original Docker daemon/container filesystem; it is not migration to another host. The saved state preserves the conversation, not an interrupted command or caller effect.

Graceful shutdown aborts in-flight turns the same way (`failed`, `server_restart`) and checkpoints idle sessions' detached state. Cancellation aborts the harness stream through its abort signal and waits for the stream task. After 10 seconds without completion, the runner stops the container and sets the session to `stopped` with `abort_timeout`. Caller cancellation yields an `aborted` turn, while limits/timeouts yield `failed`. A later prompt restarts the stopped container, but the interrupted turn is not continued.

## Token Handling

Session creation selects an eligible OpenAI token through the dispatcher and pins its ID for the session lifetime. Pi receives credentials only through qgrid's `CredentialStore`:

- `read("openai-codex")` runs on every model call. It rejects inactive or reauth-required tokens with `token_unavailable` and quota-ineligible tokens with `quota_exceeded`; the turn fails with that code. The credential's `expires` is read from the access JWT so a lagging metadata row never reports a stale expiry.
- Pi refreshes a token with less than five minutes left by calling `modify`. qgrid ignores Pi's own refresh function and refreshes through `OpenAIDispatcher.refreshCredentials` (the existing dedupe, DB write and NOTIFY path), serialized per token across all sessions, so two sessions on one token cannot invalidate each other's rotated refresh token.
- One store instance exists per token ID in the process. Pi probes every provider id at startup; only `openai-codex` is answered.

The client identity OpenAI sees is Pi/harness-pi's own headers, sent directly from the API process.

## Settings

All settings below apply on restart. Precedence is stored DB setting → corresponding environment variable → fallback. The image has an empty fallback and is required when Agents is enabled. Setting the enable env alone cannot override a stored DB `false`.

| Setting | Environment variable | Default / constraint |
|---|---|---|
| `qgrid.agents.enabled` | `QGRID_AGENTS_ENABLED` | `false` |
| `qgrid.agents.sandboxImage` | `QGRID_AGENTS_SANDBOX_IMAGE` | Empty; set `ghcr.io/cartanova-ai/qgrid-sandbox-pi:<ver>` |
| `qgrid.agents.subnet` | `QGRID_AGENTS_SUBNET` | `172.30.0.0/24` |
| `qgrid.agents.maxSessions` | `QGRID_AGENTS_MAX_SESSIONS` | `4`; positive integer, live sessions (`creating`, `idle`, `running`, `waiting_action`) |
| `qgrid.agents.idleTtlSec` | `QGRID_AGENTS_IDLE_TTL_SEC` | `1800`; positive integer seconds |
| `qgrid.agents.retainSec` | `QGRID_AGENTS_RETAIN_SEC` | `86400`; positive integer seconds |
| `qgrid.agents.maxModelCallsPerTurn` | `QGRID_AGENTS_MAX_MODEL_CALLS_PER_TURN` | `60`; positive integer |
| `qgrid.agents.maxTurnSeconds` | `QGRID_AGENTS_MAX_TURN_SECONDS` | `1200`; positive integer seconds |
| `qgrid.agents.minFreeDiskGb` | `QGRID_AGENTS_MIN_FREE_DISK_GB` | `20`; nonnegative GiB despite the key's suffix |
| `qgrid.agents.isolationCheck` | `QGRID_AGENTS_ISOLATION_CHECK` | `enforce`; choices `enforce`, `warn` |
| `qgrid.agents.isolationPorts` | `QGRID_AGENTS_ISOLATION_PORTS` | `5432,6379`; comma-separated host ports that must be unreachable, API port always added |

The former `relayPort`, `hostMode`, and `secret` settings were removed in rev3; stored DB values for them are ignored. Session creation may override only the exposed per-session TTLs. CPU (2), memory (2 GiB), PID limit (256), network name and interface name, and Pi's thinking level (`medium`) are runtime constants, not extra setting keys. Disk checks run before creation, turn start, and each model call. They inspect Docker data-root free space, falling back to `df -P /` in a sandbox when the host cannot inspect it.

## Deployment And Isolation

Pull `ghcr.io/cartanova-ai/qgrid-sandbox-pi:<ver>` on the API's Docker daemon before enabling Agents; the provider does not pull it automatically. The single image contains pinned Node 22, bash, Python 3, git, gh, rg, curl, jq, unzip, and tini, running as `node`; it contains neither Pi nor a browser (about 140 MB uncompressed). `bash` is required: harness-pi's path resolution uses bash features and the provider runs every command with `bash -c`. See `deploy/sandbox-pi/README.md`.

The API container needs `/var/run/docker.sock:/var/run/docker.sock` and a supplementary group matching that socket's host GID via `group_add`. Sandboxes do not inherit the socket or host mounts and set `Privileged: false`; the provider does not add a custom capability-drop list or `no-new-privileges` option. Docker socket access remains host-level privilege for the API process. Run one Agents owner for a retained session set; there is no cross-instance runner ownership protocol.

Sandboxes use the dedicated `qgrid-agents` bridge with interface `br-qgrid-agents` (default gateway `172.30.0.1`). A sandbox never needs to reach the host: no firewall allow rule is required, and on hosts with a default-deny INPUT policy (dev0) nothing further is needed. Do not put sandboxes on docker0.

| Environment | Isolation responsibility |
|---|---|
| dev0 | Existing ufw default deny blocks the dedicated bridge; no allow rule. Socket GID and commands are in `deploy/dev0/README.md` |
| Other Linux Docker host | Enforce sandbox-to-host restrictions in INPUT through the host firewall. DOCKER-USER/FORWARD alone does not protect host-local services |
| macOS Docker Desktop | Development-only `isolationCheck: warn` is needed (Docker Desktop's VM routing exposes host ports); use only the developer's own credentials |
| Future Kubernetes provider | Equivalent NetworkPolicy/host controls would be needed; no Kubernetes provider is implemented |

Boot starts a probe container and expects the API port and configured blocked ports to be unreachable on the bridge gateway and a distinct configured API host; the probe is removed afterward. `enforce` failure keeps Agents unavailable and records a reason; `warn` logs the failure and permits startup. The probe samples those endpoints; it neither installs firewall rules nor tests internet egress. `deploy.sh` does not verify Agents firewall rules.

Check `GET /api/qgrid/health` for `agents: { enabled, ready, reason?, sessions }`. Overall API readiness does not prove `agents.ready`. Disabled Agents returns `enabled: false, ready: false`; failed initialization leaves `enabled: true, ready: false` with a reason.

Resource footprint: Pi's conversation state lives in the API process while a turn runs (observed API RSS below 100 MB with two concurrent sessions plus the deti task). Persisted lifecycle state grows with the conversation (observed 8–20 KB for two-turn sessions, 54 KB after the deti task); an append-only `sessionStorage` table is the upgrade path if it approaches 100 KB routinely.

## Models And Deferred Work

The server's `PI_MODELS` list matches Pi's `openai-codex` catalog, not every model accepted by ordinary qgrid generation:

- `openai/gpt-6-astra`
- `openai/gpt-6-sol`
- `openai/gpt-6-luna`
- `openai/gpt-6.1-sol`
- `openai/gpt-6.1-terra`
- `openai/gpt-5.6-sol`
- `openai/gpt-5.6-terra`
- `openai/gpt-5.6-luna`

Other models are rejected with 400 `unsupported_agent_model`; there is no fallback. Anthropic and Grok have no Agents path. Browser automation, Codex/Claude Code adapter support, gVisor deployment, warm pools, and Agents dashboard work are outside this implementation. Webhook delivery, public SSE `sessionEvents`, and an Agents SDK helper are P2; operational extensions are P3 or require a separate plan. Do not infer these features from reserved columns or upstream Pi capabilities.

## Verification

From the repository, inspect smoke options without starting sessions:

```sh
mise exec -- pnpm --filter qgrid-api exec tsx scripts/agents/smoke.ts --help
```

Against a running server with Agents ready, a pulled image, and an authorized test token:

```sh
mise exec -- pnpm --filter qgrid-api exec tsx scripts/agents/smoke.ts http://localhost:44900 \
  --scenarios M1,S1,S2,S3,S6,A7 --docker
```

The script lives at `packages/api/scripts/agents/smoke.ts`; the shorter command path is relative to the filtered package. `--docker` asserts that the local Docker CLI targets the same daemon as the server. Model defaults to `openai/gpt-6-astra`; use `--model` to select another supported model. The deti fixture is `packages/api/scripts/agents/fixtures/deti-judge/`.

Omit `--scenarios` to select M1, S1–S8, S13, S10–S12, and A7. S3/S4 depend on S1; S6 audits logs from selected turns. S5/S10/S11/S12 and independent A7 grading need Docker access. S4/S7 require an operator-supplied `--restart-cmd`; S8 and S13 also require `--kill-cmd`. These commands must restart or SIGKILL the test API and return. S7/S8 expect the in-flight turn to end `failed` with `server_restart` and the re-prompt to finish the task; S13 kills the API between turns and expects the conversation to be recalled. S10 additionally needs the server's effective idle TTL set to 30 seconds and `--idle-ttl-sec 30` (the flag does not change server settings); its wait includes the 60-second sweep interval. S12 requires Linux and checks that no host port (44900/5432 on the gateway and host interfaces) is reachable while GitHub is; `--host-ip` adds another host interface to probe.

Reports go to `packages/api/scripts/agents/out/agents-smoke-*.json`. Failed assertions or cleanup failures exit nonzero. Missing prerequisites are reported as skipped, so exit zero is not proof of full acceptance: require `complete: true` for the entire suite. A partial run reports its selected scenarios separately.

For documentation changes, run `mise run qgrid-docs:sync` followed by `mise run qgrid-docs:check`. These validate the skill mirror and mapped paths, not live sandbox behavior.
