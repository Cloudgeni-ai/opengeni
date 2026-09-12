import { ChatComposer } from "@opengeni/react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
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

createRoot(document.getElementById("root")!).render(
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
              expandedPanelPresentation={newSession ? "dialog" : "menu"}
              fileUploadsEnabled
              servers={galleryToolServers}
              firstPartyTools={galleryFirstPartyTools}
              selection={galleryToolSelection}
              onToolSelectionChange={() => {}}
              repositories={{ selectedCount: 2, panel: <PickerFixture label="Repository" /> }}
              variableSets={{ selectedCount: 2, panel: <PickerFixture label="Variable set" /> }}
            />
            <button className="size-8 shrink-0" aria-label="Dictate">
              Mic
            </button>
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
          </div>
        }
        actionsStart={
          <>
            <button className="size-8 shrink-0" aria-label="Voice">
              Voice
            </button>
            <button className="size-8 shrink-0" aria-label="Pause">
              Ⅱ
            </button>
          </>
        }
      />
    </main>
  </TooltipProvider>,
);
