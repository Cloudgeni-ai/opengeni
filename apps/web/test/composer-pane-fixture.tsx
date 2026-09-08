import { ChatComposer } from "@opengeni/react";
import { createRoot } from "react-dom/client";
import { ComposerMobilePlus } from "../src/components/composer-mobile-plus";
import { ModelPicker, SessionToolPicker } from "../src/components/pickers";
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

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main style={{ width: 448, margin: 24 }}>
      <ChatComposer
        responsiveBasis="container"
        composer={idleComposer()}
        attachments={emptyAttachments()}
        attachButtonClassName="console-composer-wide-control max-sm:hidden"
        controlsLeading={
          <>
            <ComposerMobilePlus
              fileUploadsEnabled
              servers={galleryToolServers}
              firstPartyTools={galleryFirstPartyTools}
              selection={galleryToolSelection}
              onToolSelectionChange={() => {}}
              repositories={{ selectedCount: 2, panel: <div>Repository options</div> }}
            />
            <button
              className="console-composer-compact-control size-8 shrink-0 sm:hidden"
              aria-label="Variable sets"
            >
              V
            </button>
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
            <SessionToolPicker
              servers={galleryToolServers}
              firstPartyTools={galleryFirstPartyTools}
              selection={galleryToolSelection}
              onChange={() => {}}
              triggerClassName="console-composer-wide-control max-sm:hidden"
            />
            <button className="console-composer-wide-control h-8 shrink-0 max-sm:hidden">
              2 repos
            </button>
            <button className="console-composer-wide-control h-8 shrink-0 max-sm:hidden">
              Variable sets · 2
            </button>
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
