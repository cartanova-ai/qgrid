import { describe, expect, it } from "vitest";

import { tokenIdentityKey, UnknownTokenProviderError } from "./token.model";

describe("tokenIdentityKey", () => {
  it.each([
    ["anthropic", "accountUuid"],
    ["openai", "accountId"],
    ["grok", "userId"],
  ] as const)("%s accounts are identified by credentials.%s", (provider, key) => {
    expect(tokenIdentityKey(provider)).toBe(key);
  });

  it.each(["", "mistral", "constructor", "__proto__", "Grok"])(
    "rejects unknown provider %j with a typed error",
    (provider) => {
      expect(() => tokenIdentityKey(provider)).toThrow(UnknownTokenProviderError);
    },
  );
});
