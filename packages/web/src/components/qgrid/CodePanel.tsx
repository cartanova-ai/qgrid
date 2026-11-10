import { type ReactNode, useEffect, useMemo, useState } from "react";
import CheckIcon from "~icons/lucide/check";
import CopyIcon from "~icons/lucide/copy";

export function CopyButton({ text, dark }: { text: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);

    return () => clearTimeout(id);
  }, [copied]);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
  };

  return (
    <button
      type="button"
      className={`absolute top-2 right-2 p-1 rounded transition-colors ${
        dark ? "text-sand-500 hover:text-sand-300" : "text-sand-400 hover:text-sand-600"
      }`}
      onClick={handleCopy}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-sage-500" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

// Token classes for the code qgrid renders itself: server-generated type declarations and zod
// expressions, and the dashboard's own AI SDK call examples. The grammar is controlled, so one
// regex splits it without a highlighting library. A comment needs whitespace or a line start
// before `//`, so a zod regex literal ending in `\//` stays code.
const CODE_TOKEN_RE =
  /((?:^|(?<=\s))\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\btype\b|\bz\b(?=\.)|\b(?:import|from|const|await|return|satisfies)\b(?!\??:))|(\b(?:string|number|boolean|null|unknown|Record|true|false)\b)|([{}[\]()<>|?:,.=;])|([A-Za-z_$][\w$]*)|(\s+|.)/gm;

export function highlightCode(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let afterTypeKeyword = false;

  for (const match of text.matchAll(CODE_TOKEN_RE)) {
    const [token, comment, str, num, kw, builtin, punct, ident] = match;
    const key = `${match.index}-${token}`;

    if (comment) {
      nodes.push(
        <span key={key} className="text-sand-500">
          {token}
        </span>,
      );
    } else if (str || num) {
      nodes.push(
        <span key={key} className="text-sage-400">
          {token}
        </span>,
      );
    } else if (kw) {
      // Only `type` promotes the next identifier to a type name; `z.` is just a prefix.
      afterTypeKeyword = token === "type";
      nodes.push(
        <span key={key} className="text-sienna-400">
          {token}
        </span>,
      );
    } else if (builtin) {
      nodes.push(
        <span key={key} className="text-blue-300">
          {token}
        </span>,
      );
    } else if (punct) {
      nodes.push(
        <span key={key} className="text-sand-500">
          {token}
        </span>,
      );
    } else if (ident && afterTypeKeyword) {
      // The identifier right after `type` is the type name.
      afterTypeKeyword = false;
      nodes.push(
        <span key={key} className="font-semibold text-sand-50">
          {token}
        </span>,
      );
    } else {
      nodes.push(token);
    }
  }

  return nodes;
}

/**
 * A titled code card: dark highlighted block with a copy button. `actions` sits at the right of
 * the header (mode toggles, notes); `scroll` caps the block's height for long text.
 */
export function CodePanel({
  title,
  code,
  actions,
  scroll = true,
}: {
  title: string;
  code: string;
  actions?: ReactNode;
  scroll?: boolean;
}) {
  const highlighted = useMemo(() => highlightCode(code), [code]);

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center px-4 py-2">
        <span className="text-[11px] uppercase tracking-wider text-sand-500 font-medium">
          {title}
        </span>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      <div className="relative">
        <CopyButton text={code} dark />
        {/* The same dark code tone as the monit terminal (bg-sand-900). */}
        <pre
          className={`bg-sand-900 px-4 py-3 text-[12px] text-sand-200 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed ${scroll ? "max-h-64 overflow-auto" : ""}`}
        >
          {highlighted}
        </pre>
      </div>
    </div>
  );
}
