import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import ChevronLeftIcon from "~icons/lucide/chevron-left";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { RequestLogService, TokenService } from "@/services/services.generated";
import { type RequestLogSubsetMapping } from "@/services/sonamu.generated";

type RequestLog = RequestLogSubsetMapping["A"];

const PAGE_SIZE = 50;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function calcCacheHitRate(row: RequestLog): string {
  const denom = row.input_tokens + row.cache_read_tokens + row.cache_creation_tokens;
  if (denom === 0) return "—";
  return `${Math.round((row.cache_read_tokens / denom) * 100)}%`;
}

function trimQuery(q: string, maxLen = 30): string {
  return q.length > maxLen ? `${q.slice(0, maxLen)}...` : q;
}

interface RequestLogTableProps {
  page?: number;
  onPageChange?: (page: number) => void;
}

export function RequestLogTable({ page: externalPage, onPageChange }: RequestLogTableProps = {}) {
  const navigate = useNavigate();
  const [internalPage, setInternalPage] = useState(1);
  const page = externalPage ?? internalPage;
  const setPage = onPageChange ?? setInternalPage;
  const [tokenFilter, setTokenFilter] = useState("");

  const { data: tokensData } = TokenService.useTokens("A");
  const tokenNames = (tokensData?.rows ?? []).map((t) => t.name).filter(Boolean) as string[];

  const { data, isLoading } = RequestLogService.useRequestLogs("A", {
    num: PAGE_SIZE,
    page,
    orderBy: "id-desc" as const,
    ...(tokenFilter ? { token_name: tokenFilter } : {}),
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {tokenNames.length > 0 && (
          <select
            value={tokenFilter}
            onChange={(e) => {
              setTokenFilter(e.target.value);
              setPage(1);
            }}
            className="border border-sand-200 rounded-md px-2 py-1 text-xs text-sand-700 bg-white focus:outline-none focus:border-sienna-300"
          >
            <option value="">All Tokens</option>
            {tokenNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <span className="text-[11px] text-sand-400">{total} results</span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={`skel-${i}`} className="h-8 bg-sand-100 rounded animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sand-400 text-center py-12 text-sm">No requests yet.</div>
      ) : (
        <>
          <div className="rounded-lg bg-sand-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sand-200">
                  <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    Date
                  </th>
                  <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    Token
                  </th>
                  <th className="text-left px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    Query
                  </th>
                  <th className="text-right px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    In
                  </th>
                  <th className="text-right px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    Out
                  </th>
                  <th className="text-right px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    C.Read
                  </th>
                  <th className="text-right px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    C.Write
                  </th>
                  <th className="text-right px-3 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                    Hit
                  </th>
                  <th className="w-8 px-2 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-200/60">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="transition-colors duration-150 hover:bg-sand-100/60 cursor-pointer"
                    onClick={() => navigate({ to: "/requests/show", search: { id: row.id } })}
                  >
                    <td className="px-3 py-2.5">
                      <span className="text-[10px] text-sand-400 tabular-nums whitespace-nowrap">
                        {formatDateTime(row.created_at as unknown as string)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-xs text-sand-500">{row.token_name}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="text-sand-800 truncate max-w-48" title={row.query}>
                        {trimQuery(row.query)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.input_tokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.output_tokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.cache_read_tokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.cache_creation_tokens)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-sand-700">
                      {calcCacheHitRate(row)}
                    </td>
                    <td className="px-2 py-2.5">
                      <ChevronRightIcon className="size-4 text-sand-400" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-3">
              <button
                type="button"
                className="p-1 rounded text-sand-400 hover:text-sand-600 disabled:opacity-30 transition-colors"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeftIcon className="size-4" />
              </button>
              <span className="text-[11px] text-sand-400 tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                className="p-1 rounded text-sand-400 hover:text-sand-600 disabled:opacity-30 transition-colors"
                disabled={page === totalPages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
