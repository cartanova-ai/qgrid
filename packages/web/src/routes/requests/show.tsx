import { createFileRoute, Link } from "@tanstack/react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import ArrowLeftIcon from "~icons/lucide/arrow-left";

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

      {/* Query */}
      <div>
        <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
          Query
        </span>
        <div className="mt-1.5 rounded-lg bg-sand-50 px-4 py-3">
          <pre className="text-sm text-sand-800 whitespace-pre-wrap break-words font-mono leading-relaxed">
            {data.query}
          </pre>
        </div>
      </div>

      {/* Response */}
      {data.response && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
            Response
          </span>
          <div className="mt-1.5 rounded-lg bg-sand-50 px-4 py-3 prose prose-sm prose-sand max-w-none">
            <Markdown remarkPlugins={[remarkGfm]}>{data.response}</Markdown>
          </div>
        </div>
      )}

      {/* Token Breakdown + Meta */}
      <div className="space-y-4">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
            Token Breakdown
          </span>
          <div className="mt-1.5 rounded-lg bg-sand-50 px-5 py-4">
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
        </div>

        <div>
          <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
            Info
          </span>
          <div className="mt-1.5 rounded-lg bg-sand-50 px-5 py-4">
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
        </div>
      </div>

      {/* Spacer for footer clearance */}
      <div className="pb-8" />
    </div>
  );
}
