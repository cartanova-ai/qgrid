import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { highlightCode } from "./CodePanel";

type Span = ReactElement<{ className: string; children: string }>;

const spans = (code: string) =>
  highlightCode(code)
    .filter((node): node is Span => isValidElement(node))
    .map((node) => [node.props.className, node.props.children]);

describe("highlightCode", () => {
  it("keeps the text and colors comments, strings and keywords", () => {
    const code = 'import { qgrid } from "x"; // note\nconst a = { from: "https://a.b", on: true };';
    const nodes = highlightCode(code);

    expect(nodes.map((node) => (isValidElement<{ children: string }>(node) ? node.props.children : node)).join("")).toBe(code);
    expect(spans(code)).toEqual(
      expect.arrayContaining([
        ["text-sienna-400", "import"],
        ["text-sienna-400", "from"],
        ["text-sand-500", "// note"],
        ["text-sage-400", '"https://a.b"'],
        ["text-blue-300", "true"],
      ]),
    );
    // `from` as a property name is not a keyword.
    expect(spans(code).filter(([, text]) => text === "from")).toHaveLength(1);
  });

  it("leaves a zod regex ending in \\// as code", () => {
    expect(spans("z.string().regex(/^a\\//)").filter(([, text]) => text.startsWith("//"))).toEqual([]);
  });
});
