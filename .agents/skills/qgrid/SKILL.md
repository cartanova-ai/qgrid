---
name: qgrid
description: Work on the qgrid repository, an LLM subscription-token proxy with direct OpenAI private-backend HTTPS/SSE transport, Anthropic Claude Code fresh-spawn runtime, AI SDK provider compatibility, Sonamu API/web generation, weighted token routing, prompt-cache behavior, request logging, quota thresholds, and dashboard flows. Use when implementing, debugging, reviewing, or planning qgrid code, docs, migrations, provider integrations, CLI/runtime behavior, request logs, or SDK behavior.
---

# Qgrid

## Command Scope

Run the repository-specific `mise` commands in this skill only from the qgrid source
repository. In a downstream project, use that project's configured task and tool runner.

## Start Here

Use this skill for qgrid repository work. Treat qgrid as a runtime-contract-heavy system: model input travels through the active AI SDK provider, Sonamu API, provider dispatcher, provider-specific runtime, response mapping, request logging, and dashboard display.

Before changing code, identify the affected path:

- Public AI SDK provider: read `references/ai-sdk-provider-contract.md`.
- CLI startup, env vars, server boot, OAuth callback URL: read `references/cli-env-and-server-boot.md`.
- OpenAI direct transport, permits, routing, cache affinity, OAuth, or quota behavior: read `references/openai-codex-runtime.md`.
- Adding an OpenAI model, its pricing, or reasoning levels: follow the model-addition checklist in `references/openai-codex-runtime.md`.
- Anthropic models or Claude Code spawn/stream-json behavior: read `references/anthropic-claude-code-runtime.md`.
- Grok fingerprinting, OAuth, quota routing, media, voice, or retry behavior: read `references/grok-runtime.md`.
- Token registration, OAuth, token sync, active/inactive behavior, quota thresholds, or weighted token routing: read `references/token-auth-quota-lifecycle.md`.
- Provider comparisons, routing, or cross-provider bugs: read `references/provider-runtime-differences.md`.
- Tool calling, AI SDK multi-step loops, or tool-call request logs: read `references/tool-calling-and-multiturn.md`.
- `sessionKey`, opaque affinity coordinates, prompt cache metrics, usage accounting, or cost: read `references/prompt-cache-and-usage.md`.
- Design rationale, prior decisions, or "why is this feature shaped this way?": read `references/decision-rationale.md`.
- Dashboard changes: read `references/sonamu-api-web-flow.md`.
- Request log lifecycle, tool-call steps, telemetry/logger behavior: read `references/request-log-run-lifecycle.md`.
- Choosing tests, smoke scripts, or debugging common runtime errors: read `references/verification-and-debugging.md`.
- Project planning/review/documentation workflow: read `references/docs-workflow.md`.
- Repository orientation: read `references/repo-map.md`.

## Setup Guardrails

When helping a user set up local `@cartanova/qgrid-ai-sdk`, `createQgridLogger`, or qgrid CLI-backed workflows, ensure request-log project naming is configured. Check for `QGRID_PROJECT_NAME` in the calling app/runtime environment or `projectName` in qgrid provider/logger config. If neither is present, ask the user for a stable project/workflow name or add the obvious repository/app name when the surrounding setup convention makes that appropriate.

Prefer `QGRID_PROJECT_NAME` as the project-wide default. Use config `projectName` only for a deliberate per-call/per-provider override. Do not add `projectName` or `project_name` under `providerOptions.qgrid`; current code does not read it there.

When writing AI SDK examples or setup code, use `satisfies QgridProviderOptions` for language-model options or `satisfies QgridImageProviderOptions` for image-model options under `providerOptions.qgrid`. AI SDK types the outer `providerOptions` as a generic JSON record, so it cannot infer qgrid's option names and values by itself. These types describe the inner qgrid namespace, not the outer record.

Request logging is enabled by default. Use `providerOptions.qgrid.logger: false` only for a call that must create zero qgrid request-log rows. The same option suppresses both qgrid's server-native logging and `createQgridLogger` telemetry logging for that generation; it does not disable generation, AI SDK tool execution, multi-step continuation, or OpenAI cache affinity. The old `logMode` input has been removed and must not appear in setup code or raw qgrid payloads.

## Non-Negotiable Boundaries

- Use `packages/ai-sdk` as the active public SDK surface. `qgrid()` implements `LanguageModelV3` for text, tools, and structured output; it has no public image-generation options and does not support general vision. `qgrid.image("openai/gpt-image-2")` implements `ImageModelV3` for standard AI SDK `generateImage`, directly calling subscription Images for generation or reference editing without a chat driver. Dashboard chat registers its image tool internally; do not add a public SDK tool factory. See `references/ai-sdk-provider-contract.md` for image options, usage, and metadata.
- Expose thinking only as `providerOptions.qgrid.thinking?: boolean`: omission preserves the model policy, false overrides effort, and unsupported/unverified off requests fail explicitly. See the SDK and provider runtime references for the dated support snapshot. Keep Anthropic thinking controls separate from mandatory configuration and memory isolation. Haiku/Sonnet 5.5 off uses a computed thinking-only native body override with Claude Code >=2.1.295; never inherit or expose arbitrary extra body.
- The old v1 SDK package (`packages/sdk`, `@cartanova/qgrid-sdk`) has been removed from the repository. It survives only as a deprecated npm artifact (1.9.0); do not resurrect it or write new code against it.
- Let the server infer single-turn versus tool-run request-log lifecycle. Do not recreate caller-selected logging modes in the SDK or API examples.
- Route provider models by prefix: `openai/*` goes to the OpenAI Codex runtime, `anthropic/*` goes to the Anthropic Claude Code runtime. Prefix-less model fallback is not implemented.
- Treat Fable (5 and 5.1) safety fallback as upstream Claude Code behavior, not qgrid routing: a classifier refusal can retry on Opus 5 or Opus 4.8 depending on refusal category. Do not add a second qgrid retry. Preserve requested Fable versus actual serving Opus, fallback history, and provider-reported cost; a fresh Claude Code process means the fallback is not sticky across qgrid requests.
- Treat dashboard work as Sonamu API/model/generated-client/web work, not isolated frontend work.
- Prefer `getPuri()` for Sonamu model queries. Treat `getDB()` as a legacy escape hatch only when Puri cannot express the required query. Inside `@transactional` methods, all participating queries must use `getPuri()`; `getDB()` does not reuse Sonamu's ambient transaction connection.
- Never hand-author migration files for Sonamu-managed schema. In the qgrid source repository, change the entity definition, inspect `sonamu migrate status`, and create migration files with `mise exec -- pnpm --dir packages/api sonamu migrate generate`. Inspect the generated files before applying them. If Sonamu cannot express a required schema change, stop and ask rather than silently replacing its workflow with a custom migration.
- Keep OpenAI Codex built-in tools, apps, plugins, skills, web search, shell, and environment instruction blocks disabled unless the user explicitly asks for agentic Codex behavior.
- Treat OpenAI image generation as opt-in outside dashboard chat. OpenAI `qgrid_chat` opts into raw API `imageGeneration: "auto"` on every turn. Auto mode registers only the server-executed `generate_image` function and calls Codex standalone Images for ordinary or transparent output. The raw explicit chat-model `imageGeneration: true` hosted route remains supported separately. The public SDK uses only `qgrid.image()` / `generateImage` for images, calling standalone Images for every background. Do not expose the raw `imageGeneration` or `imageGenerationOptions` fields as language-model options or retain deprecated shims. Do not reintroduce a client decision tool followed by another GPT generation request. Image costs use reported image usage at public token rates when available; otherwise estimate per image from the requested quality/size table. Auto or unsupported sizes use the 1536x1024 price; omitted quality uses medium. Display combined driver and image costs as dollar amounts without Cost labels. Do not show Known/Estimated labels, pricing disclaimers, or cost-source metadata in the dashboard.

## Request log IDs (2.10.0+)

- Successful raw query responses and stream `done` events expose optional top-level `requestLogId`. AI SDK text calls expose it as `providerMetadata.qgrid.requestLogId`; await stream metadata after consuming the stream. `generateImage` exposes each call's ID under `providerMetadata.qgrid.images[]` alongside generation metadata.
- The ID identifies the parent request log and stays the same across tool-run steps. It is omitted with `logger: false`. Keep `runContext.requestLogId` for tool continuation only; do not replay the top-level ID as continuation state.
- Update both server and AI SDK to 2.10.0 or later to consume the metadata. Older servers may omit the ID. This contract does not add IDs to delta or error events or change `createQgridLogger` for external providers.

## Automatic chat images (2.9.8+)

- Raw `imageGeneration: "auto"` permits text-only replies; explicit `true` still requires an image. Both use non-stream requests. Auto mode rejects caller tools and output schemas.
- Dashboard chat sends complete text and image history, including prior generated images as user visual references. Do not assume provider conversation state retains image bytes or send assistant `input_image` blocks.
- Register only `generate_image` for auto mode, with server-validated arguments `prompt: string`, `transparent_background: boolean`, and `num_last_images_to_include: integer` from 0 to 5. Use `strict: false` on the wire, matching Codex; Astra subscription requests fail with `strict: true`. Keep complete server-side validation. The driver sees the complete conversation and writes a self-contained image prompt. Zero references means fresh generation; a positive count selects the last N conversation images in chronological order for editing. Do not forward all historical images automatically.
- Run the function directly against subscription Images with the selected token and cancellation signal, without a second text-driver request. Preserve driver usage separately from image usage. Do not register the native hosted `image_generation` tool in auto mode.
- Request-log model labels show requested model to image model using serving/image-cost metadata. Do not hardcode `gpt-image-2.5` or restore image-generation/assumption badges. In auto mode, mark image generation only when an image was produced.
- Read `references/decision-rationale.md` and `references/openai-codex-runtime.md` before changing this routing or its cache boundary.

## Image output formats (2.9.6+)

- Raw explicit chat-model hosted Responses requests support `imageGenerationOptions.outputFormat: "png" | "jpeg" | "webp"`. Omission retains PNG. Auto chat and public `generateImage` use standalone Images and support PNG only; reject other formats before generation. Public image options use flat `QgridImageProviderOptions`.
- Preserve the actual returned MIME type in qgrid content, AI SDK files, and request-log image URLs; do not relabel bytes as the requested format.
- Transparent generation uses the standalone Codex Images route and accepts PNG only. Reject transparent JPEG/WebP requests before generation. Do not convert output or fall back to another route.
- Keep the AI SDK standard `GeneratedFile.mediaType: string` contract. Do not add a qgrid-specific image wrapper or conditional return type.
- A 2026-09-29 hosted-route probe returned PNG for a prompt-only WebP request and WebP when `outputFormat: "webp"` was supplied. Model prose is not format evidence; inspect file bytes. Chat does not infer output format from prose, and no post-generation conversion is performed.

## Verification

Choose verification by blast radius:

- In the qgrid source repository, run type/lint/format with `mise run check`.
- Package tests: use the relevant package test command or targeted Vitest files.
- Provider runtime changes: run targeted tests for `packages/api/src/utils/providers/**` and, when practical, the relevant smoke script in `scripts/` or `packages/api/scripts/`.
- AI SDK changes: run `packages/ai-sdk` tests and inspect generated request payload behavior.
- Sonamu API/model changes: check generated files and both API and web consumers.

Do not rely on one provider's behavior to infer the other provider's behavior. OpenAI direct transport and Anthropic/Claude Code have different execution lifecycles, cache behavior, usage accounting, and structured-output paths.
