/**
 * The ⌘K menu: find a chat or a Site by its title, or run any action, from
 * one field.
 *
 * It opens instantly from what the app already knows (chats and Sites the
 * sidebar has loaded and the chats opened recently) and merges the server's
 * title searches as they arrive. Chats in the person's other workspaces show too, tagged with
 * their workspace, and so do workspaces to switch to. Tab on a chat shows that
 * chat's actions; the chords of chat actions work on the highlighted chat
 * while the menu is open.
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
  type RefObject,
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  LockIcon,
  MessageSquareIcon,
  PanelsTopLeftIcon,
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
import {
  readSidebarSites,
  siteRecords,
  useSiteDirectoryVersion,
  type SiteRecord,
} from "../../lib/actions/site-directory";
import { rankSites, recentSites } from "../../lib/actions/site-rank";
import { useAppActions } from "../../lib/actions/actions-provider";
import {
  foldForSearch,
  LOOSE_MATCH_BELOW,
  rankLabel,
  rankWithKeywords,
} from "../../lib/actions/rank";
import {
  appActions,
  actionIcon,
  actionTitle,
  type ActionEnv,
  type AppAction,
  type WorkspaceChoice,
} from "../../lib/actions/registry";
import { cn } from "../../lib/utils";
import { DialogOverlay, DialogPortal } from "../../../ui/dialog";
import { formatRelativeTime } from "../../../ui/relative-time";
import { Keycaps } from "./keycaps";
import { WorkspaceTag } from "./workspace-tag";
import { ChatStatusMarks, useChatStatusRefresh } from "./chat-status";
import { currentChatStatus, type ChatStatus } from "../../lib/actions/chat-status";

type Item = {
  key: string;
  group: string;
  icon: LucideIcon;
  /** A workspace's initial, drawn as the workspace picker draws it, instead of the icon. */
  tile?: string | undefined;
  title: string;
  /** Text to mark as matched in the title. */
  highlight?: string | undefined;
  /** Quiet text on the right (when, "Archived"). */
  meta?: string | undefined;
  /** The workspace a chat lives in, when it is not the one on screen. */
  workspaceTag?: string | undefined;
  chord?: Chord | undefined;
  /** Present on chat rows: Tab opens their actions, chat chords act on them. */
  chat?: ChatRecord | undefined;
  /** The chat's sidebar status marks, while its status is known to be current. */
  status?: ChatStatus | null | undefined;
  run(options: { newTab: boolean }): void;
};

type Group = { label: string; items: Item[]; best: number };

const RECENT_LIMIT = 6;
const CHAT_RESULT_LIMIT = 8;
const ACTION_RESULT_LIMIT = 6;
const WORKSPACE_RESULT_LIMIT = 4;
const SITE_RESULT_LIMIT = 5;
/** Sites before anything is typed: a few recent ones, never the whole list. */
const RECENT_SITE_LIMIT = 3;
/** Sites the server title search returns per query. */
const SERVER_SITE_LIMIT = 10;
/** Shorter queries match only the Sites the sidebar has loaded. */
const MIN_SERVER_SITE_QUERY = 2;
const NO_SITES: readonly SiteRecord[] = [];
const SERVER_DEBOUNCE_MS = 120;
/** Other workspaces whose titles the server searches too, most used first. */
const OTHER_WORKSPACES_SEARCHED = 9;
/** A chat in another workspace ranks just below an equal match here. */
const ELSEWHERE_PENALTY = 10;

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

/**
 * The server's title search: this workspace, and the person's other workspaces
 * they use most, side by side. Each workspace's matches join the list as they
 * arrive.
 */
function useServerTitleSearch(
  workspaceIds: readonly string[],
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
  const searchKey = workspaceIds.join(",");
  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !trimmed || !searchKey) {
      setState({ query: "", rows: [], loading: false });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const targets = searchKey.split(",");
      let pending = targets.length;
      let first = true;
      const settle = (rows: SessionListRow[]) => {
        if (controller.signal.aborted) return;
        pending -= 1;
        const replace = first;
        first = false;
        setState((current) => ({
          query: trimmed,
          rows: replace || current.query !== trimmed ? rows : [...current.rows, ...rows],
          loading: pending > 0,
        }));
      };
      targets.forEach((workspaceId, index) => {
        client
          .listSessionPage(workspaceId, {
            search: trimmed,
            archiveStatus: "all",
            // This workspace first and fullest; a few from each of the others.
            limit: index === 0 ? 20 : 6,
            signal: controller.signal,
          })
          .then((page) => {
            const rows = [...(page.pinned ?? []), ...page.sessions];
            rememberChats(subjectId, rows);
            settle(rows);
          })
          .catch(() => {
            // Local results still show; the server search is an addition.
            settle([]);
          });
      });
    }, SERVER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, searchKey, subjectId, query, open]);
  return state;
}

function isAccessFailure(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status: unknown }).status
      : null;
  return status === 401 || status === 403;
}

/**
 * The server's Site title search in this workspace: the artifact catalog's
 * Sites, with its access checks (Only me Sites of other people never show).
 * A failure leaves the rest of the menu as it is; a workspace that refuses
 * access is not asked again until the menu opens next.
 */
function useServerSiteSearch(workspaceId: string, query: string, open: boolean) {
  const { client } = useAppContext();
  const [state, setState] = useState<{
    key: string;
    workspaceId: string;
    sites: readonly SiteRecord[];
    loading: boolean;
  }>({
    key: "",
    workspaceId: "",
    sites: NO_SITES,
    loading: false,
  });
  const denied = useRef<string | null>(null);
  useEffect(() => {
    if (!open) denied.current = null;
  }, [open]);
  const trimmed = query.trim();
  const key = JSON.stringify([workspaceId, trimmed]);
  useEffect(() => {
    if (
      !open ||
      // One letter would scan the whole catalog on every keystroke; the Sites
      // the sidebar has loaded still match it locally.
      trimmed.length < MIN_SERVER_SITE_QUERY ||
      !workspaceId ||
      denied.current === workspaceId ||
      typeof client.listArtifactCatalog !== "function"
    ) {
      setState((current) =>
        current.loading || current.sites.length > 0
          ? { key: "", workspaceId: "", sites: NO_SITES, loading: false }
          : current,
      );
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() =>
          client.listArtifactCatalog(workspaceId, {
            kind: "site",
            q: trimmed,
            status: "active",
            sort: "updated",
            limit: SERVER_SITE_LIMIT,
            signal: controller.signal,
          }),
        )
        .then((page) => {
          if (controller.signal.aborted) return;
          const items = Array.isArray(page?.items) ? page.items : [];
          setState({
            key,
            workspaceId,
            sites: siteRecords(
              workspaceId,
              items.filter((item) => item?.kind === "site"),
            ),
            loading: false,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (isAccessFailure(error)) denied.current = workspaceId;
          // Chats and actions still show; Sites are an addition.
          setState({ key, workspaceId, sites: NO_SITES, loading: false });
        });
    }, SERVER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, workspaceId, trimmed, key, open]);
  const current = state.key === key;
  return {
    sites: current ? state.sites : NO_SITES,
    // While the next answer loads, the last one's Sites stay candidates (by
    // their title alone), so a Site does not blink out on every keystroke.
    previous: !current && state.workspaceId === workspaceId ? state.sites : NO_SITES,
    loading: state.loading,
  };
}

export default function CommandMenu(props: {
  open: boolean;
  /** Opens listing workspaces to switch to. */
  pickWorkspace: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes back to after a plain close. */
  returnFocus: RefObject<HTMLElement | null>;
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
  pickWorkspace: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
  env: ActionEnv;
  run(action: AppAction, chat?: SessionListRow | null, chord?: Chord): void;
  chordsFor(action: AppAction): Chord[];
}) {
  const { env, run, chordsFor, onOpenChange } = props;
  const { workspaceId, subjectId, platform, surface, workspaces } = env;
  const directoryVersion = useChatDirectoryVersion(subjectId);
  const siteDirectoryVersion = useSiteDirectoryVersion(subjectId);
  const [query, setQuery] = useState("");
  const [focusChat, setFocusChat] = useState<ChatRecord | null>(null);
  const [pickingWorkspace, setPickingWorkspace] = useState(props.pickWorkspace);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ranAction = useRef(false);
  /** Runs right after the menu has returned focus (see `AppAction.opensDialog`). */
  const afterClose = useRef<(() => void) | null>(null);
  const listId = useId();
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  /** Chats the menu may show: this workspace's, and those of other workspaces still open to the person. */
  const reachable = useCallback(
    (id: string) => id === workspaceId || workspaceNames.has(id),
    [workspaceId, workspaceNames],
  );
  // The server searches this workspace and the other workspaces used most recently.
  const searchWorkspaceIds = useMemo(() => {
    void directoryVersion;
    const directory = readChatDirectory(subjectId, workspaceId);
    const used: string[] = [];
    for (const id of directory.recent) {
      const record = directory.rows.get(id);
      if (record && !used.includes(record.workspaceId)) used.push(record.workspaceId);
    }
    const others = [...used, ...workspaces.map((workspace) => workspace.id)].filter(
      (id, index, all) => id !== workspaceId && reachable(id) && all.indexOf(id) === index,
    );
    return [workspaceId, ...others.slice(0, OTHER_WORKSPACES_SEARCHED)];
    // Which workspaces to search changes only when the menu opens.
  }, [props.open, subjectId, workspaceId, workspaces, reachable]); // eslint-disable-line react-hooks/exhaustive-deps
  const server = useServerTitleSearch(
    searchWorkspaceIds,
    subjectId,
    focusChat || pickingWorkspace ? "" : query,
    props.open,
  );
  const serverSites = useServerSiteSearch(
    workspaceId,
    focusChat || pickingWorkspace ? "" : query,
    props.open,
  );

  // Every open starts fresh.
  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setFocusChat(null);
    setPickingWorkspace(props.pickWorkspace);
    setActive(0);
    ranAction.current = false;
    afterClose.current = null;
  }, [props.open, props.pickWorkspace]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const runAction = useCallback(
    (action: AppAction, chat: SessionListRow | null, chord?: Chord) => {
      if (action.opensDialog) {
        afterClose.current = () => run(action, action.forChat ? chat : undefined, chord);
        close();
        return;
      }
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
      env.openChat(record.id, record.workspaceId);
    },
    [close, env, surface],
  );

  const openSite = useCallback(
    (site: SiteRecord, newTab: boolean) => {
      ranAction.current = true;
      close();
      if (newTab && surface === "web") {
        window.open(env.siteLink(site.id), "_blank", "noopener");
        return;
      }
      env.openSite(site.id);
    },
    [close, env, surface],
  );

  const openWorkspace = useCallback(
    (id: string) => {
      ranAction.current = true;
      close();
      if (id !== workspaceId) env.openWorkspace(id);
    },
    [close, env, workspaceId],
  );

  const startPickingWorkspace = useCallback(() => {
    setFocusChat(null);
    setPickingWorkspace(true);
    setQuery("");
    inputRef.current?.focus();
  }, []);

  const actionItem = useCallback(
    (action: AppAction, chat: SessionListRow | null, group: string, highlight?: string): Item => ({
      key: `action:${action.id}`,
      group,
      icon: actionIcon(action, chat),
      title: actionTitle(action, env, chat),
      highlight,
      chord: chordsFor(action)[0],
      // Switching workspace lists the workspaces right here.
      run: () =>
        action.id === "go.switchWorkspace" ? startPickingWorkspace() : runAction(action, chat),
    }),
    [chordsFor, env, runAction, startPickingWorkspace],
  );

  const groups = useMemo<Group[]>(() => {
    void directoryVersion;
    void siteDirectoryVersion;
    const now = Date.now();
    const directory = readChatDirectory(subjectId, workspaceId);
    const knownSites = readSidebarSites(subjectId, workspaceId);
    const current = env.currentChat;
    const sidebarIds = new Set([...directory.sidebarOrder, ...directory.pinnedOrder]);

    const chatItem = (record: ChatRecord, group: string, highlight?: string): Item => ({
      key: `chat:${record.id}`,
      group,
      icon: chatIcon(record),
      title: record.title,
      highlight,
      meta: current?.id === record.id ? "Open now" : relativeMeta(record, now),
      workspaceTag:
        record.workspaceId === workspaceId ? undefined : workspaceNames.get(record.workspaceId),
      chat: record,
      status: currentChatStatus(record, sidebarIds, now),
      run: ({ newTab }) => openChat(record, newTab),
    });

    const siteItem = (site: SiteRecord, group: string, highlight?: string): Item => ({
      key: `site:${site.id}`,
      group,
      icon: PanelsTopLeftIcon,
      title: site.title,
      highlight,
      meta:
        env.currentSiteId === site.id
          ? "Open now"
          : site.updatedAt
            ? formatRelativeTime(site.updatedAt, { now })
            : undefined,
      run: ({ newTab }) => openSite(site, newTab),
    });

    const workspaceItem = (choice: WorkspaceChoice, group: string, highlight?: string): Item => ({
      key: `workspace:${choice.id}`,
      group,
      icon: LockIcon,
      // A Personal workspace shows its lock, as in the workspace picker.
      tile: choice.personal ? undefined : (choice.name.trim()[0] ?? "W").toUpperCase(),
      title: choice.name,
      highlight,
      meta: choice.id === workspaceId ? "Current" : undefined,
      run: () => openWorkspace(choice.id),
    });

    // Workspaces to switch to, by organization.
    if (pickingWorkspace) {
      const trimmed = query.trim();
      const organizations = new Set(workspaces.map((choice) => choice.organization));
      const scored = workspaces.flatMap((choice) => {
        if (!trimmed) return [{ choice, rank: 0 }];
        const rank =
          rankLabel(choice.name, trimmed) ??
          (organizations.size > 1 ? rankLabel(choice.organization, trimmed) : null);
        return rank === null ? [] : [{ choice, rank }];
      });
      const realMatch = scored.some((entry) => entry.rank >= LOOSE_MATCH_BELOW);
      const kept = scored.filter(
        (entry) => !trimmed || !realMatch || entry.rank >= LOOSE_MATCH_BELOW,
      );
      if (trimmed) {
        kept.sort((a, b) => b.rank - a.rank);
        return [
          {
            label: "Workspaces",
            items: kept.map((entry) => workspaceItem(entry.choice, "Workspaces", trimmed)),
            best: 0,
          },
        ];
      }
      const byOrganization = new Map<string, Item[]>();
      for (const { choice } of kept) {
        const label = organizations.size > 1 ? choice.organization : "Workspaces";
        const list = byOrganization.get(label) ?? [];
        list.push(workspaceItem(choice, label));
        byOrganization.set(label, list);
      }
      return [...byOrganization].map(([label, items]) => ({ label, items, best: 0 }));
    }

    // A chat's own actions (after Tab).
    if (focusChat) {
      // Chats in other workspaces offer what works from here: open and copy link.
      const sameWorkspace = focusChat.workspaceId === workspaceId;
      const row = sameWorkspace
        ? (focusChat.row ?? (current?.id === focusChat.id ? current : null))
        : null;
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
      for (const action of appActions()) {
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
      // Chats opened recently come first; the top of the sidebar fills the
      // rest, so a fresh window still offers somewhere to go.
      const recentIds = [...new Set([...directory.recent, ...directory.sidebarOrder])].filter(
        (id) => id !== current?.id,
      );
      const recent = recentIds
        .map((id) => directory.rows.get(id))
        .filter((record): record is ChatRecord =>
          Boolean(record && listable(record) && !record.archived && reachable(record.workspaceId)),
        )
        .slice(0, RECENT_LIMIT);
      if (recent.length > 0) {
        result.push({
          label: "Recent chats",
          items: recent.map((record) => chatItem(record, "Recent chats")),
          best: 0,
        });
      }
      const sites = recentSites(knownSites, env.currentSiteId, RECENT_SITE_LIMIT);
      if (sites.length > 0) {
        result.push({
          label: "Recent Sites",
          items: sites.map((site) => siteItem(site, "Recent Sites")),
          best: 0,
        });
      }
      if (current) {
        const chatActions = appActions().filter(
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
      const general = appActions().filter(
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
    const scored: Array<{ record: ChatRecord; rank: number; loose: boolean }> = [];
    for (const record of directory.rows.values()) {
      if (!listable(record) || !reachable(record.workspaceId)) continue;
      let rank = rankLabel(record.title, trimmed);
      const loose = rank !== null && rank < LOOSE_MATCH_BELOW;
      // The server matched every word in the title or first message.
      if (rank === null && serverIds.has(record.id)) rank = 50;
      if (rank === null) continue;
      const visited = recentIndex.get(record.id);
      if (visited !== undefined) rank += Math.max(0, 20 - visited);
      if (record.pinned) rank += 5;
      if (record.archived) rank -= 300;
      if (record.workspaceId !== workspaceId) rank -= ELSEWHERE_PENALTY;
      scored.push({ record, rank, loose });
    }

    const actionScores: Array<{ item: Item; rank: number; loose: boolean }> = [];
    for (const action of appActions()) {
      if (action.inCommandMenu === false) continue;
      const target = action.forChat ? current : null;
      if (action.forChat && !target) continue;
      if (!action.available(env, target)) continue;
      const rank = rankWithKeywords(actionTitle(action, env, target), action.keywords, trimmed);
      if (rank === null) continue;
      actionScores.push({
        rank,
        loose: rank < LOOSE_MATCH_BELOW,
        item: actionItem(action, target, "Actions", trimmed),
      });
    }
    const workspaceScores: Array<{ item: Item; rank: number; loose: boolean }> = [];
    for (const choice of workspaces) {
      if (choice.id === workspaceId) continue;
      const rank = rankLabel(choice.name, trimmed);
      if (rank === null) continue;
      workspaceScores.push({
        rank,
        loose: rank < LOOSE_MATCH_BELOW,
        item: workspaceItem(choice, "Workspaces", trimmed),
      });
    }
    const knownIds = new Set(knownSites.map((site) => site.id));
    const siteScores = rankSites(
      [...knownSites, ...serverSites.previous.filter((site) => !knownIds.has(site.id))],
      serverSites.sites,
      trimmed,
    );
    // Letters-in-order guesses only help when nothing really matches; next to
    // real matches they are noise ("pin" → "Postgres … investigation").
    const hasRealMatch =
      scored.some((entry) => !entry.loose) ||
      siteScores.some((entry) => !entry.loose) ||
      actionScores.some((entry) => !entry.loose) ||
      workspaceScores.some((entry) => !entry.loose);
    const chats = scored
      .filter((entry) => !hasRealMatch || !entry.loose)
      .sort((a, b) => b.rank - a.rank || b.record.updatedAt - a.record.updatedAt)
      .slice(0, CHAT_RESULT_LIMIT);
    const sitesFound = siteScores
      .filter((entry) => !hasRealMatch || !entry.loose)
      .slice(0, SITE_RESULT_LIMIT);
    const actionsFound = actionScores
      .filter((entry) => !hasRealMatch || !entry.loose)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, ACTION_RESULT_LIMIT);
    const workspacesFound = workspaceScores
      .filter((entry) => !hasRealMatch || !entry.loose)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, WORKSPACE_RESULT_LIMIT);

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
    if (workspacesFound.length > 0) {
      result.push({
        label: "Workspaces",
        items: workspacesFound.map((entry) => entry.item),
        // Chats and actions first on a tie: a workspace is a bigger jump.
        best: workspacesFound[0]!.rank - 1,
      });
    }
    // A clearly better action match ("new" → New chat) comes before chats.
    result.sort((a, b) => b.best - a.best);
    if (sitesFound.length > 0) {
      const sitesGroup: Group = {
        label: "Sites",
        items: sitesFound.map((entry) => siteItem(entry.site, "Sites", trimmed)),
        best: sitesFound[0]!.rank,
      };
      // Sites always follow chats; with no chats they take their place by match.
      const chatsAt = result.findIndex((group) => group.label === "Chats");
      const at =
        chatsAt >= 0 ? chatsAt + 1 : result.findIndex((group) => group.best < sitesGroup.best);
      result.splice(at >= 0 ? at : result.length, 0, sitesGroup);
    }
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
            afterClose.current = () => env.searchMessages(trimmed);
            close();
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
    openSite,
    openWorkspace,
    pickingWorkspace,
    query,
    reachable,
    server.query,
    server.rows,
    serverSites.sites,
    serverSites.previous,
    siteDirectoryVersion,
    subjectId,
    surface,
    workspaceId,
    workspaceNames,
    workspaces,
  ]);

  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const listedChatIds = useMemo(
    () => items.flatMap((item) => (item.chat ? [item.chat.id] : [])),
    [items],
  );
  useChatStatusRefresh({ subjectId, workspaceId, ids: listedChatIds, active: props.open });
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const searching =
    Boolean(query.trim()) &&
    !focusChat &&
    !pickingWorkspace &&
    (server.loading || serverSites.loading);

  // Typing starts at the best match; the workspace list starts at the current workspace's neighbour.
  useEffect(() => {
    if (pickingWorkspace && !query) {
      const index = workspaces.findIndex((choice) => choice.id === workspaceId);
      setActive(index >= 0 && workspaces.length > 1 ? (index + 1) % workspaces.length : 0);
      return;
    }
    setActive(0);
  }, [query, focusChat, pickingWorkspace, workspaces, workspaceId]);

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
    setPickingWorkspace(false);
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
            if (focusChat || pickingWorkspace) leaveChat();
            return;
          }
          if (!focusChat && activeItem?.chat) enterChat(activeItem.chat);
          return;
        }
        case "Backspace": {
          if ((focusChat || pickingWorkspace) && !query) {
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
      const sameWorkspace = chatRecord.workspaceId === workspaceId;
      for (const action of appActions()) {
        if (!action.forChat) continue;
        const chord = chordsFor(action).find((candidate) =>
          matchesChord(event.nativeEvent, candidate, platform),
        );
        if (!chord) continue;
        const row =
          (sameWorkspace
            ? (chatRecord.row ?? (env.currentChat?.id === chatRecord.id ? env.currentChat : null))
            : null) ?? (action.id === "chat.copyLink" ? pseudoRow(chatRecord) : null);
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
      pickingWorkspace,
      platform,
      query,
      runAction,
      workspaceId,
    ],
  );

  const placeholder = focusChat
    ? "Search actions…"
    : pickingWorkspace
      ? "Switch to workspace…"
      : "Search chats and Sites, or run an action…";
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
            if (ranAction.current) {
              event.preventDefault();
              return;
            }
            const target = props.returnFocus.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
            const next = afterClose.current;
            afterClose.current = null;
            next?.();
          }}
          onEscapeKeyDown={(event) => {
            // Esc steps back out of a chat's actions, or the workspace list
            // reached from the menu, before it closes the menu.
            if (!focusChat && !(pickingWorkspace && !props.pickWorkspace)) return;
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
            ) : pickingWorkspace ? (
              <button
                type="button"
                onClick={leaveChat}
                title="Back to all results"
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hover py-0.5 pr-1.5 pl-2.5 text-xs font-medium text-fg outline-hidden hover:bg-selection focus-visible:outline-2 focus-visible:outline-ring/55"
              >
                Workspaces
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
              aria-label={
                focusChat
                  ? `Actions for ${focusChat.title}`
                  : pickingWorkspace
                    ? "Search workspaces"
                    : "Search chats, Sites and actions"
              }
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              maxLength={200}
              placeholder={placeholder}
              onChange={(event) => setQuery(event.target.value)}
              // The whole menu is the focus context; a ring on the field adds noise.
              style={{ outline: "none" }}
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
            aria-label={focusChat ? "Chat actions" : pickingWorkspace ? "Workspaces" : "Results"}
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
                          {item.tile ? (
                            <span
                              aria-hidden="true"
                              className="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-surface-3 text-2xs font-semibold text-fg-muted"
                            >
                              {item.tile}
                            </span>
                          ) : (
                            <Icon
                              aria-hidden="true"
                              className={cn(
                                "size-4 shrink-0",
                                selected ? "text-fg" : "text-fg-muted",
                              )}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            <Highlighted text={item.title} query={item.highlight} />
                          </span>
                          {item.workspaceTag ? <WorkspaceTag name={item.workspaceTag} /> : null}
                          <ChatStatusMarks status={item.status ?? null} />
                          {item.meta ? (
                            <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                              {item.meta}
                            </span>
                          ) : null}
                          {item.chord ? (
                            // Touch screens have no keys to press.
                            <Keycaps
                              chord={item.chord}
                              platform={platform}
                              className="pointer-coarse:hidden"
                            />
                          ) : null}
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
            <FooterHint
              keys={[{ code: "Enter" }]}
              label={pickingWorkspace ? "Switch" : "Open"}
              platform={platform}
            />
            {focusChat || pickingWorkspace ? (
              <FooterHint keys={[{ code: "Escape" }]} label="Back" platform={platform} />
            ) : (
              <FooterHint keys={[{ code: "Tab" }]} label="Chat actions" platform={platform} />
            )}
            {surface === "web" && !focusChat && !pickingWorkspace ? (
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
