import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RealtimeVoiceOrb } from "../src/components/realtime-voice-orb";
import type { RealtimeVoiceStatus } from "../src/hooks/use-realtime-voice";
import type { RealtimeVoiceUnavailableReason } from "@opengeni/sdk";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const layout = params.get("layout") === "mobile" ? "mobile" : "desktop";
const sessionId = "9e6e7864-7f1b-4a8d-9a30-70a50676562c";

type VoiceFixture = {
  label: string;
  note: string;
  status: RealtimeVoiceStatus;
  partial?: string;
  unavailableReason?: RealtimeVoiceUnavailableReason;
  errorCode?: string;
};

const fixtures: VoiceFixture[] = [
  {
    label: "Ready",
    note: "Session target is explicit before capture",
    status: "idle",
  },
  {
    label: "Authorizing",
    note: "Capability preflight; no microphone yet",
    status: "authorizing",
  },
  {
    label: "Connecting",
    note: "Short-lived OpenGeni grant accepted",
    status: "connecting",
  },
  {
    label: "Listening",
    note: "Partial text stays ephemeral",
    status: "listening",
    partial: "Check the production rollout and…",
  },
  {
    label: "Speaking",
    note: "Tap the orb to interrupt playback only",
    status: "speaking",
  },
  {
    label: "Executing",
    note: "Accepted final is ordinary durable Send",
    status: "executing",
  },
  {
    label: "Approval",
    note: "Normal session approval state",
    status: "awaiting-approval",
  },
  {
    label: "Reconnecting",
    note: "Durable session work remains intact",
    status: "reconnecting",
  },
  {
    label: "Protocol unavailable",
    note: "Truthful production state; no provider call",
    status: "unavailable",
    unavailableReason: "codex_realtime_protocol_unverified",
  },
  {
    label: "Permission denied",
    note: "Controlled local copy and text fallback",
    status: "error",
    errorCode: "permission_denied",
  },
  {
    label: "Provider error",
    note: "Provider details never reach UI copy",
    status: "error",
    errorCode: "provider",
  },
  {
    label: "Closed",
    note: "Text remains available after voice closes",
    status: "closed",
  },
];

function Harness() {
  const [interactiveStatus, setInteractiveStatus] = useState<RealtimeVoiceStatus>("idle");
  const [fallbackFocused, setFallbackFocused] = useState(false);

  useEffect(() => {
    (globalThis as Record<string, unknown>).__ogReady = true;
  }, []);

  return (
    <main
      data-shot
      data-realtime-voice-harness
      data-og-theme={theme === "light" ? "light" : undefined}
      data-layout={layout}
      className="og-root min-h-dvh bg-og-bg text-og-fg"
    >
      <div
        className={
          layout === "mobile"
            ? "mx-auto grid w-full max-w-[26rem] gap-5 px-3 py-5"
            : "mx-auto grid w-full max-w-6xl gap-7 px-8 py-8"
        }
      >
        <header className="relative overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1 p-5 shadow-og-lg sm:p-7">
          <div className="absolute -right-20 -top-24 size-64 rounded-full bg-og-accent/10 blur-3xl" />
          <div className="relative grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-og-accent/30 bg-og-accent/10 px-2.5 py-1 text-og-xs font-semibold text-og-accent">
                Experimental
              </span>
              <span className="rounded-full border border-og-border bg-og-surface-2 px-2.5 py-1 text-og-xs text-og-fg-muted">
                Deterministic UI fixture · not live provider proof
              </span>
            </div>
            <div className="grid gap-1.5">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                One voice orb. One durable session.
              </h1>
              <p className="max-w-3xl text-sm leading-relaxed text-og-fg-muted sm:text-base">
                Full-duplex media stays ephemeral while accepted utterances, approvals, actions, and
                results reconcile through the existing session history.
              </p>
            </div>
            <div className="flex min-w-0 items-center gap-2 rounded-og-lg border border-og-border bg-og-surface-2/60 px-3 py-2 text-og-xs text-og-fg-muted">
              <span className="size-2 shrink-0 rounded-full bg-og-status-running" />
              <span className="shrink-0 font-semibold text-og-fg">Target</span>
              <span className="truncate">This session — Production rollout audit</span>
              <span className="hidden font-og-mono text-og-fg-subtle sm:inline">{sessionId}</span>
            </div>
          </div>
        </header>

        <section className="grid gap-3" aria-labelledby="state-matrix-title">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 id="state-matrix-title" className="text-base font-semibold">
                Session lifecycle states
              </h2>
              <p className="text-og-xs text-og-fg-muted">
                The real orb component across active, recovery, denied, and unavailable states.
              </p>
            </div>
            <span className="hidden text-og-xs text-og-fg-subtle sm:block">
              {theme} · {layout}
            </span>
          </div>
          <div className={layout === "mobile" ? "grid gap-3" : "grid gap-3 md:grid-cols-2"}>
            {fixtures.map((fixture) => (
              <article
                key={`${fixture.label}-${fixture.status}`}
                className="grid min-w-0 gap-2 rounded-og-lg border border-og-border bg-og-surface-1 p-3 shadow-og-sm"
                data-fixture-status={fixture.status}
              >
                <div className="flex items-baseline justify-between gap-3 px-0.5">
                  <h3 className="text-og-xs font-semibold text-og-fg">{fixture.label}</h3>
                  <p
                    className="truncate text-right text-og-xs text-og-fg-subtle"
                    title={fixture.note}
                  >
                    {fixture.note}
                  </p>
                </div>
                <RealtimeVoiceOrb
                  status={fixture.status}
                  targetLabel="This session — Production rollout audit"
                  targetSessionId={sessionId}
                  partial={fixture.partial}
                  unavailableReason={fixture.unavailableReason}
                  errorCode={fixture.errorCode}
                  onStart={() => {}}
                  onStop={() => {}}
                  onInterrupt={() => {}}
                  onTextFallback={() => {}}
                />
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-3 rounded-og-xl border border-og-border bg-og-surface-1 p-4 shadow-og-md sm:p-5">
          <div className="grid gap-1">
            <h2 className="text-base font-semibold">Interaction and text fallback</h2>
            <p className="text-og-xs text-og-fg-muted">
              Fixture controls exercise orb callbacks only; they never request media or open a
              network connection.
            </p>
          </div>
          <RealtimeVoiceOrb
            status={interactiveStatus}
            targetLabel="This session — Production rollout audit"
            targetSessionId={sessionId}
            onStart={() => setInteractiveStatus("listening")}
            onStop={() => setInteractiveStatus("closed")}
            onInterrupt={() => setInteractiveStatus("listening")}
            onTextFallback={() => setFallbackFocused(true)}
          />
          <label className="grid gap-1.5 text-og-xs font-medium text-og-fg-muted">
            Ordinary text composer
            <textarea
              autoFocus={fallbackFocused}
              rows={2}
              placeholder="Message this session…"
              className="min-h-16 w-full resize-none rounded-og-lg border border-og-border bg-og-surface-2 px-3 py-2 text-sm text-og-fg outline-none placeholder:text-og-fg-subtle focus:border-og-accent/60 focus:ring-2 focus:ring-og-accent/15"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                "idle",
                "listening",
                "speaking",
                "executing",
                "awaiting-approval",
                "reconnecting",
              ] as const
            ).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setInteractiveStatus(status)}
                className="min-h-9 rounded-og-md border border-og-border bg-og-surface-2 px-2.5 text-og-xs text-og-fg-muted hover:border-og-accent/40 hover:text-og-fg pointer-coarse:min-h-11"
              >
                {status}
              </button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
