import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PersonalResourceAttachmentControl } from "../src/components/personal-resource-attachment-control";
import { Button } from "../src/components/ui/button";
import type {
  PersonalResourceAttachmentController,
  PersonalResourceNotice,
} from "../src/lib/use-personal-resource-attachment";
import type { PersonalAttachmentMode } from "../src/lib/personal-resource-attachments";
import "../src/styles.css";

function Preview() {
  const [mode, setMode] = useState<PersonalAttachmentMode>("once");
  const [notice, setNotice] = useState<PersonalResourceNotice | null>(null);
  const controller: PersonalResourceAttachmentController = {
    eligible: true,
    loading: false,
    refreshing: false,
    error: null,
    notice,
    sourceLost: false,
    truncated: false,
    catalog: null,
    selected: {
      variableSets: [],
      rigs: [],
      connectedMachines: [],
      resourceCount: 1,
      personalResourceCount: 1,
      closureUnverified: false,
    },
    mode,
    setMode,
    ongoingScope: null,
    visibility: "workspace",
    requiresDecision: false,
    intent: undefined,
    refresh: async () => {},
    onAccepted: () => {},
    onDeliveryError: () => {},
  };
  return (
    <main className="min-h-dvh bg-bg-subtle px-4 py-16 text-fg">
      <div className="mx-auto max-w-3xl space-y-3">
        <p className="mb-12 text-sm text-fg-muted">Personal access · isolated UI preview</p>
        <PersonalResourceAttachmentControl controller={controller} compact />
        <div className="rounded-2xl border border-border bg-bg p-4 shadow-sm">
          <textarea
            aria-label="Message"
            placeholder="Send a follow-up…"
            className="min-h-16 w-full resize-none bg-transparent outline-none"
          />
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setNotice(mode === "session" ? "accepted_session" : "accepted");
                setMode("once");
              }}
            >
              Simulate accepted send
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
