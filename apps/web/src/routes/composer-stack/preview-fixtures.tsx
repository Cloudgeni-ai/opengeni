// Deterministic session states and a production composer for /dev/composer-stack.
import { ChatComposer, type ComposerState, type UseFileAttachmentsResult } from "@opengeni/react";
import { ComposerMobilePlus } from "@opengeni/react/app/components/composer-mobile-plus";
import { ModelPicker } from "@opengeni/react/app/components/pickers";
import type { IntelligenceEffort } from "@opengeni/react/app/lib/session-tools";
import type { ClientVoiceInputConfig, Session } from "@opengeni/sdk";
import { useLayoutEffect, useState } from "react";

import {
  emptyAttachments,
  galleryFirstPartyTools,
  galleryGoal,
  galleryModelRows,
  gallerySession,
  galleryToolSelection,
  galleryToolServers,
  GALLERY_WORKSPACE_ID,
} from "@/dev/composer-chrome-fixtures";

export type StackPreviewState = "idle" | "running" | "waiting" | "all";

const WAIT_REASON = "Waiting for the Site sidebar and Site panel workers to finish.";

// A 1x1 neutral PNG keeps the attachment thumbnail deterministic.
const THUMB =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPIK2sCAAK8AWdO3aHkAAAAAElFTkSuQmCC";

const VOICE_CAPABILITY: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm"],
};

const fixtureClient = {
  async transcribeAudio(): Promise<{ text: string; languages: string[] }> {
    return { text: "", languages: [] };
  },
};

export function previewState(): StackPreviewState {
  const value = new URLSearchParams(window.location.search).get("state");
  return value === "running" || value === "waiting" || value === "all" ? value : "idle";
}

export function usePreviewTheme() {
  const theme =
    new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.ogTheme = theme;
    root.classList.toggle("dark", theme === "dark");
  }, [theme]);
  return theme;
}

export function previewAttachments(withAttachment: boolean): UseFileAttachmentsResult {
  const base = emptyAttachments();
  if (!withAttachment) return base;
  return {
    ...base,
    attachments: [
      {
        id: "preview-attachment",
        name: "Screenshot 2026-10-23 at 13.10.28.png",
        contentType: "image/png",
        sizeBytes: 25_600,
        status: "ready",
        previewUrl: THUMB,
      },
    ],
  };
}

export function previewSession(state: StackPreviewState): Session {
  return gallerySession({
    status: state === "running" ? "running" : "idle",
    backgroundCommandActivity:
      state === "running" || state === "all" ? { count: 1, state: "running" as const } : null,
    inputWait:
      state === "waiting" || state === "all"
        ? { reason: WAIT_REASON, deadlineAt: new Date(Date.now() + 47 * 60_000).toISOString() }
        : null,
  } as Partial<Session>);
}

export function previewGoal(state: StackPreviewState) {
  return state === "all"
    ? galleryGoal({
        text: "Make the status stack above the composer compact",
        continuation: {
          state: "blocked",
          reason: "held_for_input",
          holdReason: WAIT_REASON,
          wakeRevision: 1,
          observedRevision: 1,
          nextAttemptAt: new Date(Date.now() + 47 * 60_000).toISOString(),
          lastError: null,
        },
      })
    : galleryGoal(null);
}

/** The production ChatComposer with the session route's leading and model controls. */
export function PreviewComposer({
  composer,
  session,
  attachments,
  running,
}: {
  composer: ComposerState;
  session: Session;
  attachments: UseFileAttachmentsResult;
  running: boolean;
}) {
  const [model, setModel] = useState("opper/aws/claude-opus-5-5");
  const [effort, setEffort] = useState<IntelligenceEffort>("high");
  const [toolSelection, setToolSelection] = useState(galleryToolSelection);
  const [customizing, setCustomizing] = useState(false);
  return (
    <ChatComposer
      composer={composer}
      effectiveControl={session.effectiveControl}
      placeholder="Send a follow-up…"
      attachments={attachments}
      attachButtonClassName="hidden"
      running={running}
      transcription={{
        client: fixtureClient as never,
        workspaceId: GALLERY_WORKSPACE_ID,
        capability: VOICE_CAPABILITY,
        workspaceEnabled: true,
      }}
      controlsLeading={
        <ComposerMobilePlus
          fileUploadsEnabled
          servers={galleryToolServers}
          firstPartyTools={galleryFirstPartyTools}
          selection={toolSelection}
          connectorCustomizing={customizing}
          onConnectorCustomizingChange={setCustomizing}
          onToolSelectionChange={setToolSelection}
        />
      }
      controlsStart={
        <div className="@container/model-controls flex min-w-0 flex-1 items-center gap-1.5">
          <ModelPicker
            rows={galleryModelRows}
            model={model}
            effort={effort}
            latencyMode="standard"
            menuSide="top"
            onModelChange={setModel}
            onEffortChange={setEffort}
            onLatencyModeChange={() => {}}
          />
        </div>
      }
    />
  );
}
