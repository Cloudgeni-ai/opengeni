import type {
  TranscriptionAdapter,
  TranscriptionAdapterStartContext,
  TranscriptionEvent,
  TranscriptionEventListener,
  TranscriptionSession,
  TranscriptionSessionRequest,
  WorkspaceTranscriptionPolicy,
} from "@opengeni/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer, type ComposerState } from "../src/index";
import "../../../apps/web/src/styles.css";

type FixtureMode = "normal" | "denied" | "hanging" | "cleanup-hangs" | "start-secret";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const requestedMode = params.get("mode");
const initialMode: FixtureMode =
  requestedMode === "denied" ||
  requestedMode === "hanging" ||
  requestedMode === "cleanup-hangs" ||
  requestedMode === "start-secret"
    ? requestedMode
    : "normal";
if (theme === "light") document.documentElement.dataset.ogTheme = "light";
else delete document.documentElement.dataset.ogTheme;

const policy: WorkspaceTranscriptionPolicy = {
  enabled: true,
  acceptanceId: "11111111-1111-4111-8111-111111111111",
  primary: {
    provider: "fixture-speech",
    model: "fixture-v1",
    credentialMode: "managed",
    credentialConnectionId: null,
    region: null,
  },
  language: "en-US",
  autoDetectLanguage: false,
  diarization: { enabled: false, maxSpeakers: null },
  retention: { mode: "none", maxDays: null },
  privacy: { allowProviderLogging: false, allowProviderTraining: false },
  fallback: { mode: "disabled", targets: [] },
  cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
};

class FixtureTranscriptionAdapter implements TranscriptionAdapter {
  readonly descriptor = {
    provider: "fixture-speech",
    model: "fixture-v1",
    credentialMode: "managed" as const,
    region: null,
  };
  private listener: TranscriptionEventListener | null = null;
  private request: TranscriptionSessionRequest | null = null;
  private context: TranscriptionAdapterStartContext | null = null;
  private sequence = 0;

  constructor(readonly mode: FixtureMode) {}

  async start(
    request: TranscriptionSessionRequest,
    listener: TranscriptionEventListener,
    context: TranscriptionAdapterStartContext,
  ): Promise<TranscriptionSession> {
    this.request = request;
    this.listener = listener;
    this.context = context;
    this.sequence = 0;
    document.documentElement.dataset.transcriptionStartAborted = String(context.signal.aborted);
    context.signal.addEventListener(
      "abort",
      () => {
        document.documentElement.dataset.transcriptionStartAborted = "true";
      },
      { once: true },
    );
    this.emit({ type: "permission.requested" });

    if (this.mode === "hanging") {
      return await new Promise<TranscriptionSession>(() => {});
    }
    if (this.mode === "start-secret") {
      const detail =
        "FixtureProvider start failed api-key=fixture-secret Bearer opaque-token sk-fixture123";
      context.reportDiagnostic({ operation: "start", code: "provider", detail });
      throw new Error(detail);
    }
    if (this.mode === "denied") {
      this.emit({
        type: "session.error",
        code: "permission_denied",
        recoverable: false,
      });
    } else {
      this.emit({ type: "session.opened", providerSessionId: "fixture-provider-session" });
    }
    return {
      localSessionId: request.localSessionId,
      cancel: async () => {
        document.documentElement.dataset.transcriptionCancelInvoked = "true";
        if (this.mode === "cleanup-hangs") return await new Promise<void>(() => {});
        this.emit({ type: "session.closed", reason: "cancelled" });
      },
      close: async () => {
        document.documentElement.dataset.transcriptionCloseInvoked = "true";
        if (this.mode === "cleanup-hangs") return await new Promise<void>(() => {});
      },
    };
  }

  partial(text = "This partial stays ephemeral"): void {
    this.emit({
      type: "transcript.partial",
      segmentId: "fixture-segment",
      text,
      metadata: {
        detectedLanguage: "en-US",
        span: { startMilliseconds: 0, endMilliseconds: 800 },
        confidence: 0.82,
        speaker: { id: "speaker-1", label: "Speaker 1" },
      },
    });
  }

  final(text = "Final transcript remains editable"): void {
    this.emit({
      type: "transcript.final",
      segmentId: "fixture-segment",
      text,
      providerAcceptanceId: "fixture-acceptance-1",
      metadata: {
        detectedLanguage: "en-US",
        span: { startMilliseconds: 0, endMilliseconds: 1_200 },
        confidence: 0.96,
        speaker: { id: "speaker-1", label: "Speaker 1" },
        words: [
          {
            text: "Final transcript remains editable",
            span: { startMilliseconds: 0, endMilliseconds: 1_200 },
            confidence: 0.96,
            speaker: { id: "speaker-1" },
          },
        ],
      },
    });
  }

  emptyThenCorrectedFinal(): void {
    this.emit({
      type: "transcript.final",
      segmentId: "fixture-correctable",
      text: "  \n ",
      providerAcceptanceId: "fixture-correctable-acceptance",
    });
    this.emit({
      type: "transcript.final",
      segmentId: "fixture-correctable",
      text: "Corrected final is inserted once",
      providerAcceptanceId: "fixture-correctable-acceptance",
    });
  }

  reconnect(): void {
    this.emit({
      type: "session.reconnecting",
      attempt: 1,
      reason: "Fixture network interruption",
    });
  }

  restore(): void {
    this.emit({ type: "session.opened", providerSessionId: "fixture-provider-session-restored" });
  }

  fail(): void {
    this.context?.reportDiagnostic({
      operation: "session",
      code: "provider",
      detail: "FixtureProvider stream failed secret=fixture-secret Bearer opaque-token",
    });
    this.emit({
      type: "session.error",
      code: "provider",
      recoverable: false,
    });
  }

  private emit(payload: EventPayload): void {
    if (!this.listener || !this.request) return;
    this.sequence += 1;
    this.listener({
      localSessionId: this.request.localSessionId,
      sequence: this.sequence,
      occurredAt: "2026-07-21T12:00:00.000Z",
      ...payload,
    } as TranscriptionEvent);
  }
}

type EventPayload = TranscriptionEvent extends infer Event
  ? Event extends TranscriptionEvent
    ? Omit<Event, "localSessionId" | "sequence" | "occurredAt">
    : never
  : never;

function Harness() {
  const adapter = useMemo(() => new FixtureTranscriptionAdapter(initialMode), []);
  const [value, setValue] = useState("Existing editable draft");
  const [sent, setSent] = useState<Array<{ id: number; message: string }>>([]);
  const composer: ComposerState = {
    value,
    setValue,
    send: async () => {
      setSent((current) => [...current, { id: current.length + 1, message: value }]);
      return true;
    },
    steer: async () => true,
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
    <main
      className="og-root flex min-h-dvh items-center justify-center bg-og-bg p-4 text-og-fg max-sm:p-3"
      data-transcription-harness
      data-og-theme={theme === "light" ? "light" : undefined}
    >
      <section className="grid w-full max-w-3xl gap-4 rounded-og-xl border border-og-border bg-og-surface-1 p-4 shadow-og-lg">
        <header className="grid gap-1">
          <h1 className="text-lg font-semibold">Voice input lifecycle fixture</h1>
          <p className="text-sm text-og-fg-muted">
            Local adapter events only · no microphone, network, provider, or credential access
          </p>
        </header>
        <div className="min-h-24 rounded-og-md border border-og-border bg-og-surface-2/30 p-3 text-sm text-og-fg-muted">
          Ordinary session timeline remains above one ordinary composer.
          {sent.length > 0 ? (
            <ol className="mt-2 grid gap-1" aria-label="Sent messages">
              {sent.map((entry) => (
                <li key={entry.id} className="text-og-fg">
                  Sent: {entry.message}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
        <ChatComposer
          composer={composer}
          transcription={{
            adapter,
            policy,
            lifecycleTimeouts: { startMs: 80, cleanupMs: 40 },
            onDiagnostic: () => {},
          }}
        />
        <fieldset className="flex flex-wrap gap-2 rounded-og-md border border-og-border p-3">
          <legend className="px-1 text-xs text-og-fg-muted">Deterministic adapter events</legend>
          <FixtureButton onClick={() => adapter.partial()}>Emit partial</FixtureButton>
          <FixtureButton onClick={() => adapter.final()}>Emit final</FixtureButton>
          <FixtureButton onClick={() => adapter.emptyThenCorrectedFinal()}>
            Emit empty then corrected final
          </FixtureButton>
          <FixtureButton onClick={() => adapter.reconnect()}>Interrupt stream</FixtureButton>
          <FixtureButton onClick={() => adapter.restore()}>Restore stream</FixtureButton>
          <FixtureButton onClick={() => adapter.fail()}>Fail stream</FixtureButton>
        </fieldset>
      </section>
    </main>
  );
}

function FixtureButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-9 rounded-og-md border border-og-border bg-og-surface-2 px-3 text-xs text-og-fg-muted hover:text-og-fg pointer-coarse:min-h-11"
    >
      {children}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
