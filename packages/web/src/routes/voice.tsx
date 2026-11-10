import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { VOICE_TAB_IDS } from "@/components/nav-items";
import { VoicePlayground } from "@/components/qgrid/VoicePlayground";

const voiceSearchSchema = z.object({ tab: z.enum(VOICE_TAB_IDS).optional() });

export const Route = createFileRoute("/voice")({
  validateSearch: voiceSearchSchema,
  component: VoicePage,
});

function VoicePage() {
  const { tab = "tts" } = Route.useSearch();

  return (
    <div className="max-w-3xl mx-auto xl:max-w-6xl">
      <VoicePlayground tab={tab} />
    </div>
  );
}
