/**
 * The ⌘K menu: find a chat by its title, or run any action, from one field.
 *
 * It opens instantly from what the app already knows (chats the sidebar has
 * loaded and the chats opened recently) and merges the server's title search as
 * it arrives. Tab on a chat shows that chat's actions; the chords of chat
 * actions work on the highlighted chat while the menu is open.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  MessageSquareIcon,
  PinIcon,
  SearchIcon,
  TextSearchIcon,
  type LucideIcon,
} from "lucide-react";
import type { SessionListRow } from "../../../session-list-model";
import { useAppContext } from "../../app-context";
import {
  readChatDirectory,
  rememberChats,
  useChatDirectoryVersion,
  type ChatRecord,
} from "../../lib/actions/chat-directory";
import { matchesChord, type Chord } from "../../lib/actions/chords";
import { useAppActions } from "../../lib/actions/actions-provider";
import { foldForSearch, rankLabel, rankWithKeywords } from "../../lib/actions/rank";
import {
  APP_ACTIONS,
  actionIcon,
  actionTitle,
  type ActionEnv,
  type AppAction,
} from "../../lib/actions/registry";
import { cn } from "../../lib/utils";
import { DialogOverlay, DialogPortal } from "../../../ui/dialog";
import { formatRelativeTime } from "../../../ui/relative-time";
import { Keycaps } from "./keycaps";

type Item = {
  key: string;
  group: string;
  icon: LucideIcon;
  title: string;
  /** Text to mark as matched in the title. */
  highlight?: string | undefined;
  /** Quiet text on the right (when, "Archived"). */
  meta?: string | undefined;
  chord?: Chord | undefined;
  /** Present on chat rows: Tab opens their actions, chat chords act on them. */
  chat?: ChatRecord | undefined;
  run(options: { newTab: boolean }): void;
};

type Group = { label: string; items: Item[]; best: number };

const RECENT_LIMIT = 6;
const CHAT_RESULT_LIMIT = 8;
const ACTION_RESULT_LIMIT = 6;
const SERVER_DEBOUNCE_MS = 120;

function relativeMeta(record: ChatRecord, now: number): string | undefined {
  if (record.archived) return "Archived";
  if (!record.updatedAt) return undefined;
  return formatRelativeTime(record.updatedAt, { now });
}

function chatIcon(record: ChatRecord): LucideIcon {
  if (record.archived) return ArchiveIcon;
  if (record.pinned) return PinIcon;
  return MessageSquareIcon;
}

/** Rows the menu may list: top-level chats only (subagent chats live under their parent). */
function listable(record: ChatRecord): boolean {
  return !record.row || record.row.parentSessionId === null;
}

/** Marks the query's words in a title, case- and accent-insensitively. */
function Highlighted(props: { text: string; query: string | undefined }) {
  const { text, query } = props;
  const words = query ? foldForSearch(query).split(" ").filter(Boolean) : [];
  if (words.length === 0) return <>{text}</>;
  // Fold per character so positions in the folded text map back to the title.
  const folded = Array.from(text, (character) => foldForSearch(character) || " ");
  const joined = folded.join("");
  const marked = new Array<boolean>(folded.length).fill(false);
  const offsets: number[] = [];
  let offset = 0;
  for (const piece of folded) {
    offsets.push(offset);
    offset += piece.length;
  }
  const indexAt = (position: number) => {
    let index = offsets.findIndex((start) => start > position);
    index = index < 0 ? offsets.length - 1 : index - 1;
    return index;
  };
  const phrase = words.join(" ");
  const ranges: Array<[number, number]> = [];
  const whole = joined.indexOf(phrase);
  if (whole >= 0) ranges.push([whole, whole + phrase.length]);
  else {
    for (const word of words) {
      const at = joined.indexOf(word);
      if (at >= 0) ranges.push([at, at + word.length]);
    }
  }
  for (const [start, end] of ranges) {
    for (let index = indexAt(start); index <= indexAt(end - 1); index++) marked[index] = true;
  }
  const characters = Array.from(text);
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  characters.forEach((character, index) => {
    const isMarked = marked[index] ?? false;
    if (index > 0 && isMarked !== runMarked) {
      parts.push(
        runMarked ? (
          <mark key={parts.length} className="bg-transparent font-medium text-fg">
            {run}
          </mark>
        ) : (
          run
        ),
      );
      run = "";
    }
    run += character;
    runMarked = isMarked;
  });
  if (run) {
    parts.push(
      runMarked ? (
        <mark key={parts.length} className="bg-transparent font-medium text-fg">
          {run}
        </mark>
      ) : (
        run
      ),
    );
  }
  return <>{parts}</>;
}

function useServerTitleSearch(
  workspaceId: string,
  subjectId: string,
  query: string,
  open: boolean,
) {
  const { client } = useAppContext();
  const [state, setState] = useState<{ query: string; rows: SessionListRow[]; loading: boolean }>({
    query: "",
    rows: [],
    loading: false,
  });
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !trimmed) {
      setState({ query: "", rows: [], loading: false });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      client
        .listSessionPage(workspaceId, {
          search: trimmed,
          archiveStatus: "all",
          limit: 20,
          signal: controller.signal,
        })
        .then((page) => {
          const rows = [...(page.pinned ?? []), ...page.sessions];
          rememberChats(subjectId, workspaceId, rows);
          setState({ query: trimmed, rows, loading: false });
        })
        .catch(() => {
          // Local results still show; the server search is an addition.
          if (!controller.signal.aborted) setState({ query: trimmed, rows: [], loading: false });
        });
    }, SERVER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, workspaceId, subjectId, query, open]);
  return state;
}

export default function CommandMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = useAppActions();
  if (!actions) return null;
  return (
    <CommandMenuDialog
      {...props}
      env={actions.env}
      run={actions.run}
      chordsFor={actions.chordsFor}
    />
  );
}

function CommandMenuDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  env: ActionEnv;
  run(action: AppAction, chat?: SessionListRow | null, chord?: Chord): void;
  chordsFor(action: AppAction): Chord[];
}) {
  const { env, run, chordsFor, onOpenChange } = props;
  const { workspaceId, subjectId, platform, surface } = env;
  const directoryVersion = useChatDirectoryVersion(subjectId, workspaceId);
  const [query, setQuery] = useState("");
  const [focusChat, setFocusChat] = useState<ChatRecord | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ranAction = useRef(false);
  const listId = useId();
  const server = useServerTitleSearch(workspaceId, subjectId, focusChat ? "" : query, props.open);

  // Every open starts fresh.
  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setFocusChat(null);
    setActive(0);
    ranAction.current = false;
  }, [props.open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const runAction = useCallback(
    (action: AppAction, chat: SessionListRow | null, chord?: Chord) => {
      ranAction.current = true;
      close();
      run(action, action.forChat ? chat : undefined, chord);
    },
    [close, run],
  );

  const openChat = useCallback(
    (record: ChatRecord, newTab: boolean) => {
      ranAction.current = true;
      close();
      if (newTab && surface === "web") {
        window.open(env.ops.linkTo(record), "_blank", "noopener");
        return;
      }
      env.openChat(record.id);
    },
    [close, env, surface],
  );

  const actionItem = useCallback(
    (action: AppAction, chat: SessionListRow | null, group: string, highlight?: string): Item => ({
      key: `action:${action.id}`,
      group,
      icon: actionIcon(action, chat),
      title: actionTitle(action, env, chat),
      highlight,
      chord: chordsFor(action)[0],
      run: () => runAction(action, chat),
    }),
    [chordsFor, env, runAction],
  );

  const groups = useMemo<Group[]>(() => {
    void directoryVersion;
    const now = Date.now();
    const directory = readChatDirectory(subjectId, workspaceId);
    const current = env.currentChat;

    const chatItem = (record: ChatRecord, group: string, highlight?: string): Item => ({
      key: `chat:${record.id}`,
      group,
      icon: chatIcon(record),
      title: record.title,
      highlight,
      meta: current?.id === record.id ? "Open now" : relativeMeta(record, now),
      chat: record,
      run: ({ newTab }) => openChat(record, newTab),
    });

    // A chat's own actions (after Tab).
    if (focusChat) {
      const row = focusChat.row ?? (current?.id === focusChat.id ? current : null);
      const items: Array<{ item: Item; rank: number }> = [];
      const openRank = rankLabel("Open", query);
      if (openRank !== null) {
        items.push({
          rank: openRank + 1,
          item: {
            key: "open",
            group: focusChat.title,
            icon: CornerDownLeftIcon,
            title: "Open",
            highlight: query,
            run: () => openChat(focusChat, false),
          },
        });
      }
      if (surface === "web") {
        const tabRank = rankLabel("Open in new tab", query);
        if (tabRank !== null) {
          items.push({
            rank: tabRank,
            item: {
              key: "open-tab",
              group: focusChat.title,
              icon: ArrowUpRightIcon,
              title: "Open in new tab",
              highlight: query,
              run: () => openChat(focusChat, true),
            },
          });
        }
      }
      for (const action of APP_ACTIONS) {
        if (!action.forChat || action.inCommandMenu === false) continue;
        // Copy link needs only the id; the rest need the chat's row.
        const target = row ?? (action.id === "chat.copyLink" ? pseudoRow(focusChat) : null);
        if (!target || !action.available(env, target)) continue;
        const rank = rankWithKeywords(actionTitle(action, env, target), action.keywords, query);
        if (rank === null) continue;
        items.push({ rank, item: actionItem(action, target, focusChat.title, query) });
      }
      if (query) items.sort((a, b) => b.rank - a.rank);
      return [{ label: focusChat.title, items: items.map((entry) => entry.item), best: 0 }];
    }

    const trimmed = query.trim();
    if (!trimmed) {
      const result: Group[] = [];
      const recentIds = (
        directory.recent.length > 0 ? directory.recent : directory.sidebarOrder
      ).filter((id) => id !== current?.id);
      const recent = recentIds
        .map((id) => directory.rows.get(id))
        .filter((record): record is ChatRecord =>
          Boolean(record && listable(record) && !record.archived),
        )
        .slice(0, RECENT_LIMIT);
      if (recent.length > 0) {
        result.push({
          label: "Recent chats",
          items: recent.map((record) => chatItem(record, "Recent chats")),
          best: 0,
        });
      }
      if (current) {
        const chatActions = APP_ACTIONS.filter(
          (action) =>
            action.forChat &&
            action.inCommandMenu !== false &&
            action.id !== "chat.find" &&
            action.available(env, current),
        );
        if (chatActions.length > 0) {
          result.push({
            label: "This chat",
            items: chatActions.map((action) => actionItem(action, current, "This chat")),
            best: 0,
          });
        }
      }
      const general = APP_ACTIONS.filter(
        (action) =>
          !action.forChat &&
          action.inCommandMenu !== false &&
          action.id !== "commandMenu.open" &&
          action.available(env, null),
      );
      if (general.length > 0) {
        result.push({
          label: "Go to",
          items: general.map((action) => actionItem(action, null, "Go to")),
          best: 0,
        });
      }
      return result;
    }

    // Chats: everything the app knows, ranked by title, plus the server's matches.
    const recentIndex = new Map(directory.recent.map((id, index) => [id, index]));
    const serverIds = new Set(server.query === trimmed ? server.rows.map((row) => row.id) : []);
    const scored: Array<{ record: ChatRecord; rank: number }> = [];
    for (const record of directory.rows.values()) {
      if (!listable(record)) continue;
      let rank = rankLabel(record.title, trimmed);
      // The server matched every word in the title or first message.
      if (rank === null && serverIds.has(record.id)) rank = 50;
      if (rank === null) continue;
      const visited = recentIndex.get(record.id);
      if (visited !== undefined) rank += Math.max(0, 20 - visited);
      if (record.pinned) rank += 5;
      if (record.archived) rank -= 300;
      scored.push({ record, rank });
    }
    scored.sort((a, b) => b.rank - a.rank || b.record.updatedAt - a.record.updatedAt);
    const chats = scored.slice(0, CHAT_RESULT_LIMIT);

    const actionScores: Array<{ item: Item; rank: number }> = [];
    for (const action of APP_ACTIONS) {
      if (action.inCommandMenu === false) continue;
      const target = action.forChat ? current : null;
      if (action.forChat && !target) continue;
      if (!action.available(env, target)) continue;
      const rank = rankWithKeywords(actionTitle(action, env, target), action.keywords, trimmed);
      if (rank === null) continue;
      actionScores.push({ rank, item: actionItem(action, target, "Actions", trimmed) });
    }
    actionScores.sort((a, b) => b.rank - a.rank);
    const actionsFound = actionScores.slice(0, ACTION_RESULT_LIMIT);

    const result: Group[] = [];
    if (chats.length > 0) {
      result.push({
        label: "Chats",
        items: chats.map((entry) => chatItem(entry.record, "Chats", trimmed)),
        best: chats[0]!.rank,
      });
    }
    if (actionsFound.length > 0) {
      result.push({
        label: "Actions",
        items: actionsFound.map((entry) => entry.item),
        best: actionsFound[0]!.rank,
      });
    }
    // A clearly better action match ("new" → New chat) comes before chats.
    result.sort((a, b) => b.best - a.best);
    result.push({
      label: "Messages",
      best: -Infinity,
      items: [
        {
          key: "search-messages",
          group: "Messages",
          icon: TextSearchIcon,
          title: `Search messages for “${trimmed}”`,
          run: () => {
            ranAction.current = true;
            close();
            env.searchMessages(trimmed);
          },
        },
      ],
    });
    return result;
  }, [
    actionItem,
    close,
    directoryVersion,
    env,
    focusChat,
    openChat,
    query,
    server.query,
    server.rows,
    subjectId,
    surface,
    workspaceId,
  ]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const searching = Boolean(query.trim()) && !focusChat && server.loading;

  // Typing starts at the best match.
  useEffect(() => setActive(0), [query, focusChat]);

  // Keep the highlighted row in view without scrolling the page.
  useLayoutEffect(() => {
    if (!activeItem) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-item-key="${CSS.escape(activeItem.key)}"]`,
    );
    element?.scrollIntoView({ block: "nearest" });
  }, [activeItem]);

  const enterChat = useCallback((record: ChatRecord) => {
    setFocusChat(record);
    setQuery("");
    inputRef.current?.focus();
  }, []);
  const leaveChat = useCallback(() => {
    setFocusChat(null);
    setQuery("");
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing) return;
      const count = items.length;
      const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp": {
          if (event.altKey || mod) break;
          event.preventDefault();
          if (count === 0) return;
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((current) => (Math.min(current, count - 1) + step + count) % count);
          return;
        }
        case "PageDown":
        case "PageUp": {
          event.preventDefault();
          if (count === 0) return;
          const step = event.key === "PageDown" ? 5 : -5;
          setActive((current) => Math.max(0, Math.min(count - 1, current + step)));
          return;
        }
        case "Home":
        case "End": {
          // Inside the field these move the caret, unless the field is empty.
          if (query) break;
          event.preventDefault();
          setActive(event.key === "Home" ? 0 : Math.max(0, count - 1));
          return;
        }
        case "Enter": {
          event.preventDefault();
          activeItem?.run({ newTab: mod });
          return;
        }
        case "Tab": {
          event.preventDefault();
          if (event.shiftKey) {
            if (focusChat) leaveChat();
            return;
          }
          if (!focusChat && activeItem?.chat) enterChat(activeItem.chat);
          return;
        }
        case "Backspace": {
          if (focusChat && !query) {
            event.preventDefault();
            leaveChat();
          }
          return;
        }
        default:
          break;
      }
      // A chat action's chord acts on the highlighted chat, as in Linear.
      const chatRecord = focusChat ?? activeItem?.chat;
      if (!chatRecord) return;
      for (const action of APP_ACTIONS) {
        if (!action.forChat) continue;
        const chord = chordsFor(action).find((candidate) =>
          matchesChord(event.nativeEvent, candidate, platform),
        );
        if (!chord) continue;
        const row =
          chatRecord.row ??
          (env.currentChat?.id === chatRecord.id ? env.currentChat : null) ??
          (action.id === "chat.copyLink" ? pseudoRow(chatRecord) : null);
        event.preventDefault();
        event.stopPropagation();
        if (row && action.available(env, row)) runAction(action, row, chord);
        return;
      }
    },
    [
      activeItem,
      chordsFor,
      enterChat,
      env,
      focusChat,
      items.length,
      leaveChat,
      platform,
      query,
      runAction,
    ],
  );

  const placeholder = focusChat ? "Search actions…" : "Search chats or run an action…";
  const optionId = (item: Item) => `${listId}-${item.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <DialogPrimitive.Root open={props.open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/25 dark:bg-black/45" />
        <DialogPrimitive.Content
          data-og-command-menu=""
          aria-label="Command menu"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // An action moves focus where it belongs (the new chat's composer,
            // the title being renamed); only a plain close returns focus.
            if (ranAction.current) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // Esc steps back out of a chat's actions before it closes the menu.
            if (!focusChat) return;
            event.preventDefault();
            leaveChat();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "fixed top-[12dvh] left-1/2 z-50 flex max-h-[min(560px,76dvh)] w-[calc(100vw-1.5rem)] max-w-[640px] -translate-x-1/2 flex-col overflow-hidden",
            "rounded-2xl border border-border bg-surface text-fg shadow-og-lg outline-hidden",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98",
            "duration-[120ms] max-sm:top-3",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <div className="flex min-h-13 shrink-0 items-center gap-2.5 border-b border-border px-4">
            <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            {focusChat ? (
              <button
                type="button"
                onClick={leaveChat}
                title="Back to all results"
                className="inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-full bg-hover py-0.5 pr-1.5 pl-2.5 text-xs font-medium text-fg outline-hidden hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring/55"
              >
                <span className="truncate">{focusChat.title}</span>
                <ChevronRightIcon aria-hidden="true" className="size-3.5 text-fg-muted" />
              </button>
            ) : null}
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
              aria-label={focusChat ? `Actions for ${focusChat.title}` : "Search chats and actions"}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              maxLength={200}
              placeholder={placeholder}
              onChange={(event) => setQuery(event.target.value)}
              className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-hidden placeholder:text-fg-subtle"
            />
            {searching ? (
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-fg-subtle/40 border-t-fg-muted"
              />
            ) : null}
          </div>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={focusChat ? "Chat actions" : "Results"}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
          >
            {items.length === 0 ? (
              <p className="px-2.5 py-6 text-center text-sm text-fg-muted">
                {searching ? "Searching…" : "No matches"}
              </p>
            ) : (
              groups.map((group) =>
                group.items.length === 0 ? null : (
                  <div key={group.label} role="group" aria-label={group.label}>
                    {groups.length > 1 || !focusChat ? (
                      <div className="truncate px-2.5 pt-2 pb-1 text-xs leading-4.5 font-medium text-fg-muted">
                        {group.label}
                      </div>
                    ) : null}
                    {group.items.map((item) => {
                      const index = items.indexOf(item);
                      const selected = index === activeIndex;
                      const Icon = item.icon;
                      return (
                        <div
                          key={item.key}
                          id={optionId(item)}
                          data-item-key={item.key}
                          role="option"
                          aria-selected={selected}
                          onPointerMove={() => {
                            if (!selected) setActive(index);
                          }}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={(event) =>
                            item.run({ newTab: platform === "mac" ? event.metaKey : event.ctrlKey })
                          }
                          className={cn(
                            "relative flex min-h-9 w-full min-w-0 cursor-default items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-sm text-fg-label select-none pointer-coarse:min-h-11",
                            selected ? "bg-hover text-fg" : null,
                          )}
                        >
                          <Icon
                            aria-hidden="true"
                            className={cn(
                              "size-4 shrink-0",
                              selected ? "text-fg" : "text-fg-muted",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            <Highlighted text={item.title} query={item.highlight} />
                          </span>
                          {item.meta ? (
                            <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                              {item.meta}
                            </span>
                          ) : null}
                          {item.chord ? <Keycaps chord={item.chord} platform={platform} /> : null}
                        </div>
                      );
                    })}
                  </div>
                ),
              )
            )}
          </div>
          <div className="hidden shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-xs text-fg-muted pointer-fine:flex">
            <FooterHint
              keys={[{ code: "ArrowUp" }, { code: "ArrowDown" }]}
              label="Move"
              platform={platform}
            />
            <FooterHint keys={[{ code: "Enter" }]} label="Open" platform={platform} />
            {focusChat ? (
              <FooterHint keys={[{ code: "Escape" }]} label="Back" platform={platform} />
            ) : (
              <FooterHint keys={[{ code: "Tab" }]} label="Chat actions" platform={platform} />
            )}
            {surface === "web" && !focusChat ? (
              <FooterHint
                keys={[{ code: "Enter", mod: true }]}
                label="New tab"
                platform={platform}
              />
            ) : null}
            <span className="ml-auto inline-flex items-center gap-1.5">
              <Keycaps chord={{ code: "Slash", mod: true }} platform={platform} />
              All shortcuts
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

function FooterHint(props: { keys: Chord[]; label: string; platform: ActionEnv["platform"] }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5">
        {props.keys.map((chord) => (
          <Keycaps key={chord.code} chord={chord} platform={props.platform} />
        ))}
      </span>
      {props.label}
    </span>
  );
}

/** Enough of a chat row to copy its link when only a recent-chats record is known. */
function pseudoRow(record: ChatRecord): SessionListRow {
  return { id: record.id, workspaceId: record.workspaceId } as SessionListRow;
}
