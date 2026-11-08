import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { shellQuote } from "@ai-sdk/harness/utils";
import { getLogger } from "@logtape/logtape";

import { AgentStateError } from "../../application/agent/agent.model";
import { type AgentWorkspace } from "../../application/agent/agent.types";
import { type DockerSandboxSession } from "./docker-sandbox";

const logger = getLogger(["qgrid", "agents", "workspace"]);

export async function prepareWorkspace(sandbox: DockerSandboxSession, workspace?: AgentWorkspace) {
  if (workspace?.git) {
    const { url, ref, token } = workspace.git;

    // The token lives only in this exec's environment. Git receives a helper command, never
    // a credential-bearing URL, argv value or config file. Ignore inherited Git helpers.
    const helper =
      '!f() { if [ "$1" = get ]; then printf "username=x-access-token\\npassword=%s\\n" "$QGRID_CLONE_TOKEN"; fi; }; f';

    try {
      const result = await sandbox.run({
        command: `git -c credential.helper= -c credential.helper=${shellQuote(helper)} clone --depth 50 -b ${shellQuote(ref)} -- ${shellQuote(url)} /workspace`,
        env: { GIT_TERMINAL_PROMPT: "0", QGRID_CLONE_TOKEN: token ?? "" },
        abortSignal: AbortSignal.timeout(120_000),
      });

      if (result.exitCode !== 0) throw new Error("clone_failed");
    } catch {
      // Git and Docker errors can echo credentials. Discard stdout, stderr and causes.
      throw new AgentStateError(400, "workspace_clone_failed");
    }
  } else if (workspace?.archive) {
    let tar: Buffer;

    try {
      tar = gunzipSync(Buffer.from(workspace.archive, "base64"), {
        maxOutputLength: 64 * 1024 ** 2,
      });
    } catch (error) {
      logger.warn("Workspace archive gunzip failed for session {sessionId}: {message}", {
        sessionId: sandbox.id,
        message: error instanceof Error ? error.message : "Unknown gunzip error",
      });
      throw new AgentStateError(400, "invalid_workspace_archive");
    }

    try {
      await sandbox.putArchive("/workspace", Readable.from(tar));
    } catch (error) {
      logger.warn("Workspace archive putArchive failed for session {sessionId}: {message}", {
        sessionId: sandbox.id,
        message: error instanceof Error ? error.message : "Unknown putArchive error",
      });
      throw new AgentStateError(400, "invalid_workspace_archive");
    }
  }
}

export const WORKSPACE_DIFF_MAX_BYTES = 1024 ** 2;

export async function readWorkspaceDiff(sandbox: DockerSandboxSession): Promise<string> {
  const result = await sandbox.run({
    // Bound output inside the container, before Docker/host buffering. Exit 141 is git's
    // expected SIGPIPE when head reaches the cap. Disable repository-defined diff drivers.
    command: `bash -o pipefail -c 'git -C /workspace diff --no-ext-diff --no-textconv -- | head -c ${WORKSPACE_DIFF_MAX_BYTES}'`,
    abortSignal: AbortSignal.timeout(10_000),
  });

  if (result.exitCode !== 0 && result.exitCode !== 141)
    throw new AgentStateError(409, "workspace_diff_unavailable");

  // Drop an incomplete UTF-8 character at the byte boundary instead of expanding it to U+FFFD.
  return new TextDecoder().decode(
    Buffer.from(result.stdout).subarray(0, WORKSPACE_DIFF_MAX_BYTES),
    { stream: true },
  );
}

/** Sanitize values before logging/polling; the framework's private continuation stays intact. */
export function redactAgentValue<T>(value: T, secrets: readonly string[]): T {
  // These are already-validated domain objects. Recursion preserves their structure and
  // replaces only strings; it is not input validation or domain discrimination.
  /* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
  const redact = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = item;

      for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");

      return text;
    }

    if (Array.isArray(item)) return item.map(redact);

    if (item && typeof item === "object" && !(item instanceof Date))
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, redact(entry)]));

    return item;
  };

  /* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
  // SAFETY: only string values change; keys, arrays, dates and primitive types are preserved.
  return redact(value) as T;
}
