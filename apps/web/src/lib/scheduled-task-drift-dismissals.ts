import type { ScheduledTaskDriftDismissal } from "@/lib/scheduled-tasks";
import type { ScheduledTask, ScheduledTaskPolicyDrift } from "@/types";

/**
 * Per-browser record of the workspace defaults an owner chose to keep off a
 * schedule. It is a display preference only: the server keeps reporting the
 * drift, and it never changes what a run may use. It is stored with the task
 * head (execution digest) it was made for, so editing or refreshing the task
 * any other way is a fresh look, and a new default is reported again.
 */
const STORAGE_KEY = "opengeni.schedules.access-drift-dismissed";
/** Per workspace; the oldest entries fall off first. */
const TASK_LIMIT = 200;

type Store = Record<string, Record<string, ScheduledTaskDriftDismissal>>;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}

function parseDismissal(value: unknown): ScheduledTaskDriftDismissal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.executionDigest !== "string") return null;
  return {
    executionDigest: record.executionDigest,
    connectors: strings(record.connectors),
    openGeniTools: strings(record.openGeniTools),
  };
}

function readStore(): Store {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeWorkspace(
  workspaceId: string,
  entries: Record<string, ScheduledTaskDriftDismissal | null>,
): boolean {
  try {
    const store = readStore();
    const current = { ...(store[workspaceId] ?? {}) };
    for (const [taskId, dismissal] of Object.entries(entries)) {
      delete current[taskId];
      if (dismissal) current[taskId] = dismissal;
    }
    store[workspaceId] = Object.fromEntries(Object.entries(current).slice(-TASK_LIMIT));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    // Without storage the drift simply stays visible.
    return false;
  }
}

/** The dismissal for this task head, or null when none applies. */
export function scheduledTaskDriftDismissal(
  workspaceId: string,
  task: Pick<ScheduledTask, "id" | "executionDigest">,
): ScheduledTaskDriftDismissal | null {
  const dismissal = parseDismissal(readStore()[workspaceId]?.[task.id]);
  return dismissal && dismissal.executionDigest === task.executionDigest ? dismissal : null;
}

/** Keep the defaults this drift names off the schedule, for its current head. */
export function dismissScheduledTaskDrift(
  workspaceId: string,
  task: Pick<ScheduledTask, "id" | "executionDigest">,
  drift: Pick<ScheduledTaskPolicyDrift, "missingConnectors" | "missingOpenGeniTools">,
): boolean {
  const prior = scheduledTaskDriftDismissal(workspaceId, task);
  return writeWorkspace(workspaceId, {
    [task.id]: {
      executionDigest: task.executionDigest,
      connectors: [
        ...new Set([
          ...(prior?.connectors ?? []),
          ...drift.missingConnectors.map((item) => item.id),
        ]),
      ],
      openGeniTools: [...new Set([...(prior?.openGeniTools ?? []), ...drift.missingOpenGeniTools])],
    },
  });
}

/**
 * A refresh that kept the dismissed defaults off moves the task to a new head;
 * the same choice still applies to it.
 */
export function carryScheduledTaskDriftDismissal(
  workspaceId: string,
  taskId: string,
  from: ScheduledTaskDriftDismissal | null,
  toExecutionDigest: string,
) {
  if (!from || from.executionDigest === toExecutionDigest) return;
  writeWorkspace(workspaceId, { [taskId]: { ...from, executionDigest: toExecutionDigest } });
}
