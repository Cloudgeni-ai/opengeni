// Scheduled tasks: recurring or one-shot agent runs, with honest run history
// (trigger type, dispatch status, errors, and the session each run produced).
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CalendarClockIcon,
  ChevronDownIcon,
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

import { LoadErrorState, PageHeader } from "@/components/common";
import { ScheduledTaskRepositoryPicker } from "@/components/repository-picker";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useAppContext } from "@/context";
import { formatTimestamp } from "@/lib/format";
import { listViewState } from "@/lib/load-state";
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [runs, setRuns] = useState<Record<string, ScheduledTaskRun[]>>({});
  // Per-task run-history load failures, so a failed history fetch shows an
  // error with retry instead of a false "No runs yet".
  const [runErrors, setRunErrors] = useState<Record<string, boolean>>({});
  const [reloadingRunsFor, setReloadingRunsFor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [historyTaskId, setHistoryTaskId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScheduledTask | null>(null);
  const canAttachOpenGeniTool = context.clientConfig.mcpServers.some((server) => server.id === "opengeni");
  // Honest list state: the initial fetch renders as loading and a failed load
  // as an error with retry — never as the "No scheduled tasks." empty state.
  const tasksView = listViewState({ loading, error: loadError, count: tasks.length });

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  // Handles its own failures (error state + toast) so a post-mutation reload
  // error can never masquerade as a failed mutation in the callers' catch
  // blocks. The toast still fires because a failed refresh with tasks already
  // on screen keeps rendering the stale list.
  async function refresh() {
    setLoading(true);
    try {
      const next = await client.listScheduledTasks(workspaceId);
      setTasks(next);
      setLoadError(null);
      // Track each task's run-history load outcome separately: a failed history
      // fetch must surface as an error row, never as a false "No runs yet".
      const entries = await Promise.all(next.slice(0, 12).map(async (task) => {
        try {
          return [task.id, { runs: await client.listScheduledTaskRuns(workspaceId, task.id), error: false }] as const;
        } catch {
          return [task.id, { runs: [] as ScheduledTaskRun[], error: true }] as const;
        }
      }));
      setRuns(Object.fromEntries(entries.map(([id, value]) => [id, value.runs])));
      setRunErrors(Object.fromEntries(entries.map(([id, value]) => [id, value.error])));
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load scheduled tasks", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  // Retry a single task's run history after a failed load, without reloading
  // the whole list.
  async function reloadRuns(taskId: string) {
    setReloadingRunsFor(taskId);
    try {
      const taskRuns = await client.listScheduledTaskRuns(workspaceId, taskId);
      setRuns((current) => ({ ...current, [taskId]: taskRuns }));
      setRunErrors((current) => ({ ...current, [taskId]: false }));
    } catch (error) {
      setRunErrors((current) => ({ ...current, [taskId]: true }));
      toast.error("Couldn't load run history", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setReloadingRunsFor(null);
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

  const ACTION_ERROR: Record<"pause" | "resume" | "trigger" | "delete", string> = {
    pause: "Couldn't pause the task",
    resume: "Couldn't resume the task",
    trigger: "Couldn't run the task",
    delete: "Couldn't delete the task",
  };

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
      return true;
    } catch (error) {
      toast.error(ACTION_ERROR[action], { description: error instanceof Error ? error.message : String(error) });
      return false;
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
            <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} className="h-9 pointer-coarse:min-h-10">
              <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-9 pointer-coarse:min-h-10"
              onClick={() => {
                setOpen((value) => !value);
                setEditingTaskId(null);
              }}
            >
              <PlusIcon className="size-3.5" />
              New schedule
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
        {tasksView === "loading" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/45 p-4 text-sm text-fg-muted">
            <Loader2Icon className="size-4 animate-spin" />
            Loading scheduled tasks
          </div>
        ) : tasksView === "error" ? (
          <LoadErrorState title="Couldn't load scheduled tasks" error={loadError} onRetry={() => void refresh()} />
        ) : tasksView === "empty" ? (
          <EmptyState
            icon={<CalendarClockIcon className="size-4" />}
            title="No scheduled tasks yet"
            description="Create one to run the agent on a schedule — recurring or one-shot."
            action={(
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setOpen(true);
                  setEditingTaskId(null);
                }}
              >
                <PlusIcon className="size-3.5" />
                New schedule
              </Button>
            )}
          />
        ) : tasks.map((task) => {
          const taskRuns = runs[task.id] ?? [];
          const lastRun = summarizeLastRun(taskRuns);
          return (
            <div key={task.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{task.name}</span>
                    <MetaChip dot={task.status === "active" ? "idle" : "waiting"} rounded="full">
                      {task.status === "active" ? "Active" : "Paused"}
                    </MetaChip>
                  </div>
                  <div className="mt-1 text-xs text-fg-subtle">
                    {scheduleLabel(task.schedule)} · {task.runMode.replaceAll("_", " ")}
                  </div>
                  {lastRun ? (
                    <div
                      className={cn(
                        "mt-1 truncate text-2xs",
                        lastRun.tone === "failed" ? "text-status-failed" : lastRun.tone === "pending" ? "text-status-waiting" : "text-fg-subtle",
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
                    {taskRuns.length > 0 ? <span className="ml-1 rounded-full border border-border px-1.5 py-0.5 text-2xs">{taskRuns.length}</span> : null}
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
                    <Button type="button" variant="destructive" size="sm" disabled={busyTaskId === task.id} onClick={() => setConfirmDelete(task)}>
                      <Trash2Icon className="size-3.5" />
                      Delete
                    </Button>
                  )}
                />
              ) : null}

              {historyTaskId === task.id ? (
                <div className="mt-3 border-t border-border pt-2">
                  {runErrors[task.id] ? (
                    <Notice
                      tone="failed"
                      action={(
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={reloadingRunsFor === task.id}
                          onClick={() => void reloadRuns(task.id)}
                        >
                          {reloadingRunsFor === task.id ? <Loader2Icon className="size-3 animate-spin" /> : <RefreshCwIcon className="size-3" />}
                          Retry
                        </Button>
                      )}
                    >
                      Couldn't load this task's run history.
                    </Notice>
                  ) : taskRuns.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-fg-subtle">No runs yet</p>
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
                            className="flex w-full items-center justify-between gap-2 rounded border border-border px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-60"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <StatusDot tone={runStatusTone(run.status)} />
                              <span className="shrink-0">{run.triggerType}</span>
                              <span className="shrink-0">{run.status}</span>
                              {run.error ? <span className="min-w-0 truncate text-status-failed">{run.error}</span> : null}
                              {run.sessionId ? <span className="min-w-0 truncate font-mono text-2xs text-fg-subtle">{run.sessionId}</span> : null}
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

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => (next ? undefined : setConfirmDelete(null))}
        title={confirmDelete ? `Delete “${confirmDelete.name}”?` : "Delete scheduled task?"}
        description="This deletes the schedule and stops future runs. Sessions it already created are kept."
        confirmLabel="Delete task"
        onConfirm={() => (confirmDelete ? taskAction(confirmDelete, "delete") : false)}
      />
    </div>
  );
}

function runStatusTone(status: ScheduledTaskRun["status"]): StatusTone {
  if (status === "dispatched") return "idle";
  if (status === "failed") return "failed";
  return "waiting";
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
    <div className="mt-4 grid gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Name</Label>
          <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Daily infrastructure review" />
        </div>
        <div className="grid gap-1.5">
          <Label>Schedule</Label>
          <Select
            value={form.scheduleType}
            onChange={(event) => update("scheduleType", event.target.value as ScheduledTaskFormState["scheduleType"])}
          >
            <option value="once">Once</option>
            <option value="interval">Repeat on an interval</option>
            <option value="calendar">Daily at a time</option>
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label>
          {form.scheduleType === "once" ? "Run at" : form.scheduleType === "interval" ? "Every (minutes)" : "Time of day"}
        </Label>
        {form.scheduleType === "once" ? (
          <Input type="datetime-local" value={form.runAt} onChange={(event) => update("runAt", event.target.value)} />
        ) : form.scheduleType === "interval" ? (
          <Input type="number" min={1} value={form.intervalMinutes} onChange={(event) => update("intervalMinutes", Number(event.target.value))} />
        ) : (
          <Input type="time" value={form.calendarTime} onChange={(event) => update("calendarTime", event.target.value)} />
        )}
      </div>
      <div className="grid gap-1.5">
        <Label>Prompt</Label>
        <textarea
          value={form.prompt}
          onChange={(event) => update("prompt", event.target.value)}
          className="min-h-20 rounded-md border border-border bg-bg px-3 py-2 text-sm"
          placeholder="What should the agent do on schedule?"
        />
      </div>

      <details className="group rounded-md border border-border bg-surface/30 transition-colors open:bg-surface/50">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
          <span>Advanced</span>
          <span className="text-fg-subtle/70">·</span>
          <span className="truncate">session reuse, overlaps, tools, repositories</span>
        </summary>
        <div className="grid gap-3 px-3 pb-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Session</Label>
              <Select
                value={form.runMode}
                onChange={(event) => update("runMode", event.target.value as ScheduledTask["runMode"])}
              >
                <option value="new_session_per_run">New session each run</option>
                <option value="reusable_session">Reuse one session</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>If a run is still going</Label>
              <Select
                value={form.overlapPolicy}
                onChange={(event) => update("overlapPolicy", event.target.value as ScheduledTask["overlapPolicy"])}
              >
                <option value="allow_concurrent">Run both at once</option>
                <option value="skip">Skip the new run</option>
                <option value="buffer_one">Queue one run</option>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={form.includeOpenGeniTool}
              disabled={!props.canAttachOpenGeniTool}
              onChange={(event) => update("includeOpenGeniTool", event.target.checked)}
            />
            Let the agent use OpenGeni tools
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
        </div>
      </details>
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
