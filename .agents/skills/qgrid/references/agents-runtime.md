# Agents Runtime

Use this reference for qgrid-hosted Pi sessions, caller tools, recovery, and sandbox deployment. The implemented surface is the polling session API. Read `application/agent/agent.frame.ts`, `agent.types.ts`, and `utils/agents/*` under `packages/api/src` before changing its contracts.

## Purpose And Boundaries

Qgrid runs Pi inside a Docker container on behalf of a caller. The caller supplies instructions, workspace input, tool definitions, and prompts; qgrid owns the session and turn records. Pi can read and change files, run commands, install packages, and use caller tools.

Subscription credentials stay outside the container. The Pi adapter supplies a deterministic `aisdkhc_` placeholder, and the relay resolves placeholder → session key → pinned token ID → current credentials for each model call. The placeholder still authorizes subscription usage during an active turn; it is not a harmless dummy value. Only the API host gets the Docker socket. Caller-supplied `env` secrets are a separate boundary: those values deliberately enter the sandbox.

This is separate from the ordinary `qgrid()` language-model path. Pi performs native tool calls; the ordinary provider's structured-output tool emulation does not govern Agents. The Agents API uses the existing deployment authentication boundary; it adds no independent caller authentication.

## Components

| Component | Source | Responsibility |
|---|---|---|
| Docker provider | `utils/agents/docker-sandbox.ts` | Docker Engine access through dockerode, dedicated network, one container per session, exec/files/archive/port contracts, stop/resume/destroy, labeled orphan cleanup |
| Relay | `utils/agents/relay.ts` | Separate `node:http` servers in the API process; validates session-bound calls, injects credentials, forwards private Codex HTTPS/SSE, reports model-call attempts |
| Pi adapter | `utils/agents/pi-harness.ts` | `createSandboxPi()`, HarnessV1 lifecycle envelopes, deterministic secrets, bridge connection/replay, metadata sequence numbers |
| Bridge | `deploy/sandbox-pi/bridge/bridge.mjs` | Pi 1.5.0 SDK and file-backed SessionManager, built-in tools, caller-tool result waits, bridge events and disk replay |
| Runner | `utils/agents/session-runner.ts` | Token selection, turns, continuation, limits, request logs, recovery, container ownership and 60-second sweep |
| Runtime | `utils/agents/runtime.ts` | Settings, relay startup, isolation probe, runner startup/shutdown, `health().agents` |
| API and persistence | `application/agent/*` | Six polling endpoints; AgentSession and AgentTurn entities with transactional state changes |

AgentSession stores the model, pinned token ID/name, instructions, tools, container coordinates, TTLs, and complete lifecycle envelope. AgentTurn stores its zero-based session index, prompt, status, parent request-log ID, pending actions/results/delivery markers, logged-step identities, bridge cursor, usage, and output. Reserved webhook columns do not implement webhook delivery.

The adapter and bridge identify as `qgrid-pi` with `harness-v1`. Bridge port is 8787; its published host port is assigned on loopback. `BRIDGE_CHANNEL_TOKEN` authenticates the connection. Adapter state contains `{ bridge: { port, lastSeenEventId }, piSession, model, instructionsHash }`; persist the framework's entire envelope, including `pendingToolResults` and `turnSettings`, not just this data. Instructions use Pi's `appendSystemPrompt`; workspace `AGENTS.md` is not overwritten. `responseFormat`, manual compaction, built-in tool approval/filtering, and permission modes other than `allow-all` are unsupported.

## Polling Session API

All paths start with `/api/agent/`. POST bodies use Sonamu's `{ "params": { ... } }` wrapper. GET uses nested query parameters, for example `sessionGet?params[sessionId]=SESSION_ID&params[includeDiff]=true` (URL-encode brackets in clients). Successful calls return HTTP 200, including creation and asynchronous prompt acceptance.

| Method / suffix | Input inside `params` | Output |
|---|---|---|
| POST `sessionCreate` | Required `model`, `instructions` (string, may be empty), `tools` (array, may be empty); optional `projectName`, `workspace`, `env`, positive integer `idleTtlSec` / `retainSec`, `imageProfile: "default"` | `{ sessionId, status, readyMs }`, normally `idle`; waits for sandbox and bridge readiness, does not start a turn |
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
| 409 | `session_busy`, `invalid_state`, `action_result_conflict`, `workspace_diff_unavailable` |
| 429 | `limit_exceeded:max_sessions`, `limit_exceeded:disk` |
| 503 | `agents_unavailable`, `agents_shutting_down`, `token_unavailable`, `quota_exceeded`; shared handler adds `Retry-After: 30` |
| 500 | `agent_operation_failed` for unexpected operation failures; raw Docker/Git errors are not returned |

Errors use the shared server error response with a machine-readable `message`. Turn failures after prompt acceptance are polled from `turn.status` and `errorMessage`, not retroactively returned as HTTP errors. Creation failures after the DB insert leave a `failed` session row while removing the container. The public API has no session-list endpoint.

### State Transitions

Session and turn statuses are distinct. A failed turn normally leaves a reusable `idle` session.

| Trigger | Session transition | Turn transition / result |
|---|---|---|
| Create succeeds / fails | `creating → idle` / `failed` | No turn |
| Prompt | `idle → running`; `stopped → idle → running` after attach | New `running` turn and parent request log |
| Prompt while busy | `running` / `waiting_action` unchanged | HTTP 409 `session_busy`; no extra turn or log |
| Caller tool boundary committed | `running → waiting_action` | `running → waiting_action` |
| All caller results saved | `waiting_action → running` | Same turn resumes as `running` |
| Normal completion / execution error | `running → idle` | `succeeded` / `failed` |
| Caller stop | Active state → `idle → stopped`; `idle → stopped` directly | Active turn becomes `aborted` (`cancelled`); stop reason `caller` |
| Limit or action timeout | Active state → `idle`, unless abort times out | `failed`, e.g. `limit_exceeded:time`, `limit_exceeded:model_calls`, `limit_exceeded:disk`, `action_timeout` |
| Abort is not acknowledged in 10 seconds | Active state → `stopped` | Caller cancel stays `aborted`; limit failure stays `failed`; session `stopReason: "abort_timeout"` |
| Idle sweep | `idle → stopped` | Previous terminal turn unchanged; stop reason `idle` |
| Retention sweep | `stopped` / `failed → destroyed` | Records remain; container removed |
| Destroy | Any retained state → `destroyed` after active cancellation | Active turn aborted; repeated destroy succeeds |
| Startup/reattach failure | Incomplete creation or failed recovery → `failed` | Active turn, if present, becomes `failed` |

Repeated stop on `stopped` succeeds; stop on `failed`, `destroyed`, or `creating` returns 409. Prompt cannot restart `failed` or `destroyed` sessions. TTL and retention ages both use `last_turn_at` (creation or last turn start/finish), not the time the container was stopped. A 60-second sweep means TTLs are not exact stop deadlines. Retained stopped/failed sessions count toward `maxSessions` until destroyed.

## Caller Tools And Required Actions

Tool names match `^[a-z][a-z0-9_]{1,63}$`, descriptions must be nonblank, and `inputSchema` must have an object root. Names must be unique and must not collide with Pi's `read`, `write`, `edit`, `bash`, `grep`, `find`, or `ls`. Each tool declares `gate` and optional positive integer `timeoutSec` (default 600).

The plan calls the callback contract `required_action`. The implemented polling representation is `turn.pendingActions`; there is no `turn.required_action` event envelope, webhook, or public SSE endpoint yet. Act on pending actions while the turn is `waiting_action`.

| Gate | Caller responsibility |
|---|---|
| `auto` | Execute the tool and submit its result |
| `approval` | Obtain approval before execution; on refusal submit an error such as `approval_denied: <reason>` |
| `report` | Report the proposal without executing it, then submit `output: { "reported": true }` |

Qgrid records and returns the gate; the caller enforces it. Pi's built-in tools run in the container without these gates. Registering an approval tool does not restrict Pi's `bash`, `write`, or `edit`.

Caller tools are registered without an `execute` function in HarnessAgent. The bridge emits a `finish-step` with unified `tool-calls` and raw `host-input` before waiting for the result. The runner calls `suspendTurn()` and transactionally saves the complete envelope, pending actions, cursor, and `waiting_action` status before polling exposes them. After results are saved, it reconstructs the session with `continueFrom` and calls `continueStream({ toolResultContinuations })`.

`actionResult` first saves the result, then continues when every pending action has a result. Omitted output becomes JSON null for continuation; an `error` takes precedence over output. Idempotency compares the saved `{ output, error }` structurally. The same result returns 200 without executing it again, including after delivery or turn completion; a different result returns 409 `action_result_conflict`. Lookup is limited to the latest turn: once a newer turn exists, an old call ID returns 404 `action_not_found`. A new result on a terminal turn returns 409. Persist caller-side effects and results keyed by session/turn/`toolCallId` before submitting; API result idempotency does not prevent the caller from executing an effect twice.

Unanswered actions time out on the sweep (`action_timeout`). The overall turn time limit includes time spent waiting for the caller and can expire first.

## Workspace And Environment Input

- `workspace.git` takes `{ url, ref, token? }`. URL must be HTTPS without embedded credentials, query, or fragment. Ref must be nonempty, contain no whitespace/control characters, and not start with `-`. The implementation runs `git clone --depth 50 -b <ref>` into `/workspace` with a 120-second timeout; use a branch or tag, not an arbitrary commit SHA. The optional token is supplied only to that exec's credential helper through `QGRID_CLONE_TOKEN`, not written into the remote URL or Git config.
- `workspace.archive` is a base64-encoded gzip tar archive uploaded into `/workspace`. Git and archive are mutually exclusive; omitted/empty workspace starts with the image's empty workspace. Gunzip is capped at 64 MiB; the API body limit also bounds the encoded input. Qgrid passes the decompressed tar to Docker `putArchive` without its own entry/path validation. Supply trusted archive contents relative to the workspace root.
- `env` maps valid environment-variable names to strings without NUL. It becomes container environment, not a host secret lookup. There is no reserved-name allowlist or denylist; the adapter separately supplies its bridge/relay credential environment when spawning the bridge. Supply narrowly scoped caller credentials only when the task needs them. For example, `GH_TOKEN: "<SCOPED_GITHUB_TOKEN>"` enables Pi to use `gh pr create`; qgrid does not supply a GitHub token or create a PR itself. A caller-owned `open_pull_request` tool is an alternative.
- The runner masks known caller secret values in polling output and its log writes. This is literal-value redaction, not protection from exfiltration or transformed secrets. `actionResult` persists the submitted result intact and immediately writes it to the tool log without that redactor; a later bridge acknowledgement updates the log through the redacted path. Do not include secrets in submitted results. On restart the runner reloads caller env from Docker; clone-only tokens are not retained there. Do not rely on masking as sandbox isolation.

`sessionGet(includeDiff: true)` runs bounded `git diff --no-ext-diff --no-textconv` in `/workspace`, with a 10-second timeout and a 1 MiB UTF-8 cap. It returns tracked, unstaged changes only, not staged/untracked files or a full workspace export. It returns 409 when the workspace is unavailable/non-Git or the session is creating, stopped, failed, or destroyed.

## Request Logs And Stable Identities

One turn creates one `request_logs` parent. Each accepted relay model-call attempt creates one `generate` step, including failed/disconnected/aborted attempts; each caller or built-in tool call creates one `tool_call` step. A preflight rejection does not create a model step. The relay's single 401 refresh retry is inside the same recorded call attempt.

- Model-call keys are `relay:<callId>`, with `response:<upstream response.id>` aliases when known. Start increments `model_call_count`; end updates that step with usage, timing, actual model, and error. On startup, unfinished generate steps are closed as `upstream_disconnected`.
- Tool keys are `tool:<toolCallId>`; bridge events carry `providerMetadata.qgrid.seq` (also harness metadata). `agent_turns.logged_steps` maps these keys and `seq:<n>` aliases to persistent step IDs. Step append and cursor advance share a transaction; replay does not allocate a fresh local counter as identity.
- At a caller-tool boundary, cursor advancement is deferred until the atomic suspension checkpoint. Result delivery is marked on the bridge's tool-result acknowledgement, so saved but undelivered results can be replayed after host loss.
- Results update the existing tool step; built-in tool output is capped at 4 KiB. Gate metadata belongs to pending actions, not request-log-step columns.
- Usage comes from relay Responses SSE usage. Unobserved usage stays null; observed zero stays zero. OpenAI cached tokens are included in input tokens; cache creation is zero when usage is present. Costs use the pricing table and integer micro-USD. Finalization aggregates steps into the parent and turn usage; turn `failed` maps to parent `error`, while `succeeded` and `aborted` keep their names.

## Recovery And Cancellation

The runner owns Docker lifetime. Passing its sandbox session to HarnessAgent leaves `ownsSandboxLifecycle=false`; detaching the harness does not stop the container. Graceful shutdown suspends an unfinished turn or detaches a completed session and checkpoints state. Stopped sessions resume their existing container and Pi files on the next prompt.

Bridge token, session key, and placeholder derive from HMAC-SHA256 over the stable secret, session ID, and purpose. Keep `QGRID_AGENTS_SECRET` unchanged while sessions are retained. On host restart, qgrid rebuilds continuation coordinates and resumes from `last_logged_event_seq`. `waiting_action` sessions re-expose stored pending actions without reconnecting first; all-saved results trigger continuation. A `running` session reconnects and resubmits saved results without `deliveredAt`.

Host-loss cases:

| Case | Implemented recovery |
|---|---|
| (a) Bridge survives while executing a tool or between model calls | Reconnect and replay after the DB cursor; continue the same turn if the bridge still has it |
| (b) Host dies while relaying model SSE | Relay loss interrupts that call; startup closes its unfinished generate step as `upstream_disconnected`. Qgrid does not replay the HTTP request or configure Pi's retry policy. A Pi error becomes a failed turn when replayed. If the session returns to `idle`, submit a new prompt to continue from Pi's saved conversation |
| (c) Container/bridge process dies | Completed disk event logs can replay. An unfinished process-local turn cannot be reconstructed; it fails. If attach succeeds and the failure is consumed normally, the session returns to `idle` for a new prompt. If attach/startup recovery itself fails, the session becomes `failed` and the public API cannot resume it; destroy and create a new session |

Recovery needs the original Docker daemon/container filesystem and the same secret; it is not migration to another host. `resumeFrom` preserves saved conversation, not an interrupted command or caller effect.

Cancellation sends bridge abort and aborts active relay upstreams. It waits for both the stream task and explicit `finish(raw: "aborted")`. After 10 seconds without that acknowledgement, the runner stops the container and sets the session to `stopped` with `abort_timeout`; an attach needed for cancellation has its own 10-second timeout. Caller cancellation yields an `aborted` turn, while limits/timeouts yield `failed`. A later prompt can restart the stopped container, but the interrupted turn is not continued.

## Settings

All settings below apply on restart. Precedence is stored DB setting → corresponding environment variable → fallback. The image and HMAC secret have empty fallbacks and are required when Agents is enabled. Setting the enable env alone cannot override a stored DB `false`.

| Setting | Environment variable | Default / constraint |
|---|---|---|
| `qgrid.agents.enabled` | `QGRID_AGENTS_ENABLED` | `false` |
| `qgrid.agents.sandboxImage` | `QGRID_AGENTS_SANDBOX_IMAGE` | Empty; set `ghcr.io/cartanova-ai/qgrid-sandbox-pi:<ver>` |
| `qgrid.agents.subnet` | `QGRID_AGENTS_SUBNET` | `172.30.0.0/24` |
| `qgrid.agents.hostMode` | `QGRID_AGENTS_HOST_MODE` | `auto`; choices `auto`, `linux`, `desktop` |
| `qgrid.agents.relayPort` | `QGRID_AGENTS_RELAY_PORT` | `44901`; integer 1–65535 |
| `qgrid.agents.maxSessions` | `QGRID_AGENTS_MAX_SESSIONS` | `4`; positive integer, all nondestroyed sessions |
| `qgrid.agents.idleTtlSec` | `QGRID_AGENTS_IDLE_TTL_SEC` | `1800`; positive integer seconds |
| `qgrid.agents.retainSec` | `QGRID_AGENTS_RETAIN_SEC` | `86400`; positive integer seconds |
| `qgrid.agents.maxModelCallsPerTurn` | `QGRID_AGENTS_MAX_MODEL_CALLS_PER_TURN` | `60`; positive integer |
| `qgrid.agents.maxTurnSeconds` | `QGRID_AGENTS_MAX_TURN_SECONDS` | `1200`; positive integer seconds |
| `qgrid.agents.minFreeDiskGb` | `QGRID_AGENTS_MIN_FREE_DISK_GB` | `20`; nonnegative GiB despite the key's suffix |
| `qgrid.agents.isolationCheck` | `QGRID_AGENTS_ISOLATION_CHECK` | `enforce`; choices `enforce`, `warn` |
| `qgrid.agents.isolationPorts` | `QGRID_AGENTS_ISOLATION_PORTS` | `5432,6379`; comma-separated ports, API port always added |
| `qgrid.agents.secret` | `QGRID_AGENTS_SECRET` | Empty; stable nonempty HMAC secret |

Session creation may override only the exposed per-session TTLs. CPU (2), memory (2 GiB), PID limit (256), network name, and bridge interface name are runtime constants, not extra setting keys. Disk checks run before creation, turn start, and accepted model calls. They inspect Docker data-root free space, falling back to `df -P /` in a sandbox when the host cannot inspect it.

## Deployment And Isolation

Pull `ghcr.io/cartanova-ai/qgrid-sandbox-pi:<ver>` on the API's Docker daemon before enabling Agents; the provider does not pull it automatically. The single image contains pinned Node 22, Pi 1.5.0, bridge, Python 3, git, gh, rg, curl, jq, unzip, and tini, running as `node`. It has no browser. See `deploy/sandbox-pi/README.md` for build and container checks.

The API container needs `/var/run/docker.sock:/var/run/docker.sock` and a supplementary group matching that socket's host GID via `group_add`. Sandboxes do not inherit the socket or host mounts and set `Privileged: false`; the provider does not add a custom capability-drop list or `no-new-privileges` option. Docker socket access remains host-level privilege for the API process. Run one Agents owner for a retained session set; there is no cross-instance runner ownership protocol.

Sandboxes use the dedicated `qgrid-agents` bridge with interface `br-qgrid-agents`. Linux host mode maps `host.docker.internal` explicitly to that network's gateway (default `172.30.0.1`), and binds relay port 44901 on the gateway and `127.0.0.1`. Do not use `host-gateway` for this Linux layout: it can resolve to docker0 instead. Do not put sandboxes on docker0.

`hostMode: auto` selects Linux behavior by the API process platform; otherwise it selects Desktop behavior. Desktop uses `host-gateway` and a loopback relay listener. Explicit mode changes affect address selection; relay source-IP enforcement still follows `process.platform === "linux"`, not `hostMode`.

| Environment | Isolation responsibility |
|---|---|
| dev0 | Existing ufw default deny blocks the dedicated bridge; allow only the relay destination/port. Exact socket GID and commands are in `deploy/dev0/README.md` |
| Other Linux Docker host | Enforce sandbox-to-host restrictions in INPUT through the host firewall, permitting relay first. DOCKER-USER/FORWARD alone does not protect host-local services |
| macOS Docker Desktop | Development-only `isolationCheck: warn` may be needed; it does not establish host-service isolation. Use only the developer's own credentials |
| Future Kubernetes provider | Equivalent NetworkPolicy/host controls would be needed; no Kubernetes provider is implemented |

Boot starts a probe container and tests TCP reachability to the relay, then expects API and configured blocked ports to be unreachable on `host.docker.internal`, the gateway, and a distinct configured API host. The probe is removed afterward. `enforce` failure keeps Agents unavailable and records a reason; `warn` logs the failure and permits startup. The probe samples those endpoints; it neither installs firewall rules nor tests internet egress. `deploy.sh` currently does not verify Agents firewall rules.

Check `GET /api/qgrid/health` for `agents: { enabled, ready, reason?, sessions }`. Overall API readiness does not prove `agents.ready`. Disabled Agents returns `enabled: false, ready: false`; failed initialization leaves `enabled: true, ready: false` with a reason.

Relay accepts only normalized `/backend-api/codex/` paths, disallows redirects, and checks placeholder, session, Linux source IP, active turn, call/time limits, token eligibility, and exact session model. It passes Pi identity headers through while replacing authorization/account headers. It caps compressed bodies at 8 MiB and decompressed bodies at 32 MiB, accepts Pi zstd input, and uses 30-second receive timeouts. It is not a general API proxy. Git/package internet egress remains available; host-service isolation is a separate requirement.

## Models And Deferred Work

The server's `PI_MODELS` list matches the pinned Pi catalog, not every model accepted by ordinary qgrid generation:

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

Omit `--scenarios` to select M1, S1–S12, and A7. S3/S4 depend on S1; S6 audits logs from selected turns. S5/S9/S10/S11/S12 and independent A7 grading need Docker access. S4/S7 require an operator-supplied `--restart-cmd`; S8 also requires `--kill-cmd`. These commands must restart or SIGKILL the test API and return. S10 additionally needs the server's effective idle TTL set to 30 seconds and `--idle-ttl-sec 30` (the flag does not change server settings); its wait includes the 60-second sweep interval. S12 requires Linux and checks host blocking plus GitHub reachability; `--host-ip` adds another host interface to probe. S12 currently hardcodes blocked ports 44900/5432 and relay port 44901; `--relay-port` does not change those S12 probes.

Reports go to `packages/api/scripts/agents/out/agents-smoke-*.json`. Failed assertions or cleanup failures exit nonzero. Missing prerequisites are reported as skipped, so exit zero is not proof of full acceptance: require `complete: true` for the entire suite. A partial run reports its selected scenarios separately.

For documentation changes, run `mise run qgrid-docs:sync` followed by `mise run qgrid-docs:check`. These validate the skill mirror and mapped paths, not live sandbox behavior.
