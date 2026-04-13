import ActivityIcon from "~icons/lucide/activity";
import CpuIcon from "~icons/lucide/cpu";
import KeyRoundIcon from "~icons/lucide/key-round";

import type { HealthResponse } from "@/services/qgrid/qgrid.types";

interface HealthCardProps {
  data: HealthResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

interface MetricProps {
  label: string;
  icon: React.FC<React.SVGProps<SVGSVGElement>>;
  children: React.ReactNode;
}

function MetricCard({ label, icon: Icon, children }: MetricProps) {
  return (
    <div className="rounded-lg bg-sand-50 px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium">
          {label}
        </span>
        <Icon className="size-4 text-sand-400" />
      </div>
      <div>{children}</div>
    </div>
  );
}

export function HealthCard({ data, isLoading, isError }: HealthCardProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={`skeleton-${i}`} className="rounded-lg bg-sand-50 px-5 py-4 animate-pulse">
            <div className="h-3 w-16 bg-sand-200 rounded mb-3" />
            <div className="h-6 w-12 bg-sand-200 rounded" />
          </div>
        ))}
      </div>
    );
  }

  const status = isError ? "offline" : (data?.status ?? "unknown");
  const isOnline = status === "ok";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <MetricCard label="Status" icon={ActivityIcon}>
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${isOnline ? "bg-sage-400" : "bg-red-400"}`} />
          <span className="text-base font-semibold text-sand-800">
            {isOnline ? "Online" : "Offline"}
          </span>
        </div>
      </MetricCard>

      <MetricCard label="Workers" icon={CpuIcon}>
        <span className="text-base font-semibold text-sand-800">{data?.workers ?? 0}</span>
      </MetricCard>

      <MetricCard label="Active Tokens" icon={KeyRoundIcon}>
        <span className="text-base font-semibold text-sand-800">{data?.activeTokens ?? 0}</span>
      </MetricCard>
    </div>
  );
}
