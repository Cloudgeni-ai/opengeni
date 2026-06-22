import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionStatus as SessionStatusValue } from "@opengeni/sdk";
import {
  ChatComposer,
  DesktopViewer,
  FleetTile,
  MessageTimeline,
  OpenGeniProvider,
  SandboxFiles,
  SandboxTerminal,
  SessionStatus,
  useAvailableModels,
  useComposer,
  useOpenGeni,
  useSandboxFiles,
  useSandboxGit,
  useSandboxTerminal,
  useScheduledTasks,
  useSession,
  useSessionCapabilities,
  useSessionEvents,
  useWorkspaceSessions,
  WorkspaceDock,
  xtermThemeFromTokens,
  type WorkspaceTab,
  type XtermTheme,
} from "../src/index";
import { MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
import "./styles.css";

const ALL_STATUSES: SessionStatusValue[] = ["queued", "running", "idle", "requires_action", "failed", "cancelled"];

function Harness() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const sandboxTabs = useSandboxTabs(MANAGER_SESSION_ID);
  return (
    <div className="og-root min-h-full bg-og-bg" data-og-theme={theme === "light" ? "light" : undefined}>
      <div className="mx-auto flex h-dvh max-w-7xl flex-col px-4 sm:px-6">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-og-border py-4">
          <div>
            <h1 className="text-sm font-semibold text-og-fg">@opengeni/react</h1>
            <p className="text-xs text-og-fg-subtle">Component harness — real hooks against a scripted client</p>
          </div>
          <div className="flex items-center gap-2">
            {ALL_STATUSES.map((status) => (
              <SessionStatus key={status} status={status} size="sm" className="max-md:hidden" />
            ))}
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="rounded-og-sm border border-og-border px-2.5 py-1 text-xs font-medium text-og-fg-muted transition-colors hover:border-og-border-strong hover:text-og-fg"
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 py-5">
          <WorkspaceDock
            autoSaveId="og.demo.dock"
            primary={
              <div className="grid h-full min-h-0 gap-6 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
                <OpsChannel />
                <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto pb-4 max-lg:hidden">
                  <Fleet />
                  <Schedules />
                </aside>
              </div>
            }
            tabs={sandboxTabs}
          />
        </main>
      </div>
    </div>
  );
}

/** The hero surface: manager session timeline + composer. */
function OpsChannel() {
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
    <section className="flex min-h-0 flex-col overflow-hidden rounded-og-xl border border-og-border bg-og-surface-1/50">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-og-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-og-fg">Ops channel</h2>
          <p className="truncate font-og-mono text-[11px] text-og-fg-subtle">{MANAGER_SESSION_ID}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-og-fg-subtle">{connectionState}</span>
          {status ? <SessionStatus status={status} /> : null}
        </div>
      </div>
      <MessageTimeline
        items={timeline}
        status={status}
        className="min-h-0 flex-1"
        onOpenSession={(sessionId) => window.alert(`Open worker session ${sessionId}`)}
      />
      <div className="shrink-0 px-4 pb-4 pt-1">
        <ChatComposer
          composer={composer}
          status={status}
          placeholder="Message your infrastructure…"
          autoFocus
          commandContext={commandContext}
          models={models}
          selectedModel={model}
          onSelectModel={setSelectedModel}
        />
      </div>
    </section>
  );
}

/**
 * Build the three capability-gated Workspace tabs against the mock client, so
 * the headless harness exercises Files (review-first git), Terminal (xterm), and
 * Desktop (noVNC chrome) end-to-end.
 */
function useSandboxTabs(sessionId: string): WorkspaceTab[] {
  const { events } = useSessionEvents(sessionId);
  const caps = useSessionCapabilities(sessionId, { events, attachDesktop: true });
  const capabilities = caps.capabilities;
  const fsOn = capabilities?.FileSystem.available ?? false;
  const gitOn = capabilities?.Git.available ?? false;
  const terminalOn = (capabilities?.Terminal.transport ?? null) !== null;
  const desktopOn = (capabilities?.DesktopStream.transport ?? null) !== null;

  const files = useSandboxFiles(sessionId, { events, enabled: fsOn });
  const git = useSandboxGit(sessionId, { events, enabled: gitOn });
  const stagedGit = useSandboxGit(sessionId, { events, enabled: gitOn, staged: true });
  const terminal = useSandboxTerminal(sessionId, { events });

  const [xtermTheme, setXtermTheme] = useState<XtermTheme | undefined>(undefined);
  useEffect(() => {
    const derive = () => setXtermTheme(xtermThemeFromTokens());
    derive();
    const observer = new MutationObserver(derive);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-og-theme"] });
    return () => observer.disconnect();
  }, []);

  return useMemo(() => {
    const tabs: WorkspaceTab[] = [];
    if (fsOn) {
      tabs.push({
        id: "files",
        label: "Files",
        ...(git.diff.length > 0
          ? { badge: <span className="rounded-og-xs bg-og-accent-soft px-1 text-[9px] text-og-fg-muted">{git.diff.length}</span> }
          : {}),
        content: <SandboxFiles files={files} git={git} stagedGit={stagedGit} fileSystemAvailable={fsOn} className="h-full" />,
      });
    }
    if (terminalOn) {
      tabs.push({
        id: "terminal",
        label: "Terminal",
        content: (
          <div className="h-full bg-og-bg p-1">
            <SandboxTerminal result={terminal} showHeader shell={capabilities?.Terminal.shell ?? undefined} {...(xtermTheme ? { theme: xtermTheme } : {})} />
          </div>
        ),
      });
    }
    if (desktopOn) {
      tabs.push({
        id: "desktop",
        label: "Desktop",
        content: <DesktopViewer capability={capabilities?.DesktopStream ?? null} viewerCapReached={caps.viewerCapReached} className="h-full" />,
      });
    }
    return tabs;
  }, [fsOn, terminalOn, desktopOn, files, git, stagedGit, terminal, xtermTheme, capabilities, caps.viewerCapReached]);
}

function Fleet() {
  const { sessions, loading } = useWorkspaceSessions({ pollIntervalMs: 10000 });
  return (
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle">Fleet</h2>
      <div className="grid grid-cols-1 gap-3">
        {loading && sessions.length === 0 ? <p className="text-xs text-og-fg-subtle">Loading sessions…</p> : null}
        {sessions.map((session) => (
          <FleetTile key={session.id} session={session} onOpen={(s) => window.alert(`Open session ${s.id}`)} />
        ))}
      </div>
    </section>
  );
}

function Schedules() {
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
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.08em] text-og-fg-subtle">Scheduled tasks</h2>
      <ul className="flex flex-col gap-2">
        {labels.map((task) => (
          <li key={task.id} className="flex items-center justify-between gap-3 rounded-og-md border border-og-border bg-og-surface-1 px-3.5 py-2.5">
            <span className="min-w-0 truncate text-[13px] text-og-fg">{task.name}</span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] text-og-fg-subtle">
              <span className="font-og-mono">{task.cadence}</span>
              <span className={task.status === "active" ? "text-og-status-idle" : ""}>{task.status}</span>
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
