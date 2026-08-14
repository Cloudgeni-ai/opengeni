const SESSION_DOCK_PREFERENCE_VERSION = 1;

type DockPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function sessionDockLayoutStorageId(subjectId: string, sessionId: string): string {
  return [
    "og.session.dock",
    `v${SESSION_DOCK_PREFERENCE_VERSION}`,
    encodeURIComponent(subjectId),
    encodeURIComponent(sessionId),
  ].join(":");
}

export function readSessionDockCollapsed(
  layoutStorageId: string,
  storage: DockPreferenceStorage | null = browserStorage(),
): boolean | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(collapsedStorageKey(layoutStorageId));
    if (value === "true") return true;
    if (value === "false") return false;
  } catch {
    // Storage can be unavailable in sandboxed/private browser contexts.
  }
  return null;
}

export function writeSessionDockCollapsed(
  layoutStorageId: string,
  collapsed: boolean,
  storage: DockPreferenceStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(collapsedStorageKey(layoutStorageId), String(collapsed));
  } catch {
    // The dock remains usable when persistence is blocked or quota is exhausted.
  }
}

function collapsedStorageKey(layoutStorageId: string): string {
  return `${layoutStorageId}:collapsed`;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
