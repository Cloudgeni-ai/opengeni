// Shared schedules for agent turns and deterministic knowledge-source syncs,
// with honest per-run outcomes and no implied agent session for connector work.
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  LockIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import {
  Component,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { SchedulePersonalConnectionDisclosure } from "@/components/capabilities/schedule-personal-connection-disclosure";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContentPage } from "@/components/ui/content-layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormDisclosure } from "@/components/ui/form-disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { ModelPicker } from "@/components/pickers";
import { useAppContext } from "@/context";
import { listViewState } from "@/lib/load-state";
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  agentConfigFromFormState,
  applyScheduledTaskCadence,
  CALENDAR_DAY_LABEL,
  CALENDAR_DAY_ORDER,
  formStateFromScheduledTask,
  groupScheduledTasksForList,
  knowledgeSyncSourceLabel,
  newScheduledTaskFormState,
  nextScheduledRunLabel,
  notableLastRunSummary,
  recurringSessionTaskFormState,
  scheduleFromFormState,
  scheduleLabel,
  scheduledTaskCadence,
  scheduledTaskRunLabel,
  scheduledTaskRunSessionAccess,
  scheduledTaskRunTriggerIsRedundant,
  scheduledTaskRunTriggerLabel,
  scheduledTaskStateLabel,
  SCHEDULE_DESCRIPTION_MAX_LENGTH,
  taskMetadataFromFormState,
  type ScheduledTaskCadence,
  type ScheduledTaskCalendarDay,
  type ScheduledTaskFormState,
} from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import { findPickerRow, type PickerModelRow } from "@/lib/model-policy";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import type { ScheduledTask, ScheduledTaskRun, Session } from "@/types";

/**
 * Per-card run-history state. Loading, failure, and "loaded and genuinely
 * empty" are three different things, and a card that is open must be able to
 * say which one it is instead of defaulting to "No runs yet".
 */
type TaskRunHistory =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; runs: ScheduledTaskRun[] };

/**
 * Fan-out bound for the per-task last-run probe. The task list is served with a
 * default limit of 100, so an unbounded Promise.all could open a hundred
 * connections at once on a page the user has only just landed on.
 */
const RUN_PROBE_CONCURRENCY = 8;

/**
 * The rendered list and the ordering keys it is sorted by, committed as one
 * value so React can never paint tasks whose last-run facts have not arrived.
 *
 * The tradeoff this buys, deliberately: the first paint of the list waits for
 * the bounded last-run probes instead of appearing immediately and then
 * resorting itself under the pointer. A briefly stale order is the alternative,
 * and it puts a click meant for one schedule onto another.
 */
type ScheduleListSnapshot = {
  tasks: ScheduledTask[];
  /**
   * Newest run per task. A present key with `null` means the task has genuinely
   * never run; an absent key means the probe failed and we do not know.
   */
  lastRuns: Record<string, ScheduledTaskRun | null>;
};

const EMPTY_LIST: ScheduleListSnapshot = { tasks: [], lastRuns: {} };

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function SchedulesRoute({
  workspaceId,
  sourceSessionId,
  focusTaskId,
}: {
  workspaceId: string;
  sourceSessionId?: string;
  /** Arrived from a session this task started: reveal that one task on load. */
  focusTaskId?: string;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const client = context.client;
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const [list, setList] = useState<ScheduleListSnapshot>(EMPTY_LIST);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  // Full run history, fetched the first time a card is expanded and cached until
  // the next refresh.
  const [runHistory, setRunHistory] = useState<Record<string, TaskRunHistory>>({});
  const [recurringSourceSessionId, setRecurringSourceSessionId] = useState(sourceSessionId ?? null);
  const [open, setOpen] = useState(Boolean(sourceSessionId));
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // Several cards may show their runs at once, so expansion is a set rather than
  // the single "which card is open" id this page used to keep.
  const [expandedTaskIds, setExpandedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(focusTaskId ? [focusTaskId] : []),
  );
  const [pausedOpen, setPausedOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScheduledTask | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const canAttachOpenGeniTool = context.clientConfig.mcpServers.some(
    (server) => server.id === "opengeni",
  );
  // `sessions:control` on its own is what decides whether a run row even carries
  // its session id (scheduledTaskRunForGrant strips it otherwise), so the run
  // list asks for exactly that. Choosing a target session additionally needs to
  // read the session list.
  const canReadSessionIds = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "sessions:control",
  );
  const canTargetSessions =
    hasWorkspacePermission(context.accessContext, workspaceId, "sessions:read") &&
    canReadSessionIds;
  // Honest list state: the initial fetch renders as loading and a failed load
  // as an error with retry, never as the "No scheduled tasks." empty state.
  const tasksView = listViewState({
    loading,
    error: loadError,
    count: list.tasks.length,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // `refresh` re-reads the panels the user currently has open, so it needs the
  // expanded set without taking it as a dependency: depending on it would make
  // every expand/collapse re-run the whole list load.
  // Arriving from a session, the task that started it is revealed rather than
  // left for the reader to find. Runs once per focused id: re-scrolling on every
  // poll would yank the page out from under someone who has scrolled away.
  const scrolledToFocusTask = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId || scrolledToFocusTask.current === focusTaskId) return;
    const card = document.querySelector(`[data-scheduled-task-id="${focusTaskId}"]`);
    if (!card) return;
    scrolledToFocusTask.current = focusTaskId;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusTaskId, list]);
  const expandedTaskIdsRef = useRef<ReadonlySet<string>>(expandedTaskIds);
  useEffect(() => {
    expandedTaskIdsRef.current = expandedTaskIds;
  }, [expandedTaskIds]);

  // Fetch one task's full run history. `notify` is off for the refresh path so a
  // list reload with several panels open cannot produce a stack of toasts; the
  // panel renders its own error with a retry either way.
  const loadRunHistory = useCallback(
    async (taskId: string, options: { notify?: boolean } = {}) => {
      setRunHistory((current) => ({
        ...current,
        [taskId]: { status: "loading" },
      }));
      try {
        const taskRuns = await client.listScheduledTaskRuns(workspaceId, taskId);
        setRunHistory((current) => ({
          ...current,
          [taskId]: { status: "loaded", runs: taskRuns },
        }));
      } catch (error) {
        setRunHistory((current) => ({
          ...current,
          [taskId]: { status: "error" },
        }));
        if (options.notify !== false) {
          toast.error("Couldn't load run history", {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    [client, workspaceId],
  );

  // Handles its own failures (error state + toast) so a post-mutation reload
  // error can never masquerade as a failed mutation in the callers' catch
  // blocks. The toast still fires because a failed refresh with tasks already
  // on screen keeps rendering the stale list.
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [next, targetSessions, exactSourceSession] = await Promise.all([
        client.listScheduledTasks(workspaceId),
        canTargetSessions
          ? client.listSessions(workspaceId, { limit: 100 }).catch(() => [])
          : Promise.resolve([]),
        canTargetSessions && sourceSessionId
          ? client.getSession(workspaceId, sourceSessionId, { fresh: true }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setSessions(
        [
          ...(exactSourceSession ? [exactSourceSession] : []),
          ...targetSessions.filter((session) => session.id !== exactSourceSession?.id),
        ].filter((session) => session.status !== "cancelled"),
      );
      setLoadError(null);

      // Deleted schedules must not keep an expanded panel or a cached history
      // alive, and a collapsed card must never reopen onto a history from before
      // this reload, so cached history is dropped wholesale and only the panels
      // that are actually open are read again below.
      const liveTaskIds = new Set(next.map((task) => task.id));
      const openTaskIds = [...expandedTaskIdsRef.current].filter((id) => liveTaskIds.has(id));
      setExpandedTaskIds(new Set(openTaskIds));
      setRunHistory({});

      // Both the ordering and the collapsed last-run line need one last-run fact
      // per task, and the wire `ScheduledTask` carries none. A single-row probe
      // (the runs list is newest-first) is the smallest read that answers both;
      // the full history behind a card stays strictly on demand.
      type LastRunProbe = readonly [string, ScheduledTaskRun | null];
      const probes = await mapWithConcurrency<ScheduledTask, LastRunProbe | null>(
        next,
        RUN_PROBE_CONCURRENCY,
        async (task) => {
          try {
            const [newest] = await client.listScheduledTaskRuns(workspaceId, task.id, { limit: 1 });
            return [task.id, newest ?? null];
          } catch {
            // A failed probe leaves the key absent ("unknown") rather than
            // null, which would claim the task has never run.
            return null;
          }
        },
      );
      // The list and its ordering keys land in the same commit, so the order the
      // user sees is the final one from the first paint onward. Awaiting the
      // probes first is what pays for that; see ScheduleListSnapshot.
      setList({
        tasks: next,
        lastRuns: Object.fromEntries(
          probes.filter((entry): entry is LastRunProbe => entry !== null),
        ),
      });

      await Promise.all(openTaskIds.map((id) => loadRunHistory(id, { notify: false })));
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load scheduled tasks", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [canTargetSessions, client, loadRunHistory, sourceSessionId, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ordering keys come only from the probe, which is refilled by `refresh`.
  // Deliberately not from the on-demand histories: folding those in would let a
  // card reorder itself out from under the pointer the moment it was expanded.
  const groups = useMemo(() => {
    const lastRunAtByTaskId: Record<string, string | null> = {};
    for (const [taskId, run] of Object.entries(list.lastRuns)) {
      lastRunAtByTaskId[taskId] = run?.firedAt ?? null;
    }
    return groupScheduledTasksForList(list.tasks, lastRunAtByTaskId);
  }, [list]);

  function collapseRuns(taskId: string) {
    setExpandedTaskIds((current) => {
      if (!current.has(taskId)) return current;
      const next = new Set(current);
      next.delete(taskId);
      return next;
    });
  }

  function setRunsExpanded(task: ScheduledTask, expanded: boolean) {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(task.id);
      else next.delete(task.id);
      return next;
    });
    // On-demand: the history is read the first time this card is opened and
    // reused for every later open until the next refresh.
    if (expanded && runHistory[task.id] === undefined) {
      void loadRunHistory(task.id);
    }
  }

  function startEditing(task: ScheduledTask) {
    setOpen(false);
    const nextEditingTaskId = editingTaskId === task.id ? null : task.id;
    setEditingTaskId(nextEditingTaskId);
    // A card shows either its editor or its runs, never both, so opening the
    // editor collapses this card's runs region.
    if (nextEditingTaskId !== null) {
      collapseRuns(task.id);
    }
  }

  function clearRecurringLaunch() {
    setRecurringSourceSessionId(null);
    if (sourceSessionId) {
      void navigate({
        to: "/workspaces/$workspaceId/schedules",
        params: { workspaceId },
        search: {},
        replace: true,
      });
    }
  }

  async function createTask(form: ScheduledTaskFormState) {
    if (!form.prompt.trim()) {
      toast.error("Scheduled task prompt is required");
      return;
    }
    if (form.runMode === "existing_session" && !form.targetSessionId) {
      toast.error("Choose an existing session for this task");
      return;
    }
    setBusyTaskId("new");
    try {
      await client.createScheduledTask(workspaceId, {
        name: form.name.trim() || form.prompt.trim().slice(0, 64),
        schedule: scheduleFromFormState(form),
        runMode: form.runMode,
        ...(form.runMode === "existing_session" ? { targetSessionId: form.targetSessionId } : {}),
        overlapPolicy: form.overlapPolicy,
        metadata: taskMetadataFromFormState(form),
        agentConfig: agentConfigFromFormState(form),
      });
      setOpen(false);
      clearRecurringLaunch();
      await refresh();
      toast.success("Scheduled task created");
    } catch (error) {
      toast.error("Failed to create scheduled task", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function saveTask(task: ScheduledTask, form: ScheduledTaskFormState) {
    if (!form.prompt.trim()) {
      toast.error("Scheduled task prompt is required");
      return;
    }
    if (form.runMode === "existing_session" && !form.targetSessionId) {
      toast.error("Choose an existing session for this task");
      return;
    }
    setBusyTaskId(task.id);
    try {
      await client.updateScheduledTask(workspaceId, task.id, {
        name: form.name.trim() || form.prompt.trim().slice(0, 64),
        schedule: scheduleFromFormState(form),
        runMode: form.runMode,
        targetSessionId: form.runMode === "existing_session" ? form.targetSessionId : null,
        overlapPolicy: form.overlapPolicy,
        metadata: taskMetadataFromFormState(form, task),
        agentConfig: agentConfigFromFormState(form, task),
      });
      setEditingTaskId(null);
      await refresh();
      toast.success("Scheduled task updated");
    } catch (error) {
      toast.error("Failed to update scheduled task", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyTaskId(null);
    }
  }

  async function saveKnowledgeTask(
    task: ScheduledTask,
    input: { name: string; cadence: "manual" | "hourly" | "daily" },
  ) {
    setBusyTaskId(task.id);
    try {
      await client.updateScheduledTask(workspaceId, task.id, {
        name: input.name.trim() || task.name,
        schedule:
          input.cadence === "manual"
            ? { type: "manual" }
            : input.cadence === "hourly"
              ? { type: "interval", everySeconds: 3_600 }
              : { type: "calendar", timeZone: "UTC", hour: 0, minute: 0 },
      });
      setEditingTaskId(null);
      await refresh();
      toast.success("Sync schedule updated");
    } catch (error) {
      toast.error("Failed to update sync schedule", {
        description: error instanceof Error ? error.message : String(error),
      });
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

  async function taskAction(
    task: ScheduledTask,
    action: "pause" | "resume" | "trigger" | "delete",
  ) {
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
      toast.error(ACTION_ERROR[action], {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setBusyTaskId(null);
    }
  }

  function renderTaskCard(task: ScheduledTask, tone: "active" | "paused") {
    return (
      <ScheduledTaskCardBoundary key={task.id} name={task.name}>
        <ScheduledTaskCard
          task={task}
          tone={tone}
          expanded={expandedTaskIds.has(task.id)}
          editing={editingTaskId === task.id}
          busy={busyTaskId === task.id}
          history={runHistory[task.id]}
          probedLastRun={list.lastRuns[task.id]}
          now={clock}
          canReadSessionIds={canReadSessionIds}
          onExpandedChange={(next) => setRunsExpanded(task, next)}
          onEdit={() => startEditing(task)}
          onRunNow={() => void taskAction(task, "trigger")}
          onToggleStatus={() =>
            void taskAction(task, task.status === "active" ? "pause" : "resume")
          }
          onDelete={() => setConfirmDelete(task)}
          onRetryHistory={() => void loadRunHistory(task.id)}
          onOpenSession={(sessionId) =>
            void navigate({
              to: "/workspaces/$workspaceId/sessions/$sessionId",
              params: { workspaceId, sessionId },
            })
          }
          // A function, not an element: everything it touches (`task.action`,
          // `task.agentConfig`) then runs inside the card's own boundary, so a
          // malformed row degrades to one bad card rather than throwing while
          // the list is still building its children.
          renderEditor={() =>
            task.action.kind === "knowledge_source_sync" ? (
              <KnowledgeSyncTaskEditor
                key={task.id}
                task={task}
                busy={busyTaskId === task.id}
                onSubmit={(input) => void saveKnowledgeTask(task, input)}
                onCancel={() => setEditingTaskId(null)}
              />
            ) : (
              <ScheduledTaskForm
                key={task.id}
                initialState={formStateFromScheduledTask(task, {
                  model: context.model,
                  reasoningEffort: context.reasoningEffort,
                })}
                submitLabel="Save changes"
                busy={busyTaskId === task.id}
                canAttachOpenGeniTool={canAttachOpenGeniTool}
                canTargetSessions={canTargetSessions}
                sessions={sessions}
                modelRows={modelCatalog.rows}
                modelsLoading={modelCatalog.loading}
                modelsError={modelCatalog.error}
                onSubmit={(form) => void saveTask(task, form)}
                onCancel={() => setEditingTaskId(null)}
              />
            )
          }
        />
      </ScheduledTaskCardBoundary>
    );
  }

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<CalendarClockIcon className="size-4" />}
        title="Schedules"
        description="Create and manage recurring work."
        actions={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
              className="h-9 pointer-coarse:min-h-10"
            >
              <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-9 pointer-coarse:min-h-10"
              onClick={() => {
                clearRecurringLaunch();
                setOpen((value) => !value);
                setEditingTaskId(null);
              }}
            >
              <PlusIcon className="size-3.5" />
              New schedule
            </Button>
          </>
        }
      />

      {open ? (
        <>
          {recurringSourceSessionId ? (
            <Notice>
              Review the cadence and prompt below. Nothing becomes recurring until you create the
              schedule; each run will continue the exact authorized session.
            </Notice>
          ) : null}
          <ScheduledTaskForm
            key={recurringSourceSessionId ?? "new"}
            initialState={
              recurringSourceSessionId
                ? recurringSessionTaskFormState(recurringSourceSessionId, canAttachOpenGeniTool, {
                    model: context.model,
                    reasoningEffort: context.reasoningEffort,
                  })
                : newScheduledTaskFormState(canAttachOpenGeniTool, [], {
                    model: context.model,
                    reasoningEffort: context.reasoningEffort,
                  })
            }
            submitLabel="Create scheduled task"
            busy={busyTaskId === "new"}
            canAttachOpenGeniTool={canAttachOpenGeniTool}
            canTargetSessions={canTargetSessions}
            sessions={sessions}
            modelRows={modelCatalog.rows}
            modelsLoading={modelCatalog.loading}
            modelsError={modelCatalog.error}
            onSubmit={(form) => void createTask(form)}
          />
        </>
      ) : null}

      <div className="mt-4 grid gap-2">
        {tasksView === "loading" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/45 p-4 text-sm text-fg-muted">
            <Loader2Icon className="size-4 animate-spin" />
            Loading scheduled tasks
          </div>
        ) : tasksView === "error" ? (
          <LoadErrorState
            title="Couldn't load scheduled tasks"
            error={loadError}
            onRetry={() => void refresh()}
          />
        ) : tasksView === "empty" ? (
          <EmptyState
            icon={<CalendarClockIcon className="size-4" />}
            title="No schedules yet"
            description="Schedule an agent run or connector sync."
            action={
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  clearRecurringLaunch();
                  setOpen(true);
                  setEditingTaskId(null);
                }}
              >
                <PlusIcon className="size-3.5" />
                New schedule
              </Button>
            }
          />
        ) : groups.active.length === 0 ? (
          // Every schedule in the workspace is paused or disabled. Saying so
          // beats an empty gap above a collapsed "Paused" section.
          <p className="rounded-lg border border-border bg-surface/45 px-3 py-4 text-xs text-fg-subtle">
            Nothing is scheduled to run right now.
          </p>
        ) : (
          groups.active.map((task) => renderTaskCard(task, "active"))
        )}
      </div>

      {groups.paused.length > 0 ? (
        <Collapsible open={pausedOpen} onOpenChange={setPausedOpen} className="mt-5">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium text-fg-subtle">Paused</h2>
            <span aria-hidden className="h-px flex-1 bg-border" />
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-fg-subtle hover:text-fg-muted pointer-coarse:min-h-10"
              >
                {pausedOpen ? "Hide" : `View all (${groups.paused.length})`}
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", pausedOpen && "rotate-180")}
                />
              </Button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="mt-2 grid gap-2">
              {groups.paused.map((task) => renderTaskCard(task, "paused"))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => (next ? undefined : setConfirmDelete(null))}
        title={confirmDelete ? `Delete “${confirmDelete.name}”?` : "Delete scheduled task?"}
        description={
          confirmDelete?.action.kind === "knowledge_source_sync"
            ? "Deletes this schedule and disables its source. Re-enable it from the connector."
            : "Deletes future runs; existing sessions are kept."
        }
        confirmLabel="Delete task"
        onConfirm={() => (confirmDelete ? taskAction(confirmDelete, "delete") : false)}
      />
    </ContentPage>
  );
}

/**
 * One malformed row degrades to one degraded card. Scheduled tasks are rendered
 * straight from a list read, and a legacy or partially written action (a
 * connector sync with no `destination`, say) used to take the whole page to the
 * route error boundary and show the user nothing at all.
 */
class ScheduledTaskCardBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <Notice tone="failed" title="This schedule couldn't be displayed">
        “{this.props.name}” is stored in a shape this page doesn't understand. Your other schedules
        are unaffected.
      </Notice>
    );
  }
}

function ScheduledTaskCard(props: {
  task: ScheduledTask;
  /** Paused cards sit one step down the foreground ladder, not behind opacity. */
  tone: "active" | "paused";
  expanded: boolean;
  editing: boolean;
  busy: boolean;
  history: TaskRunHistory | undefined;
  probedLastRun: ScheduledTaskRun | null | undefined;
  now: Date;
  canReadSessionIds: boolean;
  onExpandedChange: (next: boolean) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
  onRetryHistory: () => void;
  onOpenSession: (sessionId: string) => void;
  renderEditor: () => ReactNode;
}) {
  const { task } = props;
  const panelId = useId();
  const state = scheduledTaskStateLabel(task);
  const muted = props.tone === "paused";
  const loadedRuns = props.history?.status === "loaded" ? props.history.runs : null;
  // Successful runs belong in the expandable history. The collapsed row only
  // interrupts its quiet hierarchy for a failure, skipped run, or live queue.
  const lastRun = notableLastRunSummary(
    loadedRuns ?? (props.probedLastRun ? [props.probedLastRun] : []),
  );
  // Never both at once: the editor owns the card while it is open, and the
  // disclosure goes inert rather than silently discarding an in-progress edit.
  const expanded = props.expanded && !props.editing;
  const nextRun = state.active ? nextScheduledRunLabel(task.schedule, props.now) : null;

  return (
    <Collapsible open={expanded} onOpenChange={props.onExpandedChange} asChild>
      <article
        data-scheduled-task-id={task.id}
        className={cn(
          "rounded-lg border p-3",
          muted ? "border-border/70 bg-surface/45" : "border-border bg-surface",
        )}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                disabled={props.editing}
                aria-expanded={expanded}
                aria-controls={panelId}
                title={
                  props.editing
                    ? "Close the editor to see this schedule's runs"
                    : expanded
                      ? "Hide runs"
                      : "Show runs"
                }
                className="-m-1 block w-full min-w-0 cursor-pointer rounded-md p-1 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronDownIcon
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-fg-subtle transition-transform",
                      expanded ? "rotate-0" : "-rotate-90",
                    )}
                  />
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      muted ? "text-fg-muted" : "text-fg",
                    )}
                  >
                    {task.name}
                  </span>
                  {!state.active ? (
                    <MetaChip dot="waiting" rounded="full">
                      {state.label}
                    </MetaChip>
                  ) : null}
                  {lastRun ? (
                    <MetaChip
                      dot={lastRun.tone === "failed" ? "failed" : "waiting"}
                      rounded="full"
                      title={lastRun.label}
                    >
                      {lastRun.run.status === "failed"
                        ? "Failed"
                        : lastRun.run.status === "skipped"
                          ? "Skipped"
                          : lastRun.run.status === "dispatched"
                            ? "Running"
                            : "Queued"}
                    </MetaChip>
                  ) : null}
                </span>
                <span className="mt-1 block truncate text-xs text-fg-subtle">
                  {scheduleLabel(task.schedule)}
                  {nextRun ? ` · ${nextRun}` : ""}
                </span>
              </button>
            </CollapsibleTrigger>
            {task.action.kind === "knowledge_source_sync" ? (
              <div className="mt-1 text-2xs text-fg-subtle">
                {knowledgeSyncSourceLabel(task.action)}
              </div>
            ) : (
              <SchedulePersonalConnectionDisclosure connections={task.personalConnections} />
            )}
          </div>
          {/* Run now remains the frequent action. Editing, state changes, and
              deletion live in one predictable menu instead of four competing
              controls at the same visual weight. */}
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-8"
              disabled={props.busy || !state.active}
              onClick={(event) => {
                event.stopPropagation();
                props.onRunNow();
              }}
              title="Fire a manual run now"
            >
              <ZapIcon className="size-3.5" />
              Run now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant={props.editing ? "secondary" : "ghost"}
                  size="icon-sm"
                  disabled={props.busy}
                  aria-label={`More actions for ${task.name}`}
                  title="More actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={props.onEdit}>
                  <WrenchIcon />
                  {props.editing ? "Close editor" : "Edit"}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onToggleStatus}>
                  {task.status === "active" ? <PauseIcon /> : <PlayIcon />}
                  {task.status === "active" ? "Pause" : "Resume"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {props.editing ? props.renderEditor() : null}

        <CollapsibleContent id={panelId}>
          <div className="mt-3 border-t border-border pt-2">
            {props.history === undefined || props.history.status === "loading" ? (
              <p className="flex items-center gap-2 px-1 py-2 text-xs text-fg-subtle">
                <Loader2Icon className="size-3 animate-spin" />
                Loading runs
              </p>
            ) : props.history.status === "error" ? (
              <Notice
                tone="failed"
                action={
                  <Button type="button" variant="ghost" size="xs" onClick={props.onRetryHistory}>
                    <RefreshCwIcon className="size-3" />
                    Retry
                  </Button>
                }
              >
                Couldn't load this task's run history.
              </Notice>
            ) : props.history.runs.length === 0 ? (
              <p className="px-1 py-2 text-xs text-fg-subtle">No runs yet</p>
            ) : (
              <ol className="grid gap-1" aria-label={`${task.name} run history`}>
                {props.history.runs.map((run) => (
                  <li key={run.id}>
                    <ScheduledTaskRunRow
                      run={run}
                      canReadSessionIds={props.canReadSessionIds}
                      onOpenSession={props.onOpenSession}
                    />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </CollapsibleContent>
      </article>
    </Collapsible>
  );
}

/**
 * One run, identified by when it fired and how it ended. Run ids and session
 * ids are never printed: a uuid tells the reader nothing, and the session it
 * points at is reached through a named link instead.
 */
function ScheduledTaskRunRow(props: {
  run: ScheduledTaskRun;
  canReadSessionIds: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const { run } = props;
  const sessionId = run.sessionId;
  const sessionAccess = scheduledTaskRunSessionAccess(run, {
    canReadSessionIds: props.canReadSessionIds,
  });
  const rowClassName =
    "flex w-full min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded border border-border px-2 py-1.5 text-left text-xs text-fg-muted";
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot tone={runStatusTone(run.status)} />
        <span className="shrink-0 font-medium">{scheduledTaskRunLabel(run)}</span>
        {scheduledTaskRunTriggerIsRedundant(run.triggerType) ? null : (
          <MetaChip>{scheduledTaskRunTriggerLabel(run.triggerType)}</MetaChip>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {run.error ? (
          <span className="min-w-0 truncate text-status-failed">{run.error}</span>
        ) : null}
        {run.knowledgeSummary ? (
          <span className="min-w-0 truncate text-fg-subtle">
            {run.knowledgeSummary.imported} imported · {run.knowledgeSummary.unchanged} unchanged ·{" "}
            {run.knowledgeSummary.skipped} skipped · {run.knowledgeSummary.failed} failed
            {run.knowledgeSummary.aclPending
              ? ` · ${run.knowledgeSummary.aclPending} ACL pending`
              : ""}
            {run.knowledgeSummary.reconnectRequired ? " · reconnect required" : ""}
          </span>
        ) : null}
        {sessionAccess === "open" ? (
          // The whole row is the control, so this is affordance only.
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
        ) : sessionAccess === "restricted" ? (
          // The run really did start a session; this viewer just lacks
          // sessions:control, so the id was stripped before it reached us.
          <span
            className="flex shrink-0 items-center gap-1 text-2xs text-fg-subtle"
            title="This run started a session. Opening it needs the sessions:control permission."
          >
            <LockIcon aria-hidden className="size-3" />
            Session not viewable
          </span>
        ) : null}
      </span>
    </>
  );
  // When the run started a session the reader can open, the whole row is the
  // control. A row-wide target is easier to hit than a button parked at the far
  // edge, and it matches how every other list row in the product behaves.
  return sessionAccess === "open" && sessionId ? (
    <button
      type="button"
      className={cn(
        rowClassName,
        "transition-colors hover:border-border-strong hover:bg-surface-2",
      )}
      onClick={() => props.onOpenSession(sessionId)}
      title="Open the session this run started"
    >
      {content}
    </button>
  ) : (
    <div className={rowClassName}>{content}</div>
  );
}

function runStatusTone(status: ScheduledTaskRun["status"]): StatusTone {
  if (status === "dispatched" || status === "succeeded") return "idle";
  if (status === "failed") return "failed";
  return "waiting";
}

function KnowledgeSyncTaskEditor(props: {
  task: ScheduledTask;
  busy: boolean;
  onSubmit: (input: { name: string; cadence: "manual" | "hourly" | "daily" }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.task.name);
  const [cadence, setCadence] = useState<"manual" | "hourly" | "daily">(
    props.task.schedule.type === "manual"
      ? "manual"
      : props.task.schedule.type === "interval"
        ? "hourly"
        : "daily",
  );
  return (
    <div className="mt-4 grid gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="grid gap-1.5">
        <Label>Name</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <Label>Schedule</Label>
        <Select
          value={cadence}
          onChange={(event) => setCadence(event.target.value as typeof cadence)}
        >
          <option value="manual">On demand</option>
          <option value="hourly">Hourly</option>
          <option value="daily">Daily at 00:00 UTC</option>
        </Select>
      </div>
      <Notice>
        Runs connector inventory and indexing without an agent session or agent-run charge.
      </Notice>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.busy}
          onClick={() => props.onSubmit({ name, cadence })}
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}

/** Weekly multi-day picker. At least one day remains selected in that preset. */
function ScheduleDayPicker(props: {
  value: readonly ScheduledTaskCalendarDay[];
  disabled: boolean;
  minimumOne?: boolean;
  onChange: (days: ScheduledTaskCalendarDay[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
      {CALENDAR_DAY_ORDER.map((day) => {
        const selected = props.value.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={selected}
            disabled={props.disabled}
            onClick={() =>
              props.onChange(
                props.minimumOne && selected && props.value.length === 1
                  ? [...props.value]
                  : CALENDAR_DAY_ORDER.filter((entry) =>
                      entry === day ? !selected : props.value.includes(entry),
                    ),
              )
            }
            className={cn(
              "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-10",
              selected
                ? "border-brand/40 bg-brand/10 text-fg"
                : "border-border bg-surface/50 text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {CALENDAR_DAY_LABEL[day]}
          </button>
        );
      })}
    </div>
  );
}

function ScheduleTimeField(props: {
  form: ScheduledTaskFormState;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid max-w-xs gap-1.5">
      <Label>At</Label>
      <Input
        type="time"
        value={props.form.calendarTime}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <p className="text-2xs text-fg-subtle">Time zone: {props.form.timeZone}</p>
    </div>
  );
}

function ScheduledTaskForm(props: {
  initialState: ScheduledTaskFormState;
  submitLabel: string;
  busy: boolean;
  canAttachOpenGeniTool: boolean;
  canTargetSessions: boolean;
  sessions: Session[];
  modelRows: PickerModelRow[];
  modelsLoading: boolean;
  modelsError: string | null;
  onSubmit: (form: ScheduledTaskFormState) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(props.initialState);
  const [cadence, setCadenceState] = useState<ScheduledTaskCadence>(() =>
    scheduledTaskCadence(props.initialState),
  );
  const [runSettingsOpen, setRunSettingsOpen] = useState(false);
  const update = <K extends keyof ScheduledTaskFormState>(
    key: K,
    value: ScheduledTaskFormState[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const selectedSession = props.sessions.find((session) => session.id === form.targetSessionId);
  const selectedModel = findPickerRow(props.modelRows, form.model);
  const reasoningLabel =
    form.reasoningEffort === "xhigh"
      ? "Extra high reasoning"
      : `${form.reasoningEffort.slice(0, 1).toUpperCase()}${form.reasoningEffort.slice(1)} reasoning`;
  const runModeLabel =
    form.runMode === "new_session_per_run"
      ? "Start a new chat each run"
      : form.runMode === "reusable_session"
        ? "Continue the same chat"
        : "Continue an existing chat";
  const modelLabel = props.modelsLoading
    ? "Loading model"
    : (selectedModel?.label ?? form.model ?? "Default model");
  const billingLabel = selectedModel
    ? selectedModel.billingClass === "opengeni_credits"
      ? "OpenGeni credits"
      : selectedModel.billingClass === "codex_subscription"
        ? "Codex subscription"
        : selectedModel.billingClass === "supergrok_subscription"
          ? "SuperGrok subscription"
          : "Your AI Gateway"
    : "Billing route unavailable";
  const setCadence = (next: ScheduledTaskCadence) => {
    setCadenceState(next);
    setForm((current) => applyScheduledTaskCadence(current, next));
  };

  return (
    <div className="mt-4 grid gap-5 border-t border-border pt-4">
      <div className="grid gap-1.5">
        <Label>Name</Label>
        <Input
          value={form.name}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Daily infrastructure review"
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Description</Label>
        <Input
          value={form.description}
          maxLength={SCHEDULE_DESCRIPTION_MAX_LENGTH}
          onChange={(event) => update("description", event.target.value)}
          placeholder="A short summary shown in the schedule list"
        />
      </div>
      <div className="grid gap-1.5">
        <Label>Instructions</Label>
        <textarea
          value={form.prompt}
          onChange={(event) => update("prompt", event.target.value)}
          className="min-h-28 rounded-md border border-border bg-bg px-3 py-2 text-sm"
          placeholder="What should the agent do on schedule?"
        />
      </div>

      <FormDisclosure
        title="Run settings"
        summary={`${modelLabel} · ${billingLabel} · ${reasoningLabel} · ${runModeLabel}`}
        open={runSettingsOpen}
        onOpenChange={setRunSettingsOpen}
      >
        <div className="flex min-h-10 items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Model and reasoning</p>
            <p className="mt-0.5 text-2xs text-fg-subtle">{billingLabel}</p>
          </div>
          <ModelPicker
            rows={props.modelRows}
            model={form.model}
            effort={form.reasoningEffort}
            latencyMode="standard"
            allowLatencyMode={false}
            disabled={props.busy}
            loading={props.modelsLoading}
            error={props.modelsError}
            onModelChange={(model) => update("model", model)}
            onEffortChange={(effort) => update("reasoningEffort", effort)}
            onLatencyModeChange={() => {}}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Each run</Label>
          <Select
            value={form.runMode}
            onChange={(event) => update("runMode", event.target.value as ScheduledTask["runMode"])}
          >
            <option value="new_session_per_run">Start a new chat</option>
            <option value="reusable_session">Continue the same chat</option>
            <option value="existing_session" disabled={!props.canTargetSessions}>
              Continue an existing chat
            </option>
          </Select>
        </div>
        {form.runMode === "existing_session" ? (
          <div className="grid gap-1.5">
            <Label>Chat to continue</Label>
            <Select
              value={form.targetSessionId}
              disabled={!props.canTargetSessions}
              onChange={(event) => update("targetSessionId", event.target.value)}
            >
              <option value="">Choose a chat</option>
              {/* Preserve a stored target even when the current viewer can no
                    longer list it, without presenting an opaque UUID. */}
              {form.targetSessionId && !selectedSession ? (
                <option value={form.targetSessionId} disabled>
                  The selected chat is unavailable
                </option>
              ) : null}
              {props.sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title?.trim() || session.initialMessage.trim() || "Untitled session"} ·{" "}
                  {session.status}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label>When a run is already active</Label>
          <Select
            value={form.overlapPolicy}
            onChange={(event) =>
              update("overlapPolicy", event.target.value as ScheduledTask["overlapPolicy"])
            }
          >
            <option value="allow_concurrent">Start another</option>
            <option value="skip">Skip this run</option>
            <option value="buffer_one">Wait and run next</option>
          </Select>
        </div>
        <div className="flex min-h-10 items-center justify-between gap-4 pt-1">
          <div className="min-w-0">
            <p className="text-sm font-medium text-fg">Workspace tools</p>
            <p className="mt-0.5 text-2xs text-fg-subtle">
              {props.canAttachOpenGeniTool
                ? "Allow this schedule to use tools enabled for this workspace."
                : "Workspace tools are not available in this deployment."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={form.includeOpenGeniTool}
            aria-label="Workspace tools"
            disabled={!props.canAttachOpenGeniTool || props.busy}
            onClick={() => update("includeOpenGeniTool", !form.includeOpenGeniTool)}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              form.includeOpenGeniTool ? "border-brand bg-brand" : "border-border bg-surface-2",
            )}
          >
            <span
              className={cn(
                "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform",
                form.includeOpenGeniTool ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </FormDisclosure>

      <section className="grid gap-3" aria-labelledby="schedule-editor-heading">
        <Label id="schedule-editor-heading">Schedule</Label>
        <div
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-surface-2 p-1"
          role="group"
          aria-label="Schedule cadence"
        >
          {(
            [
              ["once", "Once"],
              ["hourly", "Hourly"],
              ["daily", "Daily"],
              ["weekly", "Weekly"],
              ["interval", "Interval"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={cadence === value}
              disabled={props.busy}
              onClick={() => setCadence(value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 pointer-coarse:min-h-10",
                cadence === value ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {cadence === "once" ? (
          <div className="grid max-w-xs gap-1.5">
            <Label>Run at</Label>
            <Input
              type="datetime-local"
              value={form.runAt}
              onChange={(event) => update("runAt", event.target.value)}
            />
          </div>
        ) : cadence === "hourly" ? (
          <p className="text-xs text-fg-subtle">Runs every hour.</p>
        ) : cadence === "interval" ? (
          <div className="grid max-w-xs gap-1.5">
            <Label>Every (minutes)</Label>
            <Input
              type="number"
              min={1}
              value={form.intervalMinutes}
              onChange={(event) => update("intervalMinutes", Number(event.target.value))}
            />
          </div>
        ) : (
          <div className="grid gap-3">
            {cadence === "weekly" ? (
              <div className="grid gap-1.5">
                <Label>Days</Label>
                <ScheduleDayPicker
                  value={form.calendarDaysOfWeek}
                  disabled={props.busy}
                  minimumOne
                  onChange={(days) => update("calendarDaysOfWeek", days)}
                />
              </div>
            ) : null}
            <ScheduleTimeField form={form} onChange={(value) => update("calendarTime", value)} />
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {props.onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
        ) : null}
        <Button type="button" onClick={() => props.onSubmit(form)} disabled={props.busy}>
          {props.busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <BotIcon className="size-3.5" />
          )}
          {props.submitLabel}
        </Button>
      </div>
    </div>
  );
}
