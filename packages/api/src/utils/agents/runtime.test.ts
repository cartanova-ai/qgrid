import { Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../../application/setting/setting.store";
import { DockerSandboxProvider } from "./docker-sandbox";
import { AgentsRelay } from "./relay";
import {
  agentsHealth,
  checkSandboxIsolation,
  readAgentsSettings,
  startAgentsRuntime,
  stopAgentsRuntime,
} from "./runtime";

const runner = vi.hoisted(() => ({
  setRelay: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  sessionCount: vi.fn().mockReturnValue(2),
}));

vi.mock("./session-runner", () => ({
  AgentSessionRunner: class {
    setRelay = runner.setRelay;
    start = runner.start;
    shutdown = runner.shutdown;
    sessionCount = runner.sessionCount;
  },
}));

const persistence = {
  findAllAsMap: vi.fn<() => Promise<Map<string, string>>>(),
  setByKey: vi.fn(),
  clearByKey: vi.fn(),
};

async function settings(entries: Record<string, string> = {}) {
  persistence.findAllAsMap.mockResolvedValue(
    new Map(Object.entries(entries).map(([name, value]) => [`qgrid.agents.${name}`, value])),
  );
  await loadSettings(persistence);
}

const probeOptions = {
  gateway: "172.30.0.1",
  relayPort: 44901,
  apiHost: "172.19.0.1",
  apiPort: 44900,
  blockedPorts: [5432, 6379],
};

function probeOutput(exposed = false, relayReachable = true) {
  return JSON.stringify([
    { host: "host.docker.internal", port: 44901, reachable: relayReachable },
    ...["host.docker.internal", "172.30.0.1", "172.19.0.1"].flatMap((host) =>
      [44900, 5432, 6379].map((port) => ({
        host,
        port,
        reachable: exposed && host === "172.19.0.1" && port === 44900,
      })),
    ),
  ]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await settings();
});

afterEach(async () => {
  await stopAgentsRuntime();
  vi.unstubAllEnvs();
});

describe("agent settings", () => {
  it("uses definitions as fallback and resolves DB before environment", async () => {
    expect(readAgentsSettings()).toMatchObject({
      enabled: false,
      relayPort: 44901,
      maxSessions: 4,
      idleTtlSec: 1800,
      retainSec: 86400,
      maxModelCallsPerTurn: 60,
      maxTurnSeconds: 1200,
      minFreeDiskGb: 20,
      isolationCheck: "enforce",
      hostMode: "auto",
      isolationPorts: [5432, 6379],
    });
    vi.stubEnv("QGRID_AGENTS_MAX_SESSIONS", "6");
    vi.stubEnv("QGRID_AGENTS_SECRET", "test-secret");
    vi.stubEnv("QGRID_AGENTS_HOST_MODE", "desktop");
    expect(readAgentsSettings()).toMatchObject({ maxSessions: 6, secret: "test-secret", hostMode: "desktop" });
    await settings({ maxSessions: "3", hostMode: "linux" });
    expect(readAgentsSettings()).toMatchObject({ maxSessions: 3, hostMode: "linux" });
  });
});

describe("sandbox isolation", () => {
  function provider(stdout: string, exitCode = 0) {
    return {
      createSession: vi.fn().mockResolvedValue({
        run: vi.fn().mockResolvedValue({ exitCode, stdout, stderr: "" }),
      }),
      destroyContainer: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("accepts relay access with blocked host ports and removes the probe", async () => {
    const sandbox = provider(probeOutput());
    await expect(checkSandboxIsolation(sandbox, probeOptions)).resolves.toBeUndefined();
    expect(sandbox.destroyContainer).toHaveBeenCalledWith(
      sandbox.createSession.mock.calls[0]?.[0].sessionId,
    );
  });

  it.each([
    [probeOutput(true), "172.19.0.1:44900"],
    [probeOutput(false, false), "relay is unreachable"],
  ])("rejects an unsafe or unreachable network and removes the probe", async (stdout, message) => {
    const sandbox = provider(stdout);
    await expect(checkSandboxIsolation(sandbox, probeOptions)).rejects.toThrow(message);
    expect(sandbox.destroyContainer).toHaveBeenCalledTimes(1);
  });

  it("removes the probe when the command fails", async () => {
    const sandbox = provider("", 1);
    await expect(checkSandboxIsolation(sandbox, probeOptions)).rejects.toThrow("execution failed");
    expect(sandbox.destroyContainer).toHaveBeenCalledTimes(1);
  });
});

describe("agents startup", () => {
  function runtimeProbe(exposed = false) {
    const network = vi.spyOn(DockerSandboxProvider.prototype, "ensureNetwork").mockResolvedValue("172.30.0.1");
    vi.spyOn(DockerSandboxProvider.prototype, "createSession").mockResolvedValue({
      run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: probeOutput(exposed), stderr: "" }),
    } as never);
    vi.spyOn(DockerSandboxProvider.prototype, "destroyContainer").mockResolvedValue(undefined);
    const listen = vi.spyOn(AgentsRelay.prototype, "listen").mockResolvedValue(undefined);
    const close = vi.spyOn(AgentsRelay.prototype, "close").mockResolvedValue(undefined);

    return { network, listen, close };
  }

  const options = { dispatcher: {} as never, apiHost: "172.19.0.1", apiPort: 44900 };

  it.each([
    ["auto", "linux", ["172.30.0.1", "127.0.0.1"]],
    ["auto", "darwin", ["127.0.0.1"]],
    ["linux", "darwin", ["172.30.0.1", "127.0.0.1"]],
    ["desktop", "linux", ["127.0.0.1"]],
  ] as const)("binds relay for host mode %s on %s", async (hostMode, platform, addresses) => {
    const probe = runtimeProbe();
    probe.listen.mockRestore();
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      queueMicrotask(() => this.emit("listening"));
      return this;
    });
    await settings({ enabled: "true", secret: "test-secret", sandboxImage: "test:pi", hostMode });
    await startAgentsRuntime(options);
    expect(await agentsHealth()).toMatchObject({ ready: true });
    expect(listen.mock.calls.map((args) => args[1])).toEqual(addresses);
  });

  it("does not start Docker or relay when disabled", async () => {
    const probe = runtimeProbe();
    await startAgentsRuntime(options);
    expect(probe.network).not.toHaveBeenCalled();
    expect(probe.listen).not.toHaveBeenCalled();
    expect(await agentsHealth()).toEqual({ enabled: false, ready: false, sessions: 0 });
  });

  it("enforce disables agents and exposes the isolation failure in health", async () => {
    const probe = runtimeProbe(true);
    await settings({ enabled: "true", secret: "test-secret", sandboxImage: "test:pi" });
    await startAgentsRuntime(options);
    expect(await agentsHealth()).toMatchObject({
      enabled: true,
      ready: false,
      reason: expect.stringContaining("172.19.0.1:44900"),
      sessions: 0,
    });
    expect(probe.close).toHaveBeenCalledOnce();
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("warn continues startup and shutdown saves runner state before closing relay", async () => {
    const probe = runtimeProbe(true);
    await settings({ enabled: "true", secret: "test-secret", sandboxImage: "test:pi", isolationCheck: "warn", hostMode: "desktop" });
    await startAgentsRuntime(options);
    expect(await agentsHealth()).toEqual({ enabled: true, ready: true, sessions: 2 });
    await stopAgentsRuntime();
    expect(probe.close).toHaveBeenCalledOnce();
    expect(runner.shutdown.mock.invocationCallOrder[0]).toBeLessThan(probe.close.mock.invocationCallOrder[0]!);
    expect(await agentsHealth()).toMatchObject({ ready: false, reason: "shutdown" });
  });
});
