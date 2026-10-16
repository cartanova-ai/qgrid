import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AddTokenProviderOptions } from "./AddTokenModal";
import { DeviceCodeEntry } from "./DeviceCodeEntry";

// AddTokenModal imports the hook, which imports the generated client; keep both inert here.
vi.mock("./use-oauth-login-flow", () => ({ useOAuthLoginFlow: vi.fn() }));

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Finds the button whose text matches, in an unrendered element tree. */
function findButton(node: ReactNode, label: string): { onClick: () => void } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null;
  const { children, onClick } = node.props;
  if (node.type === "button" && onClick && textOf(children).includes(label)) return { onClick };
  return findButton(children, label);
}

function options(overrides: Partial<Parameters<typeof AddTokenProviderOptions>[0]> = {}) {
  return {
    disabled: false,
    loadingProvider: null,
    onStart: vi.fn(),
    onStartGrokDevice: vi.fn(),
    ...overrides,
  };
}

describe("AddTokenProviderOptions", () => {
  it("renders one Grok action that uses the device-code flow", () => {
    const html = renderToStaticMarkup(<AddTokenProviderOptions {...options()} />);

    expect(html).toContain("Login with OpenAI");
    expect(html).toContain("Login with Claude");
    expect(html).toContain("Login with xAI");
    expect(html).not.toContain("Sign in with browser");
  });

  it("routes the Grok action to the device-code handler only", () => {
    const props = options();
    const tree = AddTokenProviderOptions(props);

    findButton(tree, "Login with xAI")?.onClick();
    expect(props.onStartGrokDevice).toHaveBeenCalledTimes(1);
    expect(props.onStart).not.toHaveBeenCalledWith("grok");
  });

  it("disables every provider action until a name is entered", () => {
    const html = renderToStaticMarkup(<AddTokenProviderOptions {...options({ disabled: true })} />);

    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
});

describe("DeviceCodeEntry", () => {
  it("shows the user code and links to the complete verification URL", () => {
    const html = renderToStaticMarkup(
      <DeviceCodeEntry
        flow={{
          status: "waiting",
          userCode: "ABCD-EFGH",
          verificationUri: "https://accounts.x.ai/device",
          verificationUriComplete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
          expiresAt: Date.now() + 600_000,
          slowDown: false,
        }}
        onRestart={vi.fn()}
      />,
    );

    expect(html).toContain("ABCD-EFGH");
    expect(html).toContain('href="https://accounts.x.ai/device?user_code=ABCD-EFGH"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/expires in .*(10:00|9:59)/);
  });

  it("shows expiry and error states", () => {
    expect(
      renderToStaticMarkup(<DeviceCodeEntry flow={{ status: "expired" }} onRestart={vi.fn()} />),
    ).toContain("만료");
    expect(
      renderToStaticMarkup(
        <DeviceCodeEntry
          flow={{ status: "error", message: "Grok login failed: access denied" }}
          onRestart={vi.fn()}
        />,
      ),
    ).toContain("Grok login failed: access denied");
  });
});
