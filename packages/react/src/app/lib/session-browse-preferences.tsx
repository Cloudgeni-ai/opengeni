import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionBrowseGroupBy, SessionBrowseSortBy } from "./sessions-group";

/** "needs-you" is the Active list narrowed to workstreams waiting on the person. */
export type SessionBrowseStatus = "active" | "needs-you" | "archived" | "all";
export type SessionBrowsePreferences = {
  groupBy: SessionBrowseGroupBy;
  sortBy: SessionBrowseSortBy;
  status: SessionBrowseStatus;
  /** Only workstreams the person started or messaged. */
  mineOnly: boolean;
  showEmptyGroups: boolean;
};
export const DEFAULT_SESSION_BROWSE_PREFERENCES: SessionBrowsePreferences = {
  groupBy: "project",
  sortBy: "updatedAt",
  status: "active",
  mineOnly: false,
  showEmptyGroups: false,
};

/**
 * True only when the view differs from the default. The default view must not
 * look filtered: a new person with no sessions sees the real empty state, not
 * "No sessions match this view".
 */
export function sessionBrowsePreferencesCustomized(value: SessionBrowsePreferences): boolean {
  return (
    value.groupBy !== DEFAULT_SESSION_BROWSE_PREFERENCES.groupBy ||
    value.sortBy !== DEFAULT_SESSION_BROWSE_PREFERENCES.sortBy ||
    value.status !== DEFAULT_SESSION_BROWSE_PREFERENCES.status ||
    value.mineOnly !== DEFAULT_SESSION_BROWSE_PREFERENCES.mineOnly ||
    value.showEmptyGroups !== DEFAULT_SESSION_BROWSE_PREFERENCES.showEmptyGroups
  );
}

const SESSION_BROWSE_PREFERENCE_VERSION = 1;
const DEFAULT_SESSION_BROWSE_GROUP_BY = DEFAULT_SESSION_BROWSE_PREFERENCES.groupBy;

type BrowsePreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function sessionBrowsePreferenceStorageId(subjectId: string, workspaceId?: string): string {
  return [
    "og.session.browse",
    `v${SESSION_BROWSE_PREFERENCE_VERSION}`,
    encodeURIComponent(subjectId),
    ...(workspaceId ? [encodeURIComponent(workspaceId)] : []),
  ].join(":");
}

export function readSessionBrowseGroupBy(
  preferenceStorageId: string,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): SessionBrowseGroupBy {
  if (!storage) return DEFAULT_SESSION_BROWSE_GROUP_BY;
  try {
    const value = storage.getItem(groupByStorageKey(preferenceStorageId));
    return isSessionBrowseGroupBy(value) ? value : DEFAULT_SESSION_BROWSE_GROUP_BY;
  } catch {
    return DEFAULT_SESSION_BROWSE_GROUP_BY;
  }
}

export function writeSessionBrowseGroupBy(
  preferenceStorageId: string,
  groupBy: SessionBrowseGroupBy,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(groupByStorageKey(preferenceStorageId), groupBy);
  } catch {
    // The browse controls remain usable when storage is blocked or full.
  }
}

function isSessionBrowseGroupBy(value: string | null): value is SessionBrowseGroupBy {
  return (
    value === "activity" ||
    value === "created" ||
    value === "creator" ||
    value === "project" ||
    value === "none"
  );
}

export function readSessionBrowsePreferences(
  id: string,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): SessionBrowsePreferences {
  try {
    const parsed = JSON.parse(storage?.getItem(`${id}:view`) ?? "null");
    if (!parsed || typeof parsed !== "object")
      return {
        ...DEFAULT_SESSION_BROWSE_PREFERENCES,
        groupBy: readSessionBrowseGroupBy(id, storage),
      };
    return {
      groupBy: isSessionBrowseGroupBy(parsed.groupBy)
        ? parsed.groupBy
        : DEFAULT_SESSION_BROWSE_GROUP_BY,
      sortBy: ["updatedAt", "createdAt", "name"].includes(parsed.sortBy)
        ? parsed.sortBy
        : "updatedAt",
      status: ["active", "needs-you", "archived", "all"].includes(parsed.status)
        ? parsed.status
        : "active",
      mineOnly: parsed.mineOnly === true,
      showEmptyGroups: parsed.showEmptyGroups === true,
    };
  } catch {
    return { ...DEFAULT_SESSION_BROWSE_PREFERENCES };
  }
}

export function writeSessionBrowsePreferences(
  id: string,
  value: SessionBrowsePreferences,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(`${id}:view`, JSON.stringify(value));
  } catch {
    /* Storage may be unavailable. */
  }
}

function groupByStorageKey(preferenceStorageId: string): string {
  return `${preferenceStorageId}:group-by`;
}

/** Far above any real number of projects; only bounds what a bad value can cost. */
const MAX_REMEMBERED_COLLAPSED_SECTIONS = 1000;

/**
 * The list sections (projects and other groups) this person collapsed in this
 * workspace on this device. Only collapses are remembered, so a new project
 * still opens by default.
 */
export function readCollapsedSessionSections(
  id: string,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(`${id}:collapsed-sections`) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((key): key is string => typeof key === "string" && key.length > 0)
        .slice(0, MAX_REMEMBERED_COLLAPSED_SECTIONS),
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedSessionSections(
  id: string,
  keys: ReadonlySet<string>,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(
      `${id}:collapsed-sections`,
      JSON.stringify([...keys].slice(0, MAX_REMEMBERED_COLLAPSED_SECTIONS)),
    );
  } catch {
    /* Storage may be unavailable; collapsing still works for this visit. */
  }
}

/**
 * The collapsed list sections for one person and workspace (`id` from
 * `sessionBrowsePreferenceStorageId`). Sections open by default; the ones the
 * person collapses are remembered on this device, so they stay collapsed after
 * a reload while new sections still open. Switching `id` loads that
 * workspace's own set.
 */
export function useCollapsedSessionSections(
  id: string,
  storage: BrowsePreferenceStorage | null = browserStorage(),
): [ReadonlySet<string>, (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void] {
  const target = useRef({ id, storage });
  const [collapsed, setCollapsed] = useState(() => readCollapsedSessionSections(id, storage));
  useEffect(() => {
    if (target.current.id === id && target.current.storage === storage) return;
    target.current = { id, storage };
    setCollapsed(readCollapsedSessionSections(id, storage));
  }, [id, storage]);
  const update = useCallback((change: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
    setCollapsed((current) => {
      const next = change(current);
      if (next !== current)
        writeCollapsedSessionSections(target.current.id, next, target.current.storage);
      return next;
    });
  }, []);
  return [collapsed, update];
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
