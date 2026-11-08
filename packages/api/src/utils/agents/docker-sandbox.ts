import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { posix } from "node:path";
import { PassThrough, Readable, Transform, Writable } from "node:stream";

import {
  type HarnessV1NetworkSandboxSession,
  type HarnessV1RequestTransformation,
  type HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import {
  type Experimental_SandboxProcess as SandboxProcess,
  type Experimental_SandboxSession as SandboxSession,
  type Experimental_SandboxSpawnOptions as SpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin as SpawnWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin as SpawnWithoutStdin,
  type Experimental_WritableSandboxProcess as WritableSandboxProcess,
} from "@ai-sdk/provider-utils";
import { getLogger } from "@logtape/logtape";
import { type default as Docker } from "dockerode";

const logger = getLogger(["qgrid", "agents"]);
const NETWORK = "qgrid-agents";
const SESSION_LABEL = "qgrid.agents.session";
const BRIDGE_PORT = 8787;

export type DockerSandboxOptions = {
  image: string;
  subnet?: string;
  hostAlias: { kind: "gateway" } | { kind: "host-gateway" };
  memory: number;
  nanoCpus: number;
  pidsLimit: number;
  onRequestTransformations: (
    sessionId: string,
    rules: ReadonlyArray<HarnessV1RequestTransformation>,
  ) => void | PromiseLike<void>;
};

export type DockerSandboxSession = HarnessV1NetworkSandboxSession & {
  putArchive(path: string, tarStream: NodeJS.ReadableStream): Promise<void>;
};

// Dockerode rejects with arbitrary values; narrow its errors at this boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function hasStatus(error: unknown, status: number): boolean {
  return error instanceof Error && "statusCode" in error && error.statusCode === status;
}

function containerName(sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sessionId)) {
    throw new Error("Invalid Docker sandbox session ID");
  }

  return `qgrid-agents-${sessionId}`;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function subnetGateway(subnet: string): string {
  const [address = "", prefix, extra] = subnet.split("/");
  const bits = Number(prefix);

  if (!isIPv4(address) || !Number.isInteger(bits) || bits < 1 || bits > 30 || extra !== undefined) {
    throw new Error(`Invalid sandbox IPv4 subnet: ${subnet}`);
  }

  const octets = address.split(".").map(Number);
  const network = octets.reduce((value, octet) => value * 256 + octet, 0);
  const mask = (0xffffffff << (32 - bits)) >>> 0;

  if ((network & mask) >>> 0 !== network)
    throw new Error(`Subnet must use its network address: ${subnet}`);

  return [24, 16, 8, 0].map((shift) => ((network + 1) >>> shift) & 255).join(".");
}

async function collect(process: SandboxProcess) {
  const [stdout, stderr, result] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).arrayBuffer(),
    process.wait(),
  ]);

  return { ...result, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

export class DockerSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = "harness-sandbox-v1";
  readonly providerId = "qgrid-docker";
  private networkGateway?: string;

  constructor(
    private readonly docker: Docker,
    private readonly options: DockerSandboxOptions,
  ) {}

  /** Also used by the runner to bind the relay before creating its first session. */
  async ensureNetwork(): Promise<string> {
    const network = this.docker.getNetwork(NETWORK);
    let info: Docker.NetworkInspectInfo;

    try {
      info = await network.inspect();
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;

      try {
        const subnet = this.options.subnet ?? "172.30.0.0/24";
        await this.docker.createNetwork({
          Name: NETWORK,
          Driver: "bridge",
          // Docker may defer allocating an implicit gateway until the first endpoint.
          // Declare it so inspect can supply the relay address before container creation.
          IPAM: { Config: [{ Subnet: subnet, Gateway: subnetGateway(subnet) }] },
          Options: { "com.docker.network.bridge.name": "br-qgrid-agents" },
        });
      } catch (createError) {
        // Another API process may create the shared network concurrently.
        if (!hasStatus(createError, 409)) throw createError;
      }

      info = await network.inspect();
    }

    const gateway = info.IPAM?.Config?.[0]?.Gateway;

    if (
      info.Driver !== "bridge" ||
      info.Options?.["com.docker.network.bridge.name"] !== "br-qgrid-agents" ||
      info.IPAM?.Config?.[0]?.Subnet !== (this.options.subnet ?? "172.30.0.0/24") ||
      !gateway
    ) {
      throw new Error("qgrid-agents network does not match the configured bridge/subnet/gateway");
    }

    this.networkGateway = gateway;

    return gateway;
  }

  get gateway(): string | undefined {
    return this.networkGateway;
  }

  async createSession(
    options: Parameters<HarnessV1SandboxProvider["createSession"]>[0] & {
      env?: Record<string, string>;
    } = {},
  ): Promise<DockerSandboxSession> {
    const { sessionId = randomUUID(), abortSignal } = options;
    const name = containerName(sessionId);
    abortSignal?.throwIfAborted();
    const gateway = await this.ensureNetwork();
    abortSignal?.throwIfAborted();

    const container = await this.docker.createContainer({
      name,
      Image: this.options.image,
      User: "node",
      Env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: { [`${BRIDGE_PORT}/tcp`]: {} },
      Labels: {
        [SESSION_LABEL]: sessionId,
        "qgrid.agents.env-keys": JSON.stringify(Object.keys(options.env ?? {})),
      },
      HostConfig: {
        NetworkMode: NETWORK,
        ExtraHosts: [
          `host.docker.internal:${this.options.hostAlias.kind === "gateway" ? gateway : "host-gateway"}`,
        ],
        PortBindings: { [`${BRIDGE_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "0" }] },
        Memory: this.options.memory,
        NanoCpus: this.options.nanoCpus,
        PidsLimit: this.options.pidsLimit,
        Privileged: false,
      },
    });

    try {
      abortSignal?.throwIfAborted();
      await container.start();
      const session = await this.attach(sessionId, container);
      await options.onFirstCreate?.(session.restricted(), { abortSignal });
      abortSignal?.throwIfAborted();
      logger.info("Created sandbox {sessionId}", { sessionId });

      return session;
    } catch (error) {
      await container.remove({ force: true }).catch((cleanupError: Error) => {
        logger.error("Failed to clean up sandbox {sessionId}: {error}", {
          sessionId,
          error: cleanupError,
        });
      });
      throw error;
    }
  }

  async resumeSession({
    sessionId,
    abortSignal,
  }: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<DockerSandboxSession> {
    abortSignal?.throwIfAborted();
    await this.ensureNetwork();
    const container = this.docker.getContainer(containerName(sessionId));
    const info = await container.inspect();

    if (
      info.HostConfig.NetworkMode !== NETWORK ||
      info.Config.Labels[SESSION_LABEL] !== sessionId
    ) {
      throw new Error(`Container does not belong to sandbox ${sessionId}`);
    }

    abortSignal?.throwIfAborted();

    if (!info.State.Running) await container.start();

    return this.attach(sessionId, container);
  }

  async stopContainer(sessionId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(sessionId)).stop({ t: 5 });
    } catch (error) {
      if (!hasStatus(error, 304) && !hasStatus(error, 404)) throw error;
    }
  }

  async destroyContainer(sessionId: string): Promise<void> {
    try {
      await this.docker.getContainer(containerName(sessionId)).remove({ force: true });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
  }

  async callerEnvironment(sessionId: string): Promise<Record<string, string>> {
    const info = await this.docker.getContainer(containerName(sessionId)).inspect();
    const keys: string[] = JSON.parse(info.Config.Labels["qgrid.agents.env-keys"] ?? "[]");

    return Object.fromEntries(
      (info.Config.Env ?? []).flatMap((entry) => {
        const separator = entry.indexOf("=");
        const key = entry.slice(0, separator);

        return keys.includes(key) ? [[key, entry.slice(separator + 1)]] : [];
      }),
    );
  }

  async inspectIp(sessionId: string): Promise<string> {
    const info = await this.docker.getContainer(containerName(sessionId)).inspect();
    const ip = info.NetworkSettings.Networks[NETWORK]?.IPAddress;

    if (!ip) throw new Error(`Sandbox ${sessionId} has no IP on ${NETWORK}`);

    return ip;
  }

  async pruneOrphans(keepSessionIds: ReadonlySet<string>): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [SESSION_LABEL] },
    });

    for (const container of containers) {
      const sessionId = container.Labels[SESSION_LABEL];

      if (sessionId === undefined || keepSessionIds.has(sessionId)) continue;

      try {
        await this.docker.getContainer(container.Id).remove({ force: true });
        logger.info("Removed orphan sandbox {sessionId}", { sessionId });
      } catch (error) {
        if (!hasStatus(error, 404)) throw error;
      }
    }
  }

  /** Requires the daemon's data-root filesystem to be visible to the API host. */
  async dataRootFreeBytes(): Promise<number> {
    const { DockerRootDir } = await this.docker.info();
    const stats = await statfs(DockerRootDir);

    return stats.bavail * stats.bsize;
  }

  private async attach(
    sessionId: string,
    container: Docker.Container,
  ): Promise<DockerSandboxSession> {
    const info = await container.inspect();
    const base = info.Config.WorkingDir || "/";
    // SAFETY: bind preserves all three spawn overloads; TypeScript keeps only the last one.
    const spawn = this.spawn.bind(this, container, base) as SandboxSession["spawn"];

    const run: SandboxSession["run"] = async (options) => {
      const result = await collect(await spawn(options));

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };

    const pathCommand = (path: string) => quote(posix.resolve(base, path));

    const readBinaryFile: SandboxSession["readBinaryFile"] = async ({ path, abortSignal }) => {
      const target = pathCommand(path);

      const result = await collect(
        await spawn({
          command: `if [ ! -e ${target} ]; then exit 44; fi; cat -- ${target}`,
          abortSignal,
        }),
      );

      if (result.exitCode === 44) return null;

      if (result.exitCode !== 0) throw new Error(`Read ${path} failed: ${result.stderr}`);

      return new Uint8Array(result.stdout);
    };

    const writeFile: SandboxSession["writeFile"] = async ({ path, content, abortSignal }) => {
      const target = pathCommand(path);

      const process = await spawn({
        command: `mkdir -p -- ${quote(posix.dirname(posix.resolve(base, path)))} && cat > ${target}`,
        stdin: true,
        abortSignal,
      });

      const resultPromise = collect(process);

      const [, result] = await Promise.all([
        content.pipeTo(process.stdin, { signal: abortSignal }).catch(async (error) => {
          await process.kill();
          throw error;
        }),
        resultPromise,
      ]);

      if (result.exitCode !== 0) throw new Error(`Write ${path} failed: ${result.stderr}`);
    };

    const files: SandboxSession = {
      description: `Docker sandbox ${containerName(sessionId)} (working directory ${base})`,
      run,
      spawn,
      readBinaryFile,
      readFile: async (options) => {
        const bytes = await readBinaryFile(options);

        return bytes === null ? null : new Blob([new Uint8Array(bytes)]).stream();
      },
      readTextFile: async ({ encoding = "utf-8", startLine, endLine, ...options }) => {
        const bytes = await readBinaryFile(options);

        if (bytes === null) return null;

        const text = new TextDecoder(encoding).decode(bytes);

        return startLine === undefined && endLine === undefined
          ? text
          : text
              .split("\n")
              .slice((startLine ?? 1) - 1, endLine)
              .join("\n");
      },
      writeFile,
      writeBinaryFile: ({ content, ...options }) =>
        writeFile({
          ...options,
          content: new Blob([new Uint8Array(content)]).stream(),
        }),
      writeTextFile: ({ content, encoding = "utf-8", ...options }) => {
        if (!Buffer.isEncoding(encoding)) throw new Error(`Unsupported encoding: ${encoding}`);

        return writeFile({
          ...options,
          content: new Blob([Buffer.from(content, encoding)]).stream(),
        });
      },
      stat: async ({ path, abortSignal }) => {
        const target = pathCommand(path);

        const result = await run({
          command: `if [ ! -e ${target} ]; then exit 44; fi; stat -L -c '%F|%s' -- ${target}`,
          abortSignal,
        });

        if (result.exitCode === 44) return null;

        if (result.exitCode !== 0) throw new Error(`Stat ${path} failed: ${result.stderr}`);

        const [kind, size] = result.stdout.trim().split("|");

        return {
          type:
            kind === "directory"
              ? "directory"
              : kind === "regular file" || kind === "regular empty file"
                ? "file"
                : "other",
          size: Number(size),
        };
      },
      listDirectory: async ({ path, abortSignal }) => {
        const target = pathCommand(path);

        const result = await run({
          command: `if [ ! -e ${target} ]; then exit 44; fi; [ -d ${target} ] && find ${target} -mindepth 1 -maxdepth 1 -printf '%y %f\\0'`,
          abortSignal,
        });

        if (result.exitCode === 44) return null;

        if (result.exitCode !== 0) throw new Error(`List ${path} failed: ${result.stderr}`);

        return result.stdout
          .split("\0")
          .slice(0, -1)
          .map((entry) => ({
            name: entry.slice(2),
            type:
              entry[0] === "f"
                ? "file"
                : entry[0] === "d"
                  ? "directory"
                  : entry[0] === "l"
                    ? "symlink"
                    : "other",
          }));
      },
      deleteFile: async ({ path, abortSignal }) => {
        const target = pathCommand(path);

        const result = await run({
          command: `if [ ! -e ${target} ] && [ ! -L ${target} ]; then exit 44; fi; rm -- ${target}`,
          abortSignal,
        });

        if (result.exitCode === 44) return false;

        if (result.exitCode !== 0) throw new Error(`Delete ${path} failed: ${result.stderr}`);

        return true;
      },
    };

    const getPortEndpoint: HarnessV1NetworkSandboxSession["getPortEndpoint"] = async ({
      port,
      protocol = "ws",
    }) => {
      const current = await container.inspect();

      const binding = current.NetworkSettings.Ports[`${port}/tcp`]?.find(
        (item) => item.HostIp === "127.0.0.1",
      );

      if (!binding?.HostPort) throw new Error(`Port ${port} is not published for ${sessionId}`);

      return { url: `${protocol}://127.0.0.1:${binding.HostPort}` };
    };

    return {
      ...files,
      id: sessionId,
      defaultWorkingDirectory: base,
      ports: [BRIDGE_PORT],
      getPortEndpoint,
      getPortUrl: async (options) => (await getPortEndpoint(options)).url,
      stop: () => this.stopContainer(sessionId),
      destroy: () => this.destroyContainer(sessionId),
      addRequestTransformations: async (rules) => {
        await this.options.onRequestTransformations(sessionId, rules);
      },
      restricted: () => files,
      putArchive: async (path, tarStream) => {
        await container.putArchive(tarStream, { path: posix.resolve(base, path) });
      },
    };
  }

  private spawn(
    container: Docker.Container,
    base: string,
    options: SpawnWithStdin,
  ): Promise<WritableSandboxProcess>;
  private spawn(
    container: Docker.Container,
    base: string,
    options: SpawnWithoutStdin,
  ): Promise<SandboxProcess>;
  private spawn(
    container: Docker.Container,
    base: string,
    options: SpawnOptions,
  ): Promise<SandboxProcess | WritableSandboxProcess>;
  private async spawn(
    container: Docker.Container,
    base: string,
    options: SpawnOptions,
  ): Promise<SandboxProcess | WritableSandboxProcess> {
    const { command, env, workingDirectory, stdin = false, abortSignal } = options;
    abortSignal?.throwIfAborted();

    // Docker exposes a host PID and has no exec-kill API. A private first stdout line gives
    // us the container PID; setsid lets kill/abort terminate the command's process group.
    const exec = await container.exec({
      Cmd: ["setsid", "--wait", "sh", "-c", 'printf "%s\\n" "$$"; exec sh -c "$1"', "sh", command],
      WorkingDir: posix.resolve(base, workingDirectory ?? "."),
      Env: Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`),
      AttachStdin: stdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: "node",
      Privileged: false,
    });

    abortSignal?.throwIfAborted();
    const stream = await exec.start({ hijack: true, stdin, Tty: false });
    const pidReady = Promise.withResolvers<number>();
    let prefix = "";
    let pid: number | undefined;

    const stdout = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (pid !== undefined) {
          callback(null, chunk);

          return;
        }

        const newline = chunk.indexOf(10);

        if (newline === -1) {
          prefix += chunk.toString();
          callback();

          return;
        }

        pid = Number(prefix + chunk.subarray(0, newline).toString());

        if (!Number.isSafeInteger(pid) || pid <= 1) {
          callback(new Error("Invalid sandbox exec PID"));

          return;
        }

        pidReady.resolve(pid);
        callback(null, chunk.subarray(newline + 1));
      },
    });

    const stderr = new PassThrough();
    const completion = Promise.withResolvers<{ exitCode: number }>();
    let ended = false;
    let failed = false;
    let killPromise: Promise<void> | undefined;

    const kill = (): Promise<void> => {
      if (ended) return Promise.resolve();

      killPromise ??= (async () => {
        const processId = await pidReady.promise;

        if (ended) return;

        const killer = await container.exec({
          Cmd: ["sh", "-c", `kill -KILL -${processId}`],
          AttachStdout: true,
          AttachStderr: true,
          User: "node",
        });

        const output = await killer.start({ hijack: true, stdin: false });
        output.resume();
      })();

      return killPromise;
    };

    const fail = (error: Error) => {
      if (failed) return;

      failed = true;
      ended = true;
      abortSignal?.removeEventListener("abort", onAbort);
      pidReady.reject(error);
      completion.reject(error);
      stdout.destroy(error);
      stderr.destroy(error);
      stream.destroy();
    };

    const onAbort = () => {
      // Do not just destroy the hijacked socket: that leaves the exec running in Docker.
      kill().then(() => {
        const reason = abortSignal?.reason;
        completion.reject(reason);
        fail(
          reason instanceof Error
            ? reason
            : new Error("Sandbox command aborted", { cause: reason }),
        );
      }, fail);
    };

    // Attach rejection handlers even when callers only consume the output and never wait().
    void completion.promise.catch(() => {});
    void pidReady.promise.catch(() => {});
    stdout.on("error", fail);
    stderr.on("error", fail);
    stream.once("error", fail);
    stream.once("end", () => {
      ended = true;
      abortSignal?.removeEventListener("abort", onAbort);
      stdout.end();
      stderr.end();

      if (pid === undefined)
        pidReady.reject(new Error("Sandbox exec ended before reporting its PID"));

      exec.inspect().then((state) => {
        if (abortSignal?.aborted) completion.reject(abortSignal.reason);
        else if (state.ExitCode === null)
          completion.reject(new Error("Sandbox exec has no exit code"));
        else completion.resolve({ exitCode: state.ExitCode });
      }, completion.reject);
    });
    stream.once("close", () => {
      if (!ended) fail(new Error("Sandbox exec stream closed before EOF"));
    });
    this.docker.modem.demuxStream(stream, stdout, stderr);
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    if (abortSignal?.aborted) onAbort();

    const process: SandboxProcess = {
      pid: await pidReady.promise,
      // SAFETY: Node's byte streams implement the DOM stream contract at runtime.
      stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      // SAFETY: Same Node/DOM declaration mismatch as stdout; chunks are Buffers.
      stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
      wait: () => completion.promise,
      kill,
    };

    logger.debug("Started sandbox exec {pid}", { pid: process.pid });

    // SAFETY: The hijacked socket accepts byte chunks and closes stdin with a half-close.
    return stdin
      ? { ...process, stdin: Writable.toWeb(stream) as WritableStream<Uint8Array> }
      : process;
  }
}
