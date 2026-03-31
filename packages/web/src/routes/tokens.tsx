import { createFileRoute } from "@tanstack/react-router";
import { AddTokenModal } from "@/components/bycc/AddTokenModal";
import { TokenTable } from "@/components/bycc/TokenTable";
import { ByccService } from "@/services/services.generated";
import FolderIcon from "~icons/lucide/folder";

export const Route = createFileRoute("/tokens")({
  component: TokensPage,
});

function TokensPage() {
  const { data, isLoading } = ByccService.useStats();
  const { data: healthData } = ByccService.useHealth();

  return (
    <div className="space-y-5 max-w-300 mx-auto -translate-x-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-medium text-sand-900 tracking-tight">Tokens</h1>
        <AddTokenModal />
      </div>

      {healthData?.tokenDir && (
        <div className="flex items-center gap-2 text-[11px] text-sand-500">
          <FolderIcon className="size-3.5 text-sand-400" />
          <span>Token file:</span>
          <code className="font-mono text-sand-600">{healthData.tokenDir}</code>
        </div>
      )}

      <TokenTable data={data} isLoading={isLoading} />
    </div>
  );
}
