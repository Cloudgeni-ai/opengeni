/**
 * Schedules: one flat list of every schedule in the workspace. Active ones by
 * next run, then the ones that won't fire (paused ones get an inline Resume).
 * A row opens the schedule's own page; New schedule opens the form page.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarClockIcon,
  GitPullRequestIcon,
  PlayIcon,
  PlusIcon,
  SunriseIcon,
  TrendingUpIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStateTemplate, EmptyStateTemplates } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { markScheduledTaskAttentionSeen } from "@/components/rail/use-scheduled-task-attention";
import { useAppContext } from "@/context";
import { listViewState } from "@/lib/load-state";
import { scheduledTaskDriftDismissal } from "@/lib/scheduled-task-drift-dismissals";
import {
  loadSessionSchedules,
  scheduledTaskPolicyDriftLines,
  visibleScheduledTaskPolicyDrift,
} from "@/lib/scheduled-tasks";
import type { ScheduledTask, ScheduledTaskAccessAttention, ScheduledTaskRun } from "@/types";

import {
  SCHEDULE_TEMPLATES,
  lastRunState,
  ownsSchedule,
  scheduleWords,
  sortSchedulesForList,
  templateCadenceLabel,
} from "./schedule-model";
import {
  LastRunValue,
  NextRunValue,
  OwnerValue,
  ScheduleMenuItems,
  ScheduleTile,
  hasMenuItems,
  inAppClick,
  schedulePath,
  schedulePermissions,
  useScheduleAccess,
  useScheduleNavigation,
} from "./schedule-parts";
import { scheduledTaskAttentionText } from "./schedule-access-notices";
import { useScheduleActions } from "./use-schedule-actions";
import {
  CreateWithOpenGeniButton,
  useCanCreateScheduleWithAgent,
  useCreateWithOpenGeni,
} from "./create-with-opengeni";

/**
 * Fan-out bound for the per-schedule last-run probe. The list is served with a
 * default limit of 100, so an unbounded Promise.all could open a hundred
 * connections at once on a page the user has only just landed on.
 */
const RUN_PROBE_CONCURRENCY = 8;
const SCHEDULES_POLL_MS = 30_000;

/**
 * The rendered list and its last-run facts, committed as one value so a row
 * never paints before its Last run is known and never reorders under the
 * pointer. A present key with `null` means the schedule has never run; an
 * absent key means the probe failed and we don't know.
 */
type ScheduleListSnapshot = {
  tasks: ScheduledTask[];
  lastRuns: Record<string, ScheduledTaskRun | null>;
  /** Schedules whose latest run could not use a connector, or cannot start (owner-only). */
  attention: Record<string, ScheduledTaskAccessAttention>;
};

const EMPTY_LIST: ScheduleListSnapshot = { tasks: [], lastRuns: {}, attention: {} };

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

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  "morning-brief": <SunriseIcon />,
  "dependency-pr": <GitPullRequestIcon />,
  "cost-check": <TrendingUpIcon />,
};

/**
 * True on phone widths. Rows keep one height there, so the paused row's
 * Resume stays in its ⋯ menu instead of dropping onto a line of its own.
 */
function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

const COLUMNS: RowListColumn[] = [
  { id: "next", label: "Next run", width: 128 },
  { id: "last", label: "Last run", width: 156 },
  { id: "owner", label: "Owner", width: 112 },
];

export function SchedulesListPage({
  workspaceId,
  targetSessionId,
}: {
  workspaceId: string;
  /** Show only the schedules that post into this chat (from the chat header). */
  targetSessionId?: string;
}) {
  const { client } = useAppContext();
  const access = useScheduleAccess(workspaceId);
  const go = useScheduleNavigation(workspaceId);
  const [list, setList] = useState<ScheduleListSnapshot>(EMPTY_LIST);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const viewState = listViewState({ loading, error: loadError, count: list.tasks.length });

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Handles its own failures, so a reload error after a successful action can
  // never read as a failed action. A failed background refresh keeps the list.
  const refresh = useCallback(
    async (background = false) => {
      if (!background) setLoading(true);
      try {
        const [next, attention] = await Promise.all([
          targetSessionId
            ? loadSessionSchedules(client, workspaceId, targetSessionId)
            : client.listScheduledTasks(workspaceId),
          // Advisory: a failed read only hides the notices until the next poll.
          client.listScheduledTaskAccessAttention(workspaceId).catch(() => null),
        ]);
        setLoadError(null);
        // One newest-run probe per schedule answers both Last run and nothing
        // else; full history stays on each schedule's page.
        type LastRunProbe = readonly [string, ScheduledTaskRun | null];
        const probes = await mapWithConcurrency<ScheduledTask, LastRunProbe | null>(
          next,
          RUN_PROBE_CONCURRENCY,
          async (task) => {
            try {
              const [newest] = await client.listScheduledTaskRuns(workspaceId, task.id, {
                limit: 1,
              });
              return [task.id, newest ?? null];
            } catch {
              return null;
            }
          },
        );
        setList({
          tasks: next,
          lastRuns: Object.fromEntries(
            probes.filter((entry): entry is LastRunProbe => entry !== null),
          ),
          attention: Array.isArray(attention)
            ? Object.fromEntries(attention.map((item) => [item.taskId, item]))
            : {},
        });
        // Showing the notices here is the owner seeing them: clear the
        // navigation dot. A session-filtered view lists only some schedules,
        // so only those count.
        if (Array.isArray(attention)) {
          const listed = new Set(next.map((task) => task.id));
          markScheduledTaskAttentionSeen(
            workspaceId,
            attention.filter((item) => listed.has(item.taskId)),
          );
        }
        setClock(new Date());
      } catch (error) {
        if (!background) {
          setLoadError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (!background) setLoading(false);
      }
    },
    [client, targetSessionId, workspaceId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const reconcileForeground = () => {
      if (document.visibilityState === "visible") {
        void refresh(true);
      }
    };
    const interval = window.setInterval(reconcileForeground, SCHEDULES_POLL_MS);
    window.addEventListener("focus", reconcileForeground);
    document.addEventListener("visibilitychange", reconcileForeground);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", reconcileForeground);
      document.removeEventListener("visibilitychange", reconcileForeground);
    };
  }, [refresh]);

  const actions = useScheduleActions({
    workspaceId,
    onChanged: () => refresh(true),
  });

  // The order is fixed by the snapshot's clock, not the minute tick, so rows
  // don't move while someone is pointing at them.
  const sorted = useMemo(() => sortSchedulesForList(list.tasks, new Date()), [list]);
  const shared = sorted.some((task) => !ownsSchedule(task, access.viewerSubjectId));
  const columns = shared ? COLUMNS : COLUMNS.filter((column) => column.id !== "owner");
  const empty = viewState === "empty";
  const canCreate = access.canManage;
  const canAsk = useCanCreateScheduleWithAgent(workspaceId);
  const ask = useCreateWithOpenGeni(workspaceId);
  const narrow = useNarrow();

  return (
    <>
      <PageHeader
        icon={<CalendarClockIcon />}
        title="Schedules"
        description="Recurring agent work in this workspace."
        actions={
          canCreate && !empty && viewState !== "loading" ? (
            <>
              {canAsk ? <CreateWithOpenGeniButton onClick={ask.open} /> : null}
              <Button type="button" onClick={() => go.create()} className="pointer-coarse:h-11">
                <PlusIcon aria-hidden="true" />
                New schedule
              </Button>
            </>
          ) : undefined
        }
      />
      {targetSessionId ? (
        <Notice
          className="mt-6"
          actionLayout="responsive"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => go.list()}
              className="pointer-coarse:h-11"
            >
              Show all schedules
            </Button>
          }
        >
          Showing the schedules that post into one chat.
        </Notice>
      ) : null}
      <div className="mt-6 min-w-0">
        {viewState === "loading" ? (
          <RowList label="Schedules" columns={columns} flush busy>
            <ListRowSkeleton count={4} />
          </RowList>
        ) : viewState === "error" ? (
          <ErrorMessage
            align="center"
            title="Couldn't load schedules"
            details={loadError ? [{ label: "Error", value: loadError.message }] : undefined}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
                className="pointer-coarse:h-11"
              >
                Try again
              </Button>
            }
          >
            Check your connection, then try again. Your schedules keep running either way.
          </ErrorMessage>
        ) : empty ? (
          <SchedulesEmpty
            canCreate={canCreate}
            filtered={Boolean(targetSessionId)}
            now={clock}
            onNew={() => go.create()}
            onAsk={canAsk ? ask.open : undefined}
            onTemplate={(template) => go.create({ template })}
          />
        ) : (
          <RowList label="Schedules" columns={columns} flush>
            {sorted.map((task) => {
              const perms = schedulePermissions(task, access);
              const paused = task.status === "paused";
              const busy = actions.busyTaskId === task.id;
              const href = schedulePath(workspaceId, task.id);
              return (
                <ListRow
                  key={task.id}
                  leading={<ScheduleTile task={task} />}
                  // Titles stay in fg; a paused schedule says so in its tile and Next run.
                  title={task.name}
                  status={accessBadge({
                    task,
                    attention: list.attention[task.id] ?? null,
                    own: perms.own,
                    workspaceId,
                  })}
                  description={scheduleWords(task.schedule, clock).short}
                  cells={{
                    next: <NextRunValue task={task} now={clock} />,
                    last: <LastRunValue state={lastRunState(list.lastRuns, task.id)} />,
                    ...(shared && !perms.own
                      ? {
                          owner: (
                            <OwnerValue task={task} viewerSubjectId={access.viewerSubjectId} />
                          ),
                        }
                      : {}),
                  }}
                  control={
                    paused && perms.canPauseOrDelete && !narrow ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() => void actions.resume(task)}
                        aria-label={`Resume ${task.name}`}
                        className="h-7 rounded-[10px] px-2 pointer-coarse:h-11"
                      >
                        <PlayIcon aria-hidden="true" />
                        Resume
                      </Button>
                    ) : null
                  }
                  menu={
                    hasMenuItems(task, access) ? (
                      <ScheduleMenuItems
                        task={task}
                        access={access}
                        busy={busy}
                        onRunNow={() => void actions.runNow(task)}
                        onPause={() => void actions.pause(task)}
                        onResume={() => void actions.resume(task)}
                        onEdit={() => go.edit(task.id)}
                        onDuplicate={() => go.create({ from: task.id })}
                        onDelete={() => actions.requestDelete(task)}
                      />
                    ) : undefined
                  }
                  menuLabel={`More actions for ${task.name}`}
                  href={href}
                  linkProps={{ onClick: inAppClick(() => go.detail(task.id)) }}
                />
              );
            })}
          </RowList>
        )}
      </div>
      {actions.dialogs}
      {ask.dialog}
    </>
  );
}

/**
 * One quiet badge per row; the schedule's own page says what happened and
 * offers the refresh. Drift is shown only to the owner, who can act on it.
 */
function accessBadge({
  task,
  attention,
  own,
  workspaceId,
}: {
  task: ScheduledTask;
  attention: ScheduledTaskAccessAttention | null;
  own: boolean;
  workspaceId: string;
}): ReactNode {
  const attentionText = scheduledTaskAttentionText(attention);
  if (attentionText) {
    return (
      <StatusBadge variant="dot" status="needs_you" reason={attentionText}>
        Needs attention
      </StatusBadge>
    );
  }
  if (!own) return undefined;
  const drift = visibleScheduledTaskPolicyDrift(
    task.policyDrift,
    scheduledTaskDriftDismissal(workspaceId, task),
    task.executionDigest,
  );
  const lines = scheduledTaskPolicyDriftLines(drift);
  if (lines.length === 0) return undefined;
  return (
    <StatusBadge variant="dot" tone="attention" reason={lines.join(" ")}>
      Access out of date
    </StatusBadge>
  );
}

function SchedulesEmpty({
  canCreate,
  filtered,
  now,
  onNew,
  onAsk,
  onTemplate,
}: {
  canCreate: boolean;
  filtered: boolean;
  now: Date;
  onNew: () => void;
  /** "Create with OpenGeni"; absent without the permissions to start it. */
  onAsk?: () => void;
  onTemplate: (templateId: string) => void;
}) {
  if (filtered) {
    return (
      <EmptyState
        variant="inline"
        title="No schedules post into this chat."
        description="It may have been deleted or moved to a new chat."
      />
    );
  }
  return (
    <EmptyState
      variant="page"
      icon={<CalendarClockIcon />}
      title="No schedules yet"
      description={
        canCreate
          ? "Have the agent do something on a rhythm, like a morning brief or a weekly dependency PR."
          : "Schedules run agent work on a rhythm. Ask a workspace admin for access to create one."
      }
      action={
        canCreate ? (
          <>
            {onAsk ? <CreateWithOpenGeniButton onClick={onAsk} /> : null}
            <Button type="button" onClick={onNew} className="pointer-coarse:h-11">
              <PlusIcon aria-hidden="true" />
              New schedule
            </Button>
          </>
        ) : undefined
      }
      className="pt-12"
      templates={
        canCreate ? (
          <EmptyStateTemplates>
            {SCHEDULE_TEMPLATES.map((template) => (
              <EmptyStateTemplate
                key={template.id}
                icon={TEMPLATE_ICONS[template.id]}
                title={template.name}
                description={template.description}
                meta={templateCadenceLabel(template, now)}
                onSelect={() => onTemplate(template.id)}
              />
            ))}
          </EmptyStateTemplates>
        ) : undefined
      }
    />
  );
}
