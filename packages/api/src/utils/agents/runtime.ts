import { randomUUID } from "node:crypto";

import { shellQuote } from "@ai-sdk/harness/utils";
import { getLogger } from "@logtape/logtape";
import Docker from "dockerode";
import { z } from "zod";

import { AgentStateError } from "../../application/agent/agent.model";
import { findSettingDef, validateSettingValue } from "../../application/setting/setting.constant";
import { getSetting } from "../../application/setting/setting.store";
import { type OpenAIDispatcher } from "../providers/openai/openai-dispatcher";
import { DockerSandboxProvider } from "./docker-sandbox";
import { AgentsRelay } from "./relay";
import { type AgentSessionRunner } from "./session-runner";

const logger = getLogger(["qgrid", "agents"]);

function settingValue(name: string): string {
  const key = `qgrid.agents.${name}`;
  const def = findSettingDef(key);

  if (!def) throw new Error(`Missing setting definition: ${key}`);

  const checked = validateSettingValue(def, getSetting(key, def.envKey) ?? def.fallback);

  if (!checked.ok) throw new Error(`Invalid setting ${key}: ${checked.error}`);

  return checked.value;
}

export function readAgentsSettings() {
  const isolationPorts = settingValue("isolationPorts");

  return {
    enabled: settingValue("enabled") === "true",
    sandboxImage: settingValue("sandboxImage"),
    subnet: settingValue("subnet"),
    hostMode: settingValue("hostMode"),
    relayPort: Number(settingValue("relayPort")),
    maxSessions: Number(settingValue("maxSessions")),
    idleTtlSec: Number(settingValue("idleTtlSec")),
    retainSec: Number(settingValue("retainSec")),
    maxModelCallsPerTurn: Number(settingValue("maxModelCallsPerTurn")),
    maxTurnSeconds: Number(settingValue("maxTurnSeconds")),
    minFreeDiskGb: Number(settingValue("minFreeDiskGb")),
    isolationCheck: settingValue("isolationCheck"),
    isolationPorts: isolationPorts ? isolationPorts.split(",").map(Number) : [],
    secret: settingValue("secret"),
  };
}

const ProbeResults = z.array(
  z.object({ host: z.string(), port: z.number().int(), reachable: z.boolean() }),
);

export async function checkSandboxIsolation(
  provider: Pick<DockerSandboxProvider, "createSession" | "destroyContainer">,
  options: {
    gateway: string;
    relayPort: number;
    apiHost: string;
    apiPort: number;
    blockedPorts: number[];
  },
): Promise<void> {
  const sessionId = `probe-${randomUUID()}`;
  const hosts = new Set(["host.docker.internal", options.gateway]);

  // The API can listen on a different host interface, e.g. Swarm's gateway.
  if (!["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(options.apiHost)) {
    hosts.add(options.apiHost);
  }

  const ports = [...new Set([options.apiPort, ...options.blockedPorts])];

  const targets = [
    { host: "host.docker.internal", port: options.relayPort },
    ...[...hosts].flatMap((host) => ports.map((port) => ({ host, port }))),
  ];

  const source = `
    const net = require("node:net");
    const targets = ${JSON.stringify(targets)};
    Promise.all(targets.map(target => new Promise(resolve => {
      const socket = net.createConnection(target);
      let settled = false;
      const finish = reachable => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ ...target, reachable });
      };
      socket.setTimeout(1500);
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
    }))).then(results => process.stdout.write(JSON.stringify(results)));
  `;

  try {
    const sandbox = await provider.createSession({ sessionId });

    const result = await sandbox.run({
      command: `node -e ${shellQuote(source)}`,
      abortSignal: AbortSignal.timeout(10_000),
    });

    if (result.exitCode !== 0) throw new Error("isolation_check_failed: probe execution failed");

    const results = ProbeResults.parse(JSON.parse(result.stdout));

    if (results.length !== targets.length || !results[0]?.reachable) {
      throw new Error("isolation_check_failed: relay is unreachable from sandbox");
    }

    const exposed = results.slice(1).filter((probe) => probe.reachable);

    if (exposed.length > 0) {
      throw new Error(
        `isolation_check_failed: host ports reachable (${exposed.map(({ host, port }) => `${host}:${port}`).join(", ")})`,
      );
    }
  } finally {
    await provider.destroyContainer(sessionId);
  }
}

type AgentsHealth = {
  enabled: boolean;
  ready: boolean;
  reason?: string;
  sessions: number;
};

let health: AgentsHealth = { enabled: false, ready: false, sessions: 0 };
let runtime: { runner: AgentSessionRunner; relay: AgentsRelay } | undefined;

export function getAgentRunner(): AgentSessionRunner {
  if (!runtime) throw new AgentStateError(503, "agents_unavailable");

  return runtime.runner;
}

export async function agentsHealth(): Promise<AgentsHealth> {
  return { ...health, sessions: runtime ? await runtime.runner.sessionCount() : 0 };
}

export async function startAgentsRuntime(options: {
  dispatcher: OpenAIDispatcher | null | undefined;
  apiHost: string;
  apiPort: number;
}): Promise<void> {
  if (runtime) return;

  let relay: AgentsRelay | undefined;
  let runner: AgentSessionRunner | undefined;

  try {
    if (settingValue("enabled") !== "true") {
      health = { enabled: false, ready: false, sessions: 0 };

      return;
    }

    health = { enabled: true, ready: false, reason: "starting", sessions: 0 };
    const settings = readAgentsSettings();

    if (!settings.secret) throw new Error("QGRID_AGENTS_SECRET is required");

    if (!settings.sandboxImage) throw new Error("qgrid.agents.sandboxImage is required");

    if (!options.dispatcher) throw new Error("OpenAI dispatcher is unavailable");

    const linuxHost =
      settings.hostMode === "linux" ||
      (settings.hostMode === "auto" && process.platform === "linux");

    const provider = new DockerSandboxProvider(new Docker(), {
      image: settings.sandboxImage,
      subnet: settings.subnet,
      hostAlias: { kind: linuxHost ? "gateway" : "host-gateway" },
      memory: 2 * 1024 ** 3,
      nanoCpus: 2_000_000_000,
      pidsLimit: 256,
      onRequestTransformations: (sessionId, rules) => {
        if (!relay) throw new Error("Agents relay is unavailable");
        relay.addRules(sessionId, rules);
      },
    });

    const gateway = await provider.ensureNetwork();
    const { AgentSessionRunner } = await import("./session-runner");
    runner = new AgentSessionRunner({
      provider,
      dispatcher: options.dispatcher,
      secret: settings.secret,
      relayBaseUrl: `http://host.docker.internal:${settings.relayPort}/backend-api/codex`,
      maxSessions: settings.maxSessions,
      idleTtlSec: settings.idleTtlSec,
      retainSec: settings.retainSec,
      maxModelCallsPerTurn: settings.maxModelCallsPerTurn,
      maxTurnSeconds: settings.maxTurnSeconds,
      minFreeDiskGb: settings.minFreeDiskGb,
    });
    relay = new AgentsRelay({
      sessions: runner,
      dispatcher: options.dispatcher,
      bindAddresses: linuxHost ? [gateway, "127.0.0.1"] : ["127.0.0.1"],
      port: settings.relayPort,
      limits: {
        maxModelCalls: settings.maxModelCallsPerTurn,
        maxTurnMs: settings.maxTurnSeconds * 1000,
      },
    });
    runner.setRelay(relay);
    await relay.listen();

    try {
      await checkSandboxIsolation(provider, {
        gateway,
        relayPort: settings.relayPort,
        apiHost: options.apiHost,
        apiPort: options.apiPort,
        blockedPorts: settings.isolationPorts,
      });
    } catch (error) {
      if (settings.isolationCheck === "enforce") throw error;
      logger.warn("Agents isolation warning: {error}", { error });
    }

    await runner.start();
    runtime = { runner, relay };
    health = { enabled: true, ready: true, sessions: 0 };
  } catch (error) {
    await runner?.shutdown().catch((cleanupError: Error) => {
      logger.error("Agents startup cleanup failed: {error}", { error: cleanupError });
    });
    await relay?.close().catch((cleanupError: Error) => {
      logger.error("Agents relay cleanup failed: {error}", { error: cleanupError });
    });
    health = {
      enabled: true,
      ready: false,
      reason: error instanceof Error ? error.message : "Agents startup failed",
      sessions: 0,
    };
    logger.error("Agents disabled: {reason}", { reason: health.reason });
  }
}

export async function stopAgentsRuntime(): Promise<void> {
  const current = runtime;
  runtime = undefined;

  if (!current) return;

  health = { ...health, ready: false, reason: "shutdown", sessions: 0 };

  try {
    await current.runner.shutdown();
  } finally {
    await current.relay.close();
  }
}
