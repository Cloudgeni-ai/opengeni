/**
 * Control+Tab in the desktop app: switch between recently viewed chats, most
 * recent first, as ⌘Tab switches apps. The list spans the person's workspaces,
 * so it also jumps between chats in different workspaces. A quick press goes back to the previous
 * chat (press again to return); holding Control shows the list, each Tab moves
 * down it (Shift+Tab up), and releasing Control opens the highlighted chat.
 *
 * Past the chats someone opened, the list carries on through the other chats
 * the app knows, most recently active first, so holding Tab keeps going back
 * in time. The list is read when the switcher opens and only ever grows at
 * the end (as more chats load), so it holds still while the person cycles.
 */
import type { ChatDirectorySnapshot, ChatRecord } from "./chat-directory";

/** At most this many chats; older ones are a search away in ⌘K. */
export const SWITCHER_LIMIT = 100;
/** A press shorter than this switches without ever drawing the list. */
export const SWITCHER_SHOW_DELAY_MS = 140;

export type ChatSwitcherState = Readonly<{
  /** Chats in the order shown: recently viewed first, then recently active. */
  ids: readonly string[];
  /** How many of `ids`, from the front, are chats the person opened recently. */
  viewed: number;
  /** The highlighted chat. */
  index: number;
  /** Whether the list is drawn (after the delay, or once Tab is pressed again). */
  visible: boolean;
}>;

type SwitcherDirectory = Pick<ChatDirectorySnapshot, "recent" | "rows">;

function switchable(
  record: ChatRecord | undefined,
  reachable: (workspaceId: string) => boolean,
): boolean {
  if (!record || record.archived || !reachable(record.workspaceId)) return false;
  // Subagent chats live under their parent, as in the sidebar.
  return !record.row || record.row.parentSessionId === null;
}

/** Known chats not in `taken`, most recently active first. */
function moreChats(
  directory: SwitcherDirectory,
  taken: ReadonlySet<string>,
  reachable: (workspaceId: string) => boolean,
  room: number,
): string[] {
  if (room <= 0) return [];
  const more: ChatRecord[] = [];
  for (const record of directory.rows.values()) {
    if (!taken.has(record.id) && switchable(record, reachable)) more.push(record);
  }
  more.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  return more.slice(0, room).map((record) => record.id);
}

/**
 * The chats to switch between: the open chat (when there is one), the other
 * recently viewed chats, then the rest the app knows by latest activity.
 * Null when there is nowhere to switch to.
 */
export function openChatSwitcher(
  directory: SwitcherDirectory,
  currentChatId: string | null,
  backwards: boolean,
  /** Whether a workspace is still open to the person; chats elsewhere are left out. */
  reachable: (workspaceId: string) => boolean = () => true,
): ChatSwitcherState | null {
  const recent = directory.recent.filter(
    (id) => id !== currentChatId && switchable(directory.rows.get(id), reachable),
  );
  const viewed = (currentChatId ? [currentChatId, ...recent] : recent).slice(0, SWITCHER_LIMIT);
  const ids = [
    ...viewed,
    ...moreChats(directory, new Set(viewed), reachable, SWITCHER_LIMIT - viewed.length),
  ];
  // Away from a chat (the inbox, a new chat) the most recent chat is the target.
  const first = currentChatId ? 1 : 0;
  if (ids.length <= first) return null;
  return {
    ids,
    viewed: viewed.length,
    index: backwards ? ids.length - 1 : first,
    visible: false,
  };
}

/**
 * Chats that loaded while the list is open join at its end, so nothing the
 * person is looking at moves. The same state when there is nothing new.
 */
export function extendChatSwitcher(
  state: ChatSwitcherState,
  directory: SwitcherDirectory,
  reachable: (workspaceId: string) => boolean = () => true,
): ChatSwitcherState {
  const more = moreChats(
    directory,
    new Set(state.ids),
    reachable,
    SWITCHER_LIMIT - state.ids.length,
  );
  return more.length === 0 ? state : { ...state, ids: [...state.ids, ...more] };
}

/** Tab moves down the list and Shift+Tab up, wrapping at the ends. */
export function stepChatSwitcher(state: ChatSwitcherState, step: 1 | -1): ChatSwitcherState {
  const count = state.ids.length;
  return { ...state, index: (state.index + step + count) % count, visible: true };
}

/** Control+Tab exactly: no ⌘, no ⌥ (Shift reverses). */
export function isSwitcherKey(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey">,
) {
  return event.code === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey;
}
