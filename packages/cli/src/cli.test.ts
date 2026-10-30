import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("commander", () => ({
  Command: class {
    name() {
      return this;
    }
    version() {
      return this;
    }
    description() {
      return this;
    }
    option() {
      return this;
    }
    action() {
      return this;
    }
    parse() {}
  },
}));

const { warnMissingRuntimeCliDependencies } = await import("./cli");
const execFileSyncMock = vi.mocked(execFileSync);

describe("runtime CLI dependency check", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claude가 있으면 버전만 확인하고 설치·업데이트하지 않는다", () => {
    execFileSyncMock.mockReturnValue("1.2.3 (Claude Code)\n" as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnMissingRuntimeCliDependencies();

    const invocations = execFileSyncMock.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(invocations).toEqual(["claude --version"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("claude가 없으면 설치하지 않고 경고만 한다", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnMissingRuntimeCliDependencies();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.join("\n")).toContain("claude CLI not found");
  });
});
