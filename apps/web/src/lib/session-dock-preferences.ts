const SESSION_DOCK_PREFERENCE_VERSION = 1;

type DockPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export type SessionDockNavigation = Readonly<{
  activeTab?: string;
  browserSessionId?: string;
  desktopSessionId?: string;
  artifactId?: string;
  filePath?: string;
}>;

export type SessionDockNavigationPatch = Partial<
  Record<keyof SessionDockNavigation, string | null>
>;

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

export function readSessionDockNavigation(
  layoutStorageId: string,
  storage: DockPreferenceStorage | null = browserStorage(),
): SessionDockNavigation {
  if (!storage) return {};
  try {
    const raw = storage.getItem(navigationStorageKey(layoutStorageId));
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      navigationKeys.flatMap((key) => {
        const candidate = (value as Record<string, unknown>)[key];
        return typeof candidate === "string" && candidate.length > 0 ? [[key, candidate]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function updateSessionDockNavigation(
  layoutStorageId: string,
  patch: SessionDockNavigationPatch,
  storage: DockPreferenceStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    const next: Record<string, string> = { ...readSessionDockNavigation(layoutStorageId, storage) };
    for (const key of navigationKeys) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (typeof value === "string" && value.length > 0) next[key] = value;
      else delete next[key];
    }
    storage.setItem(navigationStorageKey(layoutStorageId), JSON.stringify(next));
  } catch {
    // Navigation remains usable when persistence is blocked or quota is exhausted.
  }
}

const navigationKeys = [
  "activeTab",
  "browserSessionId",
  "desktopSessionId",
  "artifactId",
  "filePath",
] as const satisfies readonly (keyof SessionDockNavigation)[];

function collapsedStorageKey(layoutStorageId: string): string {
  return `${layoutStorageId}:collapsed`;
}

function navigationStorageKey(layoutStorageId: string): string {
  return `${layoutStorageId}:navigation`;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
