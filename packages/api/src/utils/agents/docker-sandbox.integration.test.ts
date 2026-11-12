import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import Docker from "dockerode";
import { expect, it } from "vitest";

import { DockerSandboxProvider } from "./docker-sandbox";

// Requires the image built by deploy/sandbox-pi. For Docker Desktop, set DOCKER_HOST
// to the Unix endpoint shown by `docker context inspect` before running Vitest.
it.skipIf(process.env.QGRID_AGENTS_IT !== "1")(
  "Docker sandbox lifecycle, streams, files and cancellation",
  async () => {
    const docker = new Docker();
    const provider = new DockerSandboxProvider(docker, {
      image: process.env.QGRID_AGENTS_IT_IMAGE ?? "qgrid-sandbox-pi:dev",
      memory: 512 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 128,
    });
    const sessionId = `it-${randomUUID()}`;
    const temporary = await mkdtemp(join(tmpdir(), "qgrid-sandbox-it-"));

    try {
      const session = await provider.createSession({ sessionId });
      expect(
        await session.run({
          command: "printf '%s' \"$VALUE\"; printf error >&2; exit 7",
          env: { VALUE: "hello" },
        }),
      ).toEqual({ stdout: "hello", stderr: "error", exitCode: 7 });
      expect(await session.run({ command: "pwd", workingDirectory: "/tmp" })).toMatchObject({
        stdout: "/tmp\n",
        exitCode: 0,
      });

      const echo = await session.spawn({ command: "cat; printf done >&2", stdin: true });
      const out = new Response(echo.stdout).text();
      const err = new Response(echo.stderr).text();
      const writer = echo.stdin.getWriter();
      const input = "한글\n".repeat(32_768);
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
      expect(await out).toBe(input);
      expect(await err).toBe("done");
      expect(await echo.wait()).toEqual({ exitCode: 0 });

      const closedStdin = await session.run({ command: "cat; printf eof" });
      expect(closedStdin.stdout).toBe("eof");
      const path = "nested/quote' and\nnewline.txt";
      await session.writeTextFile({ path, content: "first\n둘째\nthird" });
      expect(await session.readTextFile({ path, startLine: 2, endLine: 2 })).toBe("둘째");
      expect(await session.stat({ path })).toEqual({
        type: "file",
        size: Buffer.byteLength("first\n둘째\nthird"),
      });
      expect(await session.listDirectory({ path: "nested" })).toEqual([
        { type: "file", name: "quote' and\nnewline.txt" },
      ]);
      const bytes = new Uint8Array([0, 255, 128, 10]);
      await session.writeBinaryFile({ path: "binary", content: bytes });
      expect(await session.readBinaryFile({ path: "binary" })).toEqual(bytes);
      await session.writeFile({ path: "streamed", content: new Blob([bytes]).stream() });
      expect(
        new Uint8Array(
          await new Response(await session.readFile({ path: "streamed" })).arrayBuffer(),
        ),
      ).toEqual(bytes);
      await session.run({ command: "ln -s binary link; ln -s missing dangling" });
      expect(await session.stat({ path: "link" })).toEqual({ type: "file", size: 4 });
      expect(await session.deleteFile({ path: "dangling" })).toBe(true);
      expect(await session.deleteFile({ path })).toBe(true);
      expect(await session.deleteFile({ path })).toBe(false);
      expect(await session.readTextFile({ path })).toBeNull();
      expect(await session.stat({ path })).toBeNull();
      expect(await session.listDirectory({ path: "missing" })).toBeNull();
      await expect(session.listDirectory({ path: "binary" })).rejects.toThrow();
      await expect(session.deleteFile({ path: "nested" })).rejects.toThrow();

      await writeFile(join(temporary, "archived.txt"), "archive content");
      await promisify(execFile)(
        "tar",
        ["--format=ustar", "-cf", join(temporary, "input.tar"), "-C", temporary, "archived.txt"],
        {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        },
      );
      await session.putArchive(
        session.defaultWorkingDirectory,
        createReadStream(join(temporary, "input.tar")),
      );
      expect(await session.readTextFile({ path: "archived.txt" })).toBe("archive content");

      expect(await provider.inspectIp(sessionId)).toMatch(/^172\.30\.0\./);
      // bash semantics inside the sandbox (D27).
      expect(await session.run({ command: "set -o pipefail && echo ok" })).toMatchObject({ stdout: "ok\n", exitCode: 0 });

      const controller = new AbortController();
      const sleeper = await session.spawn({
        command: "sleep 60 & wait",
        abortSignal: controller.signal,
      });
      const reason = new Error("integration abort");
      controller.abort(reason);
      await expect(sleeper.wait()).rejects.toBe(reason);
      // Verify the command is actually gone, not merely detached from its Docker socket.
      await expect
        .poll(
          async () =>
            (await session.run({ command: `kill -0 -${sleeper.pid} 2>/dev/null` })).exitCode,
        )
        .not.toBe(0);

      await session.stop();
      await session.stop();
      expect((await docker.getContainer(`qgrid-agents-${sessionId}`).inspect()).State.Running).toBe(
        false,
      );
      const resumed = await provider.resumeSession({ sessionId });
      expect(await resumed.readTextFile({ path: "archived.txt" })).toBe("archive content");
      expect((await resumed.run({ command: "true" })).exitCode).toBe(0);
      await resumed.destroy();
      await resumed.destroy();
      await expect(
        docker.getContainer(`qgrid-agents-${sessionId}`).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await provider.destroyContainer(sessionId);
      await rm(temporary, { recursive: true, force: true });
    }
  },
  60_000,
);
