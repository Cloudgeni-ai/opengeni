/**
 * Runs the action registry for one workspace: builds what actions need, owns
 * the ⌘K menu and the shortcut sheet, listens for chords, keeps the recent
 * chats list, and hands the desktop shell its menu bar.
 */
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionListRow } from "../../../session-list-model";
import { useAppContext } from "../../app-context";
import { useRail } from "../../components/rail/rail-context";
import { requestConversationFind } from "../conversation-find-event";
import { desktopBridge, desktopCapability } from "../desktop";
import { useNavigate, useRouterState } from "../navigation";
import { requestSessionSearch } from "../session-search-route";
import { useSessionUiFeature } from "../session-ui-features";
import { useUiEventTarget } from "../ui-events";
import { readChatDirectory, recordChatVisit } from "./chat-directory";
import {
  isSwitcherKey,
  openChatSwitcher,
  stepChatSwitcher,
  SWITCHER_SHOW_DELAY_MS,
  type ChatSwitcherState,
} from "./chat-switcher";
import {
  applicableChords,
  chordAccelerator,
  chordAriaKeys,
  chordLabel,
  currentPlatform,
  isTextEntry,
  matchesChord,
  type ActionSurface,
  type Chord,
  type ChordPlatform,
} from "./chords";
import { useChatOperations } from "./chat-operations";
import { OPEN_COMMAND_MENU_EVENT, RENAME_CURRENT_CHAT_EVENT } from "./events";
import { APP_ACTIONS, actionTitle, findAction, type ActionEnv, type AppAction } from "./registry";

const CommandMenu = lazy(() => import("../../components/command-menu/command-menu"));
const ShortcutSheet = lazy(() => import("../../components/command-menu/shortcut-sheet"));
const loadChatSwitcher = () => import("../../components/command-menu/chat-switcher");
const ChatSwitcher = lazy(loadChatSwitcher);

type ActionsContextValue = {
  env: ActionEnv;
  /** Run an action for a chat (row menus) or the current chat. */
  run(action: AppAction, chat?: SessionListRow | null, chord?: Chord): void;
  /** The chords to show for an action on this surface and platform. */
  chordsFor(action: AppAction): Chord[];
};

const ActionsContext = createContext<ActionsContextValue | null>(null);

export function useAppActions(): ActionsContextValue | null {
  return useContext(ActionsContext);
}

/**
 * An action's key for tooltips, labels and `aria-keyshortcuts`, in the
 * person's notation; nothing when this surface has no page-wide keys.
 */
export function useActionShortcut(
  actionId: string,
): { label: string; ariaKeys: string; chord: Chord } | null {
  // Keys depend only on the surface and platform, so rows need not re-render
  // when the actions' environment changes.
  const enabled = useSessionUiFeature("keyboardShortcuts");
  const action = findAction(actionId);
  if (!enabled || !action) return null;
  const platform = currentPlatform();
  const chords = applicableChords(action.chords, surface, platform);
  const chord = chords[0];
  if (!chord) return null;
  return {
    label: chordLabel(chord, platform),
    ariaKeys: chords.map((candidate) => chordAriaKeys(candidate, platform)).join(" "),
    chord,
  };
}

const surface: ActionSurface = desktopBridge ? "desktop" : "web";

function isRichTextEditor(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.isContentEditable;
}

function insideOtherOverlay(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const overlay = target.closest(
    '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
  );
  return Boolean(overlay && !overlay.closest("[data-og-command-menu],[data-og-shortcut-sheet]"));
}

/** The chord the desktop menu bar shows and owns for an action. */
function menuOwnedChord(action: AppAction, platform: ChordPlatform): Chord | undefined {
  // ⌥ chords stay with the page: a menu would take ⌥↑ from the composer's caret.
  // Formatting keys stay with the page too, so ⌘B can still bold rich text.
  return applicableChords(action.chords, "desktop", platform).find(
    (chord) => (!chord.alt || chord.mod) && !chord.formatting,
  );
}

function menuChord(action: AppAction, platform: ChordPlatform): string | null {
  const chord = menuOwnedChord(action, platform);
  return chord ? chordAccelerator(chord) : null;
}

function insideCommandMenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-og-command-menu]"));
}

function textEntryIsEmpty(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return target.value.length === 0;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return (target.textContent ?? "").length === 0;
  }
  return true;
}

export function ActionsProvider(props: { children: ReactNode }) {
  const app = useAppContext();
  const rail = useRail();
  const navigate = useNavigate();
  const ops = useChatOperations();
  const uiEvents = useUiEventTarget("document");
  const windowEvents = useUiEventTarget("window");
  const chatList = useSessionUiFeature("chatList");
  const workspacePanel = useSessionUiFeature("dock");
  const { inspectorOpen, setInspectorOpen } = app;
  const keyboardShortcuts = useSessionUiFeature("keyboardShortcuts");
  const platform = useMemo(() => currentPlatform(), []);
  const workspaceId = rail.workspaceId;
  const subjectId = app.accessContext.subjectId;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routeChatId = /\/sessions\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const currentChat =
    app.session && app.session.id === routeChatId && app.session.workspaceId === workspaceId
      ? app.session
      : null;

  const [menu, setMenu] = useState<{
    open: boolean;
    mounted: boolean;
    chat: SessionListRow | null;
  }>({ open: false, mounted: false, chat: null });
  const [sheet, setSheet] = useState({ open: false, mounted: false });

  const railRef = useRef(rail);
  railRef.current = rail;
  // What had focus when the menu or sheet opened. They open from a key or a
  // button anywhere (and load lazily the first time), so they return focus
  // there themselves instead of relying on what the dialog saw when it mounted.
  const returnFocus = useRef<HTMLElement | null>(null);
  const menuOpen = useRef(false);
  const sheetOpen = useRef(false);
  menuOpen.current = menu.open;
  sheetOpen.current = sheet.open;
  const rememberFocus = useCallback(() => {
    if (menuOpen.current || sheetOpen.current || typeof document === "undefined") return;
    // Opened from inside the phone drawer, which closes: come back to the
    // drawer's persistent opener, as search does.
    const drawerTrigger = railRef.current.drawerOpen
      ? railRef.current.drawerTriggerRef.current
      : null;
    if (drawerTrigger) {
      returnFocus.current = drawerTrigger;
      return;
    }
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);
  const openCommandMenu = useCallback(() => {
    rememberFocus();
    setSheet((current) => (current.open ? { ...current, open: false } : current));
    // The phone drawer is a modal of its own; the menu replaces it and returns
    // focus itself, so the retiring drawer must not take focus back.
    railRef.current.handOffDrawer();
    setMenu((current) => ({ open: !current.open, mounted: true, chat: null }));
  }, [rememberFocus]);
  const openShortcutSheet = useCallback(() => {
    rememberFocus();
    setMenu((current) => (current.open ? { ...current, open: false } : current));
    setSheet((current) => ({ open: !current.open, mounted: true }));
  }, [rememberFocus]);

  // Recent chats follow what is actually opened, in any way.
  useEffect(() => {
    if (currentChat) recordChatVisit(subjectId, workspaceId, currentChat);
    // Title and pin changes refresh the record without reordering.
  }, [currentChat?.id, subjectId, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const env = useMemo<ActionEnv>(
    () => ({
      workspaceId,
      subjectId,
      surface,
      platform,
      currentChat,
      ops,
      chatList,
      workspacePanel,
      newChat: () => rail.startNewSession(),
      openChat: (chatId) => rail.openSession(chatId),
      openInbox: () => {
        rail.setDrawerOpen(false);
        void navigate({ to: "/workspaces/$workspaceId/inbox", params: { workspaceId } });
      },
      toggleSidebar: () =>
        rail.isMobile ? rail.setDrawerOpen(!rail.drawerOpen) : rail.toggleCollapsed(),
      toggleWorkspacePanel: () => {
        if (!inspectorOpen && rail.isMobile) rail.setDrawerOpen(false);
        setInspectorOpen((open) => !open);
      },
      findInChat: () => requestConversationFind(uiEvents),
      searchMessages: (query) => requestSessionSearch(windowEvents, workspaceId, undefined, query),
      renameCurrentChat: () => uiEvents.dispatchEvent(new Event(RENAME_CURRENT_CHAT_EVENT)),
      openCommandMenu,
      openShortcutSheet,
      switchToRecentChat: () => {
        const target = openChatSwitcher(
          readChatDirectory(subjectId, workspaceId),
          routeChatId,
          false,
        );
        const id = target?.ids[target.index];
        if (id) rail.openSession(id);
      },
      sidebarOrder: () => readChatDirectory(subjectId, workspaceId).sidebarOrder,
      pinnedOrder: () => readChatDirectory(subjectId, workspaceId).pinnedOrder,
    }),
    [
      workspaceId,
      subjectId,
      platform,
      currentChat,
      routeChatId,
      ops,
      chatList,
      workspacePanel,
      inspectorOpen,
      setInspectorOpen,
      rail,
      navigate,
      uiEvents,
      windowEvents,
      openCommandMenu,
      openShortcutSheet,
    ],
  );
  const envRef = useRef(env);
  envRef.current = env;

  const chordsFor = useCallback(
    (action: AppAction) => applicableChords(action.chords, surface, platform),
    [platform],
  );

  const run = useCallback((action: AppAction, chat?: SessionListRow | null, chord?: Chord) => {
    const current = envRef.current;
    // Any other action replaces the open menu or sheet.
    if (action.id !== "commandMenu.open") {
      setMenu((state) => (state.open ? { ...state, open: false } : state));
    }
    if (action.id !== "help.shortcuts") {
      setSheet((state) => (state.open ? { ...state, open: false } : state));
    }
    const target = chat === undefined ? current.currentChat : chat;
    if (!action.available(current, action.forChat ? target : null)) return;
    void Promise.resolve(action.run(current, action.forChat ? target : null, chord)).catch(() => {
      // Each operation reports its own failure.
    });
  }, []);

  // The desktop menu bar shows the registry's actions and owns their keys.
  const menuBridge = desktopCapability("menuActions")?.menuActions ?? null;
  const menuSignature = useMemo(() => {
    if (!menuBridge) return "";
    return JSON.stringify(
      APP_ACTIONS.filter((action) => action.desktopMenu).map((action) => {
        const chat = action.forChat ? env.currentChat : null;
        return {
          id: action.id,
          label: actionTitle(action, env, chat),
          section: action.desktopMenu!,
          accelerator: menuChord(action, platform),
          enabled: action.available(env, chat),
        };
      }),
    );
  }, [menuBridge, env, platform]);
  useEffect(() => {
    if (!menuBridge || !menuSignature) return;
    menuBridge.set(JSON.parse(menuSignature));
  }, [menuBridge, menuSignature]);
  useEffect(() => {
    if (!menuBridge) return;
    return menuBridge.onAction((id) => {
      const action = findAction(id);
      if (action) run(action);
    });
  }, [menuBridge, run]);

  // Older desktop builds and other parts of the page open the menu by event.
  useEffect(() => {
    const open = () => openCommandMenu();
    windowEvents.addEventListener(OPEN_COMMAND_MENU_EVENT, open);
    return () => windowEvents.removeEventListener(OPEN_COMMAND_MENU_EVENT, open);
  }, [windowEvents, openCommandMenu]);

  useEffect(() => {
    if (!keyboardShortcuts) return;
    const menuOwnsKeys = Boolean(menuBridge);
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const current = envRef.current;
      for (const action of APP_ACTIONS) {
        // ⌘F belongs to the conversation's own find bar.
        if (action.id === "chat.find") continue;
        // The chat switcher handles Control+Tab itself: it needs Control's release.
        if (action.id === "go.recentChat") continue;
        const chord = applicableChords(action.chords, surface, platform).find((candidate) =>
          matchesChord(event, candidate, platform),
        );
        if (!chord) continue;
        // The menu bar delivers the key it shows; the page keeps the others.
        if (menuOwnsKeys && action.desktopMenu && chord === menuOwnedChord(action, platform))
          return;
        const toggleMenu = action.id === "commandMenu.open";
        // Inside the ⌘K menu, chat chords act on the highlighted chat; the menu handles them.
        if (action.forChat && insideCommandMenu(event.target)) return;
        if (!toggleMenu && insideOtherOverlay(event.target)) return;
        // Rich-text editors keep their formatting keys.
        if (chord.formatting && isRichTextEditor(event.target)) return;
        // Chords without ⌘/Ctrl leave text editing alone unless the field is empty.
        if (!chord.mod && isTextEntry(event.target) && !textEntryIsEmpty(event.target)) return;
        if (!action.available(current, action.forChat ? current.currentChat : null)) return;
        event.preventDefault();
        event.stopPropagation();
        run(action, undefined, chord);
        return;
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [keyboardShortcuts, menuBridge, platform, run]);

  // Control+Tab: the recent-chats switcher (desktop app only; browsers keep the key).
  const [switcher, setSwitcherState] = useState<ChatSwitcherState | null>(null);
  const switcherRef = useRef<ChatSwitcherState | null>(null);
  const setSwitcher = useCallback((next: ChatSwitcherState | null) => {
    switcherRef.current = next;
    setSwitcherState(next);
  }, []);
  const routeChatIdRef = useRef(routeChatId);
  routeChatIdRef.current = routeChatId;
  const switcherEnabled = keyboardShortcuts && chatList && surface === "desktop";
  const pickSwitcherChat = useCallback(
    (index?: number) => {
      const state = switcherRef.current;
      if (!state) return;
      const id = state.ids[index ?? state.index];
      setSwitcher(null);
      if (id && id !== routeChatIdRef.current) envRef.current.openChat(id);
    },
    [setSwitcher],
  );
  useEffect(() => {
    if (!switcherEnabled) {
      setSwitcher(null);
      return;
    }
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(showTimer);
      if (switcherRef.current) setSwitcher(null);
    };
    function onKeyDown(event: KeyboardEvent) {
      const state = switcherRef.current;
      if (isSwitcherKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (state) {
          clearTimeout(showTimer);
          setSwitcher(stepChatSwitcher(state, event.shiftKey ? -1 : 1));
          return;
        }
        // Not over the ⌘K menu, the shortcut sheet or another dialog.
        if (event.repeat || menuOpen.current || sheetOpen.current) return;
        if (insideOtherOverlay(event.target)) return;
        const opened = openChatSwitcher(
          readChatDirectory(subjectId, workspaceId),
          routeChatIdRef.current,
          event.shiftKey,
        );
        if (!opened) return;
        void loadChatSwitcher();
        setSwitcher(opened);
        // A quick press switches without drawing the list at all.
        showTimer = setTimeout(() => {
          const current = switcherRef.current;
          if (current && !current.visible) setSwitcher({ ...current, visible: true });
        }, SWITCHER_SHOW_DELAY_MS);
        return;
      }
      if (!state) return;
      // Control was let go somewhere the page did not hear it.
      if (!event.ctrlKey && event.key !== "Control") {
        cancel();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(showTimer);
        pickSwitcherChat();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(showTimer);
        setSwitcher(stepChatSwitcher(state, event.key === "ArrowDown" ? 1 : -1));
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "Control" || !switcherRef.current) return;
      clearTimeout(showTimer);
      pickSwitcherChat();
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancel);
    return () => {
      clearTimeout(showTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancel);
    };
  }, [switcherEnabled, subjectId, workspaceId, pickSwitcherChat, setSwitcher]);

  const value = useMemo<ActionsContextValue>(
    () => ({ env, run, chordsFor }),
    [env, run, chordsFor],
  );

  return (
    <ActionsContext.Provider value={value}>
      {props.children}
      {menu.mounted ? (
        <Suspense fallback={null}>
          <CommandMenu
            open={menu.open}
            onOpenChange={(open) => setMenu((current) => ({ ...current, open }))}
            returnFocus={returnFocus}
          />
        </Suspense>
      ) : null}
      {sheet.mounted ? (
        <Suspense fallback={null}>
          <ShortcutSheet
            open={sheet.open}
            onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
            returnFocus={returnFocus}
          />
        </Suspense>
      ) : null}
      {switcher?.visible ? (
        <Suspense fallback={null}>
          <ChatSwitcher
            state={switcher}
            subjectId={subjectId}
            workspaceId={workspaceId}
            currentChatId={routeChatId}
            platform={platform}
            onHover={(index) => {
              const current = switcherRef.current;
              if (current) setSwitcher({ ...current, index });
            }}
            onPick={pickSwitcherChat}
            onDismiss={() => setSwitcher(null)}
          />
        </Suspense>
      ) : null}
    </ActionsContext.Provider>
  );
}
