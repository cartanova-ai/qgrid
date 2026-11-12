import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "../../application/setting/setting.store";
import { DockerSandboxProvider } from "./docker-sandbox";
import {
  agentsHealth,
  checkSandboxIsolation,
  readAgentsSettings,
  startAgentsRuntime,
  stopAgentsRuntime,
} from "./runtime";

const runner = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  sessionCount: vi.fn().mockReturnValue(2),
}));

vi.mock("./session-runner", () => ({
  AgentSessionRunner: class {
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
  apiHost: "172.19.0.1",
  apiPort: 44900,
  blockedPorts: [5432, 6379],
};

function probeOutput(exposed = false) {
  return JSON.stringify(
    ["172.30.0.1", "172.19.0.1"].flatMap((host) =>
      [44900, 5432, 6379].map((port) => ({
        host,
        port,
        reachable: exposed && host === "172.19.0.1" && port === 44900,
      })),
    ),
  );
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
      maxSessions: 4,
      idleTtlSec: 1800,
      retainSec: 86400,
      maxModelCallsPerTurn: 60,
      maxTurnSeconds: 1200,
      minFreeDiskGb: 20,
      isolationCheck: "enforce",
      isolationPorts: [5432, 6379],
    });
    expect(readAgentsSettings()).not.toHaveProperty("relayPort");
    vi.stubEnv("QGRID_AGENTS_MAX_SESSIONS", "6");
    expect(readAgentsSettings()).toMatchObject({ maxSessions: 6 });
    await settings({ maxSessions: "3" });
    expect(readAgentsSettings()).toMatchObject({ maxSessions: 3 });
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

  it("accepts a sandbox that reaches no host port and removes the probe", async () => {
    const sandbox = provider(probeOutput());
    await expect(checkSandboxIsolation(sandbox, probeOptions)).resolves.toBeUndefined();
    expect(sandbox.destroyContainer).toHaveBeenCalledWith(
      sandbox.createSession.mock.calls[0]?.[0].sessionId,
    );
  });

  it.each([
    [probeOutput(true), "172.19.0.1:44900"],
    ["[]", "incomplete result"],
  ])("rejects an exposed host port or a short probe and removes the probe", async (stdout, message) => {
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

    return { network };
  }

  const options = { dispatcher: {} as never, apiHost: "172.19.0.1", apiPort: 44900 };

  it("starts without a relay or secret and reports ready", async () => {
    runtimeProbe();
    await settings({ enabled: "true", sandboxImage: "test:pi" });
    await startAgentsRuntime(options);
    expect(await agentsHealth()).toEqual({ enabled: true, ready: true, sessions: 2 });
    expect(runner.start).toHaveBeenCalledOnce();
  });

  it("does not start Docker when disabled", async () => {
    const probe = runtimeProbe();
    await startAgentsRuntime(options);
    expect(probe.network).not.toHaveBeenCalled();
    expect(await agentsHealth()).toEqual({ enabled: false, ready: false, sessions: 0 });
  });

  it("enforce disables agents and exposes the isolation failure in health", async () => {
    runtimeProbe(true);
    await settings({ enabled: "true", sandboxImage: "test:pi" });
    await startAgentsRuntime(options);
    expect(await agentsHealth()).toMatchObject({
      enabled: true,
      ready: false,
      reason: expect.stringContaining("172.19.0.1:44900"),
      sessions: 0,
    });
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("warn continues startup and shutdown saves runner state", async () => {
    runtimeProbe(true);
    await settings({ enabled: "true", sandboxImage: "test:pi", isolationCheck: "warn" });
    await startAgentsRuntime(options);
    expect(await agentsHealth()).toEqual({ enabled: true, ready: true, sessions: 2 });
    await stopAgentsRuntime();
    expect(runner.shutdown).toHaveBeenCalledOnce();
    expect(await agentsHealth()).toMatchObject({ ready: false, reason: "shutdown" });
  });
});
