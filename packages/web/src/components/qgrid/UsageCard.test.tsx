import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UsageStateNotes } from "./UsageCard";

// UsageCard imports the OAuth hook, which imports the generated client; keep it inert here.
vi.mock("./use-oauth-login-flow", () => ({
  isOAuthProvider: vi.fn(),
  useOAuthLoginFlow: vi.fn(),
}));

describe("UsageStateNotes", () => {
  it("labels an on-demand-excluded token", () => {
    const html = renderToStaticMarkup(<UsageStateNotes usage={{ onDemandExcluded: true }} />);
    expect(html).toContain("excluded: on-demand billing enabled");
  });
});
