import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer, type ComposerState } from "@opengeni/react";
import "@opengeni/react/compiled.css";
import "./standalone-controls.css";

function Fixture() {
  const [value, setValue] = useState("");
  const [sent, setSent] = useState("");
  const send = async () => {
    setSent(value);
    setValue("");
    return true;
  };
  const composer: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => value.trim().length > 0,
    send,
    steer: send,
    sending: false,
    canSend: value.trim().length > 0,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
  };
  return (
    <main>
      <h1>Standalone SDK, no Tailwind reset</h1>
      <button>Host button stays purple</button>
      <section className="og-root">
        <button className="rounded-og-sm px-1.5 text-og-xs">SDK disclosure</button>
        <button hidden className="inline-flex">
          Hidden disclosure must not appear
        </button>
        <ChatComposer composer={composer} placeholder="Test embedded composer" />
      </section>
      <output aria-label="Sent message">{sent}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
