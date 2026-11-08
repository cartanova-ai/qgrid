import { randomUUID } from "node:crypto";

import Docker from "dockerode";
import { expect, it, vi } from "vitest";

import { DockerSandboxProvider } from "./docker-sandbox";
import { createSandboxPi } from "./pi-harness";

it.skipIf(process.env.QGRID_AGENTS_IT !== "1")(
  "starts the preinstalled Docker bridge and completes its hello handshake without a model call",
  async () => {
    const onRequestTransformations = vi.fn();
    const provider = new DockerSandboxProvider(new Docker(), {
      image: "qgrid-sandbox-pi:dev",
      hostAlias: { kind: "gateway" },
      memory: 536870912,
      nanoCpus: 1000000000,
      pidsLimit: 128,
      onRequestTransformations,
    });
    const sessionId = `u5-${randomUUID()}`;
    const sandboxSession = await provider.createSession({ sessionId });
    try {
      const harness = createSandboxPi({
        secret: "integration-test-only",
        relayBaseUrl: "http://host.docker.internal:44901/backend-api/codex",
        startupTimeoutMs: 15000,
      });
      const session = await harness.doStart({
        sessionId,
        sandboxSession,
        sessionWorkDir: "/workspace",
        permissionMode: "allow-all",
      });
      expect(session.sessionId).toBe(sessionId);
      expect(onRequestTransformations).toHaveBeenCalledOnce();
      // doStart resolves only after bridge-ready and an authenticated bridge-hello.
      const detached = await session.doDetach();
      expect(detached.data).toMatchObject({ bridge: { port: 8787, lastSeenEventId: 0 } });
      const attached = await harness.doStart({
        sessionId,
        sandboxSession,
        sessionWorkDir: "/workspace",
        resumeFrom: detached,
      });
      expect(attached.isResume).toBe(true);
      const stopped = await attached.doStop();
      expect(stopped.data).toMatchObject({ piSession: sessionId });
    } finally {
      await sandboxSession.destroy();
    }
  },
  30000,
);
