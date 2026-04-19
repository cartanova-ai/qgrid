import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import ArrowLeftIcon from "~icons/lucide/arrow-left";
import CheckIcon from "~icons/lucide/check";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import CopyIcon from "~icons/lucide/copy";

import { RequestLogService } from "@/services/services.generated";

const showSearchSchema = z.object({
  id: z.number(),
});

export const Route = createFileRoute("/requests/show")({
  validateSearch: showSearchSchema,
  component: RequestShowPage,
});

function RequestShowPage() {
  const { id } = Route.useSearch();
  return <RequestDetail id={id} />;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function JsonValue({ value, defaultOpen = true }: { value: unknown; defaultOpen?: boolean }) {
  if (value === null) return <span className="text-sand-400">null</span>;
  if (value === undefined) return <span className="text-sand-400">undefined</span>;
  if (typeof value === "boolean") return <span className="text-amber-600">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-blue-600">{String(value)}</span>;
  if (typeof value === "string") {
    if (value.length > 200) {
      return (
        <details className="inline">
          <summary className="cursor-pointer text-sage-700">
            &quot;{value.slice(0, 80)}...&quot;{" "}
            <span className="text-sand-400 text-[10px]">({value.length} chars)</span>
          </summary>
          <pre className="mt-1 ml-2 text-sage-700 whitespace-pre-wrap wrap-break-word">
            &quot;{value}&quot;
          </pre>
        </details>
      );
    }
    return <span className="text-sage-700">&quot;{value}&quot;</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-sand-500">[]</span>;
    return (
      <details open={defaultOpen} className="inline-block w-full">
        <summary className="cursor-pointer text-sand-500">[]</summary>
        <div className="ml-4 border-l border-sand-200 pl-3">
          {value.map((item, i) => (
            <div key={i} className="py-0.5">
              <JsonValue value={item} defaultOpen />
            </div>
          ))}
        </div>
      </details>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-sand-500">{"{}"}</span>;
    return (
      <details open={defaultOpen} className="inline-block w-full">
        <summary className="cursor-pointer text-sand-500">{"{}"}</summary>
        <div className="ml-4 border-l border-sand-200 pl-3">
          {entries.map(([key, val]) => (
            <div key={key} className="py-0.5">
              <span className="text-sienna-500 font-medium">{key}</span>
              <span className="text-sand-400">: </span>
              <JsonValue value={val} defaultOpen />
            </div>
          ))}
        </div>
      </details>
    );
  }
  return <span>{String(value)}</span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
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
      className="absolute top-2 right-2 p-1 rounded text-sand-400 hover:text-sand-600 transition-colors"
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

function FormattedContent({ text, markdown }: { text: string; markdown?: boolean }) {
  const parsed = tryParseJson(text);
  const [mode, setMode] = useState<"pretty" | "plain">("pretty");

  if (parsed === null) {
    if (markdown) {
      return (
        <div className="prose prose-sm prose-sand max-w-none">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      );
    }
    return (
      <pre className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
        {text}
      </pre>
    );
  }

  return (
    <div>
      <div className="flex gap-1 mb-2">
        <button
          type="button"
          className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${mode === "plain" ? "bg-sand-200 text-sand-700" : "text-sand-400 hover:text-sand-600"}`}
          onClick={() => setMode("plain")}
        >
          Plain
        </button>
        <button
          type="button"
          className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${mode === "pretty" ? "bg-sand-200 text-sand-700" : "text-sand-400 hover:text-sand-600"}`}
          onClick={() => setMode("pretty")}
        >
          Pretty
        </button>
      </div>
      {mode === "pretty" ? (
        <div className="text-sm font-mono leading-relaxed">
          <JsonValue value={parsed} />
        </div>
      ) : (
        <pre className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex items-center gap-1 cursor-pointer select-none list-none">
        <ChevronDownIcon className="size-3.5 text-sand-400 transition-transform group-open:rotate-0 -rotate-90" />
        <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
          {title}
        </span>
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

function RequestDetail({ id }: { id: number }) {
  const { data, isLoading } = RequestLogService.useRequestLog("A", id);

  if (isLoading) {
    return (
      <div className="max-w-300 mx-auto -translate-x-4 space-y-4">
        <div className="h-4 w-32 bg-sand-200 rounded animate-pulse" />
        <div className="h-40 bg-sand-100 rounded-lg animate-pulse" />
        <div className="h-32 bg-sand-100 rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-300 mx-auto -translate-x-4">
        <Link
          to="/"
          className="flex items-center gap-1 text-sm text-sand-500 hover:text-sienna-500 mb-4"
        >
          <ArrowLeftIcon className="size-4" />
          Back to Dashboard
        </Link>
        <p className="text-sand-400 text-sm">Request not found.</p>
      </div>
    );
  }

  const denom = data.input_tokens + data.cache_read_tokens + data.cache_creation_tokens;
  const cacheHitRate = denom > 0 ? `${Math.round((data.cache_read_tokens / denom) * 100)}%` : "—";

  return (
    <div className="max-w-300 mx-auto -translate-x-4 space-y-5">
      <Link to="/" className="flex items-center gap-1 text-sm text-sand-500 hover:text-sienna-500">
        <ArrowLeftIcon className="size-4" />
        Back to Dashboard
      </Link>

      <h1 className="text-xl font-medium text-sand-900 tracking-tight">Request Detail</h1>

      <Section title="Query">
        <div className="rounded-lg bg-sand-50 px-4 py-3">
          <FormattedContent text={data.query} />
        </div>
      </Section>

      {data.response && (
        <Section title="Response">
          <div className="relative rounded-lg bg-sand-50 px-4 py-3">
            <CopyButton text={data.response} />
            <FormattedContent text={data.response} markdown />
          </div>
        </Section>
      )}

      <Section title="Token Breakdown">
        <div className="rounded-lg bg-sand-50 px-5 py-4">
          <table className="w-full text-sm tabular-nums">
            <tbody className="text-sand-700">
              <tr>
                <td className="py-1.5">Input</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.input_tokens)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5">Output</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.output_tokens)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5">Cache Read</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.cache_read_tokens)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5">Cache Write</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.cache_creation_tokens)}
                </td>
              </tr>
              <tr className="border-t border-sand-200/60">
                <td className="py-1.5 font-medium text-sand-800">Cache Hit Rate</td>
                <td className="py-1.5 text-right font-medium text-sienna-500 text-base">
                  {cacheHitRate}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Info">
        <div className="rounded-lg bg-sand-50 px-5 py-4">
          <table className="w-full text-sm">
            <tbody className="text-sand-700">
              <tr>
                <td className="py-1.5 text-sand-500">Token</td>
                <td className="py-1.5 text-right font-medium text-sand-800">{data.token_name}</td>
              </tr>
              <tr>
                <td className="py-1.5 text-sand-500">Time</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatDateTime(data.created_at as unknown as string)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-sand-500">Duration</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {(data.duration_ms / 1000).toFixed(1)}s
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <div className="pb-8" />
    </div>
  );
}
