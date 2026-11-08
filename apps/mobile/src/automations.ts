import { permissionSetCovers } from "@opengeni/contracts/personal-integration-setup";
import {
  automationNextRun,
  automationRunErrorText,
  automationRunStatusLabel,
  automationRunTriggerLabel,
  formatRelativeTime,
  formatRunTime,
  hasEventTriggers,
  isAgentAutomation,
  isFinishedOnce,
  sortAutomations,
  viewerTimeZone,
} from "@opengeni/react/automation-model";
import type { OpenGeniText } from "@opengeni/react/messages";
import type {
  AccessContext,
  EventSource,
  OpenGeniClient,
  ScheduledTask,
  ScheduledTaskRun,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Automations on the phone: the workspace's list with each one's newest run,
 * and the words its rows and page read in. The web Automations pages are the
 * model; the phone keeps the everyday part (see what each one did, open the
 * chat a run worked in, switch one on or off, Run now, delete) and leaves the
 * form to a chat that creates it, or to the web.
 */

/** One automation in the list, with its newest run (null: never ran; undefined: unknown). */
export interface AutomationEntry {
  task: ScheduledTask;
  lastRun: ScheduledTaskRun | null | undefined;
}

export interface AutomationList {
  entries: AutomationEntry[];
  /** The workspace's event sources, for the words of event triggers. */
  sources: EventSource[];
}

type AutomationsClient = Pick<
  OpenGeniClient,
  "listScheduledTasks" | "listScheduledTaskRuns" | "listEventSources"
>;

/** How many newest-run reads run at once, so a long list doesn't open dozens of requests. */
const RUN_PROBE_CONCURRENCY = 6;

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

/**
 * The workspace's automations in the web list's order (scheduled ones by next
 * run, then those waiting for events, then the ones that won't fire), each
 * with its newest run. A run that can't be read leaves that row's last run
 * unknown instead of failing the list.
 */
export async function loadAutomationList(
  client: AutomationsClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<AutomationList> {
  const tasks = sortAutomations(
    (await client.listScheduledTasks(workspaceId)).filter((task) => isAgentAutomation(task)),
    now,
  );
  const [lastRuns, sources] = await Promise.all([
    mapWithConcurrency(tasks, RUN_PROBE_CONCURRENCY, async (task) => {
      try {
        const [newest] = await client.listScheduledTaskRuns(workspaceId, task.id, { limit: 1 });
        return newest ?? null;
      } catch {
        return undefined;
      }
    }),
    // Only event triggers need source names; a failed read shows them unnamed.
    tasks.some((task) => hasEventTriggers(task))
      ? client.listEventSources(workspaceId).catch(() => [])
      : Promise.resolve([]),
  ]);
  return {
    entries: tasks.map((task, index) => ({ task, lastRun: lastRuns[index] })),
    sources,
  };
}

/* ----------------------------------------------------------------------------
   Kept for the app's lifetime, so coming back paints at once while a quiet
   refresh runs.
   -------------------------------------------------------------------------- */

const lists = new Map<string, AutomationList>();

export function cachedAutomationList(workspaceId: string): AutomationList | undefined {
  return lists.get(workspaceId);
}

/** Put one changed automation into the kept list (after a switch, Run now or edit elsewhere). */
export function rememberAutomation(workspaceId: string, task: ScheduledTask): void {
  const list = lists.get(workspaceId);
  if (!list) return;
  lists.set(workspaceId, {
    ...list,
    entries: list.entries.map((entry) => (entry.task.id === task.id ? { ...entry, task } : entry)),
  });
}

/** Take a deleted automation out of the kept list. */
export function forgetAutomation(workspaceId: string, taskId: string): void {
  const list = lists.get(workspaceId);
  if (!list) return;
  lists.set(workspaceId, {
    ...list,
    entries: list.entries.filter((entry) => entry.task.id !== taskId),
  });
}

export interface AutomationListState {
  list: AutomationList | undefined;
  /** The last read failed; the kept list (if any) still shows. */
  error: Error | null;
  refresh(): Promise<void>;
}

/** The workspace's automations, from the kept list first, refreshed on demand. */
export function useAutomationList(
  client: AutomationsClient,
  workspaceId: string,
): AutomationListState {
  const [list, setList] = useState<AutomationList | undefined>(() =>
    cachedAutomationList(workspaceId),
  );
  const [error, setError] = useState<Error | null>(null);
  const current = useRef(workspaceId);
  current.current = workspaceId;
  useEffect(() => {
    setList(cachedAutomationList(workspaceId));
    setError(null);
  }, [workspaceId]);
  const refresh = useCallback(async () => {
    const target = workspaceId;
    try {
      const next = await loadAutomationList(client, target);
      lists.set(target, next);
      if (current.current !== target) return;
      setList(next);
      setError(null);
    } catch (caught) {
      if (current.current !== target) return;
      setList(cachedAutomationList(target));
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }, [client, workspaceId]);
  return { list, error, refresh };
}

/* ----------------------------------------------------------------------------
   Who may do what. The same rules as the web pages: the owner changes, runs,
   pauses and deletes their own; a workspace automation (no owner) belongs to
   everyone who manages automations.
   -------------------------------------------------------------------------- */

export interface AutomationPermissions {
  /** Switch it on or off, and delete it. */
  canManage: boolean;
  /** Start a run now. */
  canRun: boolean;
  /** Start a chat that creates a new one. */
  canCreate: boolean;
}

function can(context: AccessContext | null, workspaceId: string, permission: string): boolean {
  const grant = context?.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  return Boolean(
    grant &&
    (permissionSetCovers(grant.permissions, permission) ||
      grant.permissions.includes("workspace:admin")),
  );
}

export function automationPermissions(
  context: AccessContext | null,
  workspaceId: string,
  task?: Pick<ScheduledTask, "ownerSubjectId"> | undefined,
): AutomationPermissions {
  const own = !task || task.ownerSubjectId === null || task.ownerSubjectId === context?.subjectId;
  return {
    canManage: own && can(context, workspaceId, "scheduled_tasks:manage"),
    canRun: own && can(context, workspaceId, "scheduled_tasks:run"),
    canCreate:
      can(context, workspaceId, "sessions:create") &&
      can(context, workspaceId, "scheduled_tasks:manage"),
  };
}

/* ----------------------------------------------------------------------------
   Words.
   -------------------------------------------------------------------------- */

/**
 * A run not yet handed to its chat. An agent run ends as `dispatched`
 * ("Started") once its chat has the message; the chat shows the rest.
 */
export function runIsLive(run: Pick<ScheduledTaskRun, "status">): boolean {
  return run.status === "queued";
}

/**
 * The row's second line, what it last did: "Started · 2 hours ago", "Failed ·
 * Yesterday", "Queued · Just now", "Hasn't run yet". Empty when the last run is
 * unknown (its read failed).
 */
export function lastRunWords(
  t: OpenGeniText,
  lastRun: ScheduledTaskRun | null | undefined,
  now: Date,
): string {
  if (lastRun === undefined) return "";
  if (lastRun === null) return "Hasn't run yet";
  const when = formatRelativeTime(lastRun.firedAt, { now, text: t });
  return `${automationRunStatusLabel(t, lastRun.status)} · ${when}`;
}

/** A word at the row's end for what keeps it from running: "Paused", "Finished". */
export function automationStateWord(task: Pick<ScheduledTask, "status" | "events">): string | null {
  if (task.status === "paused") return "Paused";
  if (isFinishedOnce(task)) return "Finished";
  return null;
}

/** "Today, 09:00" or "Mon 28 Sep, 08:00" in the viewer's zone; null when it won't run on a schedule. */
export function nextRunWords(
  t: OpenGeniText,
  task: Pick<ScheduledTask, "status" | "schedule" | "events">,
  now: Date,
): string | null {
  const next = automationNextRun(task, now);
  return next ? formatRunTime(next, { timeZone: viewerTimeZone(), now, text: t }) : null;
}

/**
 * One run on the automation's page: when as the title ("Today, 09:00"), what
 * started it as the subtitle ("On schedule") with why when it failed or was
 * skipped, and its outcome in a word at the end ("Started", "Failed").
 */
export function runRowWords(
  t: OpenGeniText,
  run: ScheduledTaskRun,
  now: Date,
): { title: string; subtitle: string; status: string; failed: boolean } {
  const when = formatRunTime(new Date(run.firedAt), { timeZone: viewerTimeZone(), now, text: t });
  const trigger = automationRunTriggerLabel(t, run.triggerType);
  const why =
    run.error && (run.status === "failed" || run.status === "skipped")
      ? automationRunErrorText(t, run.error)
      : null;
  return {
    title: when,
    subtitle: why ? `${trigger}\n${why}` : trigger,
    status: automationRunStatusLabel(t, run.status),
    failed: run.status === "failed",
  };
}
