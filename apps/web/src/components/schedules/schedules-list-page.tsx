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
import { useAppContext } from "@/context";
import { listViewState } from "@/lib/load-state";
import { loadSessionSchedules, scheduledTaskStateLabel } from "@/lib/scheduled-tasks";
import type { ScheduledTask, ScheduledTaskRun } from "@/types";

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

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  "morning-brief": <SunriseIcon />,
  "dependency-pr": <GitPullRequestIcon />,
  "cost-check": <TrendingUpIcon />,
};

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
        const next = targetSessionId
          ? await loadSessionSchedules(client, workspaceId, targetSessionId)
          : await client.listScheduledTasks(workspaceId);
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
        });
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
          <RowList label="Schedules" columns={columns} busy>
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
          <RowList label="Schedules" columns={columns}>
            {sorted.map((task) => {
              const perms = schedulePermissions(task, access);
              const paused = task.status === "paused";
              const busy = actions.busyTaskId === task.id;
              const muted = !scheduledTaskStateLabel(task).active;
              const href = schedulePath(workspaceId, task.id);
              return (
                <ListRow
                  key={task.id}
                  leading={<ScheduleTile task={task} />}
                  title={muted ? <span className="text-fg-muted">{task.name}</span> : task.name}
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
                    paused && perms.canPauseOrDelete ? (
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
