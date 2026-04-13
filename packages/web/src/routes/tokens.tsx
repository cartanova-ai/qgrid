import { createFileRoute } from "@tanstack/react-router";

import { AddTokenModal } from "@/components/qgrid/AddTokenModal";
import { TokenTable } from "@/components/qgrid/TokenTable";
import { TokenService } from "@/services/services.generated";

export const Route = createFileRoute("/tokens")({
  component: TokensPage,
});

function TokensPage() {
  const { data, isLoading } = TokenService.useTokens("A");

  return (
    <div className="space-y-5 max-w-300 mx-auto -translate-x-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-sand-900 tracking-tight">Tokens</h1>
        <AddTokenModal />
      </div>

      <TokenTable data={data?.rows} isLoading={isLoading} />
    </div>
  );
}
