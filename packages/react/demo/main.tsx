import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CalendarClockIcon, MessagesSquareIcon, NetworkIcon, PanelRightIcon } from "lucide-react";
import {
  ChatComposer,
  FleetTile,
  MessageTimeline,
  OpenGeniProvider,
  SandboxWorkspace,
  SessionStatus,
  useAvailableModels,
  useComposer,
  useOpenGeni,
  useScheduledTasks,
  useSession,
  useSessionEvents,
  useWorkspaceSessions,
} from "@opengeni/react";
import { MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
import "./styles.css";

type DemoView = "session" | "fleet" | "schedules";

type DemoHistoryState = {
  view: DemoView;
  workspaceOpen: boolean;
};

const DEMO_HISTORY_KEY = "ogReactDemo";
const COMPACT_BREAKPOINT = 1024;

function isDemoView(value: string): value is DemoView {
  return value === "session" || value === "fleet" || value === "schedules";
}

function viewFromLocation(): DemoView {
  const candidate = window.location.hash.replace(/^#/, "");
  return isDemoView(candidate) ? candidate : "session";
}

function demoHistoryState(): DemoHistoryState | null {
  const state = window.history.state;
  if (!state || typeof state !== "object") return null;
  const candidate = (state as Record<string, unknown>)[DEMO_HISTORY_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const view = (candidate as Record<string, unknown>).view;
  const workspaceOpen = (candidate as Record<string, unknown>).workspaceOpen;
  if (typeof view !== "string" || !isDemoView(view) || typeof workspaceOpen !== "boolean") {
    return null;
  }
  return { view, workspaceOpen };
}

function nextHistoryState(view: DemoView, workspaceOpen: boolean): Record<string, unknown> {
  const current = window.history.state;
  const state = current && typeof current === "object" ? { ...current } : {};
  return {
    ...state,
    [DEMO_HISTORY_KEY]: { view, workspaceOpen } satisfies DemoHistoryState,
  };
}

function urlForView(view: DemoView): string {
  const url = new URL(window.location.href);
  url.hash = view === "session" ? "" : view;
  return url.toString();
}

function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(
    () => window.matchMedia(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const compact = useCompactViewport();
  const [initialRoute] = useState(() => {
    const history = demoHistoryState();
    return {
      view: history?.view ?? viewFromLocation(),
      workspaceOpen: history?.workspaceOpen ?? false,
    };
  });
  const [view, setView] = useState<DemoView>(initialRoute.view);
  const [workspaceOpen, setWorkspaceOpen] = useState(initialRoute.workspaceOpen);
  // Mount the whole workbench through its public `<SandboxWorkspace>` surface —
  // the exact integration an external embedder uses. The deterministic client
  // supplies realistic data without pretending this public demo is a customer workspace.
  const { events } = useSessionEvents(MANAGER_SESSION_ID);

  useEffect(() => {
    const syncFromHistory = () => {
      const state = demoHistoryState();
      setView(state?.view ?? viewFromLocation());
      setWorkspaceOpen(state?.workspaceOpen ?? false);
    };

    window.history.replaceState(
      nextHistoryState(initialRoute.view, initialRoute.workspaceOpen),
      "",
      urlForView(initialRoute.view),
    );
    window.addEventListener("popstate", syncFromHistory);
    window.addEventListener("hashchange", syncFromHistory);
    return () => {
      window.removeEventListener("popstate", syncFromHistory);
      window.removeEventListener("hashchange", syncFromHistory);
    };
  }, [initialRoute]);

  const selectView = useCallback((next: DemoView) => {
    const current = demoHistoryState();
    if (current?.view === next && !current.workspaceOpen) return;
    window.history.pushState(nextHistoryState(next, false), "", urlForView(next));
    setView(next);
    setWorkspaceOpen(false);
  }, []);

  const openWorkspace = useCallback(() => {
    if (workspaceOpen) return;
    window.history.pushState(nextHistoryState(view, true), "", window.location.href);
    setWorkspaceOpen(true);
  }, [view, workspaceOpen]);

  const closeWorkspace = useCallback(() => {
    if (demoHistoryState()?.workspaceOpen) {
      window.history.back();
      return;
    }
    setWorkspaceOpen(false);
  }, []);

  const onWorkspaceCollapsedChange = useCallback(
    (collapsed: boolean) => {
      if (!compact) return;
      if (collapsed) closeWorkspace();
      else openWorkspace();
    },
    [closeWorkspace, compact, openWorkspace],
  );

  return (
    <div
      className="og-root box-border h-dvh overflow-hidden bg-og-bg pt-[env(safe-area-inset-top)]"
      data-og-theme={theme === "light" ? "light" : undefined}
    >
      <div className="mx-auto flex h-full max-w-7xl flex-col pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] lg:pl-[max(1.5rem,env(safe-area-inset-left))] lg:pr-[max(1.5rem,env(safe-area-inset-right))]">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-og-border py-2.5 sm:py-3.5">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-og-fg">OpenGeni React demo</h1>
            <p className="truncate text-[11px] text-og-fg-subtle sm:text-xs">
              Public React UI · scripted data
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-og-md border border-og-border px-3 text-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:bg-og-surface-1 hover:text-og-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent"
            aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:py-4 lg:py-5">
          {compact ? (
            <DemoNavigation
              activeView={view}
              onSelectView={selectView}
              onOpenWorkspace={openWorkspace}
              workspaceOpen={workspaceOpen}
            />
          ) : null}
          <div className="min-h-0 flex-1">
            <SandboxWorkspace
              sessionId={MANAGER_SESSION_ID}
              events={events}
              autoSaveId="og.demo.dock"
              {...(compact
                ? {
                    collapsed: !workspaceOpen,
                    onCollapsedChange: onWorkspaceCollapsedChange,
                  }
                : {})}
              primary={<DemoPrimary compact={compact} view={view} />}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

function DemoNavigation({
  activeView,
  onSelectView,
  onOpenWorkspace,
  workspaceOpen,
}: {
  activeView: DemoView;
  onSelectView: (view: DemoView) => void;
  onOpenWorkspace: () => void;
  workspaceOpen: boolean;
}) {
  const itemClass =
    "flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-og-sm px-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent";
  const selectedClass = "bg-og-surface-3 text-og-fg";
  const idleClass = "text-og-fg-subtle hover:bg-og-surface-2 hover:text-og-fg";

  return (
    <nav
      aria-label="Demo views"
      className="mb-2 grid shrink-0 grid-cols-4 gap-1 rounded-og-md border border-og-border bg-og-surface-1 p-1"
    >
      <button
        type="button"
        onClick={() => onSelectView("session")}
        aria-current={activeView === "session" && !workspaceOpen ? "page" : undefined}
        className={`${itemClass} ${activeView === "session" && !workspaceOpen ? selectedClass : idleClass}`}
      >
        <MessagesSquareIcon className="size-4" aria-hidden />
        <span className="truncate">Session</span>
      </button>
      <button
        type="button"
        onClick={() => onSelectView("fleet")}
        aria-current={activeView === "fleet" && !workspaceOpen ? "page" : undefined}
        className={`${itemClass} ${activeView === "fleet" && !workspaceOpen ? selectedClass : idleClass}`}
      >
        <NetworkIcon className="size-4" aria-hidden />
        <span className="truncate">Fleet</span>
      </button>
      <button
        type="button"
        onClick={() => onSelectView("schedules")}
        aria-current={activeView === "schedules" && !workspaceOpen ? "page" : undefined}
        className={`${itemClass} ${activeView === "schedules" && !workspaceOpen ? selectedClass : idleClass}`}
      >
        <CalendarClockIcon className="size-4" aria-hidden />
        <span className="truncate">Schedules</span>
      </button>
      <button
        type="button"
        onClick={onOpenWorkspace}
        aria-haspopup="dialog"
        aria-expanded={workspaceOpen}
        className={`${itemClass} ${workspaceOpen ? selectedClass : idleClass}`}
      >
        <PanelRightIcon className="size-4" aria-hidden />
        <span className="truncate">Workspace</span>
      </button>
    </nav>
  );
}

function DemoPrimary({ compact, view }: { compact: boolean; view: DemoView }) {
  return (
    <div
      className={
        compact
          ? "h-full min-h-0"
          : "grid h-full min-h-0 gap-6 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]"
      }
    >
      <div className={compact && view !== "session" ? "hidden" : "h-full min-h-0"}>
        <OpsChannel autoFocus={!compact} />
      </div>
      <div
        role={!compact ? "complementary" : undefined}
        aria-label={!compact ? "Fleet and scheduled tasks" : undefined}
        tabIndex={!compact ? 0 : undefined}
        className={
          compact
            ? view === "session"
              ? "hidden"
              : "h-full min-h-0"
            : "flex min-h-0 flex-col gap-6 overflow-y-auto pb-4"
        }
      >
        <div className={compact && view !== "fleet" ? "hidden" : compact ? "h-full" : ""}>
          <Fleet standalone={compact} />
        </div>
        <div className={compact && view !== "schedules" ? "hidden" : compact ? "h-full" : ""}>
          <Schedules standalone={compact} />
        </div>
      </div>
    </div>
  );
}

/** The hero surface: manager session timeline + composer. */
function OpsChannel({ autoFocus }: { autoFocus: boolean }) {
  const { client, workspaceId } = useOpenGeni();
  const { session } = useSession(MANAGER_SESSION_ID, { pollIntervalMs: 5000 });
  const { timeline, sessionStatus, connectionState } = useSessionEvents(MANAGER_SESSION_ID);
  // Host-exposed models for the composer's <ModelPicker>; preselect the
  // deployment default once it loads, then let the operator switch.
  const { models, defaultModel } = useAvailableModels();
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const model = selectedModel ?? defaultModel ?? undefined;
  // Thread the chosen model into every send via sendExtras (evaluated at send
  // time so it always reflects the current selection).
  const composer = useComposer(MANAGER_SESSION_ID, {
    sendExtras: () => (model ? { model } : {}),
    effectiveControl: session?.effectiveControl,
  });
  const status = sessionStatus ?? session?.status ?? null;
  // Surface the slash-command palette (type "/"): operator controls on this
  // session. The demo operator holds full control.
  const commandContext = {
    client,
    workspaceId,
    sessionId: MANAGER_SESSION_ID,
    status,
    permissions: ["sessions:control"],
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1/50">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-og-border px-3.5 py-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-og-fg">Staging operations</h2>
          <p className="truncate text-[11px] text-og-fg-subtle">
            Manager · API staging + production drift
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-[11px] capitalize text-og-fg-subtle min-[360px]:inline">
            {connectionState === "live" ? "stream live" : connectionState}
          </span>
          {status ? <SessionStatus status={status} /> : null}
        </div>
      </div>
      <MessageTimeline items={timeline} status={status} className="min-h-0 flex-1" />
      <div className="shrink-0 px-3.5 pb-3 pt-1 sm:px-4 sm:pb-4">
        <ChatComposer
          composer={composer}
          effectiveControl={session?.effectiveControl}
          placeholder="Ask the manager to adjust the plan…"
          autoFocus={autoFocus}
          commandContext={commandContext}
          models={models}
          selectedModel={model}
          onSelectModel={setSelectedModel}
        />
      </div>
    </section>
  );
}

function Fleet({ standalone }: { standalone: boolean }) {
  const { sessions, loading } = useWorkspaceSessions({ pollIntervalMs: 10000 });
  return (
    <section
      className={
        standalone
          ? "flex h-full min-h-0 flex-col overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1/50"
          : ""
      }
    >
      <div className={standalone ? "shrink-0 border-b border-og-border px-4 py-3" : ""}>
        <h2
          className={
            standalone
              ? "text-sm font-medium text-og-fg"
              : "mb-3 text-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle"
          }
        >
          Fleet
        </h2>
        {standalone ? (
          <p className="mt-0.5 text-[11px] text-og-fg-subtle">
            Durable manager and worker sessions in this scripted workspace
          </p>
        ) : null}
      </div>
      <div
        aria-label={standalone ? "Fleet sessions" : undefined}
        tabIndex={standalone ? 0 : undefined}
        className={
          standalone
            ? "min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            : "grid grid-cols-1 gap-3"
        }
      >
        {loading && sessions.length === 0 ? (
          <p className="text-xs text-og-fg-subtle">Loading sessions…</p>
        ) : null}
        <div className={standalone ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "contents"}>
          {sessions.map((session) => (
            <FleetTile key={session.id} session={session} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Schedules({ standalone }: { standalone: boolean }) {
  const { tasks } = useScheduledTasks();
  const labels = useMemo(
    () =>
      tasks.map((task) => ({
        id: task.id,
        name: task.name,
        cadence:
          task.schedule.type === "interval"
            ? `every ${Math.round(task.schedule.everySeconds / 60)}m`
            : task.schedule.type === "calendar"
              ? `${String(task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")} ${task.schedule.daysOfWeek?.join(", ").toLowerCase() ?? "daily"}`
              : "once",
        status: task.status,
      })),
    [tasks],
  );
  return (
    <section
      className={
        standalone
          ? "flex h-full min-h-0 flex-col overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1/50"
          : ""
      }
    >
      <div className={standalone ? "shrink-0 border-b border-og-border px-4 py-3" : ""}>
        <h2
          className={
            standalone
              ? "text-sm font-medium text-og-fg"
              : "mb-3 text-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle"
          }
        >
          Scheduled tasks
        </h2>
        {standalone ? (
          <p className="mt-0.5 text-[11px] text-og-fg-subtle">
            Recurring autonomous work configured for this workspace
          </p>
        ) : null}
      </div>
      <ul
        aria-label={standalone ? "Scheduled tasks" : undefined}
        tabIndex={standalone ? 0 : undefined}
        className={
          standalone
            ? "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            : "flex flex-col gap-2"
        }
      >
        {labels.map((task) => (
          <li
            key={task.id}
            className="flex flex-col items-start gap-1.5 rounded-og-md border border-og-border bg-og-surface-1 px-3.5 py-3 min-[390px]:flex-row min-[390px]:items-center min-[390px]:justify-between min-[390px]:gap-3"
          >
            <span className="min-w-0 break-words text-[13px] text-og-fg">{task.name}</span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] text-og-fg-subtle">
              <span className="font-og-mono">{task.cadence}</span>
              <span className={task.status === "active" ? "text-og-status-idle" : ""}>
                {task.status}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const client = new MockOpenGeniClient();
createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId="11111111-2222-4333-8444-555555555555">
    <Harness />
  </OpenGeniProvider>,
);
