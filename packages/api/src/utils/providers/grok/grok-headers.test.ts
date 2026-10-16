import { describe, expect, it } from "vitest";

import golden from "./__fixtures__/golden-responses-1.0.60.json";
import { GROK_BUILD_VERSION } from "./grok-constants";
import {
  buildGrokChatHeaders,
  buildGrokMediaHeaders,
  buildGrokProxyGetHeaders,
  buildGrokVoiceHeaders,
  generateTraceparent,
  grokPlatform,
} from "./grok-headers";

const TRANSPORT_HEADERS = new Set(["host", "content-length", "accept-encoding"]);
const TRACEPARENT = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

const placeholders: Record<string, string> = {
  "<user-id>": "11111111-1111-1111-1111-111111111111",
  "<conv-group-id>": "conv-group",
  "<redacted>": "jwt-token",
  "<traceparent>": TRACEPARENT,
  "<conv-id>": "conv-1",
  "<req-id>": "req-1",
  "<session-id>": "22222222-2222-2222-2222-222222222222",
  "<agent-id>": "33333333-3333-3333-3333-333333333333",
};

function substitute(value: string): string {
  return value.replace(/<[a-z-]+>/g, (token) => placeholders[token] ?? token);
}

const macArm = { os: "macos", arch: "aarch64" } as const;

function chatHeaders(overrides: Partial<Parameters<typeof buildGrokChatHeaders>[0]> = {}) {
  return buildGrokChatHeaders({
    bearer: "jwt-token",
    model: "grok-4.7",
    convId: "conv-1",
    reqId: "req-1",
    sessionId: "22222222-2222-2222-2222-222222222222",
    agentId: "33333333-3333-3333-3333-333333333333",
    userId: "11111111-1111-1111-1111-111111111111",
    convGroupId: "conv-group",
    turnIdx: 1,
    traceparent: TRACEPARENT,
    zstd: true,
    platform: macArm,
    ...overrides,
  });
}

describe("Grok chat headers (acceptance A3)", () => {
  it("match the 1.0.60 golden capture in key order and value", () => {
    const expectedOrder = golden.request.headerOrder.filter((name) => !TRANSPORT_HEADERS.has(name));
    const goldenHeaders: Record<string, string> = golden.request.headers;
    const expected = Object.fromEntries(
      expectedOrder.map((name) => [name, substitute(goldenHeaders[name] ?? "")]),
    );
    const headers = chatHeaders();
    expect(Object.keys(headers)).toEqual(expectedOrder);
    expect(headers).toEqual(expected);
  });

  it("pins the fixture to the build version constant", () => {
    expect(golden.request.headers["x-grok-client-version"]).toBe(GROK_BUILD_VERSION);
  });

  it("omits content-encoding for a plain body and adds transient-retry only when given", () => {
    const plain = chatHeaders({ zstd: false });
    expect(plain).not.toHaveProperty("content-encoding");
    expect(plain).not.toHaveProperty("x-grok-transient-retry");
    const retry = chatHeaders({ transientRetry: 2 });
    const keys = Object.keys(retry);
    expect(retry["x-grok-transient-retry"]).toBe("2");
    expect(keys.indexOf("x-grok-transient-retry")).toBe(keys.indexOf("x-grok-turn-idx") + 1);
  });

  it("generates a valid W3C traceparent when absent", () => {
    const headers = chatHeaders({ traceparent: undefined });
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(generateTraceparent()).not.toBe(generateTraceparent());
  });

  it("rejects malformed inputs instead of sending them", () => {
    expect(() => chatHeaders({ traceparent: "00-bad-01" })).toThrow(TypeError);
    expect(() =>
      chatHeaders({ traceparent: "00-00000000000000000000000000000000-0123456789abcdef-01" }),
    ).toThrow(TypeError);
    expect(() => chatHeaders({ bearer: "" })).toThrow(TypeError);
    expect(() => chatHeaders({ bearer: "a b" })).toThrow(TypeError);
    expect(() => chatHeaders({ turnIdx: -1 })).toThrow(TypeError);
    expect(() => chatHeaders({ userId: "" })).toThrow(TypeError);
    expect(() => chatHeaders({ convId: "a\r\nx-evil: 1" })).toThrow(TypeError);
  });

  it("overrides compactions remaining", () => {
    expect(chatHeaders({ compactionsRemaining: 0 })["x-compactions-remaining"]).toBe("0");
  });
});

describe("Grok proxy GET, media and voice headers", () => {
  it("builds proxy GET headers in the captured /settings order", () => {
    const headers = buildGrokProxyGetHeaders({
      bearer: "jwt",
      userId: "u",
      email: "a@example.com",
      platform: macArm,
    });
    expect(Object.entries(headers)).toEqual([
      ["authorization", "Bearer jwt"],
      ["x-xai-token-auth", "xai-grok-cli"],
      ["x-userid", "u"],
      ["x-grok-client-version", "1.0.60"],
      ["x-email", "a@example.com"],
      ["x-grok-client-identifier", "grok-shell"],
      ["x-grok-client-mode", "headless"],
      ["accept", "*/*"],
      ["user-agent", "grok-shell/1.0.60 (macos; aarch64)"],
    ]);
    expect(buildGrokProxyGetHeaders({ bearer: "jwt", userId: "u" })).not.toHaveProperty("x-email");
  });

  it("never attaches the proxy auth trio to api.x.ai", () => {
    expect(Object.entries(buildGrokMediaHeaders({ bearer: "jwt", sessionId: "s-1" }))).toEqual([
      ["user-agent", "xai-grok-build/1.0.60"],
      ["authorization", "Bearer jwt"],
      ["x-grok-session-id", "s-1"],
      ["x-grok-client-version", "1.0.60"],
      ["x-grok-client-identifier", "grok-shell"],
    ]);
    expect(() => buildGrokMediaHeaders({ bearer: "jwt", sessionId: "" })).toThrow(TypeError);
    expect(Object.entries(buildGrokVoiceHeaders({ bearer: "jwt", platform: macArm }))).toEqual([
      ["user-agent", "grok-shell/1.0.60 (macos; aarch64)"],
      ["authorization", "Bearer jwt"],
      ["x-grok-client-version", "1.0.60"],
      ["x-grok-client-identifier", "grok-shell"],
    ]);
  });

  it.each([
    ["darwin", "arm64", "macos", "aarch64"],
    ["darwin", "x64", "macos", "x86_64"],
    ["linux", "arm64", "linux", "aarch64"],
    ["linux", "x64", "linux", "x86_64"],
    ["win32", "x64", "windows", "x86_64"],
  ] as const)("maps %s/%s to %s/%s", (platform, arch, os, rustArch) => {
    expect(grokPlatform(platform, arch)).toEqual({ os, arch: rustArch });
  });
});
