import { createFileRoute } from "@tanstack/react-router";

import { HealthCard } from "@/components/qgrid/HealthCard";
import { RequestLogTable } from "@/components/qgrid/RequestLogTable";
import { UsageCard } from "@/components/qgrid/UsageCard";
import { QgridService } from "@/services/services.generated";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const {
    data: healthData,
    isLoading: healthLoading,
    isError: healthError,
  } = QgridService.useHealth();

  return (
    <div className="space-y-5 max-w-300 mx-auto -translate-x-4">
      <h1 className="text-xl font-medium text-sand-900 tracking-tight">Dashboard</h1>

      <HealthCard data={healthData} isLoading={healthLoading} isError={healthError} />

      <div>
        <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
          Usage
        </span>
        <div className="mt-2">
          <UsageCard />
        </div>
      </div>

      <div>
        <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
          Request Log
        </span>
        <div className="mt-2">
          <RequestLogTable />
        </div>
      </div>
    </div>
  );
}
