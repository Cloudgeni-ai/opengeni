/**
 * What the app already knows about chats, so the command menu can answer
 * instantly: rows the sidebar and searches have loaded, the chats someone
 * opened recently in any of their workspaces (kept across reloads), and each
 * workspace's sidebar order for next and previous chat. It is a cache for speed, never a source of authority: opening a chat
 * still goes through the normal authorized reads.
 */
import { useSyncExternalStore } from "react";
import { sessionDisplayTitle, type SessionListRow } from "../../../session-list-model";
import { chatStatusKey } from "./chat-status";

export type ChatRecord = {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** Present when the app holds a full or list row, needed for pin and archive. */
  row: SessionListRow | null;
  /** When `row` was last read from the server (ms), so its status is known to be current. */
  readAt: number;
};

type WorkspaceOrder = { sidebarOrder: string[]; pinnedOrder: string[] };

type DirectoryState = {
  /** Every chat the app knows, in any of the person's workspaces. */
  rows: Map<string, ChatRecord>;
  /** Recently opened chat ids across workspaces, most recent first. */
  recent: string[];
  /** Each workspace's sidebar order (pinned first), for next and previous. */
  orders: Map<string, WorkspaceOrder>;
  version: number;
};

const RECENT_LIMIT = 50;
const EMPTY_ORDER: WorkspaceOrder = { sidebarOrder: [], pinnedOrder: [] };
const directories = new Map<string, DirectoryState>();
const listeners = new Map<string, Set<() => void>>();

function storageKey(subjectId: string): string {
  return `opengeni.recentChats.${subjectId}`;
}

type StoredRecent = { id: string; workspaceId: string; title: string; at: number };

function parseStored(raw: string | null, workspaceId?: string): StoredRecent[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): StoredRecent[] => {
      if (typeof item !== "object" || item === null) return [];
      const entry = item as Partial<StoredRecent>;
      const ws = typeof entry.workspaceId === "string" ? entry.workspaceId : workspaceId;
      if (
        typeof entry.id !== "string" ||
        typeof ws !== "string" ||
        typeof entry.title !== "string" ||
        typeof entry.at !== "number"
      ) {
        return [];
      }
      return [{ id: entry.id, workspaceId: ws, title: entry.title, at: entry.at }];
    });
  } catch {
    return [];
  }
}

/**
 * The recent chats kept across reloads. Earlier versions kept one list per
 * workspace (`opengeni.recentChats.<subject>.<workspace>`); those merge into
 * the one list the first time it is read.
 */
function readStoredRecent(subjectId: string): StoredRecent[] {
  if (typeof window === "undefined") return [];
  try {
    const storage = window.localStorage;
    const key = storageKey(subjectId);
    const current = storage.getItem(key);
    if (current !== null) return parseStored(current);
    const prefix = `${key}.`;
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const name = storage.key(index);
      if (name?.startsWith(prefix)) legacyKeys.push(name);
    }
    if (legacyKeys.length === 0) return [];
    const merged = legacyKeys
      .flatMap((name) => parseStored(storage.getItem(name), name.slice(prefix.length)))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_LIMIT);
    storage.setItem(key, JSON.stringify(merged));
    for (const name of legacyKeys) storage.removeItem(name);
    return merged;
  } catch {
    return [];
  }
}

function directory(subjectId: string): DirectoryState {
  let state = directories.get(subjectId);
  if (!state) {
    const stored = readStoredRecent(subjectId);
    state = {
      rows: new Map(
        stored.map((item) => [
          item.id,
          {
            id: item.id,
            workspaceId: item.workspaceId,
            title: item.title,
            updatedAt: item.at,
            pinned: false,
            archived: false,
            row: null,
            readAt: 0,
          },
        ]),
      ),
      recent: stored.map((item) => item.id),
      orders: new Map(),
      version: 0,
    };
    directories.set(subjectId, state);
  }
  return state;
}

function emit(subjectId: string): void {
  const state = directory(subjectId);
  state.version += 1;
  for (const listener of listeners.get(subjectId) ?? []) listener();
}

function persistRecent(subjectId: string, state: DirectoryState): void {
  if (typeof window === "undefined") return;
  const stored: StoredRecent[] = state.recent.flatMap((id) => {
    const record = state.rows.get(id);
    return record
      ? [{ id, workspaceId: record.workspaceId, title: record.title, at: record.updatedAt }]
      : [];
  });
  try {
    window.localStorage.setItem(storageKey(subjectId), JSON.stringify(stored));
  } catch {
    // Storage full or blocked: recent chats then last only for this page.
  }
}

export function chatRecordFromRow(row: SessionListRow, readAt: number = Date.now()): ChatRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: sessionDisplayTitle(row),
    updatedAt: Date.parse(row.updatedAt) || 0,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    row,
    readAt,
  };
}

/** Remember rows the app has read (sidebar pages, search results, the open chat). */
export function rememberChats(subjectId: string, rows: readonly SessionListRow[]): void {
  if (rows.length === 0) return;
  const state = directory(subjectId);
  const now = Date.now();
  let changed = false;
  for (const row of rows) {
    const next = chatRecordFromRow(row, now);
    const current = state.rows.get(row.id);
    // The newest read always replaces the row (it carries the live status);
    // only a change people can see re-renders the menus.
    state.rows.set(row.id, next);
    if (
      current?.row === row ||
      (current &&
        current.row &&
        current.title === next.title &&
        current.updatedAt === next.updatedAt &&
        current.pinned === next.pinned &&
        current.archived === next.archived &&
        chatStatusKey(current.row) === chatStatusKey(row))
    ) {
      continue;
    }
    changed = true;
  }
  if (changed) emit(subjectId);
}

/** The chat was opened: move it to the front of the recent list. */
export function recordChatVisit(subjectId: string, row: SessionListRow): void {
  const state = directory(subjectId);
  const record = { ...chatRecordFromRow(row), updatedAt: Date.now() };
  const previous = state.rows.get(row.id);
  state.rows.set(row.id, previous?.row && !record.row ? { ...previous, ...record } : record);
  if (state.recent[0] !== row.id) {
    state.recent = [row.id, ...state.recent.filter((id) => id !== row.id)].slice(0, RECENT_LIMIT);
  }
  persistRecent(subjectId, state);
  emit(subjectId);
}

/** A chat was deleted or is no longer reachable: forget it. */
export function forgetChat(subjectId: string, chatId: string): void {
  const state = directory(subjectId);
  if (!state.rows.delete(chatId) && !state.recent.includes(chatId)) return;
  state.recent = state.recent.filter((id) => id !== chatId);
  persistRecent(subjectId, state);
  emit(subjectId);
}

/** The sidebar reports the chats it shows, in order, so next and previous follow it. */
export function setSidebarOrder(
  subjectId: string,
  workspaceId: string,
  order: readonly string[],
  pinnedOrder: readonly string[],
): void {
  const state = directory(subjectId);
  const current = state.orders.get(workspaceId) ?? EMPTY_ORDER;
  if (
    current.sidebarOrder.length === order.length &&
    current.sidebarOrder.every((id, index) => id === order[index]) &&
    current.pinnedOrder.length === pinnedOrder.length &&
    current.pinnedOrder.every((id, index) => id === pinnedOrder[index])
  ) {
    return;
  }
  state.orders.set(workspaceId, { sidebarOrder: [...order], pinnedOrder: [...pinnedOrder] });
  emit(subjectId);
}

export type ChatDirectorySnapshot = Readonly<{
  /** Chats in every workspace; each record names its workspace. */
  rows: ReadonlyMap<string, ChatRecord>;
  /** Recently opened chats across workspaces, most recent first. */
  recent: readonly string[];
  /** The given workspace's sidebar order and pinned order. */
  sidebarOrder: readonly string[];
  pinnedOrder: readonly string[];
  version: number;
}>;

export function readChatDirectory(subjectId: string, workspaceId: string): ChatDirectorySnapshot {
  const state = directory(subjectId);
  const order = state.orders.get(workspaceId) ?? EMPTY_ORDER;
  return {
    rows: state.rows,
    recent: state.recent,
    sidebarOrder: order.sidebarOrder,
    pinnedOrder: order.pinnedOrder,
    version: state.version,
  };
}

function subscribe(subjectId: string, listener: () => void): () => void {
  let set = listeners.get(subjectId);
  if (!set) {
    set = new Set();
    listeners.set(subjectId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Re-renders when the directory changes; read the snapshot through `readChatDirectory`. */
export function useChatDirectoryVersion(subjectId: string): number {
  return useSyncExternalStore(
    (listener) => subscribe(subjectId, listener),
    () => directory(subjectId).version,
    () => 0,
  );
}
