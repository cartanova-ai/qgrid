import { useState } from "react";
import ChevronLeftIcon from "~icons/lucide/chevron-left";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { QgridService, TokenService } from "@/services/services.generated";
import type { TokenSubsetMapping } from "@/services/sonamu.generated";

function barColor(pct: number): string {
  if (pct >= 95) return "bg-red-500";
  if (pct >= 80) return "bg-amber-400";
  return "bg-sienna-400";
}

function formatResets(iso: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "resetting...";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `resets ${h}h ${m}m` : `resets ${m}m`;
}

function UsageRow({
  label,
  utilization,
  resetsAt,
}: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
}) {
  const pct = utilization ?? 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-sand-600 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-sand-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(pct)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-sand-700 w-10 text-right">{pct}%</span>
      <span className="text-[10px] text-sand-400 w-24 text-right">{formatResets(resetsAt)}</span>
    </div>
  );
}

function TokenUsage({ token }: { token: TokenSubsetMapping["A"] }) {
  const { data, isLoading } = QgridService.useUsage(token.name);
  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2 py-2">
        <div className="h-2 w-full bg-sand-200 rounded-full" />
        <div className="h-2 w-3/4 bg-sand-200 rounded-full" />
      </div>
    );
  }

  if (data?.error) {
    return (
      <div className="py-1">
        <p className="text-[11px] text-amber-600">Session expired</p>
        <p className="text-[10px] text-sand-400 mt-0.5">
          Please re-login via OAuth or update your token
        </p>
      </div>
    );
  }

  if (!data?.five_hour) {
    return <p className="text-[11px] text-sand-400 py-1">No usage data</p>;
  }

  return (
    <div className="space-y-1.5 py-1">
      {data.five_hour && (
        <UsageRow
          label="5h"
          utilization={data.five_hour.utilization}
          resetsAt={data.five_hour.resets_at}
        />
      )}
      {data.seven_day && (
        <UsageRow
          label="7d All"
          utilization={data.seven_day.utilization}
          resetsAt={data.seven_day.resets_at}
        />
      )}
      {data.seven_day_sonnet && (
        <UsageRow
          label="7d Sonnet"
          utilization={data.seven_day_sonnet.utilization}
          resetsAt={data.seven_day_sonnet.resets_at}
        />
      )}
      {data.seven_day_opus && (
        <UsageRow
          label="7d Opus"
          utilization={data.seven_day_opus.utilization}
          resetsAt={data.seven_day_opus.resets_at}
        />
      )}
    </div>
  );
}

const PAGE_SIZE = 6; // 2×3

export function UsageCard() {
  const [page, setPage] = useState(0);
  const { data, isLoading } = TokenService.useTokens("A");

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={`skel-${i}`} className="rounded-lg bg-sand-50 px-4 py-3 animate-pulse">
            <div className="h-3 w-16 bg-sand-200 rounded mb-3" />
            <div className="h-2 w-full bg-sand-200 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  const tokens = data?.rows ?? [];

  if (tokens.length === 0) {
    return (
      <div className="rounded-lg bg-sand-50 px-5 py-4">
        <p className="text-sand-400 text-sm">No tokens registered</p>
      </div>
    );
  }

  const totalPages = Math.ceil(tokens.length / PAGE_SIZE);
  const safePage = Math.min(page, totalPages - 1);
  const pageTokens = tokens.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        {pageTokens.map((token) => (
          <div key={token.id} className="rounded-lg bg-sand-50 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-sand-800 truncate">
                {token.name ?? "Unnamed"}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${token.active ? "bg-sage-100 text-sage-600" : "bg-sand-200 text-sand-500"}`}
              >
                {token.active ? "Active" : "Inactive"}
              </span>
            </div>
            <TokenUsage token={token} />
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-3">
          <button
            type="button"
            className="p-0.5 rounded text-sand-400 hover:text-sand-600 disabled:opacity-30 transition-colors"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="text-[10px] text-sand-400 tabular-nums">
            {safePage + 1} / {totalPages}
          </span>
          <button
            type="button"
            className="p-0.5 rounded text-sand-400 hover:text-sand-600 disabled:opacity-30 transition-colors"
            disabled={safePage === totalPages - 1}
            onClick={() => setPage(safePage + 1)}
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
