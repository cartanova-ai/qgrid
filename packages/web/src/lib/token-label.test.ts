import { describe, expect, it } from "vitest";

import { maskAccessToken } from "./token-label";

describe("token credential labels", () => {
  it("displays Antigravity keychain credentials without reading a missing access token", () => {
    expect(maskAccessToken({ authSource: "system-keychain" })).toBe("System Keychain");
  });

  it("preserves OAuth token masking", () => {
    expect(maskAccessToken({ accessToken: "abcdefgh12345678wxyz" })).toBe("abcdefgh...wxyz");
    expect(maskAccessToken({ accessToken: "short-token" })).toBe("short-token");
  });

  it.each([{}, null, undefined, { accessToken: "" }, { accessToken: 123 }])(
    "handles missing or invalid credentials without crashing: %j",
    (credentials) => expect(maskAccessToken(credentials)).toBe("—"),
  );
});
