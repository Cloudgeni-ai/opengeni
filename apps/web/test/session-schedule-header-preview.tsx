// Preview-only wiring. SessionHeader and its styles are real; the sessions are sample data.
// Serve with test/session-sidebar-preview.vite.config.ts.
import { createRoot } from "react-dom/client";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import type { Session } from "@opengeni/react/app/types";
import "../src/styles.css";

const previewTheme = new URLSearchParams(window.location.search).get("theme");
if (previewTheme === "dark" || previewTheme === "light") {
  document.documentElement.classList.toggle("dark", previewTheme === "dark");
  document.documentElement.dataset.ogTheme = previewTheme;
}

const base = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  titleSource: "user",
  parentSessionId: null,
  model: "codex/gpt-6-astra",
  reasoningEffort: "high",
  latencyMode: "standard",
  metadata: {},
  status: "idle",
  pinned: false,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as unknown as Session;

const states: { label: string; session: Session }[] = [
  {
    label: "Active schedule with a future run",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004001",
      title: "Quarterly cloud cost report",
      hasSchedules: true,
      hasUpcomingSchedules: true,
    } as Session,
  },
  {
    label: "Only paused or past one-time schedules",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004002",
      title: "Release stabilization checkpoint",
      hasSchedules: true,
      hasUpcomingSchedules: false,
    } as Session,
  },
  {
    label: "No schedules",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004003",
      title: "Workspace planning",
      hasSchedules: false,
      hasUpcomingSchedules: false,
    } as Session,
  },
];

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="flex min-h-dvh flex-col gap-6 bg-bg p-8 text-fg">
      <p className="text-xs text-fg-subtle">Sample sessions. The header component is real.</p>
      {states.map(({ label, session }) => (
        <section key={session.id} className="rounded-lg border border-border bg-surface">
          <p className="border-b border-border px-4 py-2 text-xs text-fg-muted">{label}</p>
          <SessionHeader
            session={session}
            ancestors={[]}
            connectionState="live"
            status="idle"
            keyAuthRequired={false}
            onForgetAccessKey={() => undefined}
            inspectorOpen={false}
            onToggleInspector={() => undefined}
            onRename={async () => null}
            onPin={async () => null}
            onOpenSchedule={session.hasSchedules ? () => undefined : null}
          />
        </section>
      ))}
    </main>
  </TooltipProvider>,
);
