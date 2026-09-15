export type VariableSetShortlistRow = { id: string; enabled: boolean };
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
// Only failed writes use this tab-local fallback; keys retain the full identity scope.
const unavailableStorageRows = new Map<string, VariableSetShortlistRow[]>();

export function variableSetShortlistKey(subjectId: string, workspaceId: string, chatId: string) {
  return ["og.variable-set-shortlist", "v1", subjectId, workspaceId, chatId]
    .map(encodeURIComponent)
    .join(":");
}

export function variableSetRuntimeIds(rows: VariableSetShortlistRow[]): string[] {
  return rows
    .filter((row) => row.enabled)
    .map((row) => row.id)
    .reverse();
}

/** Runtime truth owns enabled membership and relative precedence, never browser preferences. */
export function reconcileVariableSetShortlist(
  runtimeIds: string[],
  remembered: VariableSetShortlistRow[] = [],
): VariableSetShortlistRow[] {
  const enabled = [...runtimeIds].reverse();
  const remaining = [...enabled];
  const newRows = enabled
    .filter((id) => !remembered.some((row) => row.id === id))
    .map((id) => ({ id, enabled: true }));
  return [...newRows, ...remembered].map((row) => {
    if (!enabled.includes(row.id)) return { id: row.id, enabled: false };
    return { id: remaining.shift()!, enabled: true };
  });
}

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readVariableSetShortlist(
  key: string,
  storage = browserStorage(),
): VariableSetShortlistRow[] {
  const fallback = unavailableStorageRows.get(key);
  if (fallback) return fallback.map((row) => ({ ...row }));
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "null");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap((row) => {
      if (
        !row ||
        typeof row.id !== "string" ||
        !row.id ||
        typeof row.enabled !== "boolean" ||
        seen.has(row.id)
      )
        return [];
      seen.add(row.id);
      return [{ id: row.id, enabled: row.enabled }];
    });
  } catch {
    return [];
  }
}

export function writeVariableSetShortlist(
  key: string,
  rows: VariableSetShortlistRow[],
  storage = browserStorage(),
) {
  const metadata = rows.map(({ id, enabled }) => ({ id, enabled }));
  try {
    if (!storage) {
      unavailableStorageRows.set(key, metadata);
      return;
    }
    storage.setItem(key, JSON.stringify(metadata));
    unavailableStorageRows.delete(key);
  } catch {
    unavailableStorageRows.set(key, metadata);
  }
}
