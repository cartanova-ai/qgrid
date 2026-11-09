import { createFileRoute } from "@tanstack/react-router";

import { VoicePlayground } from "@/components/qgrid/VoicePlayground";

export const Route = createFileRoute("/voice")({
  component: VoicePage,
});

function VoicePage() {
  return (
    <div className="max-w-3xl mx-auto">
      <VoicePlayground />
    </div>
  );
}
