import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { type DockerSandboxSession } from "./docker-sandbox";
import { prepareWorkspace, readWorkspaceDiff, WORKSPACE_DIFF_MAX_BYTES } from "./workspace";

function fixture() {
  const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  const putArchive = vi.fn().mockResolvedValue(undefined);
  return { run, putArchive, sandbox: { run, putArchive } as unknown as DockerSandboxSession };
}

describe("agent workspace", () => {
  it("clones with a transient credential helper and discards credential-bearing errors", async () => {
    const { run, sandbox } = fixture();
    const git = { url: "https://example.com/repo.git", ref: "main", token: "private-token" };
    await prepareWorkspace(sandbox, { git });
    const options = run.mock.calls[0]![0];
    expect(options.command).toContain("credential.helper=");
    expect(options.command).toContain("$QGRID_CLONE_TOKEN");
    expect(options.command).toContain("clone --depth 50 -b 'main' -- 'https://example.com/repo.git' /workspace");
    expect(options.command).not.toContain(git.token);
    expect(options.env).toEqual({ GIT_TERMINAL_PROMPT: "0", QGRID_CLONE_TOKEN: git.token });
    run.mockRejectedValue(new Error(`Git failed with ${git.token}`));
    const error = await prepareWorkspace(sandbox, { git }).catch((error: Error) => error);
    expect(error).toMatchObject({ status: 400, message: "workspace_clone_failed" });
    expect(error).not.toHaveProperty("cause");
  });

  it("expands base64 gzip to a tar stream for /workspace and rejects invalid gzip", async () => {
    const { sandbox, putArchive } = fixture();
    const tar = Buffer.alloc(1024); // Empty tar: two zero blocks.
    await prepareWorkspace(sandbox, { archive: gzipSync(tar).toString("base64") });
    expect(putArchive.mock.calls[0]![0]).toBe("/workspace");
    const chunks: Buffer[] = [];
    for await (const chunk of putArchive.mock.calls[0]![1]) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(tar);
    await expect(prepareWorkspace(sandbox, { archive: "YWJj" })).rejects.toMatchObject({ status: 400, code: "invalid_workspace_archive" });
    expect(putArchive).toHaveBeenCalledTimes(1);
  });

  it("bounds git diff in the container and retains valid UTF-8 within 1 MiB", async () => {
    const { sandbox, run } = fixture();
    run.mockResolvedValue({ exitCode: 141, stdout: "가".repeat(WORKSPACE_DIFF_MAX_BYTES), stderr: "" });
    const diff = await readWorkspaceDiff(sandbox);
    expect(run.mock.calls[0]![0].command).toContain(`head -c ${WORKSPACE_DIFF_MAX_BYTES}`);
    expect(run.mock.calls[0]![0].command).toContain("--no-ext-diff --no-textconv");
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(WORKSPACE_DIFF_MAX_BYTES);
    expect(diff).not.toContain("�");
    run.mockResolvedValue({ exitCode: 128, stdout: "", stderr: "not a repository" });
    await expect(readWorkspaceDiff(sandbox)).rejects.toMatchObject({ status: 409 });
  });
});
