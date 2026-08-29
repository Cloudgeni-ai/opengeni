import type { SessionBrowseGroupBy } from "./sessions-group";

const SESSION_BROWSE_PREFERENCE_VERSION = 1;
const DEFAULT_SESSION_BROWSE_GROUP_BY: SessionBrowseGroupBy = "activity";

type BrowsePreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function sessionBrowsePreferenceStorageId(subjectId: string): string {
  return [
    "og.session.browse",
    `v${SESSION_BROWSE_PREFERENCE_VERSION}`,
    encodeURIComponent(subjectId),
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
  return value === "activity" || value === "created" || value === "creator";
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
