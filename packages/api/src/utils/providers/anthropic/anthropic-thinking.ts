import { execFileSync } from "node:child_process";

import { resolveAnthropicEffort } from "../common/effort";
import { ThinkingValidationError } from "../common/thinking";
import {
  ANTHROPIC_DEFAULT_EFFORT,
  canonicalAnthropicModel,
  usesAdaptiveThinking,
} from "./anthropic-constants";

const THINKING_OFF_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
]);

let extraBodyRuntimeSupported: boolean | undefined;

/** These modes were verified through native extra-body delivery on Claude Code 2.1.295. */
export function assertAnthropicThinkingRuntime(extraBody: string | undefined): void {
  if (!extraBody) return;
  if (extraBodyRuntimeSupported === undefined) {
    try {
      const version = execFileSync("claude", ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      }).match(/^(\d+)\.(\d+)\.(\d+)/);
      const [major, minor, patch] = version?.slice(1).map(Number) ?? [];
      extraBodyRuntimeSupported =
        major !== undefined &&
        minor !== undefined &&
        patch !== undefined &&
        (major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 295))));
    } catch {
      extraBodyRuntimeSupported = false;
    }
  }
  if (!extraBodyRuntimeSupported) {
    throw new ThinkingValidationError(
      "thinking:false for Haiku 5.5 and Sonnet 5.5 requires Claude Code 2.1.295 or later; runtime version could not be verified",
    );
  }
}

export function resolveAnthropicThinking(model: string, thinking?: boolean, effort?: string) {
  const canonical = canonicalAnthropicModel(model);
  if (thinking === false && !THINKING_OFF_MODELS.has(canonical)) {
    const reason = usesAdaptiveThinking(canonical)
      ? "this model requires thinking"
      : "thinking-off support has not been verified for this model";
    throw new ThinkingValidationError(
      `thinking:false is not supported for anthropic/${canonical}: ${reason}`,
    );
  }
  return {
    // Never accept caller-provided extra body data or inherit it from the host environment.
    extraBody:
      thinking === false && (canonical === "claude-haiku-5-5" || canonical === "claude-sonnet-5-5")
        ? JSON.stringify({
            thinking: { type: canonical === "claude-sonnet-5-5" ? "between_tools" : "disabled" },
          })
        : undefined,
    mode:
      thinking === true
        ? ("adaptive" as const)
        : thinking === false || !usesAdaptiveThinking(canonical)
          ? ("disabled" as const)
          : undefined,
    effort:
      thinking === false
        ? ANTHROPIC_DEFAULT_EFFORT
        : (resolveAnthropicEffort(effort) ?? ANTHROPIC_DEFAULT_EFFORT),
  };
}
