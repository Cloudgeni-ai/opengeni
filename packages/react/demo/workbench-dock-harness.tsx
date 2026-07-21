import { createRoot } from "react-dom/client";
import { OpenGeniProvider, SandboxWorkspace, useSessionEvents } from "../src/index";
import { DOCK_SESSION_ID, DOCK_STATES, DockStateMockClient } from "./workbench-dock-states";
import "./styles.css";

/* ----------------------------------------------------------------------------
   M7 full-dock harness — mounts the real `<SandboxWorkspace>` (dock frame +
   header + machine chip + tabs + surfaces) against a state-driven mock client,
   so a screenshot runner can capture every dossier §13 matrix cell through the
   exact public surface an embedder (tracked issue) mounts.

   Query params:
     ?state=<key>   one of DOCK_STATES (warm-live, cold-instant, waking, …)
     &theme=dark|light
     &tab=changes|files|terminal|desktop   (initial tab override)
   -------------------------------------------------------------------------- */

const params = new URLSearchParams(window.location.search);
const stateKey = params.get("state") ?? "warm-live";
const theme = params.get("theme") === "light" ? "light" : "dark";
const tabParam = params.get("tab") ?? undefined;
const state = DOCK_STATES[stateKey] ?? DOCK_STATES["warm-live"]!;
const client = new DockStateMockClient(state);

/** A calm, neutral primary pane so the dock reads in a real session context
 *  without pulling in the scripted manager narrative. The dock is the subject. */
function PrimaryPane() {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1/40">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-og-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-og-fg">Security hardening</h2>
          <p className="truncate font-og-mono text-[11px] text-og-fg-subtle">
            session · {DOCK_SESSION_ID.slice(0, 8)}
          </p>
        </div>
        <span className="rounded-og-xs bg-og-accent-soft px-1.5 py-0.5 text-2xs text-og-fg-muted">
          agent
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="ml-auto max-w-[80%] rounded-og-lg bg-og-accent-soft px-3.5 py-2 text-[13px] text-og-fg">
          Harden the API: lock CORS to an allowlist, add helmet + rate limiting, and enable instance
          monitoring in Terraform.
        </div>
        <div className="max-w-[85%] space-y-2 text-[13px] text-og-fg-muted">
          <p>
            Done. I tightened <span className="font-og-mono text-og-fg">createServer()</span> to
            pass an explicit origin allowlist and added the two middlewares, introduced{" "}
            <span className="font-og-mono text-og-fg">ALLOWED_ORIGINS</span>, and turned on
            monitoring + EBS optimization on the API instance.
          </p>
          <p>The full diff is in the Changes tab.</p>
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4 pt-1">
        <div className="flex items-center gap-2 rounded-og-lg border border-og-border bg-og-surface-1 px-3.5 py-2.5 text-[13px] text-og-fg-subtle">
          Message the agent…
        </div>
      </div>
    </section>
  );
}

function Harness() {
  const { events } = useSessionEvents(DOCK_SESSION_ID);
  return (
    <div className="og-root h-dvh bg-og-bg" data-og-theme={theme === "light" ? "light" : undefined}>
      <div className="mx-auto flex h-dvh max-w-7xl flex-col px-4 sm:px-6">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-og-border py-3">
          <h1 className="text-sm font-semibold text-og-fg">Workbench dock — {state.label}</h1>
          <span className="font-og-mono text-[11px] text-og-fg-subtle">{stateKey}</span>
        </header>
        <main className="min-h-0 flex-1 py-4">
          <SandboxWorkspace
            key={`${stateKey}-${theme}-${tabParam ?? ""}`}
            sessionId={DOCK_SESSION_ID}
            events={events}
            autoSaveId={`og.m7.${stateKey}`}
            defaultSize={52}
            {...(tabParam ? { initialTab: tabParam } : {})}
            primary={<PrimaryPane />}
          />
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client as never} workspaceId="11111111-2222-4333-8444-555555555555">
    <Harness />
  </OpenGeniProvider>,
);
