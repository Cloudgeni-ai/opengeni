// Faithful production chrome stack for the DEV gallery.
// Same order as SessionChat in session.tsx — do not redesign.
import { ChatComposer, QueueSurface, type ComposerState } from "@opengeni/react";
import type { ClientVoiceInputConfig } from "@opengeni/sdk";
import { useMemo, useState } from "react";

import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { ComposerAgentsPill } from "@/components/session/composer-agents-pill";
import { GoalSurface } from "@/components/session/goal-surface";
import {
  emptyAttachments,
  galleryFirstPartyTools,
  galleryModelRows,
  galleryToolSelection,
  galleryToolServers,
  GALLERY_WORKSPACE_ID,
  type ChromeScenario,
} from "@/dev/composer-chrome-fixtures";
import type { IntelligenceEffort } from "@/lib/session-tools";

const VOICE_CAPABILITY: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

const fixtureClient = {
  async transcribeAudio(): Promise<{ text: string; languages: string[] }> {
    return { text: "", languages: [] };
  },
};

export function ScenarioStack({
  scenario,
  composer,
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
}) {
  const [model, setModel] = useState("gpt-5.6-sol");
  const [effort, setEffort] = useState<IntelligenceEffort>("medium");
  const [toolSelection, setToolSelection] = useState(galleryToolSelection);
  const attachments = useMemo(() => emptyAttachments(), []);

  return (
    <div
      className="flex flex-col justify-end rounded-xl border border-border bg-bg/40 pt-10"
      data-scenario={scenario.id}
    >
      <QueueSurface queue={scenario.queue} composer={composer} />
      <GoalSurface session={scenario.session} goal={scenario.goal} />
      <ComposerAgentsPill workspaceId={GALLERY_WORKSPACE_ID} nodes={scenario.agentNodes} />
      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <ChatComposer
            composer={composer}
            effectiveControl={scenario.session.effectiveControl}
            queuedAheadCount={scenario.queue.queue.length}
            placeholder="Send a follow-up…"
            attachments={attachments}
            transcription={{
              client: fixtureClient as never,
              workspaceId: GALLERY_WORKSPACE_ID,
              capability: VOICE_CAPABILITY,
              workspaceEnabled: true,
            }}
            controlsStart={
              <div className="flex min-w-0 items-center gap-1.5">
                <ModelPicker
                  rows={galleryModelRows}
                  model={model}
                  effort={effort}
                  onModelChange={setModel}
                  onEffortChange={setEffort}
                />
                <SessionToolPicker
                  servers={galleryToolServers}
                  firstPartyTools={galleryFirstPartyTools}
                  selection={toolSelection}
                  onChange={setToolSelection}
                />
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
