import { createFileRoute } from "@tanstack/react-router";
import { HealthCard } from "@/components/bycc/HealthCard";
import { ByccService } from "@/services/services.generated";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const { data, isLoading, isError } = ByccService.useHealth();

  return (
    <div className="space-y-5 max-w-300 mx-auto -translate-x-4">
      <h1 className="text-xl font-medium text-sand-900 tracking-tight">Dashboard</h1>

      <HealthCard data={data} isLoading={isLoading} isError={isError} />
    </div>
  );
}
