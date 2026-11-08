import { statfs } from "node:fs/promises";
import { Duplex, Readable } from "node:stream";

import Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { DockerSandboxProvider } from "./docker-sandbox";

function frame(channel: number, text: string | Buffer) {
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

function fixture() {
  const info = {
    Config: { WorkingDir: "/workspace", Labels: { "qgrid.agents.session": "one" } },
    State: { Running: true },
    HostConfig: { NetworkMode: "qgrid-agents" },
    NetworkSettings: {
      Networks: { "qgrid-agents": { IPAddress: "172.30.0.2" } },
      Ports: { "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    },
  };
  const container = {
    inspect: vi.fn().mockResolvedValue(info),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    putArchive: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(),
  };
  const network = {
    inspect: vi.fn().mockResolvedValue({
      Driver: "bridge",
      Options: { "com.docker.network.bridge.name": "br-qgrid-agents" },
      IPAM: { Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }] },
    }),
  };
  // Mock the daemon boundary, retaining docker-modem's real multiplex frame parser.
  const docker = new Docker();
  vi.spyOn(docker, "getNetwork").mockReturnValue(network as never);
  vi.spyOn(docker, "createNetwork").mockResolvedValue(network as never);
  vi.spyOn(docker, "createContainer").mockResolvedValue(container as never);
  vi.spyOn(docker, "getContainer").mockReturnValue(container as never);
  vi.spyOn(docker, "listContainers").mockResolvedValue([]);
  vi.spyOn(docker.modem, "demuxStream");
  const onRequestTransformations = vi.fn();
  const options = {
    image: "qgrid-sandbox-pi:dev",
    memory: 536870912,
    nanoCpus: 1000000000,
    pidsLimit: 128,
    onRequestTransformations,
  };
  const provider = new DockerSandboxProvider(docker, options);
  return { provider, docker, container, network, info, onRequestTransformations, options };
}

function mockExec(
  container: ReturnType<typeof fixture>["container"],
  { stdout = "out", stderr = "err", exitCode = 0, interactive = false } = {},
) {
  const writes: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      stream.push(frame(1, Buffer.concat(writes)));
      stream.push(null);
      callback();
    },
  });
  const exec = {
    inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: exitCode }),
    start: vi.fn().mockImplementation(async () => {
      setImmediate(() => {
        const data = Buffer.concat([frame(1, "42\n"), frame(2, stderr), frame(1, stdout)]);
        // Split through both a Docker header and the PID preamble.
        for (let i = 0; i < data.length; i += 3) stream.push(data.subarray(i, i + 3));
        if (!interactive) stream.push(null);
      });
      return stream;
    }),
  };
  container.exec.mockResolvedValueOnce(exec);
  return { exec, stream, writes };
}

describe("DockerSandboxProvider", () => {
  it("passes caller env to the container and recovers only those values for redaction", async () => {
    const { provider, docker, container, info } = fixture();
    const env = { DB_PASSWORD: "private=secret", GH_TOKEN: "git-secret" };
    await provider.createSession({ sessionId: "one", env });
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Env: ["DB_PASSWORD=private=secret", "GH_TOKEN=git-secret"],
      Labels: { "qgrid.agents.session": "one", "qgrid.agents.env-keys": '["DB_PASSWORD","GH_TOKEN"]' },
    }));
    container.inspect.mockResolvedValue({ ...info, Config: { ...info.Config,
      Labels: { ...info.Config.Labels, "qgrid.agents.env-keys": '["DB_PASSWORD","GH_TOKEN"]' },
      Env: ["PATH=/usr/bin", "DB_PASSWORD=private=secret", "GH_TOKEN=git-secret"],
    } });
    expect(await provider.callerEnvironment("one")).toEqual(env);
  });

  it("creates the dedicated bridge and applies the sandbox isolation options", async () => {
    const { provider, docker, container, network, options } = fixture();
    network.inspect.mockRejectedValueOnce(Object.assign(new Error("missing"), { statusCode: 404 }));
    const session = await provider.createSession({ sessionId: "one" });
    expect(provider.providerId).toBe("qgrid-docker");
    expect(provider.specificationVersion).toBe("harness-sandbox-v1");
    expect(docker.createNetwork).toHaveBeenCalledWith({
      Name: "qgrid-agents",
      Driver: "bridge",
      IPAM: { Config: [{ Subnet: "172.30.0.0/24", Gateway: "172.30.0.1" }] },
      Options: { "com.docker.network.bridge.name": "br-qgrid-agents" },
    });
    expect(provider.gateway).toBe("172.30.0.1");
    expect(docker.createContainer).toHaveBeenCalledWith({
      name: "qgrid-agents-one",
      Image: options.image,
      User: "node",
      Env: [],
      ExposedPorts: { "8787/tcp": {} },
      Labels: { "qgrid.agents.session": "one", "qgrid.agents.env-keys": "[]" },
      HostConfig: {
        NetworkMode: "qgrid-agents",
        ExtraHosts: ["host.docker.internal:172.30.0.1"],
        PortBindings: { "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
        Memory: options.memory,
        NanoCpus: options.nanoCpus,
        PidsLimit: 128,
        Privileged: false,
      },
    });
    expect(container.start).toHaveBeenCalledOnce();
    expect(session.defaultWorkingDirectory).toBe("/workspace");
    expect(await session.getPortEndpoint({ port: 8787 })).toEqual({ url: "ws://127.0.0.1:49152" });
    expect(await provider.inspectIp("one")).toBe("172.30.0.2");
  });

  it("refuses an existing bridge with the wrong interface", async () => {
    const { provider, network, docker } = fixture();
    network.inspect.mockResolvedValueOnce({
      Driver: "bridge",
      Options: { "com.docker.network.bridge.name": "docker0" },
      IPAM: { Config: [{ Gateway: "172.30.0.1", Subnet: "172.30.0.0/24" }] },
    });
    await expect(provider.createSession({ sessionId: "one" })).rejects.toThrow(
      "network does not match",
    );
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it("resumes a stopped sandbox and removes a fresh container if bootstrap fails", async () => {
    const { provider, info, container } = fixture();
    info.State.Running = false;
    await provider.resumeSession({ sessionId: "one" });
    expect(container.start).toHaveBeenCalledOnce();
    await expect(
      provider.createSession({
        sessionId: "one",
        onFirstCreate: async () => {
          throw new Error("bootstrap");
        },
      }),
    ).rejects.toThrow("bootstrap");
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it("demultiplexes run output, keeps its exit code and passes cwd/env", async () => {
    const { provider, docker, container } = fixture();
    const session = await provider.createSession({ sessionId: "one" });
    mockExec(container, { stdout: "한글\n", stderr: "failure\n", exitCode: 7 });
    expect(
      await session.run({ command: "command", workingDirectory: "src", env: { KEY: "a=b" } }),
    ).toEqual({ stdout: "한글\n", stderr: "failure\n", exitCode: 7 });
    expect(container.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        WorkingDir: "/workspace/src",
        Env: ["KEY=a=b"],
        Tty: false,
        AttachStdin: false,
      }),
    );
    expect(docker.modem.demuxStream).toHaveBeenCalledOnce();
  });

  it("exposes web streams and delivers stdin EOF without losing subsequent stdout", async () => {
    const { provider, container } = fixture();
    const session = await provider.createSession({ sessionId: "one" });
    mockExec(container, { stdout: "", stderr: "warning", interactive: true });
    const process = await session.spawn({ command: "cat", stdin: true });
    const stdout = new Response(process.stdout).text();
    const stderr = new Response(process.stderr).text();
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode("input"));
    await writer.close();
    expect(await stdout).toBe("input");
    expect(await stderr).toBe("warning");
    expect(await process.wait()).toEqual({ exitCode: 0 });
    mockExec(container);
    const closed = await session.spawn({ command: "true" });
    expect(closed).not.toHaveProperty("stdin");
    await closed.wait();
  });

  it.each([new Error("cancelled"), "cancelled"])(
    "rejects wait with the abort reason (%s) and kills the process group",
    async (reason) => {
      const { provider, container } = fixture();
      const session = await provider.createSession({ sessionId: "one" });
      mockExec(container, { interactive: true });
      container.exec.mockResolvedValueOnce({ start: vi.fn().mockResolvedValue(Readable.from([])) });
      const controller = new AbortController();
      const process = await session.spawn({ command: "sleep 60", abortSignal: controller.signal });
      controller.abort(reason);
      await expect(process.wait()).rejects.toBe(reason);
      expect(container.exec).toHaveBeenLastCalledWith(
        expect.objectContaining({ Cmd: ["sh", "-c", "kill -KILL -42"] }),
      );
      await process.kill();
      const before = container.exec.mock.calls.length;
      await expect(session.spawn({ command: "true", abortSignal: controller.signal })).rejects.toBe(
        reason,
      );
      expect(container.exec).toHaveBeenCalledTimes(before);
    },
  );

  it("restricts the surface while forwarding transformations and archives through the full session", async () => {
    const { provider, onRequestTransformations, container } = fixture();
    const session = await provider.createSession({ sessionId: "one" });
    expect(Object.keys(session.restricted()).sort()).toEqual(
      [
        "description",
        "run",
        "spawn",
        "readFile",
        "readTextFile",
        "readBinaryFile",
        "writeFile",
        "writeTextFile",
        "writeBinaryFile",
        "stat",
        "listDirectory",
        "deleteFile",
      ].sort(),
    );
    expect(session.restricted().spawn).toBe(session.spawn);
    await session.addRequestTransformations!([]);
    expect(onRequestTransformations).toHaveBeenCalledWith("one", []);
    const tar = Readable.from([]);
    await session.putArchive("src", tar);
    expect(container.putArchive).toHaveBeenCalledWith(tar, { path: "/workspace/src" });
  });

  it("prunes only labeled containers absent from the DB keep set, including stopped containers", async () => {
    const { provider, docker, container } = fixture();
    vi.mocked(docker.listContainers).mockResolvedValue([
      { Id: "keep", Labels: { "qgrid.agents.session": "one" } },
      { Id: "orphan", Labels: { "qgrid.agents.session": "gone" } },
      { Id: "unrelated", Labels: {} },
    ] as Docker.ContainerInfo[]);
    await provider.pruneOrphans(new Set(["one"]));
    expect(docker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["qgrid.agents.session"] },
    });
    expect(docker.getContainer).toHaveBeenCalledExactlyOnceWith("orphan");
    expect(container.remove).toHaveBeenCalledExactlyOnceWith({ force: true });
  });

  it("reads free space on the data-root filesystem and propagates unavailable paths", async () => {
    const { provider, docker } = fixture();
    vi.spyOn(docker, "info").mockResolvedValue({ DockerRootDir: "/tmp" });
    const stats = await statfs("/tmp");
    expect(await provider.dataRootFreeBytes()).toBeGreaterThan(0);
    expect(await provider.dataRootFreeBytes()).toBeLessThanOrEqual(stats.blocks * stats.bsize);
    vi.mocked(docker.info).mockResolvedValue({ DockerRootDir: "/nonexistent-qgrid-data-root" });
    await expect(provider.dataRootFreeBytes()).rejects.toMatchObject({ code: "ENOENT" });
  });
});
