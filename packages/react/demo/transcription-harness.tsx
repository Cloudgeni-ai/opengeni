import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { ChatComposer } from "../src/components/chat-composer";
import { VoiceDictationControl } from "../src/components/voice-dictation-control";
import type { ComposerState } from "../src/hooks/use-composer";
import type {
  TranscriptionEvent,
  TranscriptionEventSink,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionSessionRequest,
} from "../src/transcription/types";
import "./styles.css";

type DemoView =
  | "idle"
  | "requesting"
  | "listening"
  | "partial"
  | "reconnecting"
  | "error"
  | "permission"
  | "final"
  | "cancelled"
  | "disabled";

const params = new URLSearchParams(window.location.search);
const requestedView = params.get("view") as DemoView | null;
const view: DemoView = [
  "idle",
  "requesting",
  "listening",
  "partial",
  "reconnecting",
  "error",
  "permission",
  "final",
  "cancelled",
  "disabled",
].includes(requestedView ?? "")
  ? requestedView!
  : "idle";
const theme = params.get("theme") === "light" ? "light" : "dark";
const focusMic = params.get("focus") === "mic";

type LocalEvent = TranscriptionEvent extends infer Event
  ? Event extends TranscriptionEvent
    ? Omit<Event, "sessionId" | "providerId" | "sequence">
    : never
  : never;

function demoProvider(currentView: DemoView): TranscriptionProvider {
  return {
    id: "fixture",
    createSession(
      request: TranscriptionSessionRequest,
      emit: TranscriptionEventSink,
    ): TranscriptionSession {
      let sequence = 0;
      let closed = false;
      const send = (event: LocalEvent) => {
        emit({
          ...event,
          sessionId: request.sessionId,
          providerId: "fixture",
          sequence: ++sequence,
        } as TranscriptionEvent);
      };
      return {
        id: request.sessionId,
        providerId: "fixture",
        async start() {
          if (currentView === "requesting") {
            await new Promise<void>(() => {});
          }
          if (currentView === "permission") {
            const error = new Error("Permission denied by fixture");
            error.name = "NotAllowedError";
            throw error;
          }
          if (currentView === "error") {
            send({
              type: "error",
              code: "provider_unavailable",
              message: "Voice service is temporarily unavailable. Please retry.",
              retryable: true,
            });
            return;
          }
          send({ type: "session.ready", providerSessionId: "fixture-session" });
          if (["partial", "reconnecting", "final", "cancelled"].includes(currentView)) {
            send({
              type: "transcript.partial",
              attempt: 0,
              segmentId: "segment-1",
              logicalSegmentId: "logical-segment-1",
              text: "Schedule the production readiness review",
            });
          }
          if (currentView === "reconnecting") {
            send({
              type: "reconnecting",
              attempt: 1,
              reason: "fixture_network_change",
              retryInMs: 2_000,
            });
          }
          if (currentView === "final") {
            send({
              type: "transcript.final",
              providerAcceptanceId: "fixture-acceptance-1",
              attempt: 0,
              segmentId: "segment-1",
              logicalSegmentId: "logical-segment-1",
              text: "Schedule the production readiness review for tomorrow morning.",
            });
            send({ type: "closed", reason: "completed" });
          }
        },
        async cancel() {
          if (!closed) {
            closed = true;
            send({ type: "closed", reason: "cancelled" });
          }
        },
        async close() {
          closed = true;
        },
      };
    },
  };
}

function Harness() {
  const [value, setValue] = useState("Add this to the release note:");
  const [sent, setSent] = useState(false);
  const provider = useMemo(() => demoProvider(view), []);
  const send = async () => {
    if (!value.trim()) return false;
    setSent(true);
    setValue("");
    return true;
  };
  const composer: ComposerState = {
    value,
    setValue,
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

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const button = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Start voice dictation"]',
      );
      if (focusMic) button?.focus();
      if (view !== "idle" && view !== "disabled") button?.click();
      if (view === "cancelled") {
        window.setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }, 80);
      }
      window.setTimeout(() => {
        (globalThis as Record<string, unknown>).__ogReady = true;
      }, 220);
    }, 40);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main
      className="og-root grid min-h-dvh place-items-center overflow-hidden bg-og-bg px-4 py-8 sm:px-8"
      data-og-theme={theme === "light" ? "light" : undefined}
      data-demo-view={view}
    >
      <section className="w-full max-w-3xl overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1/60 shadow-og-lg">
        <header className="flex items-center justify-between gap-4 border-b border-og-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-og-xs font-medium uppercase tracking-[0.1em] text-og-fg-subtle">
              Composer
            </p>
            <h1 className="truncate text-og-md font-semibold text-og-fg">Release coordination</h1>
          </div>
          <span className="shrink-0 rounded-full border border-og-border px-2.5 py-1 text-og-xs text-og-fg-subtle">
            Fixture · no provider call
          </span>
        </header>

        <div className="min-h-48 px-4 py-5 sm:min-h-64 sm:px-6">
          <div className="max-w-[82%] rounded-og-lg border border-og-border bg-og-surface-2/60 px-4 py-3 text-og-sm text-og-fg-muted">
            Capture the final decision in an editable draft before sending it to the agent.
          </div>
          {sent ? (
            <div className="ml-auto mt-4 max-w-[82%] rounded-og-lg bg-og-accent/12 px-4 py-3 text-og-sm text-og-fg">
              Draft sent from the deterministic harness.
            </div>
          ) : null}
        </div>

        <div className="border-t border-og-border px-3 pb-4 pt-3 sm:px-5">
          <ChatComposer
            composer={composer}
            placeholder="Send a follow-up…"
            controlsStart={
              <VoiceDictationControl
                provider={view === "disabled" ? null : provider}
                value={value}
                setValue={setValue}
                sessionIdFactory={() => "fixture-dictation-session"}
              />
            }
          />
          <p className="mt-2 px-1 text-og-xs text-og-fg-subtle">
            Final speech becomes ordinary editable draft text. Escape cancels without inserting a
            partial.
          </p>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
