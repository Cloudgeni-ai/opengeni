// Preview-only wiring. SessionHeader and its styles are real; the sessions are sample data.
// Serve with test/session-sidebar-preview.vite.config.ts.
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { SessionSummary } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import { SessionTenancyControl } from "@opengeni/react/app/components/session/session-tenancy-control";
import { SessionTenancyOperationController } from "@opengeni/react/app/lib/session-tenancy-operation-controller";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import type { Session } from "@opengeni/react/app/types";
import "../src/styles.css";

const params = new URLSearchParams(window.location.search);
const previewTheme = params.get("theme");
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
  tenancy: { visibility: "workspace", authorityEpoch: 1, ownedByCurrentUser: true, fork: null },
} as unknown as Session;

// The access chip is the real control; the preview never changes who can open a chat.
const tenancyClient = {
  previewSessionVisibilityChange: async () => new Promise<never>(() => undefined),
  updateSessionVisibility: async () => new Promise<never>(() => undefined),
} as unknown as OpenGeniBrowserClient;
const tenancyOperations = new SessionTenancyOperationController();

function AccessChip({ session }: { session: Session }) {
  return (
    <SessionTenancyControl
      session={session}
      client={tenancyClient}
      managedSession
      canForkPrivately={false}
      scopeLabel="Acme workspace"
      captureWorkspaceInvocation={() => ({ workspaceId: session.workspaceId, revision: 1 })}
      ownsWorkspaceInvocation={() => true}
      operationController={tenancyOperations}
      operationScope={{
        principalId: "33333333-3333-4333-8333-333333333333",
        workspaceId: session.workspaceId,
        sessionId: session.id,
        workspaceTransitionRevision: 1,
      }}
      onOpenSession={() => undefined}
    />
  );
}

const fullAccess = {
  state: {
    active: true,
    allowed: true,
    canGrant: true,
    canRevoke: true,
    grantedAt: "2026-10-01T09:00:00.000Z",
    grantedBy: { subjectId: "user:preview", name: "Jordan Lee" },
  },
  busy: false,
  grant: async () => undefined,
  revoke: () => undefined,
};

const manager = {
  id: "00000000-0000-4000-9000-000000004100",
  workspaceId: base.workspaceId,
  title: "Release manager",
  titleSource: "user",
} as unknown as SessionSummary;

const nextRun = new Date(Date.now() + 20 * 60 * 60_000);
nextRun.setMinutes(0, 0, 0);

const checks = {
  source: { kind: "github" as const, name: "GitHub" },
  eventTypes: ["check_suite.completed"],
};
const mentions = {
  source: { kind: "slack" as const, name: "Acme Slack" },
  eventTypes: ["app_mention", "message"],
};
const mail = {
  source: { kind: "gmail" as const, name: "Gmail (ada@acme.dev)" },
  eventTypes: ["message.received"],
};

const states: { label: string; session: Session; ancestors?: SessionSummary[] }[] = [
  {
    label: "No automation",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004003",
      title: "Workspace planning",
      hasSchedules: false,
      hasUpcomingSchedules: false,
    } as Session,
  },
  {
    label: "Waiting for new mail",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004007",
      title: "Inbox owner",
      hasSchedules: true,
      waitingForEvents: true,
      automationWait: { nextRunAt: null, event: mail, events: [mail], automations: 1 },
    } as Session,
  },
  {
    label: "A sub-agent chat with an automation",
    ancestors: [manager],
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004008",
      parentSessionId: manager.id,
      title: "Watch the release checks",
      hasSchedules: true,
      waitingForEvents: true,
      automationWait: { nextRunAt: null, event: checks, events: [checks], automations: 1 },
    } as Session,
  },
  {
    label: "Active schedule with a future run",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004001",
      title: "Quarterly cloud cost report",
      hasSchedules: true,
      hasUpcomingSchedules: true,
      automationWait: {
        nextRunAt: nextRun.toISOString(),
        event: null,
        events: [],
        automations: 1,
      },
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
        event: checks,
        events: [checks],
        automations: 2,
      },
    } as Session,
  },
  {
    label: "Two automations waiting on different apps",
    session: {
      ...base,
      id: "00000000-0000-4000-9000-000000004006",
      title: "Support inbox",
      hasSchedules: true,
      waitingForEvents: true,
      automationWait: {
        nextRunAt: null,
        event: mentions,
        events: [mentions, mail],
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
];

const root = createRootRoute({
  component: () => (
    <TooltipProvider>
      <main className="flex min-h-dvh flex-col gap-6 bg-bg px-0 py-4 text-fg sm:p-8">
        <p className="text-xs text-fg-subtle">Sample sessions. The header component is real.</p>
        {states.map(({ label, session, ancestors = [] }) => (
          <section
            key={session.id}
            data-header-state={label}
            className="rounded-lg border border-border bg-surface"
          >
            <p className="border-b border-border px-4 py-2 text-xs text-fg-muted">{label}</p>
            <SessionHeader
              session={session}
              ancestors={ancestors}
              connectionState="live"
              status="idle"
              keyAuthRequired={false}
              onForgetAccessKey={() => undefined}
              inspectorOpen={false}
              onToggleInspector={() => undefined}
              onRename={async () => null}
              onPin={async () => null}
              onOpenAutomations={session.hasSchedules ? () => undefined : null}
              accessSlot={<AccessChip session={session} />}
              adminAccess={fullAccess}
            />
          </section>
        ))}
      </main>
    </TooltipProvider>
  ),
});
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
