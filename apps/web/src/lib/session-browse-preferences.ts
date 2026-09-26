import type { SessionBrowseGroupBy, SessionBrowseSortBy } from "./sessions-group";

export type SessionBrowseStatus = "active" | "archived" | "all";
export type SessionBrowsePreferences = {
  groupBy: SessionBrowseGroupBy;
  sortBy: SessionBrowseSortBy;
  status: SessionBrowseStatus;
  showEmptyGroups: boolean;
};
export const DEFAULT_SESSION_BROWSE_PREFERENCES: SessionBrowsePreferences = {
  groupBy: "project",
  sortBy: "updatedAt",
  status: "active",
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
      status: ["active", "archived", "all"].includes(parsed.status) ? parsed.status : "active",
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

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
