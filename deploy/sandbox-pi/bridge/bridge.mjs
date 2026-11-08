import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Pi coding agent inside the sandbox, speaking the @ai-sdk/harness bridge protocol.
// Model calls go to the qgrid relay (OPENAI_BASE_URL) with the placeholder credential wrapped in a
// fake JWT (pi's codex client parses a chatgpt_account_id claim; the relay re-maps and overrides it).
import { runBridge } from "@ai-sdk/harness/bridge";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const argv = process.argv.slice(2);

const arg = (name) => {
  const i = argv.indexOf(name);

  return i >= 0 ? argv[i + 1] : undefined;
};

const workdir = arg("--workdir");
const bridgeStateDir = arg("--bridge-state-dir");
const RELAY_BASE = process.env.OPENAI_BASE_URL;
const PLACEHOLDER = process.env.CODEX_API_KEY;

if (!workdir || !bridgeStateDir || !RELAY_BASE || !PLACEHOLDER || !process.env.BRIDGE_CHANNEL_TOKEN)
  throw new Error(
    "pi-bridge: missing --workdir/--bridge-state-dir/OPENAI_BASE_URL/CODEX_API_KEY/BRIDGE_CHANNEL_TOKEN",
  );

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const FAKE_JWT = `${b64({ alg: "none", typ: "JWT" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "sandbox-placeholder" } })}.${PLACEHOLDER}`;
const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

let runtime;
let session;
let sessionSig = "";
let currentTranslator;
let sessionId;
const hostToolNames = new Set();
const hostResults = new Map();
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const promptSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() })).transform((parts) =>
    parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  ),
]);

function outputText(output) {
  // Host tool results are JSON values; strings are already display text, other values need JSON encoding.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

async function ensureSession(start) {
  const sessionIdPath = path.join(bridgeStateDir, "pi-session-id");

  const requestedSessionId = sessionIdSchema.parse(
    start.sessionId ??
      start.resume ??
      sessionId ??
      (fs.existsSync(sessionIdPath) ? fs.readFileSync(sessionIdPath, "utf8") : randomUUID()),
  );

  const sig = JSON.stringify([
    requestedSessionId,
    start.tools ?? [],
    start.model,
    start.reasoningEffort,
    start.instructions,
  ]);

  if (session && sig === sessionSig) return session;
  session?.dispose();
  session = undefined;
  sessionSig = "";

  if (!runtime) {
    runtime = await ModelRuntime.create({
      authPath: path.join(bridgeStateDir, "pi-auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("openai-codex", { baseUrl: RELAY_BASE, apiKey: FAKE_JWT });
    await runtime.setRuntimeApiKey("openai-codex", FAKE_JWT);
    await runtime.refresh({ allowNetwork: false });
  }

  const modelId = start.model?.replace(/^openai\//, "");
  const model = runtime.getModel("openai-codex", modelId);

  if (!model) throw new Error(`pi-bridge: model '${start.model}' not in pi openai-codex catalog`);
  fs.mkdirSync(workdir, { recursive: true });
  sessionId = requestedSessionId;
  fs.writeFileSync(sessionIdPath, sessionId);
  hostToolNames.clear();

  const customTools = (start.tools ?? []).map((t) => {
    hostToolNames.add(t.name);

    return defineTool({
      name: t.name,
      label: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
      executionMode: "parallel",
      execute: async (toolCallId) => {
        const r = await currentTranslator.requestHostResult(toolCallId);
        hostResults.set(toolCallId, r.output ?? null);
        const text = outputText(r.output);

        if (r.isError) throw new Error(text);

        return { content: [{ type: "text", text }], details: r.output };
      },
    });
  });

  const agentDir = path.join(bridgeStateDir, "pi-agent");
  const settingsManager = SettingsManager.inMemory({});

  const resourceLoader = new DefaultResourceLoader({
    cwd: workdir,
    agentDir,
    settingsManager,
    appendSystemPrompt: start.instructions ? [start.instructions] : undefined,
  });

  await resourceLoader.reload();
  const sessionDir = path.join(homedir(), ".pi-session");

  const created = await createAgentSession({
    cwd: workdir,
    modelRuntime: runtime,
    model,
    thinkingLevel: EFFORT[start.reasoningEffort] ?? "low",
    sessionManager: SessionManager.open(
      path.join(sessionDir, `${sessionId}.jsonl`),
      sessionDir,
      workdir,
    ),
    customTools,
    agentDir,
    settingsManager,
    resourceLoader,
  });

  session = created.session;
  // ponytail: force SSE so the relay only needs HTTP; pi's codex client prefers WebSocket by default.
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (m, c, o) => streamFunction(m, c, { ...o, transport: "sse" });
  sessionSig = sig;

  return session;
}

const toUsage = (u) => {
  const usage = {
    inputTokens: {
      total: (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0),
      noCache: u?.input ?? 0,
      cacheRead: u?.cacheRead ?? 0,
      cacheWrite: u?.cacheWrite ?? 0,
    },
    outputTokens: {
      total: u?.output ?? 0,
      text: Math.max(0, (u?.output ?? 0) - (u?.reasoning ?? 0)),
    },
  };

  if (u?.reasoning !== undefined) usage.outputTokens.reasoning = u.reasoning;

  return usage;
};

const resultText = (r) =>
  Array.isArray(r?.content)
    ? r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
    : outputText(r);

function flags(name) {
  const result = {};

  if (!hostToolNames.has(name)) {
    result.providerExecuted = true;

    if (name !== "bash") result.dynamic = true;
  }

  return result;
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  let onAbort;

  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function createTranslator(turn) {
  let textId, reasoningId, stepUsage, stepStop;
  let stepFinished = false;
  let boundary;
  const pendingCalls = new Map();
  const state = { lastError: undefined };

  const finishHostStep = () => {
    if (
      stepFinished ||
      pendingCalls.size === 0 ||
      [...pendingCalls.values()].some((status) => status !== "waiting")
    )
      return;
    stepFinished = true;
    turn.emit({
      type: "finish-step",
      finishReason: { unified: "tool-calls", raw: "host-input" },
      usage: toUsage(stepUsage),
    });
    boundary.resolve();
  };

  state.requestHostResult = async (toolCallId) => {
    pendingCalls.set(toolCallId, "waiting");
    finishHostStep();
    // Every caller tool reaches this barrier before any requestToolResult wait begins.
    await abortable(boundary.promise, turn.abortSignal);
    turn.abortSignal.throwIfAborted();

    return abortable(turn.requestToolResult(toolCallId), turn.abortSignal);
  };

  state.handle = (ev) => {
    switch (ev.type) {
      case "message_update": {
        const u = ev.assistantMessageEvent;

        if (!u) return;

        if (u.type === "text_delta") {
          if (reasoningId) {
            turn.emit({ type: "reasoning-end", id: reasoningId });
            reasoningId = undefined;
          }

          if (!textId) {
            textId = randomUUID();
            turn.emit({ type: "text-start", id: textId });
          }

          turn.emit({ type: "text-delta", id: textId, delta: u.delta });
        } else if (u.type === "thinking_delta") {
          if (textId) {
            turn.emit({ type: "text-end", id: textId });
            textId = undefined;
          }

          if (!reasoningId) {
            reasoningId = randomUUID();
            turn.emit({ type: "reasoning-start", id: reasoningId });
          }

          turn.emit({ type: "reasoning-delta", id: reasoningId, delta: u.delta });
        }

        return;
      }

      case "message_end": {
        if (ev.message?.role !== "assistant") return;

        if (textId) {
          turn.emit({ type: "text-end", id: textId });
          textId = undefined;
        }

        if (reasoningId) {
          turn.emit({ type: "reasoning-end", id: reasoningId });
          reasoningId = undefined;
        }

        stepUsage = ev.message.usage;
        stepStop = ev.message.stopReason;
        stepFinished = false;
        boundary = Promise.withResolvers();
        pendingCalls.clear();

        for (const part of ev.message.content ?? []) {
          if (part.type === "toolCall") pendingCalls.set(part.id, "running");
        }

        if (ev.message.stopReason === "error")
          state.lastError = ev.message.errorMessage ?? "pi assistant message ended with error";

        return;
      }

      case "turn_end": {
        if (!stepFinished)
          turn.emit({
            type: "finish-step",
            finishReason: {
              unified: stepStop === "toolUse" ? "tool-calls" : "stop",
              raw: stepStop,
            },
            usage: toUsage(stepUsage),
          });
        stepUsage = undefined;

        return;
      }

      case "tool_execution_start":
        turn.emit({
          type: "tool-call",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          input: JSON.stringify(ev.args ?? {}),
          ...flags(ev.toolName),
        });

        return;
      case "tool_execution_end": {
        const host = hostToolNames.has(ev.toolName);
        const result = host ? (hostResults.get(ev.toolCallId) ?? null) : resultText(ev.result);
        hostResults.delete(ev.toolCallId);

        const resultEvent = {
          type: "tool-result",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          result,
        };

        if (ev.isError) resultEvent.isError = true;

        if (!host && ev.toolName !== "bash") resultEvent.dynamic = true;
        turn.emit(resultEvent);
        pendingCalls.delete(ev.toolCallId);
        finishHostStep();

        return;
      }

      default:
        return;
    }
  };

  return state;
}

async function onStart(start, turn) {
  let s, before, unsubscribe, onAbort;

  try {
    s = await ensureSession(start);
    before = s.getSessionStats().tokens;
    turn.abortSignal.throwIfAborted();

    const prompt = promptSchema.parse(start.prompt ?? []);

    const translator = createTranslator(turn);
    currentTranslator = translator;
    unsubscribe = s.subscribe((ev) => translator.handle(ev));
    onAbort = () => {
      s.abort().catch(() => {});
    };

    turn.abortSignal.addEventListener("abort", onAbort, { once: true });
    turn.emit({ type: "stream-start", modelId: start.model });
    await s.prompt(prompt);

    if (translator.lastError) throw new Error(translator.lastError);
  } catch (error) {
    if (!turn.abortSignal.aborted) {
      turn.emitError({ error, message: "pi turn failed" });

      return;
    }
  } finally {
    unsubscribe?.();

    if (onAbort) turn.abortSignal.removeEventListener("abort", onAbort);
    currentTranslator = undefined;
    hostResults.clear();
  }

  const after = s?.getSessionStats().tokens;
  turn.emit({
    type: "finish",
    finishReason: turn.abortSignal.aborted
      ? { unified: "other", raw: "aborted" }
      : { unified: "stop", raw: "stop" },
    totalUsage: toUsage(
      before && after
        ? {
            input: after.input - before.input,
            output: after.output - before.output,
            cacheRead: after.cacheRead - before.cacheRead,
            cacheWrite: after.cacheWrite - before.cacheWrite,
          }
        : undefined,
    ),
  });
}

await runBridge({
  bridgeType: "qgrid-pi",
  port: 8787,
  bridgeStateDir,
  onStart,
  onStop: async () => ({ piSession: sessionId }),
  onDestroy: async () => {
    session?.dispose();
  },
});
