/**
 * What the app already knows about chats, so the command menu can answer
 * instantly: rows the sidebar has loaded, the chats someone opened recently
 * (kept across reloads), and the sidebar's visible order for next and previous
 * chat. It is a cache for speed, never a source of authority: opening a chat
 * still goes through the normal authorized reads.
 */
import { useSyncExternalStore } from "react";
import { sessionDisplayTitle, type SessionListRow } from "../../../session-list-model";

export type ChatRecord = {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** Present when the app holds a full or list row, needed for pin and archive. */
  row: SessionListRow | null;
};

type DirectoryState = {
  rows: Map<string, ChatRecord>;
  /** Recently opened chat ids, most recent first. */
  recent: string[];
  /** Sidebar order of visible chats (pinned first), for next and previous. */
  sidebarOrder: string[];
  pinnedOrder: string[];
  version: number;
};

const RECENT_LIMIT = 30;
const directories = new Map<string, DirectoryState>();
const listeners = new Map<string, Set<() => void>>();

function key(subjectId: string, workspaceId: string): string {
  return `${subjectId}\u0000${workspaceId}`;
}

function storageKey(subjectId: string, workspaceId: string): string {
  return `opengeni.recentChats.${subjectId}.${workspaceId}`;
}

type StoredRecent = { id: string; title: string; at: number };

function readStoredRecent(subjectId: string, workspaceId: string): StoredRecent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(subjectId, workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredRecent =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as StoredRecent).id === "string" &&
        typeof (item as StoredRecent).title === "string" &&
        typeof (item as StoredRecent).at === "number",
    );
  } catch {
    return [];
  }
}

function directory(subjectId: string, workspaceId: string): DirectoryState {
  const id = key(subjectId, workspaceId);
  let state = directories.get(id);
  if (!state) {
    const stored = readStoredRecent(subjectId, workspaceId);
    state = {
      rows: new Map(
        stored.map((item) => [
          item.id,
          {
            id: item.id,
            workspaceId,
            title: item.title,
            updatedAt: item.at,
            pinned: false,
            archived: false,
            row: null,
          },
        ]),
      ),
      recent: stored.map((item) => item.id),
      sidebarOrder: [],
      pinnedOrder: [],
      version: 0,
    };
    directories.set(id, state);
  }
  return state;
}

function emit(subjectId: string, workspaceId: string): void {
  const state = directory(subjectId, workspaceId);
  state.version += 1;
  for (const listener of listeners.get(key(subjectId, workspaceId)) ?? []) listener();
}

function persistRecent(subjectId: string, workspaceId: string, state: DirectoryState): void {
  if (typeof window === "undefined") return;
  const stored: StoredRecent[] = state.recent.flatMap((id) => {
    const record = state.rows.get(id);
    return record ? [{ id, title: record.title, at: record.updatedAt }] : [];
  });
  try {
    window.localStorage.setItem(storageKey(subjectId, workspaceId), JSON.stringify(stored));
  } catch {
    // Storage full or blocked: recent chats then last only for this page.
  }
}

export function chatRecordFromRow(row: SessionListRow): ChatRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: sessionDisplayTitle(row),
    updatedAt: Date.parse(row.updatedAt) || 0,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    row,
  };
}

/** Remember rows the app has read (sidebar pages, search results, the open chat). */
export function rememberChats(
  subjectId: string,
  workspaceId: string,
  rows: readonly SessionListRow[],
): void {
  if (rows.length === 0) return;
  const state = directory(subjectId, workspaceId);
  let changed = false;
  for (const row of rows) {
    if (row.workspaceId !== workspaceId) continue;
    const next = chatRecordFromRow(row);
    const current = state.rows.get(row.id);
    if (
      current?.row === row ||
      (current &&
        current.row &&
        current.title === next.title &&
        current.updatedAt === next.updatedAt &&
        current.pinned === next.pinned &&
        current.archived === next.archived)
    ) {
      continue;
    }
    state.rows.set(row.id, next);
    changed = true;
  }
  if (changed) emit(subjectId, workspaceId);
}

/** The chat was opened: move it to the front of the recent list. */
export function recordChatVisit(subjectId: string, workspaceId: string, row: SessionListRow): void {
  const state = directory(subjectId, workspaceId);
  const record = { ...chatRecordFromRow(row), updatedAt: Date.now() };
  const previous = state.rows.get(row.id);
  state.rows.set(row.id, previous?.row && !record.row ? { ...previous, ...record } : record);
  if (state.recent[0] !== row.id) {
    state.recent = [row.id, ...state.recent.filter((id) => id !== row.id)].slice(0, RECENT_LIMIT);
  }
  persistRecent(subjectId, workspaceId, state);
  emit(subjectId, workspaceId);
}

/** A chat was deleted or is no longer reachable: forget it. */
export function forgetChat(subjectId: string, workspaceId: string, chatId: string): void {
  const state = directory(subjectId, workspaceId);
  if (!state.rows.delete(chatId) && !state.recent.includes(chatId)) return;
  state.recent = state.recent.filter((id) => id !== chatId);
  persistRecent(subjectId, workspaceId, state);
  emit(subjectId, workspaceId);
}

/** The sidebar reports the chats it shows, in order, so next and previous follow it. */
export function setSidebarOrder(
  subjectId: string,
  workspaceId: string,
  order: readonly string[],
  pinnedOrder: readonly string[],
): void {
  const state = directory(subjectId, workspaceId);
  if (
    state.sidebarOrder.length === order.length &&
    state.sidebarOrder.every((id, index) => id === order[index]) &&
    state.pinnedOrder.length === pinnedOrder.length &&
    state.pinnedOrder.every((id, index) => id === pinnedOrder[index])
  ) {
    return;
  }
  state.sidebarOrder = [...order];
  state.pinnedOrder = [...pinnedOrder];
  emit(subjectId, workspaceId);
}

export type ChatDirectorySnapshot = Readonly<{
  rows: ReadonlyMap<string, ChatRecord>;
  recent: readonly string[];
  sidebarOrder: readonly string[];
  pinnedOrder: readonly string[];
  version: number;
}>;

export function readChatDirectory(subjectId: string, workspaceId: string): ChatDirectorySnapshot {
  return directory(subjectId, workspaceId);
}

function subscribe(subjectId: string, workspaceId: string, listener: () => void): () => void {
  const id = key(subjectId, workspaceId);
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Re-renders when the directory changes; read the snapshot through `readChatDirectory`. */
export function useChatDirectoryVersion(subjectId: string, workspaceId: string): number {
  return useSyncExternalStore(
    (listener) => subscribe(subjectId, workspaceId, listener),
    () => directory(subjectId, workspaceId).version,
    () => 0,
  );
}
