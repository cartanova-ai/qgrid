import { createFileRoute } from "@tanstack/react-router";

import { UsageCard } from "@/components/qgrid/UsageCard";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="space-y-5 max-w-300 mx-auto -translate-x-4">
      <h1 className="text-xl font-medium text-sand-900 tracking-tight">Dashboard</h1>
      <div className="pt-12">
        <UsageCard />
      </div>
    </div>
  );
}
