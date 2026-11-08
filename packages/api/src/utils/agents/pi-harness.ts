import { createHash, createHmac } from "node:crypto";

import {
  commonTool,
  HarnessCapabilityUnsupportedError,
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  harnessV1BridgeOutboundMessageSchema,
  type HarnessV1,
  type HarnessV1ContinueTurnState,
  type HarnessV1Session,
  type HarnessV1StreamPart,
  type HarnessV1ContinueTurnOptions,
} from "@ai-sdk/harness";
import {
  SandboxChannel,
  classifyDiskLog,
  createBridgeWebSocketConnect,
  createCredentialRequestTransformation,
  drainBridgeProcessStream,
  extractHarnessPromptContent,
  getRestrictedSandboxSession,
  markBridgeStarting,
  resolveBridgeEndpoint,
  resolveSandboxCredentialEnvironment,
  resolveSandboxHomeDir,
  shellQuote,
  waitForBridgeReady,
} from "@ai-sdk/harness/utils";
import { tool, type Experimental_SandboxProcess } from "@ai-sdk/provider-utils";
import { WebSocket } from "ws";
import { z } from "zod/v4";

const HARNESS_ID = "qgrid-pi";
const PORT = 8787;

// Pi uses path/oldText/newText, not the common file_path/old_string/new_string contract.
export const PI_BUILTIN_TOOLS = {
  read: {
    ...tool({
      description: "Read a file",
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }),
    }),
    toolUseKind: "readonly",
  },
  write: {
    ...tool({
      description: "Write a file",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    }),
    toolUseKind: "edit",
  },
  edit: {
    ...tool({
      description: "Replace text in a file",
      inputSchema: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
    }),
    toolUseKind: "edit",
  },
  bash: commonTool("bash", {
    nativeName: "bash",
    toolUseKind: "bash",
    description: "Execute a shell command",
    inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
  }),
  grep: commonTool("grep", {
    nativeName: "grep",
    toolUseKind: "readonly",
    description: "Search file contents",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      glob: z.string().optional(),
      ignoreCase: z.boolean().optional(),
      literal: z.boolean().optional(),
      context: z.number().optional(),
      limit: z.number().optional(),
    }),
  }),
  find: {
    ...tool({
      description: "Find files by glob",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        limit: z.number().optional(),
      }),
    }),
    toolUseKind: "readonly",
  },
  ls: {
    ...tool({
      description: "List a directory",
      inputSchema: z.object({ path: z.string().optional(), limit: z.number().optional() }),
    }),
    toolUseKind: "readonly",
  },
} as const;

export type SandboxPiSettings = {
  secret: string;
  relayBaseUrl: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  startupTimeoutMs?: number;
};

/** Shared with the runner's relay registration; never persist these values in lifecycle data. */
export function derivePiSessionSecrets(secret: string, sessionId: string) {
  if (!secret) throw new Error("Pi harness requires a nonempty secret");

  const derive = (purpose: string) =>
    createHmac("sha256", secret).update(sessionId).update("\0").update(purpose).digest("base64url");

  return {
    bridgeToken: derive("bridge-token"),
    sessionKey: derive("session-key"),
    placeholder: `aisdkhc_${derive("placeholder")}`,
  };
}

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const lifecycleDataSchema = z.object({
  bridge: z.object({ port: z.literal(PORT), lastSeenEventId: z.number().int().nonnegative() }),
  piSession: sessionIdSchema,
  model: z.string().nullable(),
  instructionsHash: z.string().nullable(),
});

/** Reattach after host loss; the runner retains framework-owned pending actions/settings separately. */
export function reconstructContinueState({
  sessionId,
  lastSeenEventId,
  piSession,
}: {
  sessionId: string;
  lastSeenEventId: number;
  piSession?: string;
}): HarnessV1ContinueTurnState {
  sessionIdSchema.parse(sessionId);

  return {
    type: "continue-turn",
    harnessId: HARNESS_ID,
    specificationVersion: "harness-v1",
    data: lifecycleDataSchema.parse({
      bridge: { port: PORT, lastSeenEventId },
      piSession: piSession ?? sessionId,
      model: null,
      instructionsHash: null,
    }),
  };
}

// The upstream union strips seq. Preserve it alongside validated protocol fields.
const outboundSchema = z.intersection(
  harnessV1BridgeOutboundMessageSchema,
  z.object({ seq: z.number().int().nonnegative().optional() }),
);

type Channel = SandboxChannel<z.infer<typeof outboundSchema>, { type: string }>;

function unsupported(capability: string) {
  return new HarnessCapabilityUnsupportedError({
    harnessId: HARNESS_ID,
    message: `Harness '${HARNESS_ID}' does not support ${capability}.`,
  });
}

export function createSandboxPi(settings: SandboxPiSettings): HarnessV1<typeof PI_BUILTIN_TOOLS> {
  return {
    harnessId: HARNESS_ID,
    specificationVersion: "harness-v1",
    builtinTools: PI_BUILTIN_TOOLS,
    supportsBuiltinToolApprovals: false,
    supportsBuiltinToolFiltering: false,
    lifecycleStateSchema: lifecycleDataSchema,
    getBootstrap: async () => ({
      harnessId: HARNESS_ID,
      bootstrapDir: ".harness-bootstrap/qgrid-pi",
      files: [],
      commands: [],
    }),
    doStart: async (options) => {
      sessionIdSchema.parse(options.sessionId);

      if (options.permissionMode !== undefined && options.permissionMode !== "allow-all")
        throw unsupported("permission modes other than allow-all");

      const sandboxSession = options.sandboxSession;

      if (
        !("addRequestTransformations" in sandboxSession) ||
        !sandboxSession.addRequestTransformations
      )
        throw unsupported("sandboxes without credential brokering");

      const continuation = options.continueFrom ?? options.resumeFrom?.continueFrom;
      const lifecycle = continuation ?? options.resumeFrom;

      if (
        lifecycle &&
        (lifecycle.harnessId !== HARNESS_ID || lifecycle.specificationVersion !== "harness-v1")
      )
        throw new Error("Incompatible Pi lifecycle state");

      const data = lifecycle
        ? lifecycleDataSchema.parse(lifecycle.data)
        : {
            bridge: { port: PORT, lastSeenEventId: 0 },
            piSession: options.sessionId,
            model: settings.model ?? null,
            instructionsHash: null,
          };

      const secrets = derivePiSessionSecrets(settings.secret, options.sessionId);

      const environment = await resolveSandboxCredentialEnvironment({
        environment: { CODEX_API_KEY: secrets.sessionKey },
        credentialEnvironmentVariables: ["CODEX_API_KEY"],
        credentialForwarding: undefined,
        previousSandboxCredentialEnvironment: { CODEX_API_KEY: secrets.placeholder },
      });

      await sandboxSession.addRequestTransformations([
        createCredentialRequestTransformation({
          matchUrl: settings.relayBaseUrl,
          matchHeaders: { Authorization: `Bearer ${environment.CODEX_API_KEY}` },
          transformHeaders: { Authorization: `Bearer ${secrets.sessionKey}` },
        }),
      ]);

      const sandbox = getRestrictedSandboxSession(sandboxSession);

      const sandboxHomeDir = await resolveSandboxHomeDir({
        sandbox,
        abortSignal: options.abortSignal,
      });

      const stateDirectory = harnessStateDirectoryPath({ sandboxHomeDir });
      const bridgeStateDir = `${harnessSessionDataDirectoryPath({ stateDirectory, sessionId: options.sessionId })}/bridge`;
      const timeoutMs = settings.startupTimeoutMs ?? 120_000;

      const endpoint = await resolveBridgeEndpoint({
        sandboxSession,
        port: PORT,
        portEndpointOverride: undefined,
        token: secrets.bridgeToken,
      });

      const connect = async (retry: boolean) => {
        const channel = new SandboxChannel({
          connect: createBridgeWebSocketConnect({
            endpoint,
            webSocketConstructor: WebSocket,
            openRetryTimeoutMs: retry ? timeoutMs : undefined,
            startAbortSignal: options.abortSignal,
          }),
          outboundSchema,
          initialLastSeenEventId: data.bridge.lastSeenEventId,
        });

        try {
          // Between-turn detach already consumed its finish; continue replays the unfinished tail.
          await channel.open(lifecycle ? { resume: true } : undefined);

          return channel;
        } catch (error) {
          channel.close();
          throw error;
        }
      };

      if (lifecycle) {
        try {
          return createSession(await connect(false));
        } catch {
          options.abortSignal?.throwIfAborted();
        }
      }

      let lostTurn = false;

      if (continuation) {
        const log = await Promise.resolve(
          sandbox.readTextFile({
            path: `${bridgeStateDir}/event-log.ndjson`,
            abortSignal: options.abortSignal,
          }),
        ).catch(() => null);

        // A dead Pi process cannot restore an in-flight JS/tool wait. Only completed disk logs replay.
        lostTurn = (await classifyDiskLog(log)) !== "replay";
      }

      await markBridgeStarting({
        sandbox,
        bridgeStateDir,
        bridgeType: HARNESS_ID,
        abortSignal: options.abortSignal,
      });

      const proc = await sandbox.spawn({
        command: `node /opt/qgrid-pi-bridge/bridge.mjs --workdir ${shellQuote(options.sessionWorkDir)} --bridge-state-dir ${shellQuote(bridgeStateDir)}`,
        env: {
          ...environment,
          OPENAI_BASE_URL: settings.relayBaseUrl,
          BRIDGE_CHANNEL_TOKEN: secrets.bridgeToken,
          BRIDGE_WS_PORT: String(PORT),
          BRIDGE_REPLAY_FROM_DISK: lifecycle ? "1" : "0",
        },
        abortSignal: options.abortSignal,
      });

      // Consume process pipes without printing credentials or arbitrary tool output to host logs.
      void drainBridgeProcessStream(proc.stderr);

      try {
        await waitForBridgeReady({
          proc,
          sandbox,
          bridgeStateDir,
          bridgeType: HARNESS_ID,
          timeoutMs,
          abortSignal: options.abortSignal,
          createTimeoutError: () => new Error("Pi bridge startup timed out"),
          createExitError: () => new Error("Pi bridge exited before becoming ready"),
        });
        void drainBridgeProcessStream(proc.stdout);

        return createSession(await connect(true), proc, lostTurn);
      } catch (error) {
        await proc.kill();
        throw error;
      }

      function createSession(
        channel: Channel,
        process?: Experimental_SandboxProcess,
        cannotContinue = false,
      ): HarnessV1Session {
        let stopped = false;
        let pendingResume = lifecycle ? data.piSession : undefined;

        const assertActive = () => {
          if (stopped) throw new Error("Pi session is already stopped or detached");
        };

        const state = <T extends "resume-session" | "continue-turn">(type: T) => ({
          type,
          harnessId: HARNESS_ID,
          specificationVersion: "harness-v1" as const,
          data: { ...data, bridge: { port: PORT, lastSeenEventId: channel.lastSeenEventId } },
        });

        const suspend = async <T extends "resume-session" | "continue-turn">(type: T) => {
          assertActive();
          stopped = true;
          const lastSeenEventId = await channel.suspend();
          const result = state(type);
          result.data.bridge.lastSeenEventId = lastSeenEventId;

          return result;
        };

        const wireTurn = (turnOptions: HarnessV1ContinueTurnOptions) => {
          assertActive();

          if (turnOptions.responseFormat !== undefined) throw unsupported("responseFormat");

          const { promise: done, resolve, reject } = Promise.withResolvers<void>();
          let settled = false;
          const unsubs: (() => void)[] = [];

          const settle = (error?: Error) => {
            if (settled) return;
            settled = true;

            for (const unsub of unsubs) unsub();
            turnOptions.abortSignal?.removeEventListener("abort", onAbort);

            if (error) reject(error);
            else resolve();
          };

          const onAbort = () => {
            if (settled) return;

            try {
              channel.send({ type: "abort" });
            } catch {
              settle(new Error("Pi bridge unavailable during abort"));
            }
            // Keep listening for finish(raw: aborted); the runner owns the abort timeout.
          };

          const release = channel.beginListenerAttachment();

          const forward = (event: HarnessV1StreamPart & { seq?: number }) => {
            if (event.seq === undefined) {
              settle(new Error("Pi bridge emitted a stream part without seq"));

              return;
            }

            // Mutate the validated frame to retain SandboxChannel's non-enumerable checkpoint.
            // harnessMetadata is also required by harness 1.0.173's agent stream conversion.
            const metadata = {
              ...("harnessMetadata" in event ? event.harnessMetadata : undefined),
              ...("providerMetadata" in event ? event.providerMetadata : undefined),
              qgrid: { seq: event.seq },
            };

            try {
              turnOptions.emit(
                Object.assign(event, { providerMetadata: metadata, harnessMetadata: metadata }),
              );
            } catch (error) {
              settle(new Error("Pi stream consumer failed", { cause: error }));
            }
          };

          for (const type of [
            "stream-start",
            "text-start",
            "text-delta",
            "text-end",
            "reasoning-start",
            "reasoning-delta",
            "reasoning-end",
            "tool-input-start",
            "tool-input-delta",
            "tool-input-end",
            "tool-call",
            "tool-approval-request",
            "tool-result",
            "file-change",
            "compaction",
            "finish-step",
            "raw",
          ] as const) {
            unsubs.push(channel.on(type, forward));
          }

          unsubs.push(
            channel.on("finish", (event) => {
              forward(event);
              settle();
            }),
          );
          unsubs.push(
            channel.on("error", (event) => {
              if (event.seq !== undefined) forward(event);
              settle(new Error("Pi bridge turn failed", { cause: event.error }));
            }),
          );
          channel.onClose((_code, reason) =>
            settle(
              reason === "suspended"
                ? undefined
                : new Error("Pi bridge closed before the turn finished"),
            ),
          );
          turnOptions.abortSignal?.addEventListener("abort", onAbort, { once: true });
          release();

          if (turnOptions.abortSignal?.aborted) onAbort();

          return {
            control: {
              done,
              submitToolResult: async (input) => {
                assertActive();
                channel.send(Object.assign({ type: "tool-result" }, input));
              },
            } satisfies Awaited<ReturnType<HarnessV1Session["doPromptTurn"]>>,
            sendStart: (send: () => void) => {
              setTimeout(() => {
                if (settled) return;

                try {
                  send();

                  if (turnOptions.abortSignal?.aborted) onAbort();
                } catch (error) {
                  settle(new Error("Pi bridge start failed", { cause: error }));
                }
              }, 0);
            },
          };
        };

        return {
          sessionId: options.sessionId,
          isResume: lifecycle !== undefined,
          doPromptTurn: async (promptOptions) => {
            if (promptOptions.responseFormat !== undefined) throw unsupported("responseFormat");
            promptOptions.abortSignal?.throwIfAborted();
            const model = promptOptions.model ?? data.model ?? settings.model;

            if (!model) throw new Error("Pi harness requires a qgrid model ID");

            const turn = wireTurn(promptOptions);
            data.model = model;
            data.instructionsHash = createHash("sha256")
              .update(promptOptions.instructions ?? "")
              .digest("hex");

            const start = {
              type: "start",
              model,
              instructions: promptOptions.instructions,
              tools: promptOptions.tools,
              reasoningEffort: settings.reasoningEffort,
              prompt: extractHarnessPromptContent({ prompt: promptOptions.prompt }),
              sessionId: options.sessionId,
              resume: pendingResume,
            };

            pendingResume = undefined;
            turn.sendStart(() => channel.send(start));

            return turn.control;
          },
          doContinueTurn: async (continueOptions) => {
            if (continueOptions.responseFormat !== undefined) throw unsupported("responseFormat");

            if (cannotContinue)
              throw new Error(
                "Pi bridge restarted before the turn finished; resume the session with a new prompt",
              );
            data.model = continueOptions.model ?? data.model;
            data.instructionsHash = createHash("sha256")
              .update(continueOptions.instructions ?? "")
              .digest("hex");

            return wireTurn(continueOptions).control;
          },
          doCompact: async () => {
            throw unsupported("manual compaction");
          },
          doSuspendTurn: () => suspend("continue-turn"),
          doDetach: () => suspend("resume-session"),
          doStop: async () => {
            assertActive();
            stopped = true;
            channel.beginClose();

            try {
              const stoppedData = await new Promise<string | undefined>((resolve, reject) => {
                const timer = setTimeout(() => {
                  unsub();
                  reject(new Error("Pi bridge did not reply to stop within 5s"));
                }, 5000);

                const unsub = channel.on("bridge-stop", (event) => {
                  clearTimeout(timer);
                  unsub();

                  const parsed = z
                    .object({ piSession: sessionIdSchema.optional() })
                    .safeParse(event.data);

                  if (parsed.success) resolve(parsed.data.piSession);
                  else reject(new Error("Invalid Pi stop state"));
                });

                try {
                  channel.send({ type: "stop" });
                } catch (error) {
                  clearTimeout(timer);
                  unsub();
                  reject(error);
                }
              });

              data.piSession = stoppedData ?? data.piSession;

              return state("resume-session");
            } finally {
              await closeProcess(channel, process);
            }
          },
          doDestroy: async () => {
            if (stopped) return;
            stopped = true;
            channel.beginClose();

            try {
              if (!channel.isClosed()) channel.send({ type: "destroy" });
            } finally {
              await closeProcess(channel, process);
            }
          },
        };
      }
    },
  };
}

async function closeProcess(channel: Channel, process?: Experimental_SandboxProcess) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (process)
      await Promise.race([
        process.wait(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
  } finally {
    clearTimeout(timer);

    try {
      await process?.kill();
    } finally {
      channel.close();
    }
  }
}
