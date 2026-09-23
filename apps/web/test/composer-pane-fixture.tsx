import { ChatComposer, ComposerTranscriptionControl } from "@opengeni/react";
import { createRoot } from "react-dom/client";
import { useState, type ReactNode } from "react";
import { NewSessionRealtimeControl } from "@opengeni/react/realtime";
import { ComposerMobilePlus } from "../src/components/composer-mobile-plus";
import { ModelPicker } from "../src/components/pickers";
import { TooltipProvider } from "../src/components/ui/tooltip";
import {
  emptyAttachments,
  galleryFirstPartyTools,
  galleryModelRows,
  galleryToolSelection,
  galleryToolServers,
  idleComposer,
} from "../src/dev/composer-chrome-fixtures";
import "../src/styles.css";

const newSession = new URLSearchParams(location.search).has("new-session");

function PickerFixture({ leading, label }: { leading?: ReactNode; label: string }) {
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b p-3">
        {leading}
        {label}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="picker-scroll">
        {Array.from({ length: 30 }, (_, index) => (
          <button key={index} className="block w-full p-3 text-left">
            {label} option {index + 1}
          </button>
        ))}
      </div>
    </>
  );
}

const voiceModel = {
  id: "gpt-live-1-boulder-alpha" as const,
  label: "Codex Live",
  provider: "Connected Codex" as const,
  description: "Deep session integration",
  available: true,
  unavailableReason: null,
  recommended: false,
};

function Fixture() {
  const [settings, setSettings] = useState({});
  return (
    <TooltipProvider>
      <main style={{ width: 448, margin: newSession ? "30vh auto 0" : 24 }}>
        <ChatComposer
          responsiveBasis="container"
          composer={idleComposer()}
          attachments={emptyAttachments()}
          attachButtonClassName="hidden"
          controlsLeading={
            <>
              <ComposerMobilePlus
                menuSide={newSession ? "bottom" : "top"}
                draftChatSettings={
                  newSession
                    ? {
                        workspaceId: "composer-fixture",
                        scope: "workspace",
                        value: settings,
                        onChange: setSettings,
                      }
                    : undefined
                }
                chatSettings={
                  !newSession
                    ? {
                        workspaceId: "composer-fixture",
                        sessionId: "session-fixture",
                        scope: "workspace",
                        canEdit: true,
                      }
                    : undefined
                }
                fileUploadsEnabled
                servers={galleryToolServers}
                firstPartyTools={galleryFirstPartyTools}
                selection={galleryToolSelection}
                onToolSelectionChange={() => {}}
                repositories={{ selectedCount: 2, panel: <PickerFixture label="Repository" /> }}
                variableSets={{ selectedCount: 2, panel: <PickerFixture label="Variable set" /> }}
              />
            </>
          }
          controlsStart={
            <div className="@container/model-controls flex min-w-0 flex-1 flex-wrap items-center gap-1.5 max-sm:flex-nowrap">
              <ModelPicker
                rows={galleryModelRows}
                model="gpt-5.6-sol"
                effort="medium"
                latencyMode="standard"
                onModelChange={() => {}}
                onEffortChange={() => {}}
                onLatencyModeChange={() => {}}
              />
              <ComposerTranscriptionControl />
            </div>
          }
          actionsStart={
            <>
              <NewSessionRealtimeControl
                codexConnected
                models={[voiceModel]}
                selectedModel={voiceModel}
                onSelectModel={() => {}}
                onStart={async () => false}
                modelMenu="split"
              />
              <button className="size-8 shrink-0" aria-label="Pause">
                Ⅱ
              </button>
            </>
          }
        />
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
