import { beforeEach, describe, expect, it, vi } from "vitest";

const version = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: version }));

describe("Anthropic native extra-body thinking modes", () => {
  beforeEach(() => {
    vi.resetModules();
    version.mockReset();
  });

  it.each([
    ["claude-haiku-5-5", "disabled"],
    ["claude-sonnet-5-5", "between_tools"],
  ])("%s only overrides thinking and ignores caller effort", async (model, type) => {
    const { resolveAnthropicThinking, assertAnthropicThinkingRuntime } = await import("./anthropic-thinking");
    version.mockReturnValue("2.1.295 (Claude Code)");
    const policy = resolveAnthropicThinking(model, false, "max");
    expect(policy.mode).toBe("disabled");
    expect(policy.effort).toBe("low");
    expect(JSON.parse(policy.extraBody!)).toEqual({thinking: {type}});
    assertAnthropicThinkingRuntime(policy.extraBody);
    assertAnthropicThinkingRuntime(policy.extraBody);
    expect(version).toHaveBeenCalledTimes(1);
    expect(resolveAnthropicThinking(model).extraBody).toBeUndefined();
    expect(resolveAnthropicThinking(model, true).extraBody).toBeUndefined();
  });

  it.each(["2.1.294 (Claude Code)", "unrecognized"])("rejects unverified runtime %s without affecting other models", async (output) => {
    const { assertAnthropicThinkingRuntime } = await import("./anthropic-thinking");
    version.mockReturnValue(output);
    expect(() => assertAnthropicThinkingRuntime(undefined)).not.toThrow();
    expect(version).not.toHaveBeenCalled();
    expect(() => assertAnthropicThinkingRuntime('{"thinking":{"type":"disabled"}}')).toThrow("2.1.295");
  });
});
