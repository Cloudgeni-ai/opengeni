import type {
  CapabilityCatalogItem,
  CodexConnectionStatus,
  Session,
  Workspace,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarStyleContext } from "./components/AgentAvatar";
import { ChatView } from "./components/ChatView";
import { SettingsDialog, type SettingsTab, type Theme } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { DraftAgentView, newDraft, type Draft } from "./components/DraftAgent";
import { archivedAgents, toAgents, type Agent } from "./lib/agents";
import {
  appApi,
  client,
  EFFORT_REASONING,
  sessionEffort,
  type AppState,
  type Bootstrap,
  type EffortLevel,
} from "./lib/app-api";
import { AppEventsContext } from "./lib/app-events";
import { appHost } from "./lib/app-host";
import { avatarStyleId } from "./lib/avatar-styles";
import { AppComputerProvider } from "./lib/this-computer";
import { buildModelContext, type ReplyLength } from "./lib/context";
import { Splash } from "./components/Splash";
import { StartProblem } from "./components/StartProblem";
import { Welcome } from "./components/Welcome";

const THEME_KEY = "simple:theme";
const SESSION_POLL_MS = 4000;
const STATE_POLL_MS = 5000;
const DRAFT = "new";

function readHashAgent() {
  if (window.location.hash === `#/${DRAFT}`) return DRAFT;
  const match = /^#\/([0-9a-f-]{36})$/.exec(window.location.hash);
  return match ? match[1]! : null;
}

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function App({
  workspaceId,
  onSwitchWorkspace,
}: {
  workspaceId: string;
  onSwitchWorkspace: (id: string) => void;
}) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<unknown>(undefined);
  const [state, setState] = useState<AppState | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [connections, setConnections] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CapabilityCatalogItem[]>([]);
  const [codex, setCodex] = useState<CodexConnectionStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(readHashAgent);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(newDraft);
  // The agent made from the draft, shown as the draft until the list has it.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>(storedTheme);

  // Theme follows the system unless chosen.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
  const setTheme = (next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Remembered for this tab only.
    }
  };

  const loadBoot = useCallback(() => {
    setBootError(undefined);
    appApi
      .bootstrap(workspaceId)
      .then((value) => {
        setBoot(value);
        setState(value);
      })
      .catch((error: unknown) => setBootError(error ?? new Error("Unknown")));
  }, [workspaceId]);
  useEffect(loadBoot, [loadBoot]);

  const refreshSessions = useCallback(async () => {
    setSessions(await appApi.agents(workspaceId));
  }, [workspaceId]);
  const refreshState = useCallback(async () => {
    setState(await appApi.state(workspaceId));
  }, [workspaceId]);
  const refreshCodex = useCallback(() => {
    void client.codexStatus(workspaceId).then(setCodex, () => setCodex(null));
  }, [workspaceId]);

  useEffect(() => {
    if (!boot?.mainSessionId) return;
    let stopped = false;
    let loaded = false;
    const tick = () => {
      if (stopped) return;
      // Later polls fail quietly; the first one must load, or the splash never ends.
      void refreshSessions().then(
        () => {
          loaded = true;
        },
        (error: unknown) => {
          if (!loaded && !stopped) setBootError(error ?? new Error("Unknown"));
        },
      );
    };
    tick();
    const sessionsTimer = setInterval(tick, SESSION_POLL_MS);
    const stateTimer = setInterval(() => void refreshState().catch(() => {}), STATE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(sessionsTimer);
      clearInterval(stateTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [boot, refreshSessions, refreshState]);

  useEffect(() => {
    if (!boot) return;
    void client.listWorkspaces().then(setWorkspaces, () => {});
    refreshCodex();
    const loadConnections = () =>
      void client.listConnections(workspaceId).then(
        (rows) =>
          setConnections([
            ...new Set(
              rows.filter((row) => row.status === "active").map((row) => row.providerDomain),
            ),
          ]),
        () => {},
      );
    const loadCatalog = () =>
      void client.listCapabilities(workspaceId).then(
        (value) => setCatalog(value.items),
        () => {},
      );
    loadConnections();
    loadCatalog();
    const timer = setInterval(() => {
      loadConnections();
      loadCatalog();
    }, 30_000);
    return () => clearInterval(timer);
  }, [boot, refreshCodex, workspaceId]);

  const archived = useMemo(
    () => archivedAgents(sessions ?? [], state?.profiles ?? []),
    [sessions, state?.profiles],
  );
  const agents = useMemo(
    () => toAgents(sessions ?? [], state?.profiles ?? [], state?.usage ?? []),
    [sessions, state],
  );
  const mainId = boot?.mainSessionId ?? null;
  const selected =
    agents.find((agent) => agent.id === selectedId) ??
    agents.find((agent) => agent.id === mainId) ??
    null;

  const prefs = state?.prefs ?? {};
  const defaultEffort =
    (prefs.defaultEffort as EffortLevel | undefined) ?? boot?.config.defaultEffort ?? "balanced";
  const replyLength: ReplyLength = prefs.replyLength === "detailed" ? "detailed" : "short";
  // The Mac app notifies by default; a browser tab only when asked to.
  const notifications =
    prefs.notifications === "on" || (prefs.notifications !== "off" && appHost !== null);
  const setPref = (key: string, value: string) => {
    setState((current) =>
      current ? { ...current, prefs: { ...current.prefs, [key]: value } } : current,
    );
    void appApi.setPrefs(workspaceId, { [key]: value }).catch(() => void refreshState());
  };

  // Every message a person sends carries its agent's thinking setting.
  for (const agent of agents) {
    sessionEffort.set(agent.id, EFFORT_REASONING[agent.profile?.effort ?? defaultEffort]);
  }

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setSidebarOpen(false);
      if (window.location.hash !== `#/${id}`) window.history.pushState(null, "", `#/${id}`);
      if (id !== DRAFT) void appApi.usage(workspaceId, id, "open");
    },
    [workspaceId],
  );
  useEffect(() => {
    const onHash = () => setSelectedId(readHashAgent());
    window.addEventListener("popstate", onHash);
    return () => window.removeEventListener("popstate", onHash);
  }, []);
  // A just-created agent may not be in the list yet; fetch until it is.
  useEffect(() => {
    if (
      selectedId &&
      selectedId !== DRAFT &&
      sessions &&
      !sessions.some((session) => session.id === selectedId)
    ) {
      const timer = setTimeout(() => void refreshSessions().catch(() => {}), 800);
      return () => clearTimeout(timer);
    }
  }, [refreshSessions, selectedId, sessions]);

  const changed = useCallback(() => {
    void refreshSessions().catch(() => {});
    void refreshState().catch(() => {});
  }, [refreshSessions, refreshState]);
  const events = useMemo(
    () => ({
      changed,
      openSettings: (tab?: string) => setSettings((tab as SettingsTab) ?? "general"),
    }),
    [changed],
  );

  // Opening the draft is instant and idempotent; the agent is made on the first message.
  const newAgent = () => select(DRAFT);
  const sendDraft = async (text: string) => {
    const current = { ...draft, sending: text, error: null };
    setDraft(current);
    const self = { id: "this chat", name: "New agent", role: "agent" } as Agent;
    try {
      const { sessionId } = await appApi.createAgent(workspaceId, {
        shared: current.shared,
        firstMessage: text,
        requestId: current.requestId,
        modelContext: buildModelContext({ self, agents, connections, replyLength }),
      });
      setPendingId(sessionId);
      select(sessionId);
      await Promise.all([refreshSessions(), refreshState()]).catch(() => {});
    } catch (error) {
      setDraft({
        ...current,
        text,
        sending: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // Once the new agent is listed, the draft starts over for next time.
  useEffect(() => {
    if (pendingId && agents.some((agent) => agent.id === pendingId)) {
      setPendingId(null);
      setDraft(newDraft());
    }
  }, [agents, pendingId]);

  useNotifications(agents, notifications, selected?.id ?? null, select);

  if (bootError !== undefined) return <StartProblem error={bootError} onRetry={loadBoot} />;
  if (boot?.needsModel) return <Welcome workspaceId={workspaceId} onReady={loadBoot} />;
  if (!boot || !sessions || !selected) return <Splash />;
  const drafting =
    selectedId === DRAFT ||
    (pendingId !== null && selectedId === pendingId && !agents.some((a) => a.id === pendingId));

  const avatarStyle = avatarStyleId(prefs.avatarTheme);
  const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null;
  const sidebar = (
    <Sidebar
      agents={agents}
      archived={archived}
      onRestore={async (id) => {
        try {
          await client.updateSessionArchive(workspaceId, id, { archived: false });
          await refreshSessions();
          select(id);
        } catch {
          window.alert("Couldn't restore this agent. Try again in a moment.");
        }
      }}
      selectedId={drafting ? null : selected.id}
      workspaceName={workspaces.length > 1 ? workspaceName : null}
      drafting={drafting}
      onSelect={select}
      onNew={newAgent}
      onSettings={() => setSettings("general")}
      onClose={() => setSidebarOpen(false)}
    />
  );

  return (
    <AppEventsContext.Provider value={events}>
      <AvatarStyleContext.Provider value={avatarStyle}>
        <AppComputerProvider workspaceId={workspaceId}>
          <div className="flex h-full">
            <div className="hidden w-[272px] shrink-0 border-r border-[var(--app-border)] md:block">
              {sidebar}
            </div>
            {sidebarOpen ? (
              <div className="fixed inset-0 z-40 md:hidden">
                <div
                  className="absolute inset-0 bg-black/30"
                  onClick={() => setSidebarOpen(false)}
                />
                <div className="card-in absolute inset-y-0 left-0 w-[86%] max-w-[320px] shadow-2xl">
                  {sidebar}
                </div>
              </div>
            ) : null}
            <main className="flex h-full min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
              {codex && !codex.connected ? (
                <div className="flex shrink-0 items-center gap-3 border-b border-[var(--app-border)] bg-[var(--app-accent-soft)] px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1">Connect ChatGPT so your agents can think.</span>
                  <button
                    type="button"
                    onClick={() => setSettings("models")}
                    className="shrink-0 rounded-full bg-[var(--app-accent)] px-3 py-1 text-xs font-medium text-white"
                  >
                    Connect
                  </button>
                </div>
              ) : null}
              {drafting ? (
                <DraftAgentView
                  draft={draft}
                  workspaceName={workspaceName}
                  onChange={setDraft}
                  onSend={(text) => void sendDraft(text)}
                  onOpenSidebar={() => setSidebarOpen(true)}
                />
              ) : (
                <ChatView
                  workspaceId={workspaceId}
                  agent={selected}
                  agents={agents}
                  effort={selected.profile?.effort ?? defaultEffort}
                  defaultEffort={defaultEffort}
                  replyLength={replyLength}
                  connections={connections}
                  catalog={catalog}
                  onOpenAgent={select}
                  onOpenSidebar={() => setSidebarOpen(true)}
                  onReconnectModel={() => setSettings("models")}
                  fullAppUrl={boot?.config.fullAppUrl ?? null}
                />
              )}
            </main>
          </div>
          {settings ? (
            <SettingsDialog
              tab={settings}
              onTab={setSettings}
              onClose={() => setSettings(null)}
              workspaceId={workspaceId}
              workspaces={workspaces}
              onSwitchWorkspace={(id) => {
                setSettings(null);
                onSwitchWorkspace(id);
              }}
              theme={theme}
              onTheme={setTheme}
              defaultEffort={defaultEffort}
              onDefaultEffort={(value) => setPref("defaultEffort", value)}
              avatarThemes={boot?.config.avatarThemes ?? []}
              avatarTheme={avatarStyle}
              avatarSamples={agents.slice(0, 4)}
              onAvatarTheme={(value) => setPref("avatarTheme", value)}
              replyLength={replyLength}
              onReplyLength={(value) => setPref("replyLength", value)}
              notifications={notifications}
              onNotifications={(enabled) => {
                if (enabled && "Notification" in window && Notification.permission === "default") {
                  void Notification.requestPermission();
                }
                setPref("notifications", enabled ? "on" : "off");
              }}
              codex={codex}
              onCodexChanged={refreshCodex}
              fullAppUrl={boot.config.fullAppUrl}
              agentName={(id) => agents.find((agent) => agent.id === id)?.name ?? null}
            />
          ) : null}
        </AppComputerProvider>
      </AvatarStyleContext.Provider>
    </AppEventsContext.Provider>
  );
}

/**
 * A notification when an agent gets news while the person is elsewhere, and in
 * the Mac app a Dock badge counting the agents that want them.
 */
function useNotifications(
  agents: ReturnType<typeof toAgents>,
  enabled: boolean,
  selectedId: string | null,
  select: (id: string) => void,
) {
  const wants = (agent: Agent) => agent.unread || agent.needsYou || agent.failed;
  const attention = agents.filter(
    (agent) => agent.needsYou || (agent.unread && agent.id !== selectedId),
  ).length;
  useEffect(() => appHost?.setAttention(attention), [attention]);
  useEffect(() => appHost?.onOpenAgent(select), [select]);
  const seen = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = new Map(agents.map((agent) => [agent.id, wants(agent)]));
    if (!previous || !enabled) return;
    // In the app a window behind others still counts as elsewhere.
    if (appHost ? document.hasFocus() : document.visibilityState === "visible") return;
    if (!appHost && (!("Notification" in window) || Notification.permission !== "granted")) return;
    for (const agent of agents) {
      if (!wants(agent) || previous.get(agent.id) !== false) continue;
      const body = agent.needsYou
        ? "Needs your input"
        : agent.failed
          ? "Stopped. Open it to see why."
          : "Has a reply for you";
      if (appHost) {
        appHost.notify({ title: agent.name, body, agentId: agent.id });
        continue;
      }
      const notification = new Notification(agent.name, {
        body,
        tag: agent.id,
        icon: "/favicon.svg",
      });
      notification.onclick = () => {
        window.focus();
        select(agent.id);
      };
    }
  }, [agents, enabled, selectedId, select]);
}
