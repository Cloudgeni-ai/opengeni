/**
 * The action registry: everything a person can do from the keyboard, the ⌘K
 * menu, menus and the desktop menu bar. Each action is defined once here, with
 * its name, keys and availability, so every surface shows and runs it the same
 * way. See docs/command-menu-and-shortcuts.md.
 */
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CommandIcon,
  InboxIcon,
  KeyboardIcon,
  LinkIcon,
  MailIcon,
  MailOpenIcon,
  PanelLeftIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  TextSearchIcon,
  type LucideIcon,
} from "lucide-react";
import type { SessionListRow } from "../../../session-list-model";
import type { ActionSurface, Chord, ChordPlatform } from "./chords";
import type { ChatOperations } from "./chat-operations";

export type ActionGroup = "chat" | "navigate" | "view" | "help";

/** Where the desktop menu bar shows an action. */
export type DesktopMenuPlacement = "file" | "view" | "go" | "chat" | "help";

export type ActionEnv = {
  workspaceId: string;
  subjectId: string;
  surface: ActionSurface;
  platform: ChordPlatform;
  /** The chat on screen, if any. */
  currentChat: SessionListRow | null;
  ops: ChatOperations;
  /** Whether the sidebar's chat list is part of this surface. */
  chatList: boolean;
  newChat(): void;
  openChat(chatId: string): void;
  openInbox(): void;
  toggleSidebar(): void;
  findInChat(): void;
  searchMessages(query?: string): void;
  renameCurrentChat(): void;
  openCommandMenu(): void;
  openShortcutSheet(): void;
  /** Chats in sidebar order, and the pinned ones in their order. */
  sidebarOrder(): readonly string[];
  pinnedOrder(): readonly string[];
};

export type AppAction = {
  id: string;
  /** Plain words; chat actions may read the chat (Pin or Unpin). */
  title: string | ((env: ActionEnv, chat: SessionListRow | null) => string);
  group: ActionGroup;
  icon: LucideIcon;
  /** A different icon for some chats (Unpin for a pinned chat). */
  iconFor?: (chat: SessionListRow | null) => LucideIcon;
  /** Extra words the ⌘K menu matches, e.g. "share" for Copy link. */
  keywords?: readonly string[];
  chords?: readonly Chord[];
  /** The cheat sheet's own key text when one action has many chords (⌘1 to ⌘9). */
  chordSummary?: (platform: ChordPlatform) => string;
  /** Acts on a chat: the current one, or the one a menu or ⌘K row points at. */
  forChat?: boolean;
  /** Listed in the ⌘K menu (some exist only as keys). Default true. */
  inCommandMenu?: boolean;
  /**
   * Opens a dialog of its own. From ⌘K it runs once the menu has handed focus
   * back, so the new dialog returns focus to the same place when it closes.
   */
  opensDialog?: boolean;
  /** Offered in ⌘K before anything is typed. */
  suggested?: boolean;
  /** The desktop menu bar section, when it appears there. */
  desktopMenu?: DesktopMenuPlacement;
  available(env: ActionEnv, chat: SessionListRow | null): boolean;
  run(env: ActionEnv, chat: SessionListRow | null, chord?: Chord): void | Promise<void>;
};

export function actionTitle(
  action: AppAction,
  env: ActionEnv,
  chat: SessionListRow | null,
): string {
  return typeof action.title === "string" ? action.title : action.title(env, chat);
}

export function actionIcon(action: AppAction, chat: SessionListRow | null): LucideIcon {
  return action.iconFor?.(chat) ?? action.icon;
}

const ALWAYS = () => true;

function stepChat(env: ActionEnv, direction: 1 | -1): void {
  const order = env.sidebarOrder();
  if (order.length === 0) return;
  const index = env.currentChat ? order.indexOf(env.currentChat.id) : -1;
  const next = index < 0 ? (direction === 1 ? 0 : order.length - 1) : index + direction;
  if (next < 0 || next >= order.length) return;
  env.openChat(order[next]!);
}

const PINNED_CHORDS: Chord[] = Array.from({ length: 9 }, (_, index) => ({
  code: `Digit${index + 1}`,
  mod: true,
  only: "desktop" as const,
}));

export const APP_ACTIONS: readonly AppAction[] = [
  {
    id: "commandMenu.open",
    title: "Command menu",
    group: "help",
    icon: CommandIcon,
    chords: [{ code: "KeyK", mod: true }],
    inCommandMenu: false,
    desktopMenu: "go",
    available: ALWAYS,
    run: (env) => env.openCommandMenu(),
  },
  {
    id: "chat.new",
    title: "New chat",
    group: "chat",
    icon: PlusIcon,
    keywords: ["start", "create", "session"],
    // The desktop menu shows its first key, the familiar ⌘N; browsers keep ⌘N for windows.
    chords: [
      { code: "KeyN", mod: true, only: "desktop" },
      { code: "KeyO", mod: true, shift: true },
    ],
    suggested: true,
    desktopMenu: "file",
    available: ALWAYS,
    run: (env) => env.newChat(),
  },
  {
    id: "chat.copyLink",
    title: "Copy link",
    group: "chat",
    icon: LinkIcon,
    keywords: ["share", "url", "address"],
    chords: [{ code: "Comma", mod: true, shift: true }],
    forChat: true,
    suggested: true,
    desktopMenu: "chat",
    available: (_env, chat) => chat !== null,
    run: (env, chat) => (chat ? env.ops.copyLink(chat) : undefined),
  },
  {
    id: "chat.pin",
    title: (_env, chat) => (chat?.pinned ? "Unpin" : "Pin"),
    group: "chat",
    icon: PinIcon,
    iconFor: (chat) => (chat?.pinned ? PinOffIcon : PinIcon),
    keywords: ["unpin", "favorite", "star"],
    chords: [{ code: "KeyP", mod: true, alt: true }],
    forChat: true,
    suggested: true,
    desktopMenu: "chat",
    available: (_env, chat) => chat !== null && !chat.archived,
    run: (env, chat) => (chat ? env.ops.setPinned(chat, !chat.pinned) : undefined),
  },
  {
    id: "chat.rename",
    title: "Rename",
    group: "chat",
    icon: PencilIcon,
    keywords: ["title", "name"],
    forChat: true,
    desktopMenu: "chat",
    // Renaming happens in the chat's own title, so only for the chat on screen.
    available: (env, chat) => chat !== null && env.currentChat?.id === chat.id,
    run: (env) => env.renameCurrentChat(),
  },
  {
    id: "chat.unread",
    title: (_env, chat) => (chat?.unread ? "Mark as read" : "Mark as unread"),
    group: "chat",
    icon: MailIcon,
    iconFor: (chat) => (chat?.unread ? MailOpenIcon : MailIcon),
    keywords: ["read", "unread"],
    forChat: true,
    desktopMenu: "chat",
    available: (_env, chat) => chat !== null && !chat.archived,
    run: (env, chat) => (chat ? env.ops.setUnread(chat, !chat.unread) : undefined),
  },
  {
    id: "chat.archive",
    title: (_env, chat) => (chat?.archived ? "Restore" : "Archive"),
    group: "chat",
    icon: ArchiveIcon,
    iconFor: (chat) => (chat?.archived ? ArchiveRestoreIcon : ArchiveIcon),
    keywords: ["restore", "hide", "done"],
    forChat: true,
    desktopMenu: "chat",
    available: (_env, chat) => chat !== null && chat.parentSessionId === null,
    run: (env, chat) => (chat ? env.ops.setArchived(chat, !chat.archived) : undefined),
  },
  {
    id: "chat.find",
    title: "Find in chat",
    group: "chat",
    icon: TextSearchIcon,
    keywords: ["search", "find"],
    chords: [{ code: "KeyF", mod: true }],
    desktopMenu: "chat",
    // The conversation owns ⌘F itself; the registry lists it so it is discoverable.
    available: (env) => env.currentChat !== null,
    run: (env) => env.findInChat(),
  },
  {
    id: "go.inbox",
    title: "Inbox",
    group: "navigate",
    icon: InboxIcon,
    keywords: ["notifications", "replies", "needs you"],
    chords: [
      { code: "KeyI", mod: true, shift: true, platform: "mac" },
      // Browsers on Windows and Linux open developer tools with Ctrl+Shift+I.
      { code: "KeyI", mod: true, shift: true, platform: "other", only: "desktop" },
    ],
    suggested: true,
    desktopMenu: "go",
    available: ALWAYS,
    run: (env) => env.openInbox(),
  },
  {
    id: "go.previousChat",
    title: "Previous chat",
    group: "navigate",
    icon: ArrowUpIcon,
    chords: [{ code: "ArrowUp", alt: true }],
    inCommandMenu: false,
    available: (env) => env.chatList,
    run: (env) => stepChat(env, -1),
  },
  {
    id: "go.nextChat",
    title: "Next chat",
    group: "navigate",
    icon: ArrowDownIcon,
    chords: [{ code: "ArrowDown", alt: true }],
    inCommandMenu: false,
    available: (env) => env.chatList,
    run: (env) => stepChat(env, 1),
  },
  {
    id: "go.pinnedChat",
    title: "Pinned chat 1 to 9",
    group: "navigate",
    icon: PinIcon,
    chords: PINNED_CHORDS,
    chordSummary: (platform) => (platform === "mac" ? "⌘1 – ⌘9" : "Ctrl+1 – Ctrl+9"),
    inCommandMenu: false,
    available: (env) => env.chatList,
    run: (env, _chat, chord) => {
      const index = chord ? Number(chord.code.slice(5)) - 1 : 0;
      const id = env.pinnedOrder()[index];
      if (id) env.openChat(id);
    },
  },
  {
    id: "go.searchMessages",
    title: "Search messages",
    group: "navigate",
    icon: SearchIcon,
    keywords: ["find", "history", "full text"],
    opensDialog: true,
    desktopMenu: "go",
    available: ALWAYS,
    run: (env) => env.searchMessages(),
  },
  {
    id: "view.sidebar",
    title: "Toggle sidebar",
    group: "view",
    icon: PanelLeftIcon,
    keywords: ["hide", "show", "collapse", "rail"],
    chords: [
      { code: "KeyS", mod: true, control: true, platform: "mac" },
      { code: "KeyS", mod: true, shift: true, platform: "other" },
    ],
    desktopMenu: "view",
    available: (env) => env.chatList,
    run: (env) => env.toggleSidebar(),
  },
  {
    id: "help.shortcuts",
    title: "Keyboard shortcuts",
    group: "help",
    icon: KeyboardIcon,
    keywords: ["keys", "hotkeys", "cheat sheet", "help"],
    chords: [{ code: "Slash", mod: true }],
    desktopMenu: "help",
    available: ALWAYS,
    run: (env) => env.openShortcutSheet(),
  },
];

export function findAction(id: string): AppAction | undefined {
  return APP_ACTIONS.find((action) => action.id === id);
}
