import {
  authorizeConnectAttempt,
  ConnectController,
  createBrowserConnectNavigation,
} from "@opengeni/connect";
import { ConnectPanel } from "@opengeni/react/connect";
import { SiteDetail, SiteList } from "@opengeni/react/sites";
import type {
  CodexConnectionStatus,
  ConnectionMetadata,
  ScheduledTask,
  Workspace,
} from "@opengeni/sdk";
import { ArrowLeft, ExternalLink, Pause, Play, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { client, EFFORT_LABELS, type EffortLevel } from "../lib/app-api";
import type { ReplyLength } from "../lib/context";
import { CodexConnect } from "./CodexConnect";

export type SettingsTab =
  | "general"
  | "connections"
  | "models"
  | "schedules"
  | "sites"
  | "workspace";

export type Theme = "system" | "light" | "dark";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "connections", label: "Connections" },
  { id: "models", label: "Model" },
  { id: "schedules", label: "Schedules" },
  { id: "sites", label: "Sites" },
  { id: "workspace", label: "Workspace" },
];

export type SettingsDialogProps = {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
  workspaceId: string;
  workspaces: Workspace[];
  onSwitchWorkspace: (id: string) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  defaultEffort: EffortLevel;
  onDefaultEffort: (effort: EffortLevel) => void;
  replyLength: ReplyLength;
  onReplyLength: (length: ReplyLength) => void;
  notifications: boolean;
  onNotifications: (enabled: boolean) => void;
  codex: CodexConnectionStatus | null;
  onCodexChanged: () => void;
  fullAppUrl: string | null;
  agentName: (sessionId: string | null) => string | null;
};

export function SettingsDialog(props: SettingsDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-0 backdrop-blur-[2px] md:p-6">
      <div className="absolute inset-0" onClick={props.onClose} />
      <div
        role="dialog"
        aria-label="Settings"
        className="card-in relative flex h-full w-full max-w-4xl flex-col overflow-hidden bg-[var(--app-bg)] shadow-2xl md:h-[min(720px,90vh)] md:flex-row md:rounded-3xl md:border md:border-[var(--app-border)]"
      >
        <div className="flex shrink-0 items-center justify-between bg-[var(--app-sidebar)] px-4 pt-3 md:hidden">
          <div className="text-[15px] font-semibold">Settings</div>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--app-border)] bg-[var(--app-sidebar)] p-2 md:w-52 md:flex-col md:items-stretch md:border-r md:border-b-0 md:p-3">
          <div className="hidden px-2 pt-1 pb-3 text-[15px] font-semibold md:block">Settings</div>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => props.onTab(entry.id)}
              className={`shrink-0 rounded-xl px-3 py-1.5 text-left text-sm ${
                props.tab === entry.id
                  ? "bg-[var(--app-card)] font-medium shadow-sm"
                  : "text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
          <button
            type="button"
            onClick={props.onClose}
            className="absolute top-4 right-4 hidden rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] md:block"
            aria-label="Close settings"
          >
            <X size={18} />
          </button>
          {props.tab === "general" ? <General {...props} /> : null}
          {props.tab === "connections" ? <Connections workspaceId={props.workspaceId} /> : null}
          {props.tab === "models" ? (
            <Section
              title="Model"
              hint="There is no model picker. Agents use a smart model, and pick models for their helpers themselves."
            >
              <CodexConnect
                workspaceId={props.workspaceId}
                status={props.codex}
                onConnected={props.onCodexChanged}
              />
            </Section>
          ) : null}
          {props.tab === "schedules" ? (
            <Schedules workspaceId={props.workspaceId} agentName={props.agentName} />
          ) : null}
          {props.tab === "sites" ? <Sites workspaceId={props.workspaceId} /> : null}
          {props.tab === "workspace" ? <WorkspaceTab {...props} /> : null}
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {hint ? (
        <p className="mt-0.5 mb-4 max-w-xl text-sm text-[var(--app-muted)]">{hint}</p>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </section>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-[var(--app-hover)] p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-xl px-3.5 py-1.5 text-sm ${
            value === option.value
              ? "bg-[var(--app-card)] font-medium shadow-sm"
              : "text-[var(--app-muted)]"
          }`}
          title={option.hint}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-[var(--app-border)] py-4 first:pt-0 last:border-b-0 md:flex-row md:items-center md:justify-between">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint ? <div className="text-xs text-[var(--app-muted)]">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

function General(props: SettingsDialogProps) {
  return (
    <Section title="General">
      <Row label="Appearance">
        <Segmented
          value={props.theme}
          onChange={props.onTheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Row>
      <Row
        label="Thinking"
        hint="How long agents think before replying. Each agent can override this."
      >
        <Segmented
          value={props.defaultEffort}
          onChange={props.onDefaultEffort}
          options={(Object.keys(EFFORT_LABELS) as EffortLevel[]).map((level) => ({
            value: level,
            label: EFFORT_LABELS[level].label,
            hint: EFFORT_LABELS[level].hint,
          }))}
        />
      </Row>
      <Row
        label="Replies"
        hint="Short by default. Press Tell me more on any reply for the long version."
      >
        <Segmented
          value={props.replyLength}
          onChange={props.onReplyLength}
          options={[
            { value: "short", label: "Short" },
            { value: "detailed", label: "Detailed" },
          ]}
        />
      </Row>
      <Row
        label="Notifications"
        hint="Get a notification when an agent replies while this tab is in the background."
      >
        <Segmented
          value={props.notifications ? "on" : "off"}
          onChange={(value) => props.onNotifications(value === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </Row>
    </Section>
  );
}

function Connections({ workspaceId }: { workspaceId: string }) {
  // Owned by the effect, so React's development double-mount can't hand the
  // panel a controller that was already disposed.
  const [controller, setController] = useState<ConnectController | null>(null);
  const [connections, setConnections] = useState<ConnectionMetadata[] | null>(null);
  useEffect(() => {
    const next = new ConnectController(client.connectTransport(), workspaceId);
    setController(next);
    return () => next.dispose();
  }, [workspaceId]);
  useEffect(() => {
    void client
      .listConnections(workspaceId)
      .then(setConnections)
      .catch(() => setConnections([]));
  }, [workspaceId]);
  return (
    <Section
      title="Connections"
      hint="Agents ask to connect what they need right in the chat. You can also connect things here."
    >
      {connections && connections.length ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {connections.map((connection) => (
            <span
              key={connection.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-1 text-sm"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${connection.status === "active" ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {connection.providerDomain}
            </span>
          ))}
        </div>
      ) : null}
      <div className="og-connect-host">
        {controller ? (
          <ConnectPanel
            controller={controller}
            client={client}
            returnUrl={window.location.href}
            title={null}
            presentation="catalog"
            showProviderConnections
            onAuthorize={(attempt) =>
              authorizeConnectAttempt(
                client.connectTransport(),
                attempt,
                createBrowserConnectNavigation(window),
                { mode: "popup" },
              ).then(async (result) => {
                if (result) await controller.recover(result.id);
              })
            }
          />
        ) : null}
      </div>
    </Section>
  );
}

function describeSchedule(task: ScheduledTask) {
  const spec = task.schedule;
  if (spec.type === "manual") return "Manual";
  if (spec.type === "once") return `Once, ${new Date(spec.runAt).toLocaleString()}`;
  if (spec.type === "interval") {
    const minutes = Math.round(spec.everySeconds / 60);
    return minutes < 60
      ? `Every ${minutes} min`
      : minutes % 1440 === 0
        ? `Every ${minutes / 1440} day(s)`
        : `Every ${Math.round(minutes / 60)} h`;
  }
  const time = `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;
  const days = spec.daysOfWeek?.length
    ? spec.daysOfWeek.map((day) => day.slice(0, 1) + day.slice(1, 3).toLowerCase()).join(", ")
    : "Every day";
  return `${days} at ${time}`;
}

function Schedules({
  workspaceId,
  agentName,
}: {
  workspaceId: string;
  agentName: (sessionId: string | null) => string | null;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    client
      .listScheduledTasks(workspaceId, { limit: 100 })
      .then(setTasks)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per workspace
  }, [workspaceId]);
  const act = (action: () => Promise<unknown>) =>
    void action().then(load, (cause: unknown) => setError(String(cause)));
  return (
    <Section
      title="Schedules"
      hint='Ask any agent to do something on a schedule, like "every weekday at 8, summarize my inbox".'
    >
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {tasks === null ? (
        <p className="text-sm text-[var(--app-muted)]">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--app-border)] p-6 text-center text-sm text-[var(--app-muted)]">
          Nothing scheduled yet.
        </p>
      ) : (
        <div className="divide-y divide-[var(--app-border)] rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)]">
          {tasks.map((task) => {
            const target = agentName(task.targetSessionId ?? task.reusableSessionId);
            return (
              <div key={task.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{task.name}</div>
                  <div className="truncate text-xs text-[var(--app-muted)]">
                    {describeSchedule(task)}
                    {target ? ` · ${target}` : ""}
                    {task.status === "paused" ? " · Paused" : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)]"
                  aria-label={task.status === "paused" ? "Resume" : "Pause"}
                  onClick={() =>
                    act(() =>
                      task.status === "paused"
                        ? client.resumeScheduledTask(workspaceId, task.id)
                        : client.pauseScheduledTask(workspaceId, task.id),
                    )
                  }
                >
                  {task.status === "paused" ? <Play size={15} /> : <Pause size={15} />}
                </button>
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-red-600"
                  aria-label="Delete"
                  onClick={() => {
                    if (window.confirm(`Delete "${task.name}"?`))
                      act(() => client.deleteScheduledTask(workspaceId, task.id));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function Sites({ workspaceId }: { workspaceId: string }) {
  const [siteId, setSiteId] = useState<string | null>(null);
  return (
    <Section title="Sites" hint="Websites and apps your agents have published.">
      {siteId ? (
        <>
          <button
            type="button"
            onClick={() => setSiteId(null)}
            className="mb-3 inline-flex items-center gap-1 text-sm text-[var(--app-muted)] hover:text-[var(--app-fg)]"
          >
            <ArrowLeft size={14} /> All sites
          </button>
          <SiteDetail client={client} workspaceId={workspaceId} siteId={siteId} canPublish />
        </>
      ) : (
        <div className="og-connect">
          <SiteList
            client={client}
            workspaceId={workspaceId}
            onOpen={(site) => setSiteId(site.id)}
          />
        </div>
      )}
    </Section>
  );
}

function WorkspaceTab(props: SettingsDialogProps) {
  const current = props.workspaces.find((workspace) => workspace.id === props.workspaceId);
  return (
    <Section
      title="Workspace"
      hint="Agents live in a workspace. Shared agents are visible to everyone in it."
    >
      <Row label="Current workspace" hint={current?.name ?? props.workspaceId}>
        {props.workspaces.length > 1 ? (
          <select
            value={props.workspaceId}
            onChange={(event) => props.onSwitchWorkspace(event.target.value)}
            className="rounded-xl border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-1.5 text-sm"
          >
            {props.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-[var(--app-muted)]">Only workspace</span>
        )}
      </Row>
      {props.fullAppUrl ? (
        <Row label="Full Opengeni" hint="Members, permissions, billing and every advanced setting.">
          <a
            href={props.fullAppUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-3.5 py-1.5 text-sm"
          >
            Open <ExternalLink size={14} />
          </a>
        </Row>
      ) : null}
    </Section>
  );
}
