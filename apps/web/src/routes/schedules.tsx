// Scheduled tasks: recurring or one-shot agent runs, with honest run history
// (trigger type, dispatch status, errors, and the session each run produced).
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CalendarClockIcon,
  HistoryIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader } from "@/components/common";
import { ScheduledTaskRepositoryPicker } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppContext } from "@/context";
import { formatTimestamp } from "@/lib/format";
import {
  agentConfigFromFormState,
  formStateFromScheduledTask,
  newScheduledTaskFormState,
  scheduleFromFormState,
  scheduleLabel,
  summarizeLastRun,
  type ScheduledTaskFormState,
} from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type { ScheduledTask, ScheduledTaskRun } from "@/types";

export function SchedulesRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const client = context.client;
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [open, setOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const canAttachOpenGeniTool = context.clientConfig.mcpServers.some((server) => server.id === "opengeni");

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  // Handles its own failures (toast) so a post-mutation reload error can
  // never masquerade as a failed mutation in the callers' catch blocks.
  async function refresh() {
    try {
      const next = await client.listScheduledTasks(workspaceId);
      setTasks(next);
      const entries = await Promise.all(next.slice(0, 12).map(async (task) =>
        [task.id, await client.listScheduledTaskRuns(workspaceId, task.id).catch(() => [] as ScheduledTaskRun[])] as const));
      setRuns(Object.fromEntries(entries));
    } catch (error) {
      toast.error("Failed to load scheduled tasks", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  async function createTask(form: ScheduledTaskFormState) {
    if (!form.prompt.trim()) {
      toast.error("Scheduled task prompt is required");
      return;
    }
    setBusyTaskId("new");
    try {
      await client.createScheduledTask(workspaceId, {
        name: form.name.trim() || form.prompt.trim().slice(0, 64),
        schedule: scheduleFromFormState(form),
        runMode: form.runMode,
        overlapPolicy: form.overlapPolicy,
        agentConfig: agentConfigFromFormState(form, undefined, {
          resources: context.currentResources,
          model: context.model,
          reasoningEffort: context.reasoningEffort,
        }),
      });
      setOpen(false);
      await refresh();
      toast.success("Scheduled task created");
    } catch (error) {
      toast.error("Failed to create scheduled task", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function saveTask(task: ScheduledTask, form: ScheduledTaskFormState) {
    if (!form.prompt.trim()) {
      toast.error("Scheduled task prompt is required");
      return;
    }
    setBusyTaskId(task.id);
    try {
      await client.updateScheduledTask(workspaceId, task.id, {
        name: form.name.trim() || form.prompt.trim().slice(0, 64),
        schedule: scheduleFromFormState(form),
        runMode: form.runMode,
        overlapPolicy: form.overlapPolicy,
        agentConfig: agentConfigFromFormState(form, task),
      });
      setEditingTaskId(null);
      await refresh();
      toast.success("Scheduled task updated");
    } catch (error) {
      toast.error("Failed to update scheduled task", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function taskAction(task: ScheduledTask, action: "pause" | "resume" | "trigger" | "delete") {
    setBusyTaskId(task.id);
    try {
      if (action === "pause") {
        await client.pauseScheduledTask(workspaceId, task.id);
      } else if (action === "resume") {
        await client.resumeScheduledTask(workspaceId, task.id);
      } else if (action === "trigger") {
        await client.triggerScheduledTask(workspaceId, task.id);
        toast.success("Scheduled task triggered");
      } else {
        await client.deleteScheduledTask(workspaceId, task.id);
        setEditingTaskId(null);
        toast.success("Scheduled task deleted");
      }
      await refresh();
    } catch (error) {
      toast.error("Scheduled task action failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <PageHeader
        icon={<CalendarClockIcon className="size-4" />}
        title="Scheduled tasks"
        description="Recurring or one-shot agent runs with run history per task."
        actions={(
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} className="h-9">
              <RefreshCwIcon className="size-3.5" />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-9"
              onClick={() => {
                setOpen((value) => !value);
                setEditingTaskId(null);
              }}
            >
              <PlusIcon className="size-3.5" />
              New
            </Button>
          </>
        )}
      />

      {open ? (
        <ScheduledTaskForm
          key="new"
          workspaceId={workspaceId}
          initialState={newScheduledTaskFormState(canAttachOpenGeniTool, context.currentResources)}
          submitLabel="Create scheduled task"
          busy={busyTaskId === "new"}
          canAttachOpenGeniTool={canAttachOpenGeniTool}
          onSubmit={(form) => void createTask(form)}
        />
      ) : null}

      <div className="mt-4 grid gap-2">
        {tasks.length === 0 ? (
          <EmptyState>No scheduled tasks.</EmptyState>
        ) : tasks.map((task) => {
          const taskRuns = runs[task.id] ?? [];
          const lastRun = summarizeLastRun(taskRuns);
          return (
            <div key={task.id} className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{task.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                        task.status === "active"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-200",
                      )}
                    >
                      {task.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--color-fg-subtle)]">
                    {scheduleLabel(task.schedule)} · {task.runMode.replaceAll("_", " ")}
                  </div>
                  {lastRun ? (
                    <div
                      className={cn(
                        "mt-1 truncate text-[11px]",
                        lastRun.tone === "failed" ? "text-red-300" : lastRun.tone === "pending" ? "text-amber-200" : "text-[color:var(--color-fg-subtle)]",
                      )}
                    >
                      {lastRun.label}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-8"
                    disabled={busyTaskId === task.id}
                    onClick={() => void taskAction(task, "trigger")}
                    title="Fire a manual run now"
                  >
                    <ZapIcon className="size-3.5" />
                    Run now
                  </Button>
                  <Button
                    type="button"
                    variant={historyTaskId === task.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8"
                    onClick={() => setHistoryTaskId((current) => current === task.id ? null : task.id)}
                  >
                    <HistoryIcon className="size-3.5" />
                    Runs
                    {taskRuns.length > 0 ? <span className="ml-1 rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px]">{taskRuns.length}</span> : null}
                  </Button>
                  <Button
                    type="button"
                    variant={editingTaskId === task.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8"
                    onClick={() => {
                      setOpen(false);
                      setEditingTaskId((current) => current === task.id ? null : task.id);
                    }}
                  >
                    <WrenchIcon className="size-3.5" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8"
                    disabled={busyTaskId === task.id}
                    onClick={() => void taskAction(task, task.status === "active" ? "pause" : "resume")}
                  >
                    {task.status === "active" ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                    {task.status === "active" ? "Pause" : "Resume"}
                  </Button>
                </div>
              </div>

              {editingTaskId === task.id ? (
                <ScheduledTaskForm
                  key={task.id}
                  workspaceId={workspaceId}
                  initialState={formStateFromScheduledTask(task)}
                  submitLabel="Save changes"
                  busy={busyTaskId === task.id}
                  canAttachOpenGeniTool={canAttachOpenGeniTool}
                  onSubmit={(form) => void saveTask(task, form)}
                  onCancel={() => setEditingTaskId(null)}
                  secondaryActions={(
                    <Button type="button" variant="destructive" size="sm" disabled={busyTaskId === task.id} onClick={() => void taskAction(task, "delete")}>
                      <Trash2Icon className="size-3.5" />
                      Delete
                    </Button>
                  )}
                />
              ) : null}

              {historyTaskId === task.id ? (
                <div className="mt-3 border-t border-[color:var(--color-border)] pt-2">
                  {taskRuns.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-[color:var(--color-fg-subtle)]">No runs recorded for this task yet.</p>
                  ) : (
                    <ol className="grid gap-1" aria-label={`${task.name} run history`}>
                      {taskRuns.map((run) => (
                        <li key={run.id}>
                          <button
                            type="button"
                            disabled={!run.sessionId}
                            onClick={() => run.sessionId
                              ? void navigate({ to: "/workspaces/$workspaceId/sessions/$sessionId", params: { workspaceId, sessionId: run.sessionId } })
                              : undefined}
                            className="flex w-full items-center justify-between gap-2 rounded border border-[color:var(--color-border)] px-2 py-1.5 text-left text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] disabled:opacity-60"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <span
                                className={cn(
                                  "size-2 shrink-0 rounded-full",
                                  run.status === "dispatched" && "bg-emerald-400",
                                  run.status === "failed" && "bg-red-400",
                                  run.status === "queued" && "bg-amber-300",
                                )}
                              />
                              <span className="shrink-0">{run.triggerType}</span>
                              <span className="shrink-0">{run.status}</span>
                              {run.error ? <span className="min-w-0 truncate text-red-300">{run.error}</span> : null}
                              {run.sessionId ? <span className="min-w-0 truncate font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{run.sessionId}</span> : null}
                            </span>
                            <span className="shrink-0">{formatTimestamp(run.firedAt)}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScheduledTaskForm(props: {
  workspaceId: string;
  initialState: ScheduledTaskFormState;
  submitLabel: string;
  busy: boolean;
  canAttachOpenGeniTool: boolean;
  onSubmit: (form: ScheduledTaskFormState) => void;
  onCancel?: () => void;
  secondaryActions?: ReactNode;
}) {
  const context = useAppContext();
  const [form, setForm] = useState(props.initialState);
  const update = <K extends keyof ScheduledTaskFormState>(key: K, value: ScheduledTaskFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="mt-4 grid gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Name</Label>
          <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Daily infrastructure review" />
        </div>
        <div className="grid gap-1.5">
          <Label>Schedule</Label>
          <select
            className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
            value={form.scheduleType}
            onChange={(event) => update("scheduleType", event.target.value as ScheduledTaskFormState["scheduleType"])}
          >
            <option value="once">Once</option>
            <option value="interval">Interval</option>
            <option value="calendar">Daily</option>
          </select>
        </div>
      </div>
      <textarea
        value={form.prompt}
        onChange={(event) => update("prompt", event.target.value)}
        className="min-h-20 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm"
        placeholder="What should the agent do on schedule?"
      />
      <div className="grid gap-2 sm:grid-cols-3">
        {form.scheduleType === "once" ? (
          <Input type="datetime-local" value={form.runAt} onChange={(event) => update("runAt", event.target.value)} />
        ) : form.scheduleType === "interval" ? (
          <Input type="number" min={1} value={form.intervalMinutes} onChange={(event) => update("intervalMinutes", Number(event.target.value))} />
        ) : (
          <Input type="time" value={form.calendarTime} onChange={(event) => update("calendarTime", event.target.value)} />
        )}
        <select
          className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
          value={form.runMode}
          onChange={(event) => update("runMode", event.target.value as ScheduledTask["runMode"])}
        >
          <option value="new_session_per_run">New session per run</option>
          <option value="reusable_session">Reusable session</option>
        </select>
        <select
          className="h-9 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-sm"
          value={form.overlapPolicy}
          onChange={(event) => update("overlapPolicy", event.target.value as ScheduledTask["overlapPolicy"])}
        >
          <option value="allow_concurrent">Allow concurrent</option>
          <option value="skip">Skip overlapping</option>
          <option value="buffer_one">Buffer one</option>
        </select>
      </div>
      <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
        <input
          type="checkbox"
          checked={form.includeOpenGeniTool}
          disabled={!props.canAttachOpenGeniTool}
          onChange={(event) => update("includeOpenGeniTool", event.target.checked)}
        />
        Attach OpenGeni MCP tool
      </label>
      <ScheduledTaskRepositoryPicker
        configured={context.githubStatus?.configured === true}
        repositories={context.githubRepos}
        groups={context.repositoryGroups}
        resources={form.resources}
        busy={props.busy}
        repoBusy={context.repoBusy}
        onRefresh={() => context.refreshGitHub(props.workspaceId, undefined, { sync: true })}
        onResourcesChange={(resources) => update("resources", resources)}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {props.onCancel ? (
          <Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        {props.secondaryActions}
        <Button type="button" onClick={() => props.onSubmit(form)} disabled={props.busy}>
          {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <BotIcon className="size-3.5" />}
          {props.submitLabel}
        </Button>
      </div>
    </div>
  );
}
