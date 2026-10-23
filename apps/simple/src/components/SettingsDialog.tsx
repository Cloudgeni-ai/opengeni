import { OPENGENI_BROWSER_EXTENSION_URL } from "@opengeni/contracts";
import { SiteDetail, SiteList } from "@opengeni/react/sites";
import { ThisComputerPanel } from "@opengeni/react/this-computer";
import type { CodexConnectionStatus, ScheduledTask, Workspace } from "@opengeni/sdk";
import { AppWindow, ArrowLeft, ExternalLink, Monitor, Pause, Play, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { client, EFFORT_LABELS, type AvatarThemeOption, type EffortLevel } from "../lib/app-api";
import type { ReplyLength } from "../lib/context";
import { useAppComputer } from "../lib/this-computer";
import { AgentAvatar, type AvatarSubject } from "./AgentAvatar";
import { CodexConnect } from "./CodexConnect";
import { ConnectionsSettings } from "./ConnectionsSettings";

export type SettingsTab =
  | "general"
  | "connections"
  | "computer"
  | "models"
  | "schedules"
  | "sites"
  | "workspace";

export type Theme = "system" | "light" | "dark";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "connections", label: "Connections" },
  { id: "computer", label: "Computer" },
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
  avatarThemes: AvatarThemeOption[];
  avatarTheme: string;
  avatarSamples: AvatarSubject[];
  onAvatarTheme: (theme: string) => void;
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
          {props.tab === "connections" ? (
            <ConnectionsSettings workspaceId={props.workspaceId} />
          ) : null}
          {props.tab === "computer" ? <ComputerTab /> : null}
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

function ComputerTab() {
  const app = useAppComputer();
  return (
    <Section
      title="Your computer"
      hint="Let agents use this Mac when a task needs it: open pages in your Chrome and, if you allow it, see and control the screen. They ask in the chat first."
    >
      {app ? (
        <div className="simple-connections">
          <ThisComputerPanel
            computer={app.computer}
            platform={app.platform}
            labels={app.labels}
            onSetup={app.openSetup}
            icon={<Monitor size={18} />}
          />
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--app-border)] p-4">
          <Monitor size={18} className="shrink-0 text-[var(--app-muted)]" />
          <p className="text-sm text-[var(--app-muted)]">
            Open the Opengeni Mac app to let agents use your computer.
          </p>
        </div>
      )}
      <div className="mt-4 flex items-start gap-3 rounded-2xl border border-[var(--app-border)] p-4">
        <AppWindow size={18} className="mt-0.5 shrink-0 text-[var(--app-muted)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Chrome extension (optional)</p>
          <p className="mt-0.5 text-sm text-[var(--app-muted)]">
            Lets agents work in the Chrome you already use, signed in to your sites. Without it they
            use a separate browser window.
          </p>
        </div>
        <a
          href={OPENGENI_BROWSER_EXTENSION_URL}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm hover:bg-[var(--app-hover)]"
        >
          Get it
        </a>
      </div>
    </Section>
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
    <div className="inline-flex shrink-0 gap-1 rounded-2xl bg-[var(--app-hover)] p-1">
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
        hint="Get a notification when an agent replies while the app is in the background."
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
      <AvatarStyles {...props} />
    </Section>
  );
}

/** Stand-ins when there are too few agents to show a style off. */
const SAMPLE_NAMES = ["Coach", "Finance", "Meals"];

function AvatarStyles(props: SettingsDialogProps) {
  const samples = [...props.avatarSamples];
  for (const name of SAMPLE_NAMES) {
    if (samples.length >= 4) break;
    samples.push({ id: `sample-${name}`, name, role: "agent", profile: null });
  }
  return (
    <div className="py-3">
      <div className="text-sm font-medium">Avatar style</div>
      <div className="text-xs text-[var(--app-muted)]">
        The colors every agent wears. Switching is instant.
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {props.avatarThemes.map((theme) => {
          const selected = theme.id === props.avatarTheme;
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => props.onAvatarTheme(theme.id)}
              aria-pressed={selected}
              className={`rounded-xl border p-2.5 text-left transition-colors ${
                selected
                  ? "border-[var(--app-accent)] bg-[var(--app-hover)]"
                  : "border-[var(--app-border)] hover:bg-[var(--app-hover)]"
              }`}
            >
              <div className="flex gap-1.5">
                {samples.map((sample) => (
                  <AgentAvatar key={sample.id} agent={sample} styleId={theme.id} size={40} />
                ))}
              </div>
              <div className="mt-2 text-sm font-medium">{theme.name}</div>
              <div className="text-xs text-[var(--app-muted)]">{theme.blurb}</div>
            </button>
          );
        })}
      </div>
    </div>
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
