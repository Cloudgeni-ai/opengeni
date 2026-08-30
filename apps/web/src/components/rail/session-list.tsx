// The session list — the rail's home. Reuses the same useWorkspaceSessions
// hook the old sessions index used, groups by recency (running pinned on top),
// and supports ArrowUp/Down + Enter keyboard navigation. Each row is a status
// dot + single-line truncated title + relative time (visible at rest). The
// active session (from the URL) is highlighted with an accent bar.
import { useChannels, useSessionLineage, useWorkspaceSessions } from "@opengeni/react";
import {
  OpenGeniApiError,
  OpenGeniSessionListCursorError,
  type SessionListResponse,
} from "@opengeni/sdk";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  Clock3Icon,
  EllipsisIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderOpenIcon,
  ListFilterIcon,
  MailIcon,
  MailOpenIcon,
  MessagesSquareIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type DragEvent,
  type ReactNode,
} from "react";

import { useRail } from "@/components/rail/rail-context";
import {
  RailTrailingMetadata,
  SessionRowContent,
  sessionRowAccessibleName,
} from "@/components/rail/session-row-content";
export { RailTrailingMetadata } from "@/components/rail/session-row-content";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChannelCreateDialog } from "@/components/rail/channel-create-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import {
  activeSessionContinuation,
  advanceSessionPageIdentity,
  authoritativeSessionContinuationChannels,
  emptySessionContinuation,
  mergeSessionContinuation,
  rebaseSessionContinuation,
  reconcileRetainedSessionContinuationChannel,
  sessionPageKey,
} from "@/lib/session-pagination";
import { pinLiveAnnouncement } from "@/lib/pin-live-announcement";
import {
  SESSION_TITLE_MAX_LENGTH,
  sessionDisplayTitle,
  useInlineRename,
} from "@/lib/session-rename";
import {
  applySessionChannelMove,
  beginSessionChannelMove,
  commitSessionChannelMove,
  discardRejectedSessionChannelMove,
  readSessionChannelMovePoint,
  reconcileSessionChannelMovePointRead,
  reconcileSessionChannelMoves,
  rollbackSessionChannelMove,
  type SessionChannelMoveOverrides,
} from "@/lib/session-channel-move";
import {
  MAX_VISUAL_TREE_DEPTH,
  defaultExpandedAncestors,
  sessionAncestorPath,
  sessionStateLabel,
  visualTreeDepth,
} from "@/lib/session-rail";
import {
  cancelSessionRowRevealIntent,
  consumeSessionRowRevealIntent,
  requestSessionComposerFocus,
  sessionFocusAttribute,
  shouldRecordSessionRowFocusIntent,
  shouldMoveSessionRowFocus,
  shouldRestoreSessionFocus,
  type SessionFocusTarget,
} from "@/lib/session-focus";
import {
  applySessionChannelProjection,
  applySessionPinProjection,
  applySessionRailProjection,
  subscribeToSessionPinChanges,
} from "@/lib/session-pins";
import {
  applySessionAttentionProjections,
  localSessionDeliveryAttentionCounts,
  latestSessionAttentionProjection,
  notifySessionAttentionChanged,
  subscribeToLocalSessionDeliveryAttention,
  subscribeToSessionAttentionChanges,
  type SessionAttentionProjection,
} from "@/lib/session-attention";
import {
  buildPinnedRailSections,
  channelRailSections,
  filterSessionsForBrowse,
  groupSessionsForBrowse,
  projectRailSessions,
  groupSessionsForRail,
  mergeSessionForRail,
  relativeTimeLabel,
  scheduledTaskIdOf,
  selectedDescendantNode,
  sessionCreatorLabelMap,
  visibleForestRows,
  visibleTreeRows,
  summarizeRailNodes,
  type RailAggregateStatus,
  type SessionTreeNode,
  type SessionBrowseDateField,
  type SessionBrowseDateRange,
  type SessionBrowseGroupBy,
} from "@/lib/sessions-group";
import {
  readSessionBrowseGroupBy,
  sessionBrowsePreferenceStorageId,
  writeSessionBrowseGroupBy,
} from "@/lib/session-browse-preferences";
import { railRowCreator } from "@/lib/creator-initials";
import { formatWaitingSince } from "@/lib/format";
import { sessionDescendantCountAria, sessionDescendantCountText } from "@/lib/session-tree-count";
import { requestCreateComposerFocus } from "@/lib/create-composer-focus";
import {
  authoritativeSessionBranchChannels,
  beginSessionBranchRequest,
  commitSessionBranchPage,
  failSessionBranchRequest,
  sessionBranchSummaryKey,
  sessionBranchSummaryDecision,
  upsertSessionBranchChild,
  type SessionBranchPage,
} from "@/lib/session-branch-cache";
import { cn } from "@/lib/utils";
import type { Channel, Session } from "@/types";

/** True when the browser should own navigation (new tab / window / modified click). */
function isModifiedNavigationClick(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button">,
): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

/** Composer / sessions-index entry — real link so Cmd/Ctrl-click opens a new tab. */
export function NewSessionLink(props: {
  className?: string;
  "aria-label"?: string;
  channelId?: string;
  children: ReactNode;
}) {
  const rail = useRail();
  const context = useAppContext();
  return (
    <Link
      to="/workspaces/$workspaceId/sessions"
      params={{ workspaceId: rail.workspaceId }}
      search={props.channelId ? { channelId: props.channelId } : {}}
      aria-label={props["aria-label"]}
      aria-keyshortcuts="Meta+Shift+O Control+Shift+O"
      className={props.className}
      onClick={(event) => {
        if (isModifiedNavigationClick(event)) return;
        context.resetSessionView();
        rail.setDrawerOpen(false);
        // Same-route Link may not remount the index; ask it to refocus the composer.
        queueMicrotask(() => requestCreateComposerFocus());
      }}
    >
      {props.children}
    </Link>
  );
}

type RenameFn = (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
type PinFn = (
  session: Session,
  pinned: boolean,
  restoreFocusTo?: SessionFocusTarget,
) => Promise<Session | null>;
type MoveToChannelFn = (
  session: Session,
  channelId: string | null,
  restoreFocusTo?: SessionFocusTarget,
) => Promise<void>;
type UpdateAttentionFn = (
  session: Session,
  update: { unread?: boolean; activelyWorking?: boolean },
) => Promise<void>;
type ArchiveFn = (session: Session, archived: boolean) => Promise<void>;
type RequestDeleteFn = (session: Session) => void;
type PinOverride = { session: Session; operation: number };
type PendingSessionFocus = {
  sessionId: string;
  operation: number;
  target: SessionFocusTarget;
  settled: boolean;
};
type ChildPageState = SessionBranchPage;

const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

function findSessionTreeNode(
  nodes: readonly SessionTreeNode[],
  sessionId: string | null,
): SessionTreeNode | null {
  if (!sessionId) return null;
  for (const node of nodes) {
    if (node.session.id === sessionId) return node;
    const child = findSessionTreeNode(node.children, sessionId);
    if (child) return child;
  }
  return null;
}

export function SessionList() {
  const rail = useRail();
  const context = useAppContext();
  const sessionClient = context.client;
  const setContextSession = context.setSession;
  const navigate = useNavigate();
  const activeSessionId = useRouterState({
    select: (state): string | null => {
      const match = /\/sessions\/([^/]+)/.exec(state.location.pathname);
      return match?.[1] ?? null;
    },
  });
  const [documentForeground, setDocumentForeground] = useState(() =>
    Boolean(document.visibilityState === "visible" && document.hasFocus()),
  );
  useEffect(() => {
    const reconcileDocumentForeground = () => {
      setDocumentForeground(document.visibilityState === "visible" && document.hasFocus());
    };
    window.addEventListener("focus", reconcileDocumentForeground);
    window.addEventListener("blur", reconcileDocumentForeground);
    document.addEventListener("visibilitychange", reconcileDocumentForeground);
    return () => {
      window.removeEventListener("focus", reconcileDocumentForeground);
      window.removeEventListener("blur", reconcileDocumentForeground);
      document.removeEventListener("visibilitychange", reconcileDocumentForeground);
    };
  }, []);
  // Poll so running sessions surface and move to the top without a manual
  // refresh; the previous index relied on a one-shot load.
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const browsePreferenceStorageId = useMemo(
    () => sessionBrowsePreferenceStorageId(context.accessContext.subjectId),
    [context.accessContext.subjectId],
  );
  const previousBrowsePreferenceStorageId = useRef(browsePreferenceStorageId);
  const [browseGroupBy, setBrowseGroupByState] = useState<SessionBrowseGroupBy>(() =>
    readSessionBrowseGroupBy(browsePreferenceStorageId),
  );
  const [browseDateField, setBrowseDateField] = useState<SessionBrowseDateField>("activity");
  const [browseDateRange, setBrowseDateRange] = useState<SessionBrowseDateRange>("any");
  const [browseCreator, setBrowseCreator] = useState<string | null>(null);
  useEffect(() => {
    if (previousBrowsePreferenceStorageId.current === browsePreferenceStorageId) return;
    previousBrowsePreferenceStorageId.current = browsePreferenceStorageId;
    setBrowseGroupByState(readSessionBrowseGroupBy(browsePreferenceStorageId));
  }, [browsePreferenceStorageId]);
  const setBrowseGroupBy = useCallback(
    (groupBy: SessionBrowseGroupBy) => {
      setBrowseGroupByState(groupBy);
      writeSessionBrowseGroupBy(browsePreferenceStorageId, groupBy);
    },
    [browsePreferenceStorageId],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);
  const browseControlsActive =
    browseGroupBy !== "activity" || browseDateRange !== "any" || browseCreator !== null;
  const hierarchyMode = search.length === 0 && !browseControlsActive;
  const clearBrowseControls = useCallback(() => {
    setBrowseGroupBy("activity");
    setBrowseDateField("activity");
    setBrowseDateRange("any");
    setBrowseCreator(null);
  }, [setBrowseGroupBy]);

  const rootPage = useWorkspaceSessions({
    limit: 50,
    search,
    ...(hierarchyMode ? { parentSessionId: null } : {}),
    archivedOnly: false,
    pollIntervalMs: 15_000,
    beginRead: context.sessionChannelProjectionAuthority.beginRead,
  });
  // Archive is a closed folder at the end of the normal session rail. Keep
  // its page independent so opening it never changes the active-session view.
  const archivedRootPage = useWorkspaceSessions({
    limit: 50,
    parentSessionId: null,
    archivedOnly: true,
    pollIntervalMs: 15_000,
  });
  // Pins are shortcuts and may point anywhere in a workstream. Fetch their
  // complete global section separately from the root-only hierarchy page; a
  // pinned child must never make either it or its descendants disappear from
  // the actual tree.
  const globalPinPage = useWorkspaceSessions({
    limit: 1,
    pinsOnly: true,
    pollIntervalMs: 15_000,
    beginRead: context.sessionChannelProjectionAuthority.beginRead,
  });
  // Workspace-shared channels back the user-facing workstreams. Unfiled roots
  // live in Recents even before the first workstream is created. The list is
  // tiny and churn is rare, so it polls gently.
  const channelsQuery = useChannels({ pollIntervalMs: 60_000 });
  const channels = channelsQuery.channels;
  const {
    create: requestCreateChannel,
    update: updateProject,
    remove: removeProject,
    reorder: reorderProjects,
  } = channelsQuery;
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [channelNameDraft, setChannelNameDraft] = useState("");
  const [projectPendingDelete, setProjectPendingDelete] = useState<Channel | null>(null);
  const [sessionPendingDelete, setSessionPendingDelete] = useState<Session | null>(null);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const {
    sessions,
    nextCursor,
    loading,
    error,
    readRevision: rootReadRevision,
    readGeneration: rootReadGeneration,
    refresh,
  } = rootPage;
  const { sessions: archivedSessions, refresh: refreshArchivedSessions } = archivedRootPage;
  const {
    pinned: globalPinned,
    loading: globalPinsLoading,
    error: globalPinsError,
    pinnedTruncated: globalPinsTruncated,
    readGeneration: globalPinsReadGeneration,
    refresh: refreshGlobalPins,
  } = globalPinPage;
  const pinned = hierarchyMode ? globalPinned : rootPage.pinned;
  const pinnedTruncated = hierarchyMode ? globalPinsTruncated : rootPage.pinnedTruncated;
  // The hierarchy and its global pinned shortcuts come from separate queries.
  // Every invalidation must refresh both or a pin changed in another tab/device
  // can disappear from the shortcut section until the next polling interval.
  const refreshSessionPages = useCallback(async () => {
    await Promise.all([refresh(), refreshArchivedSessions(), refreshGlobalPins()]);
  }, [refresh, refreshArchivedSessions, refreshGlobalPins]);
  // Ordinary rows page independently of the complete pinned section. The
  // polled hook owns page one; additional pages are appended and deduplicated.
  // A filter change starts a fresh cursor chain rather than mixing snapshots.
  // The continuation generation is keyed to workspace/search and whether the
  // projection is a root hierarchy or flat browse. Polling page one rotates
  // the server's short-lived snapshot, but must not discard older pages the
  // user already loaded from the prior snapshot.
  const paginationKey = sessionPageKey(
    rail.workspaceId,
    `${search}\n${hierarchyMode ? "tree" : "browse"}`,
  );
  const paginationIdentity = useRef({ key: paginationKey, generation: 0 });
  paginationIdentity.current = advanceSessionPageIdentity(
    paginationIdentity.current,
    paginationKey,
  );
  const pageGeneration = paginationIdentity.current.generation;
  const [continuation, setContinuation] = useState(() => emptySessionContinuation(pageGeneration));
  const activeContinuation = activeSessionContinuation(continuation, pageGeneration);
  const extraSessions = activeContinuation.sessions;
  const authoritativeExtraSessionEvidence = useMemo(
    () =>
      authoritativeSessionContinuationChannels(
        activeContinuation,
        pageGeneration,
        rootReadRevision,
        rootReadGeneration,
      ),
    [activeContinuation, pageGeneration, rootReadGeneration, rootReadRevision],
  );
  const continuationCursor =
    activeContinuation.nextCursor === undefined ? nextCursor : activeContinuation.nextCursor;
  const continuationSnapshotReadRevision =
    activeContinuation.nextCursor === undefined
      ? rootReadRevision
      : activeContinuation.snapshotRevision;
  const continuationSnapshotReadGeneration =
    activeContinuation.nextCursor === undefined
      ? rootReadGeneration
      : activeContinuation.snapshotGeneration;
  const continuationSnapshotSource =
    activeContinuation.nextCursor === undefined ? "root" : activeContinuation.source;
  const [loadingMoreGeneration, setLoadingMoreGeneration] = useState<number | null>(null);
  const loadingMore = loadingMoreGeneration === pageGeneration;
  const loadMoreAttempt = useRef(0);
  const loadMoreError = activeContinuation.failed;
  const [announcement, setAnnouncement] = useState("");
  const pinAnnouncementSequence = useRef(0);
  const announcePinResult = useCallback((message: string) => {
    pinAnnouncementSequence.current += 1;
    setAnnouncement(pinLiveAnnouncement(message, pinAnnouncementSequence.current));
  }, []);
  const [childPages, setChildPages] = useState<ReadonlyMap<string, ChildPageState>>(
    () => new Map(),
  );
  const childLoadEpoch = useRef(0);
  const childRequestSequence = useRef(0);
  const branchSummaryKeys = useRef(new Map<string, string>());
  const activeBranchHydration = useRef<string | null>(null);
  useEffect(() => {
    childLoadEpoch.current += 1;
    branchSummaryKeys.current.clear();
    activeBranchHydration.current = null;
    setChildPages(new Map());
  }, [rail.workspaceId, hierarchyMode]);
  // Short-lived optimistic projections only. The page returned by the server
  // remains canonical; after each mutation we replace the projection with that
  // returned row and refresh once to reconcile tabs/devices/offline recovery.
  const [pinOverrides, setPinOverrides] = useState<ReadonlyMap<string, PinOverride>>(
    () => new Map(),
  );
  const [channelMoveOverrides, setChannelMoveOverrides] = useState<SessionChannelMoveOverrides>(
    () => new Map(),
  );
  const acceptedChannelReadRevision = useSyncExternalStore(
    context.sessionChannelProjectionAuthority.subscribe,
    context.sessionChannelProjectionAuthority.getRevision,
    context.sessionChannelProjectionAuthority.getRevision,
  );
  useEffect(
    () =>
      context.sessionChannelProjectionAuthority.subscribe((accepted) => {
        if (!accepted) return;
        if (accepted.workspaceId !== rail.workspaceId) return;
        setChannelMoveOverrides((current) => {
          const override = current.get(accepted.id);
          return override?.committed
            ? reconcileSessionChannelMovePointRead(
                current,
                accepted.id,
                override.operation,
                accepted,
              )
            : current;
        });
        // The route records an exact read before merging its full detail
        // projection. Apply the accepted channel immediately so that merge
        // cannot preserve an older committed move owner in the same batch.
        setContextSession((current) => applySessionChannelProjection(current, accepted));
      }),
    [context.sessionChannelProjectionAuthority, rail.workspaceId, setContextSession],
  );
  const [archiveTransitions, setArchiveTransitions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [attentionOverrides, setAttentionOverrides] = useState<
    ReadonlyMap<string, SessionAttentionProjection>
  >(() => new Map());
  const [localDeliveryAttention, setLocalDeliveryAttention] = useState<ReadonlyMap<string, number>>(
    () => localSessionDeliveryAttentionCounts(rail.workspaceId),
  );
  useEffect(() => {
    const refreshLocalDeliveryAttention = () => {
      setLocalDeliveryAttention(localSessionDeliveryAttentionCounts(rail.workspaceId));
    };
    refreshLocalDeliveryAttention();
    return subscribeToLocalSessionDeliveryAttention(refreshLocalDeliveryAttention);
  }, [rail.workspaceId]);
  const archiving = useRef(new Set<string>());
  const moveRequestOwner = useRef({});
  const pinOperation = useRef(0);
  const focusRestoreOperation = useRef(0);
  const pinning = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const pendingSessionFocus = useRef<PendingSessionFocus | null>(null);
  const [focusRestoreRevision, setFocusRestoreRevision] = useState(0);
  const channelMoveProbes = useRef(
    new Map<string, { operation: number; promise: Promise<void> }>(),
  );
  const rootChannelProjectionOwner = useRef({});
  const continuationChannelProjectionOwner = useRef({});
  const branchChannelProjectionOwner = useRef({});
  const pinsChannelProjectionOwner = useRef({});
  const lineageChannelProjectionOwner = useRef({});
  const moveChannelProjectionOwner = useRef({});
  const activeLineage = useSessionLineage(context.session?.id ?? null, {
    pollIntervalMs: 30_000,
    beginRead: context.sessionChannelProjectionAuthority.beginRead,
  });
  const lineageChannelAuthoritySessions = useMemo(
    () => activeLineage.lineage?.ancestors ?? [],
    [activeLineage.lineage?.ancestors],
  );
  const loadedChildren = useMemo(
    () => [...childPages.values()].flatMap((page) => page.sessions),
    [childPages],
  );
  const loadedChildChannelEvidence = useMemo(
    () => [...childPages.values()].flatMap(authoritativeSessionBranchChannels),
    [childPages],
  );
  const pinnedChannelReadGeneration = hierarchyMode ? globalPinsReadGeneration : rootReadGeneration;
  const currentListChannelEvidence = useMemo(() => {
    void acceptedChannelReadRevision;
    const evidence = new Map<string, readonly [session: Session, readGeneration: number]>();
    const add = (candidates: readonly Session[], readGeneration: number) => {
      for (const session of candidates) {
        const current = evidence.get(session.id);
        if (!current || readGeneration >= current[1]) {
          evidence.set(session.id, [session, readGeneration]);
        }
      }
    };
    for (const [session, readGeneration] of authoritativeExtraSessionEvidence) {
      add([session], readGeneration);
    }
    add(sessions, rootReadGeneration);
    add(pinned, pinnedChannelReadGeneration);
    for (const [session, readGeneration] of loadedChildChannelEvidence) {
      add([session], readGeneration);
    }
    return evidence;
  }, [
    acceptedChannelReadRevision,
    authoritativeExtraSessionEvidence,
    loadedChildChannelEvidence,
    pinned,
    pinnedChannelReadGeneration,
    rootReadGeneration,
    sessions,
  ]);
  const listedSessions = useMemo(() => {
    const source = new Map<string, Session>();
    for (const session of [...extraSessions, ...sessions, ...loadedChildren, ...pinned]) {
      const current = source.get(session.id);
      source.set(session.id, current ? mergeSessionForRail(current, session) : session);
    }
    return [...source.values()].map((session) => {
      const evidence = currentListChannelEvidence.get(session.id);
      const projected =
        evidence && (session.channelId ?? null) !== (evidence[0].channelId ?? null)
          ? { ...session, channelId: evidence[0].channelId ?? null }
          : session;
      return context.sessionChannelProjectionAuthority.project(projected, evidence?.[1] ?? 0);
    });
  }, [
    context.sessionChannelProjectionAuthority,
    currentListChannelEvidence,
    extraSessions,
    loadedChildren,
    pinned,
    sessions,
  ]);
  const rootChannelAuthoritySessions = useMemo(() => sessions, [sessions]);
  const channelAuthoritySessions = useMemo(() => {
    return [...currentListChannelEvidence.values()].map(([session, readGeneration]) =>
      context.sessionChannelProjectionAuthority.project(session, readGeneration),
    );
  }, [context.sessionChannelProjectionAuthority, currentListChannelEvidence]);
  const channelAuthorityById = useMemo(
    () => new Map(channelAuthoritySessions.map((session) => [session.id, session])),
    [channelAuthoritySessions],
  );
  useEffect(() => {
    setContinuation((current) =>
      reconcileRetainedSessionContinuationChannel(
        current,
        pageGeneration,
        rootReadRevision,
        context.session,
        rootReadGeneration,
      ),
    );
  }, [context.session, pageGeneration, rootReadGeneration, rootReadRevision]);
  useLayoutEffect(() => {
    const owner = rootChannelProjectionOwner.current;
    context.sessionChannelProjectionAuthority.replace(
      owner,
      rootChannelAuthoritySessions,
      0,
      rootReadGeneration,
    );
    return () => context.sessionChannelProjectionAuthority.clear(owner);
  }, [context.sessionChannelProjectionAuthority, rootChannelAuthoritySessions, rootReadGeneration]);
  useLayoutEffect(() => {
    const owner = continuationChannelProjectionOwner.current;
    context.sessionChannelProjectionAuthority.replaceOwner(
      owner,
      authoritativeExtraSessionEvidence,
    );
    return () => context.sessionChannelProjectionAuthority.clear(owner);
  }, [authoritativeExtraSessionEvidence, context.sessionChannelProjectionAuthority]);
  useLayoutEffect(() => {
    const owner = branchChannelProjectionOwner.current;
    context.sessionChannelProjectionAuthority.replaceOwner(owner, loadedChildChannelEvidence);
    return () => context.sessionChannelProjectionAuthority.clear(owner);
  }, [context.sessionChannelProjectionAuthority, loadedChildChannelEvidence]);
  useLayoutEffect(() => {
    const owner = pinsChannelProjectionOwner.current;
    context.sessionChannelProjectionAuthority.replace(
      owner,
      hierarchyMode ? globalPinned : [],
      0,
      globalPinsReadGeneration,
    );
    return () => context.sessionChannelProjectionAuthority.clear(owner);
  }, [
    context.sessionChannelProjectionAuthority,
    globalPinned,
    globalPinsReadGeneration,
    hierarchyMode,
  ]);
  useLayoutEffect(() => {
    const owner = lineageChannelProjectionOwner.current;
    context.sessionChannelProjectionAuthority.replace(
      owner,
      hierarchyMode ? lineageChannelAuthoritySessions : [],
      0,
      activeLineage.readGeneration,
    );
    return () => context.sessionChannelProjectionAuthority.clear(owner);
  }, [
    activeLineage.readGeneration,
    context.sessionChannelProjectionAuthority,
    hierarchyMode,
    lineageChannelAuthoritySessions,
  ]);
  useLayoutEffect(() => {
    const owner = moveChannelProjectionOwner.current;
    context.sessionChannelProjectionAuthority.replace(
      owner,
      [...channelMoveOverrides].map(([id, override]) => ({
        id,
        workspaceId: rail.workspaceId,
        channelId: override.channelId,
      })),
      1,
    );
    return () => context.sessionChannelProjectionAuthority.clear(owner);
  }, [channelMoveOverrides, context.sessionChannelProjectionAuthority, rail.workspaceId]);
  const serverSessions = useMemo(() => {
    const source = new Map(listedSessions.map((session) => [session.id, session]));
    // Search is intentionally flat. Normal navigation starts with real roots,
    // then adds only explicitly loaded child pages and the active session's
    // lineage. A child can therefore never become a fake root merely because
    // its parent fell outside a global recency page.
    // List/page projections own personal pin revisions and server treeStats.
    // Insert those first, with the current pinned section last so an older
    // ordinary continuation cannot overwrite a newer pin projection.
    // Route/lineage projections own lifecycle and content. Project their
    // channel through persistent authority first, then merge list-owned fields
    // rather than replacing either domain wholesale; in particular, a stale
    // route object must not resurrect a cross-device pin or project move.
    const lineageSessions = hierarchyMode
      ? [...(activeLineage.lineage?.ancestors ?? []), ...(context.session ? [context.session] : [])]
      : [];
    for (const session of lineageSessions) {
      const lineageProjected = context.sessionChannelProjectionAuthority.project(
        session,
        activeLineage.readGeneration,
      );
      const projected = source.get(session.id);
      const authoritative = channelAuthorityById.get(session.id);
      const channelOwned =
        authoritative !== undefined &&
        context.sessionChannelProjectionAuthority.owns(authoritative) &&
        (authoritative.channelId ?? null) === (projected?.channelId ?? null);
      source.set(
        session.id,
        projected
          ? applySessionRailProjection(lineageProjected, projected, { channelOwned })
          : lineageProjected,
      );
    }
    return [...source.values()];
  }, [
    activeLineage.lineage?.ancestors,
    activeLineage.readGeneration,
    channelAuthorityById,
    context.sessionChannelProjectionAuthority,
    context.session,
    hierarchyMode,
    listedSessions,
  ]);
  const allSessions = useMemo(() => {
    const source = new Map(serverSessions.map((session) => [session.id, session]));
    for (const [id, override] of pinOverrides) {
      const current = source.get(id);
      source.set(
        id,
        current
          ? (applySessionPinProjection(current, override.session) ?? current)
          : override.session,
      );
    }
    for (const [id, override] of channelMoveOverrides) {
      const current = source.get(id);
      if (current) source.set(id, applySessionChannelMove(current, override));
    }
    const projectedAttention = new Map(attentionOverrides);
    const active = activeSessionId ? source.get(activeSessionId) : null;
    if (documentForeground && active?.unread && active.workspaceId === rail.workspaceId) {
      const foregroundProjection: SessionAttentionProjection = {
        id: active.id,
        workspaceId: active.workspaceId,
        unread: false,
        attentionVersion: active.attentionVersion,
        lastSequence: active.lastSequence,
      };
      projectedAttention.set(
        active.id,
        latestSessionAttentionProjection(projectedAttention.get(active.id), foregroundProjection),
      );
    }
    return applySessionAttentionProjections([...source.values()], projectedAttention);
  }, [
    activeSessionId,
    attentionOverrides,
    channelMoveOverrides,
    documentForeground,
    pinOverrides,
    rail.workspaceId,
    serverSessions,
  ]);

  const verifySessionChannelMove = useCallback(
    (sessionId: string, operation: number): Promise<void> => {
      const existing = channelMoveProbes.current.get(sessionId);
      if (existing?.operation === operation) return existing.promise;

      let readGeneration = 0;
      const detailReadOwner = {};
      const promise = readSessionChannelMovePoint(
        sessionClient,
        rail.workspaceId,
        sessionId,
        () => {
          readGeneration = context.sessionChannelProjectionAuthority.beginDetailRead(
            detailReadOwner,
            { id: sessionId, workspaceId: rail.workspaceId },
          );
        },
      )
        .then((authoritative) => {
          const currentProbe = channelMoveProbes.current.get(sessionId);
          if (currentProbe?.operation !== operation) return;
          const accepted = context.sessionChannelProjectionAuthority.recordRead(
            authoritative,
            readGeneration,
          );
          if (accepted) {
            setChannelMoveOverrides((current) =>
              reconcileSessionChannelMovePointRead(current, sessionId, operation, authoritative),
            );
            setContextSession((current) => applySessionChannelProjection(current, authoritative));
            return;
          }

          // A still-newer accepted detail/point read won while this request was
          // in flight. Retire only this operation's overlay, then expose that
          // persistent winner instead of the rejected response.
          setChannelMoveOverrides((current) =>
            discardRejectedSessionChannelMove(current, sessionId, operation),
          );
          const winner = context.sessionChannelProjectionAuthority.project(
            authoritative,
            readGeneration,
          );
          if (context.sessionChannelProjectionAuthority.owns(winner)) {
            setContextSession((current) => applySessionChannelProjection(current, winner));
          }
        })
        .catch((requestError: unknown) => {
          const currentProbe = channelMoveProbes.current.get(sessionId);
          if (
            currentProbe?.operation !== operation ||
            !(requestError instanceof OpenGeniApiError) ||
            requestError.status !== 404
          ) {
            return;
          }
          // Whether this absence is accepted or loses to a still-newer read,
          // exact post-settlement evidence makes the temporary move overlay
          // redundant. Persistent authority retains any newer present winner.
          context.sessionChannelProjectionAuthority.recordMissing(
            { id: sessionId, workspaceId: rail.workspaceId },
            readGeneration,
          );
          setChannelMoveOverrides((current) =>
            reconcileSessionChannelMovePointRead(current, sessionId, operation, null),
          );
        });
      const probe = { operation, promise };
      channelMoveProbes.current.set(sessionId, probe);
      void promise.finally(() => {
        context.sessionChannelProjectionAuthority.finishDetailReads(detailReadOwner);
        if (channelMoveProbes.current.get(sessionId) === probe) {
          channelMoveProbes.current.delete(sessionId);
        }
      });
      return promise;
    },
    [context.sessionChannelProjectionAuthority, rail.workspaceId, sessionClient, setContextSession],
  );

  // Matching causally authoritative list/page evidence confirms the optimistic
  // destination. Display-only retained rows cannot confirm or disagree: their
  // channel may have been patched from context after their list authority
  // expired. Resolve absent or different authority with an exact point read
  // started after the write. That point read can preserve the optimistic move,
  // supersede it with a newer cross-client move, or retire it after deletion
  // without requiring a database schema revision.
  useEffect(() => {
    setChannelMoveOverrides((current) =>
      reconcileSessionChannelMoves(current, channelAuthoritySessions),
    );
    const authoritativeById = new Map(
      channelAuthoritySessions.map((session) => [session.id, session]),
    );
    for (const [sessionId, override] of channelMoveOverrides) {
      if (!override.committed) continue;
      const authoritativeEvidence = authoritativeById.get(sessionId);
      if (
        authoritativeEvidence &&
        (authoritativeEvidence.channelId ?? null) === override.channelId
      ) {
        continue;
      }
      void verifySessionChannelMove(sessionId, override.operation);
    }
  }, [channelMoveOverrides, channelAuthoritySessions, verifySessionChannelMove]);

  useEffect(() => {
    channelMoveProbes.current.clear();
    pendingSessionFocus.current = null;
    setChannelMoveOverrides(new Map());
  }, [rail.workspaceId]);
  const branchParentsById = useRef<ReadonlyMap<string, Session>>(new Map());
  branchParentsById.current = new Map(allSessions.map((session) => [session.id, session]));

  useEffect(() => {
    setAttentionOverrides(new Map());
    return subscribeToSessionAttentionChanges((projection) => {
      setAttentionOverrides((current) => {
        const latest = latestSessionAttentionProjection(current.get(projection.id), projection);
        if (latest !== projection) return current;
        const next = new Map(current);
        next.set(projection.id, latest);
        if (next.size > 64) next.delete(next.keys().next().value!);
        return next;
      });
    });
  }, [rail.workspaceId]);
  const creatorLabels = useMemo(() => sessionCreatorLabelMap(allSessions), [allSessions]);
  const creatorOptions = useMemo(() => {
    return [...creatorLabels].map(([value, label]) => ({ value, label }));
  }, [creatorLabels]);
  const browseSessions = useMemo(
    () =>
      filterSessionsForBrowse(
        allSessions.filter((session) => {
          if (archiveTransitions.has(session.rootSessionId)) return false;
          // Child rows inherit their root's archive membership from the
          // lineage query. Only roots carry the personal archive projection.
          return session.parentSessionId !== null || !session.archived;
        }),
        {
          creator: browseCreator,
          dateField: browseDateField,
          dateRange: browseDateRange,
        },
      ),
    [allSessions, archiveTransitions, browseCreator, browseDateField, browseDateRange],
  );

  // A complete pins-only page makes presence authoritative, but absence does
  // not carry the version of a remotely unpinned relation. Loaded child pages
  // can outlive many root/global polls, so point-read only their stale positive
  // pins and merge the exact revision back into every cached parent page.
  const staleChildPinProbes = useRef(new Map<string, string>());
  useEffect(() => {
    if (globalPinsLoading || globalPinsError) return;
    const pinnedIds = new Set(globalPinned.map((session) => session.id));
    const stalePins = loadedChildren.filter(
      (session) => session.pinned && !pinnedIds.has(session.id),
    );
    const staleKeys = new Set(
      stalePins.map((session) => `${session.id}:${session.pinVersion ?? 0}`),
    );
    for (const [sessionId, key] of staleChildPinProbes.current) {
      if (!staleKeys.has(key)) staleChildPinProbes.current.delete(sessionId);
    }
    const childEpoch = childLoadEpoch.current;
    for (const stale of stalePins) {
      const key = `${stale.id}:${stale.pinVersion ?? 0}`;
      if (staleChildPinProbes.current.get(stale.id) === key) continue;
      staleChildPinProbes.current.set(stale.id, key);
      void context.client
        .getSession(rail.workspaceId, stale.id)
        .then((authoritative) => {
          if (
            childLoadEpoch.current !== childEpoch ||
            staleChildPinProbes.current.get(stale.id) !== key
          ) {
            return;
          }
          setChildPages((current) => {
            let changed = false;
            const next = new Map(current);
            for (const [parentId, page] of current) {
              const projectedSessions = page.sessions.map((session) => {
                if (session.id !== stale.id) return session;
                const projected = applySessionPinProjection(session, authoritative) ?? session;
                if (projected !== session) changed = true;
                return projected;
              });
              if (projectedSessions.some((session, index) => session !== page.sessions[index])) {
                next.set(parentId, { ...page, sessions: projectedSessions });
              }
            }
            return changed ? next : current;
          });
        })
        .catch((requestError: unknown) => {
          if (requestError instanceof OpenGeniApiError && requestError.status === 404) {
            setChildPages((current) => {
              let changed = false;
              const next = new Map(current);
              for (const [parentId, page] of current) {
                const retainedSessions = page.sessions.filter((session) => session.id !== stale.id);
                if (retainedSessions.length !== page.sessions.length) {
                  changed = true;
                  next.set(parentId, { ...page, sessions: retainedSessions });
                }
              }
              return changed ? next : current;
            });
          }
          if (staleChildPinProbes.current.get(stale.id) === key) {
            staleChildPinProbes.current.delete(stale.id);
          }
        });
    }
  }, [
    context.client,
    globalPinned,
    globalPinsError,
    globalPinsLoading,
    loadedChildren,
    rail.workspaceId,
  ]);
  const openSessionId = context.session?.id;
  const openSessionWorkspaceId = context.session?.workspaceId;
  const openSessionPinned = Boolean(context.session?.pinned);
  const openSessionPinVersion = context.session?.pinVersion ?? 0;
  // The route header and rail intentionally keep separate projections. Merge
  // list-owned pin and project fields into the open session while preserving
  // route/SSE-owned lifecycle and content. Project reconciliation is paused
  // only while an optimistic move owns the row; its point-read fence updates
  // the context directly and prevents a pre-write list response from winning.
  useEffect(() => {
    if (!openSessionId || openSessionWorkspaceId !== rail.workspaceId) return;
    // Do not feed the rail's short-lived optimistic override into the route
    // header. A same-version optimistic timestamp can make a later failed
    // rollback look non-exact, causing its authoritative lower revision to be
    // rejected as stale and leaving the header pinned forever.
    const projected = serverSessions.find((candidate) => candidate.id === openSessionId);
    if (!projected) return;
    setContextSession((current) => {
      const pinProjected = applySessionPinProjection(current, projected);
      return channelMoveOverrides.has(openSessionId)
        ? pinProjected
        : applySessionChannelProjection(pinProjected, projected);
    });
  }, [
    channelMoveOverrides,
    openSessionId,
    openSessionWorkspaceId,
    rail.workspaceId,
    serverSessions,
    setContextSession,
  ]);

  const activePinProbe = useRef<{ key: string | null; operation: number }>({
    key: null,
    operation: 0,
  });
  useEffect(() => {
    const globalPageContainsOpenSession = globalPinned.some(
      (candidate) => candidate.id === openSessionId,
    );
    if (
      !openSessionId ||
      openSessionWorkspaceId !== rail.workspaceId ||
      !openSessionPinned ||
      globalPinsLoading ||
      globalPinsError ||
      globalPageContainsOpenSession
    ) {
      activePinProbe.current.key = null;
      activePinProbe.current.operation += 1;
      return;
    }

    const key = `${openSessionId}:${openSessionPinVersion}`;
    if (activePinProbe.current.key === key) return;
    const operation = ++activePinProbe.current.operation;
    activePinProbe.current.key = key;
    void context.client
      .getSession(rail.workspaceId, openSessionId)
      .then((authoritative) => {
        if (activePinProbe.current.operation !== operation) return;
        // Point reads are used only for the absent pin projection. Route/SSE
        // remains authoritative for every lifecycle and content field.
        setContextSession((current) => applySessionPinProjection(current, authoritative));
      })
      .catch(() => {
        if (activePinProbe.current.operation === operation) {
          activePinProbe.current.key = null;
        }
      });
  }, [
    context.client,
    globalPinned,
    globalPinsError,
    globalPinsLoading,
    openSessionId,
    openSessionPinned,
    openSessionPinVersion,
    openSessionWorkspaceId,
    rail.workspaceId,
    setContextSession,
  ]);

  // Only a route transition or keyboard navigation may reveal a row. Polls and
  // pagination replace `flat` too, so a derived focus index is not itself
  // permission to move this scroll container.
  const rowRevealIntent = useRef<string | null>(activeSessionId);

  // Search results and browse groupings are deliberately flat: a partial match
  // set is not a tree, and a browse bucket is a list. Normal navigation instead
  // carries only true roots, lazily loaded children, and the active lineage.
  // Both flat consumers read the SAME normalized rows, so a session rendered as
  // a top-level row never still claims a parent that is nowhere on screen.
  const projectedSessions = useMemo(
    () => projectRailSessions(browseSessions, hierarchyMode),
    [browseSessions, hierarchyMode],
  );
  // The helper builds all three projections together so explicit nested pins
  // never disappear into an ancestor shortcut.
  const railSections = useMemo(
    () => buildPinnedRailSections(projectedSessions),
    [projectedSessions],
  );
  const forest = useMemo(
    () =>
      browseGroupBy === "activity"
        ? railSections.ordinary
        : groupSessionsForBrowse(
            projectedSessions.filter((session) => !session.pinned),
            browseGroupBy,
            { creatorLabels },
          ),
    [browseGroupBy, projectedSessions, creatorLabels, railSections.ordinary],
  );
  const pinnedNodes = railSections.pinned;
  // The hierarchy rail always has the same shape: unfiled Recents first, then
  // workstreams. A workspace with no created workstreams should not fall back
  // to a completely different recency UI.
  const channelMode = hierarchyMode;
  const channelSections = useMemo(
    () => (channelMode ? channelRailSections(forest, channels) : []),
    [channelMode, forest, channels],
  );
  const archivedNodes = useMemo(() => {
    const archiveForest = buildPinnedRailSections(
      archivedSessions.filter((session) => !archiveTransitions.has(session.rootSessionId)),
    ).complete;
    return [...archiveForest.running, ...archiveForest.grouped.flatMap((group) => group.sessions)];
  }, [archiveTransitions, archivedSessions]);
  // Workstreams open on first paint. A user collapse is local interaction
  // state; new or newly loaded sections therefore remain open by default.
  const [collapsedChannelSections, setCollapsedChannelSections] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setCollapsedChannelSections(new Set());
  }, [rail.workspaceId]);
  const toggleChannelSection = useCallback((sectionKey: string) => {
    setCollapsedChannelSections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  }, []);
  const submitCreateChannel = useCallback(async () => {
    const name = channelNameDraft.trim();
    if (!name) return;
    const created = await requestCreateChannel({ name });
    if (created) {
      setChannelDialogOpen(false);
      setChannelNameDraft("");
    } else {
      toast.error("Couldn't create the project. The name may already be in use.");
    }
  }, [channelNameDraft, requestCreateChannel]);
  const onMoveToChannel = useCallback(
    async (
      session: Session,
      channelId: string | null,
      restoreFocusTo: SessionFocusTarget = "row",
    ) => {
      if (session.channelId === channelId) return;
      const acceptedTransition = context.captureWorkspaceInvocation(session.workspaceId);
      if (!acceptedTransition) return;
      const moveRequest = context.sessionChannelProjectionAuthority.beginMove(
        moveRequestOwner.current,
        session,
      );
      if (!moveRequest) return;
      const operation = moveRequest.operation;
      const focusOperation = ++focusRestoreOperation.current;
      pendingSessionFocus.current = {
        sessionId: session.id,
        operation: focusOperation,
        target: restoreFocusTo,
        settled: false,
      };
      setCollapsedChannelSections((current) => {
        const destinationKey = channelId ?? "default";
        if (!current.has(destinationKey)) return current;
        const next = new Set(current);
        next.delete(destinationKey);
        return next;
      });
      setChannelMoveOverrides((current) =>
        beginSessionChannelMove(current, session.id, channelId, operation),
      );
      try {
        let moved: Session | null = null;
        try {
          moved = await context.client.updateSessionChannel(session.workspaceId, session.id, {
            channelId,
          });
        } catch {
          // Preserve the existing optimistic rollback UX, while keeping the
          // raw successful response available after this component unmounts.
        }
        if (
          !context.ownsWorkspaceInvocation(session.workspaceId, acceptedTransition) ||
          !context.sessionChannelProjectionAuthority.ownsMove(moveRequestOwner.current, moveRequest)
        ) {
          return;
        }
        if (moved) {
          // The successful write response is exact evidence. Settlement
          // fences reads that started before it returned, while a completed
          // newer read requires the post-response point verification below.
          const disposition = context.sessionChannelProjectionAuthority.recordMove(
            moveRequestOwner.current,
            moveRequest,
            moved,
          );
          if (disposition === "rejected") {
            setChannelMoveOverrides((current) =>
              discardRejectedSessionChannelMove(current, session.id, operation),
            );
            return;
          }
          setChannelMoveOverrides((current) =>
            commitSessionChannelMove(current, session.id, moved.channelId ?? null, operation),
          );
          context.setSession((current) =>
            current?.id === moved.id && current.workspaceId === moved.workspaceId
              ? { ...current, channelId: moved.channelId ?? null }
              : current,
          );
          // Always start and await an exact read after the successful response
          // settles. It distinguishes the committed B from a genuinely newer
          // C; if it fails, the persistent move token and settlement fence keep
          // B visible through rail remounts and late overlapping reads.
          await verifySessionChannelMove(session.id, operation);
        } else {
          setChannelMoveOverrides((current) =>
            rollbackSessionChannelMove(current, session.id, operation),
          );
          toast.error("Couldn't move the workstream. Its previous project was restored.");
        }
        await refreshSessionPages();
      } finally {
        context.sessionChannelProjectionAuthority.finishMove(moveRequestOwner.current, moveRequest);
        const pending = pendingSessionFocus.current;
        if (pending?.sessionId === session.id && pending.operation === focusOperation) {
          pending.settled = true;
          setFocusRestoreRevision((current) => current + 1);
        }
      }
    },
    [context, refreshSessionPages, verifySessionChannelMove],
  );
  const onToggleProjectPin = useCallback(
    async (project: Channel) => {
      const updated = await updateProject(project.id, { pinned: !project.pinned });
      if (!updated) toast.error("Couldn't update the project pin.");
    },
    [updateProject],
  );
  const onDeleteProject = useCallback(async (): Promise<boolean> => {
    if (!projectPendingDelete) return false;
    const deleted = await removeProject(projectPendingDelete.id);
    if (!deleted) {
      toast.error("Couldn't delete the project.");
      return false;
    }
    await refreshSessionPages();
    return true;
  }, [projectPendingDelete, refreshSessionPages, removeProject]);
  const onReorderProjects = useCallback(
    async (sourceProjectId: string, targetProjectId: string) => {
      if (sourceProjectId === targetProjectId) return;
      const sourceIndex = channels.findIndex((project) => project.id === sourceProjectId);
      const sourceProject = channels[sourceIndex];
      const targetProject = channels.find((project) => project.id === targetProjectId);
      if (!sourceProject || !targetProject) return;
      if (sourceProject.pinned !== targetProject.pinned) {
        toast.error(
          "Pinned projects stay at the top. Pin or unpin it before moving it between groups.",
        );
        return;
      }
      const ordered = [...channels];
      const [moved] = ordered.splice(sourceIndex, 1);
      if (!moved) return;
      // Dropping on a project always places the dragged project immediately
      // before it, regardless of whether the source began above or below.
      ordered.splice(
        ordered.findIndex((project) => project.id === targetProjectId),
        0,
        moved,
      );
      const result = await reorderProjects(ordered.map((project) => project.id));
      if (!result) toast.error("Couldn't save the project order. Try again.");
    },
    [channels, reorderProjects],
  );
  const onUpdateAttention = useCallback<UpdateAttentionFn>(
    async (session, update) => {
      try {
        const updated = await context.client.updateSessionAttention(rail.workspaceId, session.id, {
          ...update,
          expectedVersion: session.attentionVersion ?? 0,
        });
        // The open session has a separate detail/SSE projection from the rail
        // page. Reflect the mutation there immediately; waiting for a later
        // navigation or stream event left the action menu showing stale text.
        context.setSession((current) =>
          current?.id === updated.id
            ? {
                ...current,
                unread: updated.unread,
                activelyWorking: updated.activelyWorking,
                attentionVersion: updated.attentionVersion,
              }
            : current,
        );
        await refreshSessionPages();
      } catch (attentionError) {
        toast.error("Couldn't update the session status.", {
          description:
            attentionError instanceof Error ? attentionError.message : String(attentionError),
        });
        await refreshSessionPages();
      }
    },
    [context, rail.workspaceId, refreshSessionPages],
  );
  const onArchive = useCallback<ArchiveFn>(
    async (session, archived) => {
      if (archiving.current.has(session.id)) return;
      archiving.current.add(session.id);
      setArchiveTransitions((current) => new Set(current).add(session.id));
      try {
        const updated = await context.client.updateSessionArchive(rail.workspaceId, session.id, {
          archived,
          expectedVersion: session.archiveVersion ?? 0,
        });
        context.setSession((current) =>
          current?.id === updated.id
            ? {
                ...current,
                archived: updated.archived,
                archivedAt: updated.archivedAt,
                archiveVersion: updated.archiveVersion,
                pinned: updated.pinned,
                pinnedAt: updated.pinnedAt,
                pinVersion: updated.pinVersion,
                activelyWorking: updated.activelyWorking,
                attentionVersion: updated.attentionVersion,
              }
            : current,
        );
        toast.success(archived ? "Chat archived" : "Chat restored");
        await refreshSessionPages();
      } catch (archiveError) {
        toast.error(archived ? "Couldn't archive the chat." : "Couldn't restore the chat.", {
          description: archiveError instanceof Error ? archiveError.message : String(archiveError),
        });
        await refreshSessionPages();
      } finally {
        archiving.current.delete(session.id);
        setArchiveTransitions((current) => {
          const next = new Set(current);
          next.delete(session.id);
          return next;
        });
      }
    },
    [context, rail.workspaceId, refreshSessionPages],
  );
  const onDeleteSession = useCallback(async (): Promise<boolean> => {
    if (!sessionPendingDelete) return false;
    try {
      const result = await context.client.deleteSession(rail.workspaceId, sessionPendingDelete.id);
      const viewingDeletedTree = context.session?.rootSessionId === sessionPendingDelete.id;
      if (viewingDeletedTree) {
        context.resetSessionView();
        await navigate({
          to: "/workspaces/$workspaceId/sessions",
          params: { workspaceId: rail.workspaceId },
          replace: true,
        });
      }
      await refreshSessionPages();
      toast.success(
        result.deletedSessionCount === 1
          ? "Session deleted"
          : `${result.deletedSessionCount} sessions deleted`,
      );
      return true;
    } catch (deleteError) {
      toast.error("Couldn't delete the workstream.", {
        description: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      return false;
    }
  }, [context, navigate, rail.workspaceId, refreshSessionPages, sessionPendingDelete]);
  const nodesById = useMemo(() => {
    const result = new Map<string, SessionTreeNode>();
    const visit = (node: SessionTreeNode): void => {
      if (result.has(node.session.id)) return;
      result.set(node.session.id, node);
      for (const child of node.children) visit(child);
    };
    for (const node of railSections.complete.running) visit(node);
    for (const bucket of railSections.complete.grouped) {
      for (const node of bucket.sessions) visit(node);
    }
    return result;
  }, [railSections.complete]);

  // Manual state is separate from the small derived active-path expansion.
  // Polls can therefore never reopen a branch the user explicitly collapsed.
  const [manualExpanded, setManualExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [manualCollapsed, setManualCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const parentOf = useMemo(() => {
    const map = new Map<string, string>();
    const byId = new Set(allSessions.map((session) => session.id));
    for (const session of allSessions) {
      if (session.parentSessionId && byId.has(session.parentSessionId)) {
        map.set(session.id, session.parentSessionId);
      }
    }
    return map;
  }, [allSessions]);
  const activeAncestorIds = useMemo(
    () => sessionAncestorPath(activeSessionId, parentOf),
    [activeSessionId, parentOf],
  );
  const autoExpanded = useMemo(
    () => defaultExpandedAncestors(activeAncestorIds, manualCollapsed),
    [activeAncestorIds, manualCollapsed],
  );
  const expanded = useMemo(
    () => new Set([...manualExpanded, ...autoExpanded]),
    [autoExpanded, manualExpanded],
  );
  useEffect(() => {
    setManualExpanded(new Set());
    setManualCollapsed(new Set());
  }, [rail.workspaceId]);
  const loadChildPage = useCallback(
    async (
      parentSessionId: string,
      cursor?: string,
      preserve: readonly Session[] = [],
    ): Promise<void> => {
      const epoch = childLoadEpoch.current;
      if (!branchSummaryKeys.current.has(parentSessionId)) {
        const parent = branchParentsById.current.get(parentSessionId);
        if (parent) {
          branchSummaryKeys.current.set(parentSessionId, sessionBranchSummaryKey(parent));
        }
      }
      childRequestSequence.current += 1;
      const requestId = childRequestSequence.current;
      setChildPages((current) =>
        beginSessionBranchRequest(current, parentSessionId, requestId, cursor),
      );
      try {
        const readGeneration = context.sessionChannelProjectionAuthority.beginRead();
        const page = await context.client.listSessionPage(rail.workspaceId, {
          limit: 50,
          parentSessionId,
          ...(cursor ? { cursor } : {}),
          archivedOnly: false,
        });
        if (childLoadEpoch.current !== epoch) return;
        setChildPages((current) =>
          commitSessionBranchPage(
            current,
            parentSessionId,
            {
              sessions: [...page.sessions, ...page.pinned],
              nextCursor: page.nextCursor,
            },
            {
              append: cursor !== undefined,
              preserve,
              requestId,
              readGeneration,
            },
          ),
        );
      } catch {
        if (childLoadEpoch.current !== epoch) return;
        setChildPages((current) => failSessionBranchRequest(current, parentSessionId, requestId));
      }
    },
    [context.client, context.sessionChannelProjectionAuthority, rail.workspaceId],
  );
  // The active route supplies exact child + ancestor detail even before the
  // lazy branch query catches up. Commit that projection into the branch cache
  // and reconcile the complete sibling page once, so leaving the child route
  // cannot make the row disappear again.
  useEffect(() => {
    const active = context.session;
    if (!hierarchyMode || !active?.parentSessionId) {
      activeBranchHydration.current = null;
      return;
    }
    setChildPages((current) => upsertSessionBranchChild(current, active));
    const hydrationKey = `${active.parentSessionId}:${active.id}`;
    if (activeBranchHydration.current === hydrationKey) return;
    activeBranchHydration.current = hydrationKey;
    void loadChildPage(active.parentSessionId, undefined, [active]);
  }, [context.session, hierarchyMode, loadChildPage]);

  // Deep active routes auto-expand their ancestor path. Load every missing
  // parent page on that path, not just the active session's immediate siblings,
  // so leaving the route does not collapse lineage-only projections back out of
  // the durable rail hierarchy.
  useEffect(() => {
    if (!hierarchyMode) return;
    const activeParentSessionId = context.session?.parentSessionId ?? null;
    for (const parentId of autoExpanded) {
      if (parentId === activeParentSessionId) continue;
      const page = childPages.get(parentId);
      if (page && !page.stale) continue;
      const node = nodesById.get(parentId);
      const knownDirectChildren =
        node?.session.treeStats?.directChildren ?? node?.children.length ?? 0;
      if (knownDirectChildren > 0) void loadChildPage(parentId);
    }
  }, [
    autoExpanded,
    childPages,
    context.session?.parentSessionId,
    hierarchyMode,
    loadChildPage,
    nodesById,
  ]);

  // Root pages are polled server truth and carry bounded descendant summaries.
  // When a loaded branch's summary changes (notably directChildren after an
  // orchestrator spawn), refresh that exact branch instead of retaining its old
  // child list forever. This preserves root-only pagination and lazy hierarchy
  // while making newly authorized children durable sidebar state.
  useEffect(() => {
    const parentsById = new Map(allSessions.map((session) => [session.id, session]));
    const loadedParentIds = new Set(childPages.keys());
    const newlyStale = new Set<string>();
    for (const parentId of branchSummaryKeys.current.keys()) {
      if (!loadedParentIds.has(parentId)) branchSummaryKeys.current.delete(parentId);
    }
    for (const [parentId, page] of childPages) {
      const parent = parentsById.get(parentId);
      if (!parent) continue;
      const nextKey = sessionBranchSummaryKey(parent);
      const previousKey = branchSummaryKeys.current.get(parentId);
      const decision = sessionBranchSummaryDecision({
        previousKey,
        nextKey,
        loading: page.loading,
        expanded: expanded.has(parentId),
        stale: page.stale,
      });
      if (decision.acknowledge) branchSummaryKeys.current.set(parentId, nextKey);
      if (decision.refresh) void loadChildPage(parentId);
      else if (decision.markStale) newlyStale.add(parentId);
    }
    if (newlyStale.size > 0) {
      setChildPages((current) => {
        const next = new Map(current);
        for (const parentId of newlyStale) {
          const page = next.get(parentId);
          if (page) next.set(parentId, { ...page, stale: true });
        }
        return next;
      });
    }
  }, [allSessions, childPages, expanded, loadChildPage]);
  const toggleExpand = useCallback(
    (sessionId: string) => {
      const opening = !expanded.has(sessionId);
      setManualExpanded((current) => {
        const next = new Set(current);
        if (opening) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
      setManualCollapsed((current) => {
        const next = new Set(current);
        if (opening) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      const node = nodesById.get(sessionId);
      const knownDirectChildren =
        node?.session.treeStats?.directChildren ?? node?.children.length ?? 0;
      if (
        opening &&
        hierarchyMode &&
        knownDirectChildren > 0 &&
        (!childPages.has(sessionId) ||
          childPages.get(sessionId)?.failed === true ||
          childPages.get(sessionId)?.stale === true)
      ) {
        void loadChildPage(sessionId);
      }
    },
    [childPages, expanded, hierarchyMode, loadChildPage, nodesById],
  );
  const visibleRows = useMemo(() => {
    const seen = new Set<string>();
    // Channel mode replaces the ordinary recency forest with channel sections;
    // the flattened order must match the rendered order or arrow keys drift.
    const ordinaryRows = channelMode
      ? channelSections.flatMap((section) =>
          !collapsedChannelSections.has(section.key)
            ? visibleTreeRows(section.sessions, expanded, activeSessionId)
            : (() => {
                const selected = findSessionTreeNode(section.sessions, activeSessionId);
                return selected ? [{ node: selected, depth: 0 }] : [];
              })(),
        )
      : visibleForestRows(forest, expanded, activeSessionId);
    return [...visibleTreeRows(pinnedNodes, expanded, activeSessionId), ...ordinaryRows].filter(
      ({ node }) => {
        if (seen.has(node.session.id)) return false;
        seen.add(node.session.id);
        return true;
      },
    );
  }, [
    activeSessionId,
    channelMode,
    channelSections,
    expanded,
    collapsedChannelSections,
    forest,
    pinnedNodes,
  ]);
  const flat = useMemo<Session[]>(() => visibleRows.map((row) => row.node.session), [visibleRows]);

  useLayoutEffect(() => {
    const pending = pendingSessionFocus.current;
    const root = listRef.current;
    if (!pending || !root) return;
    const operation = pending.operation;
    let cancelled = false;
    let frame: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const restore = () => {
      if (cancelled) return;
      const current = pendingSessionFocus.current;
      if (!current || current.operation !== operation) return;
      const attribute = sessionFocusAttribute(current.target);
      const destination = [...root.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
        (element) => element.getAttribute(attribute) === current.sessionId,
      );
      if (
        destination &&
        shouldRestoreSessionFocus(
          document.activeElement as HTMLElement | null,
          destination,
          current.sessionId,
          document.body,
        )
      ) {
        try {
          destination.focus({ preventScroll: true });
        } catch {
          // A concurrent query transition can remove the destination between
          // the connectivity check and focus(). The next fenced attempt is the
          // only safe recovery; never fall back to an unrelated element.
        }
      }
    };
    const finish = () => {
      restore();
      const current = pendingSessionFocus.current;
      if (current?.operation === operation && current.settled) {
        pendingSessionFocus.current = null;
      }
    };

    // Layout handles the optimistic/rollback commit. The microtask lets
    // Radix finish its close bookkeeping, and rAF handles the post-animation
    // remount; every attempt is fenced to this exact operation.
    restore();
    queueMicrotask(() => {
      restore();
      if (cancelled) return;
      if (typeof window.requestAnimationFrame === "function") {
        frame = window.requestAnimationFrame(finish);
      } else {
        timeout = setTimeout(finish, 0);
      }
    });

    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [flat, focusRestoreRevision]);

  const onPin = useCallback<PinFn>(
    async (target, nextPinned, restoreFocusTo = "row") => {
      if (pinning.current.has(target.id)) {
        return target;
      }
      const acceptedTransition = context.captureWorkspaceInvocation(target.workspaceId);
      if (!acceptedTransition) return null;
      pinning.current.add(target.id);
      const operation = ++pinOperation.current;
      const focusOperation = ++focusRestoreOperation.current;
      // An optimistic pin moves the row between different group subtrees. That
      // remounts the Radix menu trigger before Radix can restore keyboard focus.
      // Keep the intended destination through the whole request so a failed
      // mutation that rolls the row back also restores focus after its remount.
      pendingSessionFocus.current = {
        sessionId: target.id,
        operation: focusOperation,
        target: restoreFocusTo,
        settled: false,
      };
      const optimistic: Session = {
        ...target,
        pinned: nextPinned,
        pinnedAt: nextPinned ? new Date().toISOString() : null,
        pinVersion: (target.pinVersion ?? 0) + 1,
      };
      setPinOverrides((current) =>
        new Map(current).set(target.id, { session: optimistic, operation }),
      );
      try {
        const updated = await context.updateSessionPin(
          target.workspaceId,
          target.id,
          nextPinned,
          target.pinVersion ?? 0,
        );
        if (!context.ownsWorkspaceInvocation(target.workspaceId, acceptedTransition)) return null;
        if (updated) {
          setPinOverrides((current) => {
            if (current.get(target.id)?.operation !== operation) return current;
            return new Map(current).set(target.id, {
              session: updated,
              operation,
            });
          });
        }
        await refreshSessionPages();
        if (!context.ownsWorkspaceInvocation(target.workspaceId, acceptedTransition)) return null;
        const label = sessionDisplayTitle(target);
        announcePinResult(
          updated
            ? `${nextPinned ? "Pinned" : "Unpinned"} ${label}.`
            : `${label} was not ${nextPinned ? "pinned" : "unpinned"}. Server state refreshed.`,
        );
        return updated;
      } finally {
        pinning.current.delete(target.id);
        const pending = pendingSessionFocus.current;
        if (pending?.sessionId === target.id && pending.operation === focusOperation) {
          pending.settled = true;
          setFocusRestoreRevision((current) => current + 1);
        }
        setPinOverrides((current) => {
          if (current.get(target.id)?.operation !== operation) return current;
          const next = new Map(current);
          next.delete(target.id);
          return next;
        });
      }
    },
    [announcePinResult, context, refreshSessionPages],
  );

  const loadMore = useCallback(async () => {
    if (!continuationCursor || loadingMore) return;
    const requestGeneration = pageGeneration;
    let requestSnapshotReadRevision = continuationSnapshotReadRevision;
    let requestSnapshotReadGeneration = continuationSnapshotReadGeneration;
    let requestSnapshotSource = continuationSnapshotSource;
    const attempt = ++loadMoreAttempt.current;
    const requestIsCurrent = (): boolean =>
      paginationIdentity.current.generation === requestGeneration &&
      loadMoreAttempt.current === attempt;
    const listPage = async (
      cursor?: string,
    ): Promise<{ page: SessionListResponse; readGeneration: number }> => {
      const readGeneration = context.sessionChannelProjectionAuthority.beginRead();
      const page = await context.client.listSessionPage(rail.workspaceId, {
        limit: 50,
        ...(cursor ? { cursor } : {}),
        ...(search ? { search } : {}),
        ...(hierarchyMode ? { parentSessionId: null } : {}),
        archivedOnly: false,
      });
      return { page, readGeneration };
    };
    setLoadingMoreGeneration(requestGeneration);
    setContinuation((current) => ({
      ...activeSessionContinuation(current, requestGeneration),
      failed: false,
    }));
    try {
      let page: SessionListResponse;
      let pageReadGeneration: number;
      try {
        const continuationRead = await listPage(continuationCursor);
        page = continuationRead.page;
        pageReadGeneration = continuationRead.readGeneration;
      } catch (cursorError) {
        if (!(cursorError instanceof OpenGeniSessionListCursorError)) throw cursorError;

        // The snapshot behind the retained cursor expired. Re-read page one
        // once, fence it to this query, and continue immediately from its new
        // cursor. A second expiry bubbles to the normal retryable failure path
        // instead of creating an unbounded cursor-refresh loop.
        const rebaseRead = await listPage();
        const freshFirstPage = rebaseRead.page;
        if (!requestIsCurrent()) return;
        requestSnapshotReadRevision = attempt;
        requestSnapshotReadGeneration = rebaseRead.readGeneration;
        requestSnapshotSource = "rebase";
        setContinuation((current) =>
          rebaseSessionContinuation(
            current,
            pageGeneration,
            requestGeneration,
            freshFirstPage,
            requestSnapshotReadRevision,
            requestSnapshotReadGeneration,
            requestSnapshotSource,
          ),
        );
        if (!freshFirstPage.nextCursor) {
          setAnnouncement("No more older sessions.");
          return;
        }
        const continuationRead = await listPage(freshFirstPage.nextCursor);
        page = continuationRead.page;
        pageReadGeneration = continuationRead.readGeneration;
      }
      if (!requestIsCurrent()) return;
      setContinuation((current) =>
        mergeSessionContinuation(
          current,
          pageGeneration,
          requestGeneration,
          page,
          requestSnapshotReadRevision,
          requestSnapshotReadGeneration,
          requestSnapshotSource,
          pageReadGeneration,
        ),
      );
      setAnnouncement(
        page.sessions.length === 0
          ? "No more older sessions."
          : `Loaded ${page.sessions.length} older session${page.sessions.length === 1 ? "" : "s"}.`,
      );
    } catch {
      if (!requestIsCurrent()) return;
      // Keep already loaded rows and make this bounded page explicitly
      // retryable; a silent no-op would look like pagination had ended.
      setContinuation((current) => ({
        ...activeSessionContinuation(current, requestGeneration),
        failed: true,
      }));
      setAnnouncement("Older sessions did not load. Retry is available.");
    } finally {
      if (requestIsCurrent()) {
        setLoadingMoreGeneration(null);
      }
    }
  }, [
    context.client,
    continuationCursor,
    continuationSnapshotReadGeneration,
    continuationSnapshotReadRevision,
    continuationSnapshotSource,
    context.sessionChannelProjectionAuthority,
    hierarchyMode,
    loadingMore,
    pageGeneration,
    rail.workspaceId,
    search,
  ]);

  // Cross-tab invalidation and lifecycle reconciliation. Cross-device changes
  // arrive on the 15s poll; returning to a tab or reconnecting refreshes now.
  useEffect(
    () => subscribeToSessionPinChanges(rail.workspaceId, () => void refreshSessionPages()),
    [rail.workspaceId, refreshSessionPages],
  );
  useEffect(() => {
    const reconcile = () => void refreshSessionPages();
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshSessionPages]);

  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const rowFocusIntent = useRef<string | null>(null);
  const focusIndex = useMemo(() => {
    const preferredId = focusedSessionId ?? activeSessionId;
    const preferred = preferredId ? flat.findIndex((session) => session.id === preferredId) : -1;
    return preferred >= 0 ? preferred : flat.length > 0 ? 0 : -1;
  }, [activeSessionId, flat, focusedSessionId]);

  // Follow the active session only when the ROUTE changes. Polls, pagination,
  // pin reorder, and cross-device reconciliation also replace `flat`; those
  // refreshes must preserve a keyboard user's still-visible roving target
  // instead of stealing focus back to the route-active row.
  const previousActiveSessionId = useRef(activeSessionId);
  useEffect(() => {
    const routeChanged = previousActiveSessionId.current !== activeSessionId;
    previousActiveSessionId.current = activeSessionId;
    if (routeChanged) {
      rowRevealIntent.current = activeSessionId;
    }
    setFocusedSessionId((current) => {
      if (!routeChanged && current && flat.some((session) => session.id === current)) {
        return current;
      }
      if (activeSessionId && flat.some((session) => session.id === activeSessionId)) {
        return activeSessionId;
      }
      return flat[0]?.id ?? null;
    });
  }, [activeSessionId, flat]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (flat.length === 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (!target?.hasAttribute("data-session-focus")) {
        return;
      }
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        nextIndex = Math.min(flat.length - 1, focusIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        nextIndex = Math.max(0, focusIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        nextIndex = 0;
      } else if (event.key === "End") {
        event.preventDefault();
        nextIndex = flat.length - 1;
      }
      const next = nextIndex === null ? null : flat[nextIndex];
      if (next && shouldRecordSessionRowFocusIntent(nextIndex, focusIndex)) {
        rowFocusIntent.current = next.id;
        setFocusedSessionId(next.id);
      } else {
        // A boundary key is a navigation no-op. Clear any older intent
        // synchronously so a later list refresh cannot steal focus from a row
        // action that the user focused after the no-op.
        rowFocusIntent.current = null;
      }
    },
    [flat, focusIndex],
  );

  // Consume an explicit reveal/focus intent once. Data churn can rerun this
  // effect, but with no intent it owns neither DOM focus nor rail scroll.
  // Layout timing makes real DOM focus part of the discrete keyboard commit;
  // a passive effect can leave Home/End visibly on the prior row for a frame.
  useLayoutEffect(() => {
    const root = listRef.current;
    if (focusIndex < 0 || !root) {
      return;
    }
    const requestedFocusId = rowFocusIntent.current;
    const requestedRevealId = rowRevealIntent.current;
    const requestedSessionId = requestedFocusId ?? requestedRevealId;
    if (!requestedSessionId) {
      return;
    }
    const row = [...root.querySelectorAll<HTMLElement>("[data-session-row]")].find(
      (candidate) => candidate.dataset.sessionRow === requestedSessionId,
    );
    if (!row) {
      return;
    }
    // Arrow/Home/End navigation must move real DOM focus, not just paint a
    // visual highlight. A route/poll/pin reorder has no such intent and must
    // never steal focus from an actions trigger or another active control.
    if (requestedFocusId) {
      const renderedSessionId = flat[focusIndex]?.id ?? null;
      if (
        pendingSessionFocus.current ||
        !root.contains(document.activeElement) ||
        !shouldMoveSessionRowFocus(requestedFocusId, renderedSessionId)
      ) {
        rowFocusIntent.current = null;
        return;
      }
      rowFocusIntent.current = null;
      row.scrollIntoView({ block: "nearest" });
      row.focus();
    } else {
      consumeSessionRowRevealIntent(root, rowRevealIntent);
    }
  }, [flat, focusIndex]);

  useEffect(() => {
    if (loading || (!search && !browseControlsActive)) return;
    const count = browseSessions.length;
    setAnnouncement(`${count} matching session${count === 1 ? "" : "s"}.`);
  }, [browseControlsActive, browseSessions.length, loading, search]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-2 pb-1 pl-[18px] pr-3 pt-1">
        <span className="text-sm font-normal text-fg-muted">
          {hierarchyMode ? "Sessions" : search ? "Search results" : "Browse sessions"}
        </span>
      </div>

      <div className="mb-1 ml-2 mr-3 flex shrink-0 items-center gap-1">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search sessions</span>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle"
          />
          <input
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchDraft) {
                event.preventDefault();
                setSearchDraft("");
              }
            }}
            maxLength={200}
            placeholder="Search"
            aria-label="Search sessions"
            className="h-7 w-full min-w-0 rounded-md border border-border bg-bg/45 pl-7 pr-2 text-xs text-fg outline-none placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40 pointer-coarse:h-11 pointer-coarse:text-base"
          />
        </label>
        {hierarchyMode ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="New project"
                onClick={() => setChannelDialogOpen(true)}
                className="shrink-0 text-fg-muted hover:text-fg pointer-coarse:size-11"
              >
                <FolderPlusIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">New project</TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={browseControlsActive ? "Session filters, active" : "Session filters"}
              className={cn(
                "relative shrink-0 text-fg-muted hover:text-fg pointer-coarse:size-11",
                browseControlsActive && "bg-surface-2 text-fg",
              )}
            >
              <ListFilterIcon className="size-3.5" />
              {browseControlsActive ? (
                <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-brand" />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Group sessions</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={browseGroupBy}
              onValueChange={(value) => setBrowseGroupBy(value as SessionBrowseGroupBy)}
            >
              <DropdownMenuRadioItem value="activity">Last activity</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created">Created date</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="creator">Creator</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                Date field
                <span className="ml-auto mr-1 text-2xs text-fg-subtle">
                  {browseDateField === "activity" ? "Activity" : "Created"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                <DropdownMenuRadioGroup
                  value={browseDateField}
                  onValueChange={(value) => setBrowseDateField(value as SessionBrowseDateField)}
                >
                  <DropdownMenuRadioItem value="activity">Last activity</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="created">Created date</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                Date range
                <span className="ml-auto mr-1 text-2xs text-fg-subtle">
                  {browseDateRange === "any"
                    ? "Any"
                    : browseDateRange === "today"
                      ? "Today"
                      : browseDateRange === "week"
                        ? "7d"
                        : "30d"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-40">
                <DropdownMenuRadioGroup
                  value={browseDateRange}
                  onValueChange={(value) => setBrowseDateRange(value as SessionBrowseDateRange)}
                >
                  <DropdownMenuRadioItem value="any">Any time</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="today">Today</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="week">Last 7 days</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="month">Last 30 days</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                Creator
                <span className="ml-auto mr-1 max-w-20 truncate text-2xs text-fg-subtle">
                  {browseCreator
                    ? (creatorOptions.find((option) => option.value === browseCreator)?.label ??
                      "Selected")
                    : "Anyone"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) w-52 overflow-x-hidden overflow-y-auto">
                <DropdownMenuRadioGroup
                  value={browseCreator ?? "all"}
                  onValueChange={(value) => setBrowseCreator(value === "all" ? null : value)}
                >
                  <DropdownMenuRadioItem value="all">Anyone</DropdownMenuRadioItem>
                  {creatorOptions.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      <span className="truncate">{option.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {browseControlsActive ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearBrowseControls}>Reset view</DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-2xs leading-4 text-fg-subtle">
              Filters cover loaded sessions. Load older sessions to extend the result set.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        ref={listRef}
        role="region"
        aria-label={hierarchyMode ? "Sessions" : search ? "Session search results" : "Sessions"}
        data-sessionpin-session-list
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          // Direct reader input cancels a reveal whose target has not mounted
          // yet. A generic scroll handler cannot distinguish that input from
          // browser anchoring caused by page merges and other DOM reflow.
          cancelSessionRowRevealIntent(rowRevealIntent);
        }}
        onTouchStart={() => {
          cancelSessionRowRevealIntent(rowRevealIntent);
        }}
        onWheel={() => {
          cancelSessionRowRevealIntent(rowRevealIntent);
        }}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 pl-2 pr-3"
      >
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {(loading && allSessions.length === 0) ||
        (hierarchyMode && channelsQuery.loading && channels.length === 0) ? (
          // The second clause holds the skeleton until the initial channels
          // read resolves, so the rail paints Recents/workstreams directly
          // instead of flashing the old recency layout first.
          <SessionListSkeleton />
        ) : error && allSessions.length === 0 ? (
          <div role="alert" className="px-2 py-3 text-xs text-fg-subtle">
            Session history is unavailable.{" "}
            <button
              type="button"
              className="underline hover:text-fg"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        ) : flat.length === 0 && (search || browseControlsActive) ? (
          <div className="px-2 py-4 text-center text-xs text-fg-subtle">
            <p>No sessions match this view.</p>
            {continuationCursor ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="mt-2 min-h-8 rounded px-2 font-medium text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60 pointer-coarse:min-h-11"
              >
                {loadingMore ? "Loading…" : "Load older sessions"}
              </button>
            ) : null}
            <button
              type="button"
              className="mt-2 min-h-8 rounded px-2 underline hover:text-fg pointer-coarse:min-h-11"
              onClick={() => {
                setSearchDraft("");
                clearBrowseControls();
              }}
            >
              Clear search and filters
            </button>
          </div>
        ) : browseSessions.length === 0 && !hierarchyMode ? (
          <EmptySessions />
        ) : (
          <>
            {pinnedNodes.length > 0 ? (
              <>
                <SessionGroup
                  label="Pinned"
                  nodes={pinnedNodes}
                  localDeliveryAttention={localDeliveryAttention}
                  flat={flat}
                  activeSessionId={activeSessionId}
                  focusIndex={focusIndex}
                  onFocusSession={setFocusedSessionId}
                  expanded={expanded}
                  onToggleExpand={toggleExpand}
                  childPages={childPages}
                  onLoadMoreChildren={loadChildPage}
                  onRename={context.updateSessionTitle}
                  onPin={onPin}
                  channels={channels}
                  onMoveToChannel={onMoveToChannel}
                  onUpdateAttention={onUpdateAttention}
                  onArchive={onArchive}
                  onRequestDelete={setSessionPendingDelete}
                />
                {pinnedTruncated ? (
                  <p className="px-2 pb-2 text-[11px] text-fg-subtle" role="status">
                    Showing the 100 most recently pinned sessions. Older pins are omitted.
                  </p>
                ) : null}
              </>
            ) : null}
            {channelMode ? (
              channelSections.map((section) => (
                <SessionGroup
                  key={section.key}
                  label={section.name}
                  channelId={section.channelId}
                  sectionId={`channel-${section.key}`}
                  channelHeader
                  project={
                    section.channelId
                      ? channels.find((project) => project.id === section.channelId)
                      : undefined
                  }
                  onToggleProjectPin={onToggleProjectPin}
                  onDeleteProject={setProjectPendingDelete}
                  draggedProjectId={draggedProjectId}
                  dragOverProjectId={dragOverProjectId}
                  onProjectDragStart={setDraggedProjectId}
                  onProjectDragOver={setDragOverProjectId}
                  onProjectDrop={(sourceProjectId, targetProjectId) => {
                    void onReorderProjects(sourceProjectId, targetProjectId);
                    setDraggedProjectId(null);
                    setDragOverProjectId(null);
                  }}
                  onProjectDragEnd={() => {
                    setDraggedProjectId(null);
                    setDragOverProjectId(null);
                  }}
                  sectionExpanded={!collapsedChannelSections.has(section.key)}
                  onToggleSection={() => toggleChannelSection(section.key)}
                  nodes={section.sessions}
                  localDeliveryAttention={localDeliveryAttention}
                  flat={flat}
                  activeSessionId={activeSessionId}
                  focusIndex={focusIndex}
                  onFocusSession={setFocusedSessionId}
                  expanded={expanded}
                  onToggleExpand={toggleExpand}
                  childPages={childPages}
                  onLoadMoreChildren={loadChildPage}
                  onRename={context.updateSessionTitle}
                  onPin={onPin}
                  channels={channels}
                  onMoveToChannel={onMoveToChannel}
                  onUpdateAttention={onUpdateAttention}
                  onArchive={onArchive}
                  onRequestDelete={setSessionPendingDelete}
                />
              ))
            ) : (
              <>
                {forest.running.length > 0 ? (
                  <SessionGroup
                    label="Active"
                    nodes={forest.running}
                    localDeliveryAttention={localDeliveryAttention}
                    flat={flat}
                    activeSessionId={activeSessionId}
                    focusIndex={focusIndex}
                    onFocusSession={setFocusedSessionId}
                    expanded={expanded}
                    onToggleExpand={toggleExpand}
                    childPages={childPages}
                    onLoadMoreChildren={loadChildPage}
                    onRename={context.updateSessionTitle}
                    onPin={onPin}
                    channels={channels}
                    onMoveToChannel={onMoveToChannel}
                    onUpdateAttention={onUpdateAttention}
                    onArchive={onArchive}
                    onRequestDelete={setSessionPendingDelete}
                  />
                ) : null}
                {forest.grouped.map((bucket) => (
                  <SessionGroup
                    key={bucket.group}
                    label={bucket.label}
                    nodes={bucket.sessions}
                    localDeliveryAttention={localDeliveryAttention}
                    flat={flat}
                    activeSessionId={activeSessionId}
                    focusIndex={focusIndex}
                    onFocusSession={setFocusedSessionId}
                    expanded={expanded}
                    onToggleExpand={toggleExpand}
                    childPages={childPages}
                    onLoadMoreChildren={loadChildPage}
                    onRename={context.updateSessionTitle}
                    onPin={onPin}
                    channels={channels}
                    onMoveToChannel={onMoveToChannel}
                    onUpdateAttention={onUpdateAttention}
                    onArchive={onArchive}
                    onRequestDelete={setSessionPendingDelete}
                  />
                ))}
              </>
            )}
            {hierarchyMode ? (
              <SessionGroup
                label="Archived"
                sectionId="archived"
                channelHeader
                allowNewSession={false}
                showSummary={false}
                sectionExpanded={archivedOpen}
                onToggleSection={() => setArchivedOpen((current) => !current)}
                nodes={archivedNodes}
                localDeliveryAttention={localDeliveryAttention}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                onFocusSession={setFocusedSessionId}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                childPages={childPages}
                onLoadMoreChildren={loadChildPage}
                onRename={context.updateSessionTitle}
                onPin={onPin}
                channels={channels}
                onMoveToChannel={onMoveToChannel}
                onUpdateAttention={onUpdateAttention}
                onArchive={onArchive}
                onRequestDelete={setSessionPendingDelete}
              />
            ) : null}
            {continuationCursor ? (
              <div className="px-2 py-2 text-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  className="min-h-8 rounded-md px-2 text-xs font-medium text-fg-subtle hover:bg-surface-2 hover:text-fg disabled:opacity-60 pointer-coarse:min-h-11"
                >
                  {loadingMore
                    ? "Loading…"
                    : loadMoreError
                      ? "Retry older sessions"
                      : "Load older sessions"}
                </button>
                {loadMoreError ? (
                  <p role="status" className="mt-1 text-2xs text-status-failed">
                    Older sessions didn&apos;t load.
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      <ChannelCreateDialog
        open={channelDialogOpen}
        name={channelNameDraft}
        busy={channelsQuery.mutating}
        onNameChange={setChannelNameDraft}
        onOpenChange={(open) => {
          setChannelDialogOpen(open);
          if (!open) setChannelNameDraft("");
        }}
        onSubmit={() => void submitCreateChannel()}
      />
      <ConfirmDialog
        open={sessionPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSessionPendingDelete(null);
        }}
        title={
          <>Delete “{sessionPendingDelete ? sessionDisplayTitle(sessionPendingDelete) : ""}”?</>
        }
        description={
          sessionPendingDelete?.treeStats?.totalDescendants
            ? `This permanently deletes the complete workstream and its ${sessionPendingDelete.treeStats.totalDescendants} spawned sessions. This cannot be undone.`
            : "This permanently deletes the session and its history. This cannot be undone."
        }
        confirmLabel="Delete workstream"
        cancelAutoFocus
        onConfirm={onDeleteSession}
      />
      <ConfirmDialog
        open={projectPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setProjectPendingDelete(null);
        }}
        title={<>Delete project “{projectPendingDelete?.name}”?</>}
        description="Its sessions will remain available in Default. This cannot be undone."
        confirmLabel="Delete project"
        cancelAutoFocus
        onConfirm={onDeleteProject}
      />
    </div>
  );
}

function SessionGroup(props: {
  label: string;
  /**
   * Stable DOM id suffix. Required for folder sections: labels are
   * user-controlled, so slugging them can collide with each other and with
   * the fixed groups ("Pinned", the synthetic "Recents").
   */
  sectionId?: string;
  /** Real folder id. Null identifies the synthetic Recents section. */
  channelId?: string | null;
  /** Folder-styled, collapsible header instead of the recency label. */
  channelHeader?: boolean;
  /** Archived folders are navigational only; new chats always start active. */
  allowNewSession?: boolean;
  project?: Channel;
  onToggleProjectPin?: (project: Channel) => void;
  onDeleteProject?: (project: Channel) => void;
  draggedProjectId?: string | null;
  dragOverProjectId?: string | null;
  onProjectDragStart?: (projectId: string) => void;
  onProjectDragOver?: (projectId: string) => void;
  onProjectDrop?: (sourceProjectId: string, targetProjectId: string) => void;
  onProjectDragEnd?: () => void;
  /** Archive is a destination, not an attention summary. */
  showSummary?: boolean;
  sectionExpanded?: boolean;
  onToggleSection?: () => void;
  nodes: SessionTreeNode[];
  localDeliveryAttention: ReadonlyMap<string, number>;
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  onFocusSession: (sessionId: string) => void;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
  childPages: ReadonlyMap<string, ChildPageState>;
  onLoadMoreChildren: (sessionId: string, cursor?: string) => Promise<void>;
  onRename: RenameFn;
  onPin: PinFn;
  channels: Channel[];
  onMoveToChannel: MoveToChannelFn;
  onUpdateAttention: UpdateAttentionFn;
  onArchive: ArchiveFn;
  onRequestDelete: RequestDeleteFn;
}) {
  const sectionId = `session-group-${
    props.sectionId ?? props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  }`;
  const sectionExpanded = props.channelHeader ? Boolean(props.sectionExpanded) : true;
  const summary = summarizeRailNodes(props.nodes, props.localDeliveryAttention);
  const collapsedSelection = props.channelHeader
    ? findSessionTreeNode(props.nodes, props.activeSessionId)
    : null;
  const renderedNodes = sectionExpanded
    ? props.nodes
    : collapsedSelection
      ? [collapsedSelection]
      : [];
  const treeExpanded = sectionExpanded ? props.expanded : EMPTY_SESSION_IDS;
  return (
    <div role="group" aria-label={props.label} className="mb-1.5 min-w-0">
      {props.channelHeader ? (
        <div
          draggable={Boolean(props.project)}
          onDragStart={(event: DragEvent<HTMLDivElement>) => {
            if (!props.project) return;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", props.project.id);
            props.onProjectDragStart?.(props.project.id);
          }}
          onDragOver={(event: DragEvent<HTMLDivElement>) => {
            if (!props.project) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            props.onProjectDragOver?.(props.project.id);
          }}
          onDrop={(event: DragEvent<HTMLDivElement>) => {
            if (!props.project) return;
            event.preventDefault();
            const sourceProjectId = event.dataTransfer.getData("text/plain");
            if (sourceProjectId) props.onProjectDrop?.(sourceProjectId, props.project.id);
          }}
          onDragEnd={props.onProjectDragEnd}
          className={cn(
            "group/section relative flex h-8 w-full min-w-0 items-center rounded-md pr-1 text-fg hover:bg-surface-2 pointer-coarse:h-11",
            props.project && "cursor-grab active:cursor-grabbing",
            props.project && props.draggedProjectId === props.project.id && "opacity-45",
            props.project &&
              props.dragOverProjectId === props.project.id &&
              props.draggedProjectId !== props.project.id &&
              "ring-1 ring-inset ring-accent",
          )}
        >
          <button
            id={sectionId}
            type="button"
            aria-expanded={sectionExpanded}
            aria-controls={`${sectionId}-sessions`}
            onClick={props.onToggleSection}
            title={`${summary.label} · ${summary.total} total`}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left text-sm font-normal text-fg"
          >
            <span className="flex w-4 shrink-0 items-center">
              {sectionExpanded ? (
                <FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">{props.label}</span>
            {props.showSummary !== false ? <RailTrailingMetadata summary={summary} /> : null}
          </button>
          {props.project ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${props.label}`}
                  className={cn(
                    "absolute top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded bg-surface-2 text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover/section:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100",
                    props.allowNewSession !== false ? "right-7" : "right-0.5",
                  )}
                >
                  <EllipsisIcon aria-hidden="true" className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="right">
                <DropdownMenuItem onSelect={() => props.onToggleProjectPin?.(props.project!)}>
                  <PinIcon
                    aria-hidden="true"
                    className={props.project.pinned ? "size-3.5 fill-current" : "size-3.5"}
                  />
                  {props.project.pinned ? "Unpin project" : "Pin project"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => props.onDeleteProject?.(props.project!)}
                >
                  <Trash2Icon aria-hidden="true" className="size-3.5" />
                  Delete project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {props.allowNewSession !== false ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <NewSessionLink
                  channelId={props.channelId ?? undefined}
                  aria-label={`New chat in ${props.label}`}
                  className="absolute right-0.5 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded bg-surface-2 text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover/section:opacity-100 pointer-coarse:right-0 pointer-coarse:size-9 pointer-coarse:opacity-100"
                >
                  <PlusIcon aria-hidden="true" className="size-3.5" />
                </NewSessionLink>
              </TooltipTrigger>
              <TooltipContent side="right">New chat in {props.label}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : (
        <p
          id={sectionId}
          className="px-1.5 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-wider text-fg-muted"
        >
          {props.label}
        </p>
      )}
      {renderedNodes.length > 0 ? (
        <div
          id={`${sectionId}-sessions`}
          role="list"
          aria-label={`${props.label} sessions`}
          className="grid min-w-0 grid-cols-1 gap-px"
        >
          {renderedNodes.map((node) => (
            <SessionTreeRow
              key={node.session.id}
              node={node}
              localDeliveryAttention={props.localDeliveryAttention}
              depth={0}
              flat={props.flat}
              activeSessionId={props.activeSessionId}
              focusIndex={props.focusIndex}
              onFocusSession={props.onFocusSession}
              expanded={treeExpanded}
              onToggleExpand={props.onToggleExpand}
              childPages={props.childPages}
              onLoadMoreChildren={props.onLoadMoreChildren}
              onRename={props.onRename}
              onPin={props.onPin}
              channels={props.channels}
              onMoveToChannel={props.onMoveToChannel}
              onUpdateAttention={props.onUpdateAttention}
              onArchive={props.onArchive}
              onRequestDelete={props.onRequestDelete}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A node plus, when expanded, its spawned children rendered one level deeper. */
function SessionTreeRow(props: {
  node: SessionTreeNode;
  localDeliveryAttention: ReadonlyMap<string, number>;
  depth: number;
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  onFocusSession: (sessionId: string) => void;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
  childPages: ReadonlyMap<string, ChildPageState>;
  onLoadMoreChildren: (sessionId: string, cursor?: string) => Promise<void>;
  onRename: RenameFn;
  onPin: PinFn;
  channels: Channel[];
  onMoveToChannel: MoveToChannelFn;
  onUpdateAttention: UpdateAttentionFn;
  onArchive: ArchiveFn;
  onRequestDelete: RequestDeleteFn;
}) {
  const { node } = props;
  const index = props.flat.indexOf(node.session);
  const directChildCount = node.session.treeStats?.directChildren ?? node.children.length;
  // Server treeStats only counts spawned descendants. Repeat runs of a scheduled
  // task are folded in client-side, so take whichever is larger or a grouped
  // entry renders with no child region at all.
  const childCount = Math.max(node.session.treeStats?.totalDescendants ?? 0, node.children.length);
  const childCountTruncated = node.session.treeStats?.truncated ?? false;
  const hasChildren = directChildCount > 0 || node.children.length > 0;
  const aggregateStatus = summarizeRailNodes([node], props.localDeliveryAttention);
  const isExpanded = props.expanded.has(node.session.id);
  const childPage = props.childPages.get(node.session.id);
  // A collapsed branch keeps only its selected descendant visible, rendered as
  // the same ordinary row used by the expanded list. This preserves context
  // without opening the whole branch or introducing a second navigation shape.
  const collapsedSelectedNode = !isExpanded
    ? selectedDescendantNode(node, props.activeSessionId)
    : null;
  const title = sessionDisplayTitle(node.session);
  const hasVisibleChildRegion = Boolean(collapsedSelectedNode || (isExpanded && childCount > 0));
  return (
    <div role="listitem" className="min-w-0">
      <SessionRow
        session={node.session}
        index={index}
        depth={props.depth}
        childCount={childCount}
        childCountTruncated={childCountTruncated}
        hasChildren={hasChildren}
        expanded={isExpanded}
        aggregateStatus={aggregateStatus}
        onToggleExpand={() => props.onToggleExpand(node.session.id)}
        active={node.session.id === props.activeSessionId}
        focused={index >= 0 && index === props.focusIndex}
        onFocus={() => props.onFocusSession(node.session.id)}
        onRename={props.onRename}
        onPin={props.onPin}
        channels={props.channels}
        onMoveToChannel={props.onMoveToChannel}
        onUpdateAttention={props.onUpdateAttention}
        onArchive={props.onArchive}
        onRequestDelete={props.onRequestDelete}
      />
      {hasVisibleChildRegion ? (
        <div role="list" aria-label={`Spawned sessions from ${title}`}>
          {collapsedSelectedNode ? (
            <SessionTreeRow
              node={collapsedSelectedNode}
              localDeliveryAttention={props.localDeliveryAttention}
              depth={props.depth + 1}
              flat={props.flat}
              activeSessionId={props.activeSessionId}
              focusIndex={props.focusIndex}
              onFocusSession={props.onFocusSession}
              expanded={props.expanded}
              onToggleExpand={props.onToggleExpand}
              childPages={props.childPages}
              onLoadMoreChildren={props.onLoadMoreChildren}
              onRename={props.onRename}
              onPin={props.onPin}
              channels={props.channels}
              onMoveToChannel={props.onMoveToChannel}
              onUpdateAttention={props.onUpdateAttention}
              onArchive={props.onArchive}
              onRequestDelete={props.onRequestDelete}
            />
          ) : null}
          {childCount > 0 && isExpanded
            ? node.children.map((child) => (
                <SessionTreeRow
                  key={child.session.id}
                  node={child}
                  localDeliveryAttention={props.localDeliveryAttention}
                  depth={props.depth + 1}
                  flat={props.flat}
                  activeSessionId={props.activeSessionId}
                  focusIndex={props.focusIndex}
                  onFocusSession={props.onFocusSession}
                  expanded={props.expanded}
                  onToggleExpand={props.onToggleExpand}
                  childPages={props.childPages}
                  onLoadMoreChildren={props.onLoadMoreChildren}
                  onRename={props.onRename}
                  onPin={props.onPin}
                  channels={props.channels}
                  onMoveToChannel={props.onMoveToChannel}
                  onUpdateAttention={props.onUpdateAttention}
                  onArchive={props.onArchive}
                  onRequestDelete={props.onRequestDelete}
                />
              ))
            : null}
          {isExpanded && childPage?.loading ? (
            <TreeLoadRow depth={props.depth + 1} text="Loading sessions…" />
          ) : null}
          {isExpanded && childPage?.failed ? (
            <TreeLoadRow
              depth={props.depth + 1}
              text="Retry loading sessions"
              onClick={() =>
                void props.onLoadMoreChildren(node.session.id, childPage.retryCursor ?? undefined)
              }
            />
          ) : null}
          {isExpanded && !childPage?.loading && !childPage?.failed && childPage?.nextCursor ? (
            <TreeLoadRow
              depth={props.depth + 1}
              text="Show more"
              onClick={() => void props.onLoadMoreChildren(node.session.id, childPage.nextCursor!)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TreeLoadRow({
  depth,
  text,
  onClick,
}: {
  depth: number;
  text: string;
  onClick?: () => void;
}) {
  const style = { paddingLeft: 26 + visualTreeDepth(depth) * 12 };
  return onClick ? (
    <div role="listitem">
      <button
        type="button"
        onClick={onClick}
        style={style}
        className="h-8 w-full rounded-md pr-2 text-left text-xs text-fg-subtle hover:bg-surface-2 hover:text-fg pointer-coarse:h-11"
      >
        {text}
      </button>
    </div>
  ) : (
    <div role="listitem">
      <div style={style} className="flex h-8 items-center text-xs text-fg-subtle" role="status">
        {text}
      </div>
    </div>
  );
}

function SessionRow(props: {
  session: Session;
  index: number;
  /** Nesting depth; children indent one step per level. */
  depth: number;
  /** Spawned-child count; a chevron + badge appear when > 0. */
  childCount: number;
  /** True when childCount is a server traversal lower bound. */
  childCountTruncated: boolean;
  hasChildren: boolean;
  expanded: boolean;
  /** One status for this session and every hidden descendant. */
  aggregateStatus: RailAggregateStatus;
  onToggleExpand: () => void;
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  onRename: RenameFn;
  onPin: PinFn;
  channels: Channel[];
  onMoveToChannel: MoveToChannelFn;
  onUpdateAttention: UpdateAttentionFn;
  onArchive: ArchiveFn;
  onRequestDelete: RequestDeleteFn;
}) {
  const rail = useRail();
  const context = useAppContext();
  const title = sessionDisplayTitle(props.session);
  const rename = useInlineRename(props.session, props.onRename);
  const contextPinSelection = useRef(false);
  const hasChildren = props.hasChildren;
  const creator = railRowCreator(props.session);
  const stateLabel = sessionStateLabel(props.session);
  const descendantLabel = sessionDescendantLabel(props.session);
  const childCountAria = sessionDescendantCountAria(props.childCount, props.childCountTruncated);
  const depthLabel = props.depth > MAX_VISUAL_TREE_DEPTH ? `Level ${props.depth + 1}` : null;
  const relativeTime = relativeTimeLabel(props.session.updatedAt);
  // Indent nested rows without changing the root title column. Parents and
  // leaves reserve the same compact disclosure slot, so the chevron does not
  // push a parent title away from the leaf titles beside it.
  const indentStyle =
    props.depth > 0 ? { marginLeft: visualTreeDepth(props.depth) * 12 } : undefined;

  const rowClassName = cn(
    "group relative flex h-8 w-full items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-left text-sm pointer-coarse:h-11 pointer-coarse:py-0",
    rail.isMobile && "h-12 py-1.5 pointer-coarse:h-12",
    "hover:bg-surface-2",
    props.active ? "bg-surface-3 font-medium text-fg" : "text-fg-muted",
    props.focused && !props.active ? "bg-surface-2/60" : "",
  );

  const lead = (
    <span className="flex w-4 shrink-0 items-center" style={indentStyle}>
      {hasChildren ? (
        <button
          type="button"
          aria-label={props.expanded ? "Collapse spawned sessions" : "Expand spawned sessions"}
          aria-expanded={props.expanded}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleExpand();
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-11"
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-90")}
          />
        </button>
      ) : null}
    </span>
  );

  // While renaming, the row body becomes an inline input. SessionTreeRow owns
  // the listitem semantics so its spawned-session list can remain nested.
  if (rename.editing) {
    return (
      <div className={rowClassName}>
        <ActiveAccent active={props.active} />
        {lead}
        <input
          ref={rename.inputRef}
          data-session-index={props.index}
          data-session-focus
          tabIndex={props.focused ? 0 : -1}
          onFocus={props.onFocus}
          value={rename.draft}
          onChange={(event) => rename.setDraft(event.target.value)}
          onBlur={() => void rename.commit()}
          onKeyDown={(event) => {
            // Keep keystrokes (incl. Arrow/Enter/Esc) inside the field, away
            // from the list's keyboard navigation.
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              void rename.commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              rename.cancel();
            }
          }}
          maxLength={SESSION_TITLE_MAX_LENGTH}
          aria-label="Session title"
          className="min-w-0 flex-1 truncate rounded-sm bg-transparent text-sm outline-none ring-1 ring-ring/40 focus-visible:ring-ring"
        />
        <RailTrailingMetadata
          summary={props.aggregateStatus}
          scheduled={Boolean(scheduledTaskIdOf(props.session))}
          relativeTime={rail.isMobile ? undefined : relativeTime}
          creator={creator}
        />
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          title={`${title} — ${stateLabel} — ${props.aggregateStatus.label}`}
          className={rowClassName}
        >
          <ActiveAccent active={props.active} />
          {lead}
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId: rail.workspaceId, sessionId: props.session.id }}
            data-session-index={props.index}
            data-session-focus
            data-session-row={props.session.id}
            tabIndex={props.focused ? 0 : -1}
            aria-current={props.active ? "page" : undefined}
            aria-label={sessionRowAccessibleName({
              title,
              stateLabel,
              pinned: Boolean(props.session.pinned),
              statusLabel: props.aggregateStatus.label,
              spawnedLabel: hasChildren ? childCountAria.replace("descendant", "spawned") : null,
              creator,
            })}
            onFocus={props.onFocus}
            onClick={(event) => {
              if (isModifiedNavigationClick(event)) return;
              if (
                props.session.unread &&
                !props.session.archived &&
                document.visibilityState === "visible" &&
                document.hasFocus()
              ) {
                const projection: SessionAttentionProjection = {
                  id: props.session.id,
                  workspaceId: props.session.workspaceId,
                  unread: false,
                  attentionVersion: props.session.attentionVersion,
                  lastSequence: props.session.lastSequence,
                };
                // A rail click is already a foreground view. Commit its exact
                // known frontier before route data loads so a fast second
                // navigation cannot cancel the read.
                notifySessionAttentionChanged(projection);
                const acceptedTransition = context.captureWorkspaceInvocation(
                  props.session.workspaceId,
                );
                if (acceptedTransition) {
                  const acknowledge = (retry: boolean): void => {
                    void context.client
                      .updateSessionAttention(props.session.workspaceId, props.session.id, {
                        unread: false,
                        acknowledgedThroughSequence: props.session.lastSequence,
                      })
                      .then((updated) => {
                        if (
                          context.ownsWorkspaceInvocation(
                            props.session.workspaceId,
                            acceptedTransition,
                          )
                        ) {
                          notifySessionAttentionChanged(updated);
                        }
                      })
                      .catch(() => {
                        if (
                          retry &&
                          context.ownsWorkspaceInvocation(
                            props.session.workspaceId,
                            acceptedTransition,
                          )
                        ) {
                          acknowledge(false);
                        }
                      });
                  };
                  acknowledge(true);
                }
              }
              if (!rail.isMobile) {
                requestSessionComposerFocus(rail.workspaceId, props.session.id);
              }
              rail.setDrawerOpen(false);
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
          >
            <SessionRowContent
              title={title}
              stateLabel={stateLabel}
              depthLabel={depthLabel}
              descendantLabel={descendantLabel}
              mobile={rail.isMobile}
              summary={props.aggregateStatus}
              scheduled={Boolean(scheduledTaskIdOf(props.session))}
              relativeTime={rail.isMobile ? undefined : relativeTime}
              creator={creator}
            />
          </Link>
          <RowActionsMenu
            session={props.session}
            onRename={rename.startEditing}
            onPin={props.onPin}
            channels={props.channels}
            onMoveToChannel={props.onMoveToChannel}
            onUpdateAttention={props.onUpdateAttention}
            onArchive={props.onArchive}
            onRequestDelete={props.onRequestDelete}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-40"
        data-session-menu={props.session.id}
        onCloseAutoFocus={(event) => {
          if (!contextPinSelection.current) return;
          // The original trigger is about to be unmounted by the optimistic
          // group move. SessionList restores the corresponding remounted row.
          event.preventDefault();
          contextPinSelection.current = false;
        }}
      >
        <ContextMenuItem className="pointer-coarse:min-h-11" onSelect={rename.startEditing}>
          <PencilIcon className="size-4" />
          Rename
        </ContextMenuItem>
        {!props.session.archived ? (
          <>
            <ContextMenuItem
              className="pointer-coarse:min-h-11"
              onSelect={() => {
                contextPinSelection.current = true;
                void props.onPin(props.session, !props.session.pinned, "row");
              }}
            >
              <PinIcon className={props.session.pinned ? "size-4 fill-current" : "size-4"} />
              {props.session.pinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            <ContextMenuItem
              className="pointer-coarse:min-h-11"
              onSelect={() =>
                void props.onUpdateAttention(props.session, { unread: !props.session.unread })
              }
            >
              {props.session.unread ? (
                <MailOpenIcon className="size-4" />
              ) : (
                <MailIcon className="size-4" />
              )}
              {props.session.unread ? "Mark as read" : "Mark as unread"}
            </ContextMenuItem>
            <ContextMenuItem
              className="pointer-coarse:min-h-11"
              onSelect={() =>
                void props.onUpdateAttention(props.session, {
                  activelyWorking: !props.session.activelyWorking,
                })
              }
            >
              <CircleDashedIcon className="size-4" />
              {props.session.activelyWorking ? "Stop actively working" : "Mark as actively working"}
            </ContextMenuItem>
          </>
        ) : null}
        {props.session.parentSessionId === null ? (
          <ContextMenuItem
            className="pointer-coarse:min-h-11"
            onSelect={() => void props.onArchive(props.session, !props.session.archived)}
          >
            <ArchiveIcon className="size-4" />
            {props.session.archived ? "Restore" : "Archive"}
          </ContextMenuItem>
        ) : null}
        {props.session.parentSessionId === null && props.session.archived ? (
          <ContextMenuItem
            className="pointer-coarse:min-h-11 text-status-failed"
            onSelect={() => props.onRequestDelete(props.session)}
          >
            <Trash2Icon className="size-4" />
            Delete workstream
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function sessionDescendantLabel(session: Session): string | null {
  const stats = session.treeStats;
  if (!stats || stats.totalDescendants === 0) return null;
  const live = stats.runningDescendants + stats.queuedDescendants;
  const total = sessionDescendantCountText(stats.totalDescendants, stats.truncated);
  if (stats.attentionDescendants > 0) {
    const waiting = stats.attentionSince ? formatWaitingSince(stats.attentionSince) : "";
    return `${stats.attentionDescendants} need you${waiting ? ` for ${waiting}` : ""} · ${total} total`;
  }
  if (live > 0) return `${live} active · ${total} total`;
  return `${total} session${stats.totalDescendants === 1 && !stats.truncated ? "" : "s"}`;
}

/** The active-session accent bar shared by the row's display and edit modes. */
function ActiveAccent({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand transition-opacity",
        active ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * The hover/focus rename affordance: a small overflow button revealed on row
 * hover (and always visible while keyboard-focused, for a11y) that opens a
 * minimal menu whose primary action is Rename. The button stops click
 * propagation so opening the menu never opens the session.
 */
function RowActionsMenu({
  session,
  onRename,
  onPin,
  channels,
  onMoveToChannel,
  onUpdateAttention,
  onArchive,
  onRequestDelete,
}: {
  session: Session;
  onRename: () => void;
  onPin: PinFn;
  channels: Channel[];
  onMoveToChannel: MoveToChannelFn;
  onUpdateAttention: UpdateAttentionFn;
  onArchive: ArchiveFn;
  onRequestDelete: RequestDeleteFn;
}) {
  const remountSelection = useRef(false);
  // Filing is a root-session concept: the rail groups a whole tree by its
  // root's channel, so children offer no move affordance.
  const canMove = channels.length > 0 && session.parentSessionId === null && !session.archived;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${sessionDisplayTitle(session)}`}
          data-session-actions={session.id}
          onClick={(event) => event.stopPropagation()}
          className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2 bg-surface-2 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:right-0 pointer-coarse:size-11 pointer-coarse:opacity-100"
        >
          <EllipsisIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40"
        data-session-menu={session.id}
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          if (!remountSelection.current) return;
          // The optimistic projection remounts the trigger under another
          // SessionGroup; the list-level focus owner targets that new node.
          event.preventDefault();
          remountSelection.current = false;
        }}
      >
        <DropdownMenuItem
          className="pointer-coarse:min-h-11"
          onSelect={onRename}
          // The menu item lives inside the row; stop the synthetic click from
          // activating the session link.
          onClick={(event) => event.stopPropagation()}
        >
          <PencilIcon className="size-4" />
          Rename
        </DropdownMenuItem>
        {!session.archived ? (
          <>
            <DropdownMenuItem
              className="pointer-coarse:min-h-11"
              onSelect={() => {
                remountSelection.current = true;
                void onPin(session, !session.pinned, "actions");
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <PinIcon className={session.pinned ? "size-4 fill-current" : "size-4"} />
              {session.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="pointer-coarse:min-h-11"
              onSelect={() => void onUpdateAttention(session, { unread: !session.unread })}
              onClick={(event) => event.stopPropagation()}
            >
              {session.unread ? (
                <MailOpenIcon className="size-4" />
              ) : (
                <MailIcon className="size-4" />
              )}
              {session.unread ? "Mark as read" : "Mark as unread"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="pointer-coarse:min-h-11"
              onSelect={() =>
                void onUpdateAttention(session, { activelyWorking: !session.activelyWorking })
              }
              onClick={(event) => event.stopPropagation()}
            >
              <CircleDashedIcon className="size-4" />
              {session.activelyWorking ? "Stop actively working" : "Mark as actively working"}
            </DropdownMenuItem>
          </>
        ) : null}
        {session.parentSessionId === null ? (
          <DropdownMenuItem
            className="pointer-coarse:min-h-11"
            onSelect={() => void onArchive(session, !session.archived)}
            onClick={(event) => event.stopPropagation()}
          >
            <ArchiveIcon className="size-4" />
            {session.archived ? "Restore" : "Archive"}
          </DropdownMenuItem>
        ) : null}
        {session.parentSessionId === null && session.archived ? (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onRequestDelete(session)}
            onClick={(event) => event.stopPropagation()}
          >
            <Trash2Icon className="size-4" />
            Delete workstream
          </DropdownMenuItem>
        ) : null}
        {canMove ? (
          // Flat section, deliberately not a Radix submenu: the Sub primitives
          // are otherwise unused in the shell graph and pulling them in
          // re-clusters ~470 KB of shared chunks into the startup bundle.
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs font-medium uppercase tracking-wider text-fg-subtle">
              Move to project
            </DropdownMenuLabel>
            {channels.map((channel) => (
              <DropdownMenuItem
                key={channel.id}
                className="pointer-coarse:min-h-11"
                disabled={session.channelId === channel.id}
                onSelect={() => {
                  remountSelection.current = true;
                  void onMoveToChannel(session, channel.id, "actions");
                }}
                onClick={(event) => event.stopPropagation()}
              >
                <span className="truncate">{channel.name}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              className="pointer-coarse:min-h-11"
              disabled={session.channelId === null}
              onSelect={() => {
                remountSelection.current = true;
                void onMoveToChannel(session, null, "actions");
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <Clock3Icon className="size-4" />
              Default
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptySessions({ archived = false }: { archived?: boolean }) {
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
      <p className="text-xs text-fg-subtle">
        {archived ? "No archived sessions" : "No sessions yet"}
      </p>
      {!archived ? (
        <Button asChild size="sm" className="mx-auto">
          <NewSessionLink>
            <PlusIcon className="size-3.5" />
            Start your first session
          </NewSessionLink>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Collapsed-rail stand-in for the list: a Sessions icon carrying a count badge
 * of running sessions; clicking expands the rail to reveal the full list.
 */
export function CollapsedSessionsButton() {
  const rail = useRail();
  const { sessions, loading, error } = useWorkspaceSessions({
    limit: 50,
    pollIntervalMs: 15_000,
  });
  const runningCount = useMemo(() => groupSessionsForRail(sessions).running.length, [sessions]);
  // The collapsed rail can't render the expanded list's loading/error copy, so
  // it mirrors those states: a failed load shows a failed-tone marker + tooltip
  // (expanding reveals the retry), a first load shows a gentle pulse.
  const failed = Boolean(error) && sessions.length === 0;
  const firstLoad = loading && sessions.length === 0;
  const tooltip = failed ? "Session history is unavailable" : "Sessions";
  return (
    <div className="flex flex-1 flex-col items-center gap-1 px-2 pt-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={
              failed
                ? "Sessions (history unavailable)"
                : `Sessions${runningCount > 0 ? ` (${runningCount} running)` : ""}`
            }
            onClick={() => rail.setCollapsed(false)}
            className="relative text-fg-muted hover:text-fg"
          >
            <MessagesSquareIcon
              className={cn("size-4", firstLoad && "motion-safe:animate-pulse")}
            />
            {failed ? (
              <span className="absolute -right-0.5 -top-0.5 flex size-2 rounded-full bg-status-failed" />
            ) : runningCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-brand-strong px-1 text-2xs font-semibold leading-tight text-brand-fg">
                {runningCount}
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SessionListSkeleton() {
  const skeletonRows = [
    "session-skeleton-1",
    "session-skeleton-2",
    "session-skeleton-3",
    "session-skeleton-4",
    "session-skeleton-5",
  ];
  return (
    <div className="grid gap-1 px-1 pt-2">
      {skeletonRows.map((rowKey) => (
        <div key={rowKey} className="flex h-8 items-center gap-2 px-1">
          <span className="size-1.5 shrink-0 rounded-full bg-surface-3" />
          <span className="h-3 flex-1 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
