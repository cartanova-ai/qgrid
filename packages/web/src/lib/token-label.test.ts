import { describe, expect, it } from "vitest";

import { type TokenCredentials } from "@/services/token/token.types";

import { maskAccessToken } from "./token-label";

function anthropicCredentials(accessToken: string): TokenCredentials {
  return { accessToken, refreshToken: "refresh", expiresAt: 0, accountUuid: "account" };
}

describe("token credential labels", () => {
  it("preserves OAuth token masking", () => {
    expect(maskAccessToken(anthropicCredentials("abcdefgh12345678wxyz"))).toBe(
      "abcdefgh...wxyz",
    );
    expect(maskAccessToken(anthropicCredentials("short-token"))).toBe("short-token");
  });

  it("shows a placeholder for an empty access token", () => {
    expect(maskAccessToken(anthropicCredentials(""))).toBe("—");
  });
});
