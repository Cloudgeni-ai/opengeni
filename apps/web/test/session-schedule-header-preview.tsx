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

const nextRun = new Date(Date.now() + 20 * 60 * 60_000);
nextRun.setMinutes(0, 0, 0);

const states: { label: string; session: Session }[] = [
  {
    label: "Active schedule with a future run",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004001",
      title: "Quarterly cloud cost report",
      hasSchedules: true,
      hasUpcomingSchedules: true,
      automationWait: { nextRunAt: nextRun.toISOString(), event: null, automations: 1 },
    } as Session,
  },
  {
    label: "Waiting for an app's event, with a schedule too",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004004",
      title: "Ship the billing migration",
      hasSchedules: true,
      hasUpcomingSchedules: true,
      waitingForEvents: true,
      automationWait: {
        nextRunAt: nextRun.toISOString(),
        event: {
          source: { kind: "github", name: "GitHub" },
          eventTypes: ["check_suite.completed"],
        },
        automations: 2,
      },
    } as Session,
  },
  {
    label: "Waiting for an event, from a server without the details",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004005",
      title: "Follow up when the order ships",
      hasSchedules: true,
      waitingForEvents: true,
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
            onOpenAutomations={session.hasSchedules ? () => undefined : null}
          />
        </section>
      ))}
    </main>
  </TooltipProvider>,
);
