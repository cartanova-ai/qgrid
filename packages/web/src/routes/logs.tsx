import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { RequestLogTable } from "@/components/qgrid/RequestLogTable";

const logsSearchSchema = z.object({
  page: z.number().optional().default(1),
});

export const Route = createFileRoute("/logs")({
  validateSearch: logsSearchSchema,
  component: LogsPage,
});

function LogsPage() {
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="space-y-5 max-w-300 mx-auto -translate-x-4">
      <h1 className="text-xl font-medium text-sand-900 tracking-tight">Request Logs</h1>
      <RequestLogTable page={page} onPageChange={(p) => navigate({ search: { page: p } })} />
    </div>
  );
}
