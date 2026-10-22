/**
 * Control+Tab in the desktop app: switch between recently viewed chats, most
 * recent first, as ⌘Tab switches apps. The list spans the person's workspaces,
 * so it also jumps between chats in different workspaces. A quick press goes back to the previous
 * chat (press again to return); holding Control shows the list, each Tab moves
 * down it (Shift+Tab up), and releasing Control opens the highlighted chat.
 *
 * The list is read once when the switcher opens, so it holds still while the
 * person cycles through it.
 */
import type { ChatDirectorySnapshot } from "./chat-directory";

/** At most this many chats; older ones are a search away in ⌘K. */
export const SWITCHER_LIMIT = 10;
/** A press shorter than this switches without ever drawing the list. */
export const SWITCHER_SHOW_DELAY_MS = 140;

export type ChatSwitcherState = Readonly<{
  /** Chats in the order shown, most recently viewed first. */
  ids: readonly string[];
  /** The highlighted chat. */
  index: number;
  /** Whether the list is drawn (after the delay, or once Tab is pressed again). */
  visible: boolean;
}>;

/**
 * The chats to switch between, most recently viewed first, with the open chat
 * (when there is one) at the front. Null when there is nowhere to switch to.
 */
export function openChatSwitcher(
  directory: Pick<ChatDirectorySnapshot, "recent" | "rows">,
  currentChatId: string | null,
  backwards: boolean,
  /** Whether a workspace is still open to the person; chats elsewhere are left out. */
  reachable: (workspaceId: string) => boolean = () => true,
): ChatSwitcherState | null {
  const switchable = directory.recent.filter((id) => {
    const record = directory.rows.get(id);
    if (!record || record.archived || !reachable(record.workspaceId)) return false;
    // Subagent chats live under their parent, as in the sidebar.
    return !record.row || record.row.parentSessionId === null;
  });
  const ids = currentChatId
    ? [currentChatId, ...switchable.filter((id) => id !== currentChatId)]
    : switchable;
  const limited = ids.slice(0, SWITCHER_LIMIT);
  // Away from a chat (the inbox, a new chat) the most recent chat is the target.
  const first = currentChatId ? 1 : 0;
  if (limited.length <= first) return null;
  return { ids: limited, index: backwards ? limited.length - 1 : first, visible: false };
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
