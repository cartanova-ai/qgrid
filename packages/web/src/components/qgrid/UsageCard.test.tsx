import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UsageStateNotes } from "./UsageCard";

// UsageCard imports the OAuth hook, which imports the generated client; keep it inert here.
vi.mock("./use-oauth-login-flow", () => ({
  isOAuthProvider: vi.fn(),
  useOAuthLoginFlow: vi.fn(),
}));

describe("UsageStateNotes", () => {
  it("labels a ZDR token as unavailable for video next to the on-demand label", () => {
    const html = renderToStaticMarkup(
      <UsageStateNotes usage={{ onDemandExcluded: true, zdrVideoExcluded: true }} />,
    );
    expect(html).toContain("excluded: on-demand billing enabled");
    expect(html).toContain("video unavailable: zero data retention");
  });

  it("omits the ZDR label when the flag is false or absent", () => {
    expect(renderToStaticMarkup(<UsageStateNotes usage={{ zdrVideoExcluded: false }} />)).toBe("");
    expect(renderToStaticMarkup(<UsageStateNotes usage={{ tier: "Super" }} />)).not.toContain(
      "zero data retention",
    );
  });
});
