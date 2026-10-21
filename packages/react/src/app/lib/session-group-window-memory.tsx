import { SESSION_GROUP_VISIBLE_STEP } from "./session-group-window";

/**
 * Manual "Show more" windows outlive the rail itself. Leaving for Settings (or
 * any route that swaps the rail) unmounts the session list; returning in the
 * same tab restores what the reader had opened. This is tab-scoped navigation
 * state, so it uses sessionStorage: a new tab starts compact, unlike the
 * deliberate browse preferences kept in localStorage.
 *
 * One entry per person and workspace remembers only the current view. A
 * different view (grouping, sort, status, search or day) starts from the
 * default step, matching the in-memory reset when the view changes.
 */
const MEMORY_VERSION = 1;
const MAX_GROUPS = 64;
const MAX_ROWS = 500;

type WindowMemoryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function sessionGroupWindowMemoryId(subjectId: string, workspaceId: string): string {
  return [
    "og.session.groupWindows",
    `v${MEMORY_VERSION}`,
    encodeURIComponent(subjectId),
    encodeURIComponent(workspaceId),
  ].join(":");
}

export function readSessionGroupWindows(
  memoryId: string,
  view: string,
  storage: WindowMemoryStorage | null = browserSessionStorage(),
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!storage) return counts;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(memoryId) ?? "null");
    if (!parsed || typeof parsed !== "object") return counts;
    const record = parsed as { view?: unknown; counts?: unknown };
    if (record.view !== view || !record.counts || typeof record.counts !== "object") {
      return counts;
    }
    for (const [key, value] of Object.entries(record.counts).slice(0, MAX_GROUPS)) {
      if (typeof value !== "number" || !Number.isInteger(value)) continue;
      if (value <= SESSION_GROUP_VISIBLE_STEP) continue;
      counts.set(key, Math.min(MAX_ROWS, value));
    }
  } catch {
    // Unreadable memory is only a lost convenience; start from the default.
  }
  return counts;
}

export function writeSessionGroupWindows(
  memoryId: string,
  view: string,
  counts: ReadonlyMap<string, number>,
  storage: WindowMemoryStorage | null = browserSessionStorage(),
): void {
  if (!storage) return;
  const expanded = [...counts]
    .filter(([, value]) => value > SESSION_GROUP_VISIBLE_STEP)
    .slice(0, MAX_GROUPS)
    .map(([key, value]) => [key, Math.min(MAX_ROWS, value)] as const);
  try {
    if (expanded.length === 0) storage.removeItem(memoryId);
    else storage.setItem(memoryId, JSON.stringify({ view, counts: Object.fromEntries(expanded) }));
  } catch {
    // Quota or privacy mode: keep the in-memory window only.
  }
}

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
