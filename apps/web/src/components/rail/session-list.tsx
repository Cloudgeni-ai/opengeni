// The session list — the rail's home. Reuses the same useWorkspaceSessions
// hook the old sessions index used, groups by recency (running pinned on top),
// and supports ArrowUp/Down + Enter keyboard navigation. Each row is a status
// dot + single-line truncated title + relative time (visible at rest). The
// active session (from the URL) is highlighted with an accent bar.
import { useSessionLineage, useWorkspaceSessions } from "@opengeni/react";
import { useRouterState } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  EllipsisIcon,
  LocateFixedIcon,
  MessagesSquareIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRail } from "@/components/rail/rail-context";
import { Button } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import {
  activeSessionContinuation,
  advanceSessionPageIdentity,
  emptySessionContinuation,
  mergeSessionContinuation,
  sessionPageKey,
} from "@/lib/session-pagination";
import { SESSION_TITLE_MAX_LENGTH, useInlineRename } from "@/lib/session-rename";
import {
  MAX_VISUAL_TREE_DEPTH,
  defaultExpandedAncestors,
  sessionAncestorPath,
  sessionStateLabel,
  visualTreeDepth,
} from "@/lib/session-rail";
import { applySessionPinProjection, subscribeToSessionPinChanges } from "@/lib/session-pins";
import {
  SESSION_GROUP_LABELS,
  SESSION_GROUP_ORDER,
  buildRailForest,
  groupSessionsForRail,
  nodeIsActive,
  recencyGroupFor,
  relativeTimeLabel,
  sessionActivityTime,
  visibleForestRows,
  type SessionTreeNode,
} from "@/lib/sessions-group";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

type RenameFn = (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
type PinFn = (session: Session, pinned: boolean) => Promise<Session | null>;
type PinOverride = { session: Session; operation: number };
type ChildPageState = {
  sessions: Session[];
  nextCursor: string | null;
  loading: boolean;
  failed: boolean;
};

export function SessionList() {
  const rail = useRail();
  const context = useAppContext();
  // Poll so running sessions surface and move to the top without a manual
  // refresh; the previous index relied on a one-shot load.
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);
  const hierarchyMode = search.length === 0;
  const rootPage = useWorkspaceSessions({
    limit: 50,
    search,
    ...(hierarchyMode ? { parentSessionId: null } : {}),
    pollIntervalMs: 15_000,
  });
  // Pins are shortcuts and may point anywhere in a workstream. Fetch their
  // complete global section separately from the root-only hierarchy page; a
  // pinned child must never make either it or its descendants disappear from
  // the actual tree.
  const globalPinPage = useWorkspaceSessions({
    limit: 1,
    pollIntervalMs: 15_000,
    enabled: hierarchyMode,
  });
  const { sessions, nextCursor, loading, error, refresh } = rootPage;
  const pinned = hierarchyMode ? globalPinPage.pinned : rootPage.pinned;
  // Ordinary rows page independently of the complete pinned section. The
  // polled hook owns page one; additional pages are appended and deduplicated.
  // A filter change starts a fresh cursor chain rather than mixing snapshots.
  // The server cursor carries the first page's short-lived snapshot identity.
  // If a poll replaces that snapshot, any continuation loaded from the old
  // activity order is stale even when workspace/search are unchanged.
  const paginationKey = `${sessionPageKey(rail.workspaceId, search)}\u0000${
    hierarchyMode ? "roots" : "search"
  }\u0000${nextCursor ?? "complete"}`;
  const paginationIdentity = useRef({ key: paginationKey, generation: 0 });
  paginationIdentity.current = advanceSessionPageIdentity(
    paginationIdentity.current,
    paginationKey,
  );
  const pageGeneration = paginationIdentity.current.generation;
  const [continuation, setContinuation] = useState(() => emptySessionContinuation(pageGeneration));
  const activeContinuation = activeSessionContinuation(continuation, pageGeneration);
  const extraSessions = activeContinuation.sessions;
  const continuationCursor =
    activeContinuation.nextCursor === undefined ? nextCursor : activeContinuation.nextCursor;
  const [loadingMoreGeneration, setLoadingMoreGeneration] = useState<number | null>(null);
  const loadingMore = loadingMoreGeneration === pageGeneration;
  const loadMoreAttempt = useRef(0);
  const loadMoreError = activeContinuation.failed;
  const [announcement, setAnnouncement] = useState("");
  const [childPages, setChildPages] = useState<ReadonlyMap<string, ChildPageState>>(
    () => new Map(),
  );
  const childLoadEpoch = useRef(0);
  useEffect(() => {
    childLoadEpoch.current += 1;
    setChildPages(new Map());
  }, [rail.workspaceId, hierarchyMode]);
  // Short-lived optimistic projections only. The page returned by the server
  // remains canonical; after each mutation we replace the projection with that
  // returned row and refresh once to reconcile tabs/devices/offline recovery.
  const [pinOverrides, setPinOverrides] = useState<ReadonlyMap<string, PinOverride>>(
    () => new Map(),
  );
  const pinOperation = useRef(0);
  const pinning = useRef(new Set<string>());
  const activeLineage = useSessionLineage(context.session?.id ?? null, {
    pollIntervalMs: 30_000,
  });
  const loadedChildren = useMemo(
    () => [...childPages.values()].flatMap((page) => page.sessions),
    [childPages],
  );
  const allSessions = useMemo(() => {
    const source = new Map<string, Session>();
    // Search is intentionally flat. Normal navigation starts with real roots,
    // then adds only explicitly loaded child pages and the active session's
    // lineage. A child can therefore never become a fake root merely because
    // its parent fell outside a global recency page.
    const lineageSessions = hierarchyMode
      ? [...(activeLineage.lineage?.ancestors ?? []), ...(context.session ? [context.session] : [])]
      : [];
    // Precedence is continuation < current page < lazy children < active
    // lineage < current pinned section. Pins carry the freshest personal pin
    // revision, while route/SSE data wins for the currently open lifecycle.
    for (const session of [
      ...extraSessions,
      ...sessions,
      ...loadedChildren,
      ...lineageSessions,
      ...pinned,
    ]) {
      source.set(session.id, session);
    }
    for (const [id, override] of pinOverrides) source.set(id, override.session);
    return [...source.values()];
  }, [
    activeLineage.lineage?.ancestors,
    context.session,
    extraSessions,
    hierarchyMode,
    loadedChildren,
    pinOverrides,
    pinned,
    sessions,
  ]);
  const pinnedSessions = useMemo(
    () => allSessions.filter((session) => Boolean(session.pinned)),
    [allSessions],
  );
  const openSessionId = context.session?.id;
  const openSessionWorkspaceId = context.session?.workspaceId;
  const setContextSession = context.setSession;

  // The route header and rail intentionally keep separate projections. Merge
  // the canonical pin fields from each successful page poll into the open
  // session so a pin changed on another device cannot leave those affordances
  // disagreeing. Preserve the route/SSE-owned lifecycle and content fields.
  useEffect(() => {
    if (!openSessionId || openSessionWorkspaceId !== rail.workspaceId) return;
    const projected = allSessions.find((candidate) => candidate.id === openSessionId);
    if (!projected) return;
    setContextSession((current) => applySessionPinProjection(current, projected));
  }, [allSessions, openSessionId, openSessionWorkspaceId, rail.workspaceId, setContextSession]);

  const activeSessionId = useRouterState({
    select: (state): string | null => {
      const match = /\/sessions\/([^/]+)/.exec(state.location.pathname);
      return match?.[1] ?? null;
    },
  });

  // Search results are deliberately flat: a partial match set is not a tree.
  // Normal navigation contains only true roots, lazily loaded children, and the
  // active lineage, so buildRailForest never has to invent root placement.
  const completeForest = useMemo(
    () =>
      buildRailForest(
        hierarchyMode
          ? allSessions
          : allSessions.map((session) => ({
              ...session,
              parentSessionId: null,
            })),
      ),
    [allSessions, hierarchyMode],
  );
  const forest = useMemo(() => {
    // A pinned node is promoted with its subtree into the Pinned section. Prune
    // it recursively from the ordinary hierarchy so a pinned child is not
    // rendered twice (and keyboard focus never has two rows with one identity).
    type RemovedCounts = {
      total: number;
      running: number;
      queued: number;
      attention: number;
      paused: number;
      failed: number;
    };
    const emptyCounts = (): RemovedCounts => ({
      total: 0,
      running: 0,
      queued: 0,
      attention: 0,
      paused: 0,
      failed: 0,
    });
    const addCounts = (target: RemovedCounts, source: RemovedCounts): void => {
      target.total += source.total;
      target.running += source.running;
      target.queued += source.queued;
      target.attention += source.attention;
      target.paused += source.paused;
      target.failed += source.failed;
    };
    const subtreeCounts = (node: SessionTreeNode): RemovedCounts => {
      const stats = node.session.treeStats;
      const status = node.session.status;
      const counts: RemovedCounts = {
        total: 1,
        running: status === "running" || status === "recovering" ? 1 : 0,
        queued: status === "queued" || status === "waiting_capacity" ? 1 : 0,
        attention: status === "requires_action" ? 1 : 0,
        paused: status === "paused" ? 1 : 0,
        failed: status === "failed" ? 1 : 0,
      };
      if (stats) {
        counts.total += stats.totalDescendants;
        counts.running += stats.runningDescendants;
        counts.queued += stats.queuedDescendants;
        counts.attention += stats.attentionDescendants;
        counts.paused += stats.pausedDescendants;
        counts.failed += stats.failedDescendants;
      } else {
        for (const child of node.children) addCounts(counts, subtreeCounts(child));
      }
      return counts;
    };
    const prune = (
      node: SessionTreeNode,
    ): { node: SessionTreeNode | null; removed: RemovedCounts } => {
      if (node.session.pinned) return { node: null, removed: subtreeCounts(node) };
      const removed = emptyCounts();
      let removedDirectChildren = 0;
      const children: SessionTreeNode[] = [];
      for (const child of node.children) {
        const result = prune(child);
        addCounts(removed, result.removed);
        if (result.node) children.push(result.node);
        else removedDirectChildren += 1;
      }
      const stats = node.session.treeStats;
      const session = stats
        ? {
            ...node.session,
            treeStats: {
              directChildren: Math.max(0, stats.directChildren - removedDirectChildren),
              totalDescendants: Math.max(0, stats.totalDescendants - removed.total),
              runningDescendants: Math.max(0, stats.runningDescendants - removed.running),
              queuedDescendants: Math.max(0, stats.queuedDescendants - removed.queued),
              attentionDescendants: Math.max(0, stats.attentionDescendants - removed.attention),
              pausedDescendants: Math.max(0, stats.pausedDescendants - removed.paused),
              failedDescendants: Math.max(0, stats.failedDescendants - removed.failed),
            },
          }
        : node.session;
      const pruned = {
        session,
        children,
        hasActiveDescendant: children.some((child) => nodeIsActive(child)),
      };
      return { node: pruned, removed };
    };
    const roots = [
      ...completeForest.running,
      ...completeForest.grouped.flatMap((bucket) => bucket.sessions),
    ];
    const prunedRoots = roots.flatMap((node) => {
      const result = prune(node).node;
      return result ? [result] : [];
    });
    const running = prunedRoots
      .filter((node) => nodeIsActive(node))
      .sort(
        (left, right) => sessionActivityTime(right.session) - sessionActivityTime(left.session),
      );
    const buckets = new Map<(typeof SESSION_GROUP_ORDER)[number], SessionTreeNode[]>();
    for (const node of prunedRoots
      .filter((candidate) => !nodeIsActive(candidate))
      .sort(
        (left, right) => sessionActivityTime(right.session) - sessionActivityTime(left.session),
      )) {
      const group = recencyGroupFor(sessionActivityTime(node.session));
      const sessions = buckets.get(group) ?? [];
      sessions.push(node);
      buckets.set(group, sessions);
    }
    return {
      running,
      grouped: SESSION_GROUP_ORDER.flatMap((group) => {
        const nodes = buckets.get(group);
        return nodes?.length
          ? [{ group, label: SESSION_GROUP_LABELS[group], sessions: nodes }]
          : [];
      }),
    };
  }, [completeForest]);
  const nodesById = useMemo(() => {
    const result = new Map<string, SessionTreeNode>();
    const visit = (node: SessionTreeNode): void => {
      if (result.has(node.session.id)) return;
      result.set(node.session.id, node);
      for (const child of node.children) visit(child);
    };
    for (const node of completeForest.running) visit(node);
    for (const bucket of completeForest.grouped) {
      for (const node of bucket.sessions) visit(node);
    }
    return result;
  }, [completeForest]);
  // Pins are promoted shortcuts, not a second ownership model. If both a
  // parent and its descendant are pinned, the parent owns the visible pinned
  // subtree so no session row appears twice.
  const pinnedNodes = useMemo<SessionTreeNode[]>(() => {
    const byId = new Map(allSessions.map((session) => [session.id, session]));
    const hasPinnedAncestor = (session: Session): boolean => {
      const seen = new Set<string>();
      let parentId = session.parentSessionId;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) return false;
        if (parent.pinned) return true;
        parentId = parent.parentSessionId;
      }
      return false;
    };
    return [...pinnedSessions]
      .filter((session) => !hasPinnedAncestor(session))
      .sort(
        (left, right) =>
          Date.parse(right.pinnedAt ?? "") - Date.parse(left.pinnedAt ?? "") ||
          right.id.localeCompare(left.id),
      )
      .map(
        (session) =>
          nodesById.get(session.id) ?? {
            session,
            children: [],
            hasActiveDescendant: false,
          },
      );
  }, [allSessions, nodesById, pinnedSessions]);

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
    async (parentSessionId: string, cursor?: string): Promise<void> => {
      const epoch = childLoadEpoch.current;
      setChildPages((current) => {
        const previous = current.get(parentSessionId);
        return new Map(current).set(parentSessionId, {
          sessions: previous?.sessions ?? [],
          nextCursor: previous?.nextCursor ?? null,
          loading: true,
          failed: false,
        });
      });
      try {
        const page = await context.client.listSessionPage(rail.workspaceId, {
          limit: 50,
          parentSessionId,
          ...(cursor ? { cursor } : {}),
        });
        if (childLoadEpoch.current !== epoch) return;
        setChildPages((current) => {
          const previous = current.get(parentSessionId);
          const merged = new Map<string, Session>();
          for (const session of [
            ...(cursor ? (previous?.sessions ?? []) : []),
            ...page.sessions,
            ...page.pinned,
          ]) {
            merged.set(session.id, session);
          }
          return new Map(current).set(parentSessionId, {
            sessions: [...merged.values()],
            nextCursor: page.nextCursor,
            loading: false,
            failed: false,
          });
        });
      } catch {
        if (childLoadEpoch.current !== epoch) return;
        setChildPages((current) => {
          const previous = current.get(parentSessionId);
          return new Map(current).set(parentSessionId, {
            sessions: previous?.sessions ?? [],
            nextCursor: previous?.nextCursor ?? null,
            loading: false,
            failed: true,
          });
        });
      }
    },
    [context.client, rail.workspaceId],
  );
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
      if (opening && hierarchyMode && knownDirectChildren > 0 && !childPages.has(sessionId)) {
        void loadChildPage(sessionId);
      }
    },
    [childPages, expanded, hierarchyMode, loadChildPage, nodesById],
  );
  const revealActivePath = useCallback(() => {
    setManualExpanded((current) => new Set([...current, ...activeAncestorIds]));
    setManualCollapsed((current) => {
      const next = new Set(current);
      for (const sessionId of activeAncestorIds) next.delete(sessionId);
      return next;
    });
  }, [activeAncestorIds]);

  const visibleRows = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...pinnedNodes.map((node) => ({ node, depth: 0 })),
      ...visibleForestRows(forest, expanded),
    ].filter(({ node }) => {
      if (seen.has(node.session.id)) return false;
      seen.add(node.session.id);
      return true;
    });
  }, [pinnedNodes, forest, expanded]);
  const flat = useMemo<Session[]>(() => visibleRows.map((row) => row.node.session), [visibleRows]);

  const onPin = useCallback<PinFn>(
    async (target, nextPinned) => {
      if (pinning.current.has(target.id)) {
        return target;
      }
      pinning.current.add(target.id);
      const operation = ++pinOperation.current;
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
        if (updated) {
          setPinOverrides((current) => {
            if (current.get(target.id)?.operation !== operation) return current;
            return new Map(current).set(target.id, {
              session: updated,
              operation,
            });
          });
        }
        await Promise.all([refresh(), globalPinPage.refresh()]);
        const label = target.title?.trim() || target.initialMessage?.trim() || "Untitled session";
        setAnnouncement(
          updated
            ? `${nextPinned ? "Pinned" : "Unpinned"} ${label}.`
            : `${label} was not ${nextPinned ? "pinned" : "unpinned"}. Server state refreshed.`,
        );
        return updated;
      } finally {
        pinning.current.delete(target.id);
        setPinOverrides((current) => {
          if (current.get(target.id)?.operation !== operation) return current;
          const next = new Map(current);
          next.delete(target.id);
          return next;
        });
      }
    },
    [context, globalPinPage.refresh, refresh],
  );

  const loadMore = useCallback(async () => {
    if (!continuationCursor || loadingMore) return;
    const requestGeneration = pageGeneration;
    const attempt = ++loadMoreAttempt.current;
    setLoadingMoreGeneration(requestGeneration);
    setContinuation((current) => ({
      ...activeSessionContinuation(current, requestGeneration),
      failed: false,
    }));
    try {
      const page = await context.client.listSessionPage(rail.workspaceId, {
        limit: 50,
        cursor: continuationCursor,
        ...(search ? { search } : {}),
        ...(hierarchyMode ? { parentSessionId: null } : {}),
      });
      if (
        paginationIdentity.current.generation !== requestGeneration ||
        loadMoreAttempt.current !== attempt
      ) {
        return;
      }
      setContinuation((current) =>
        mergeSessionContinuation(current, pageGeneration, requestGeneration, page),
      );
      setAnnouncement(
        page.sessions.length === 0
          ? "No more older sessions."
          : `Loaded ${page.sessions.length} older session${page.sessions.length === 1 ? "" : "s"}.`,
      );
    } catch {
      if (
        paginationIdentity.current.generation !== requestGeneration ||
        loadMoreAttempt.current !== attempt
      ) {
        return;
      }
      // Keep already loaded rows and make this bounded page explicitly
      // retryable; a silent no-op would look like pagination had ended.
      setContinuation((current) => ({
        ...activeSessionContinuation(current, requestGeneration),
        failed: true,
      }));
      setAnnouncement("Older sessions did not load. Retry is available.");
    } finally {
      if (
        paginationIdentity.current.generation === requestGeneration &&
        loadMoreAttempt.current === attempt
      ) {
        setLoadingMoreGeneration(null);
      }
    }
  }, [
    context.client,
    continuationCursor,
    hierarchyMode,
    loadingMore,
    pageGeneration,
    rail.workspaceId,
    search,
  ]);

  // Cross-tab invalidation and lifecycle reconciliation. Cross-device changes
  // arrive on the 15s poll; returning to a tab or reconnecting refreshes now.
  useEffect(
    () => subscribeToSessionPinChanges(rail.workspaceId, () => void refresh()),
    [rail.workspaceId, refresh],
  );
  useEffect(() => {
    const reconcile = () => void refresh();
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
  }, [refresh]);

  const listRef = useRef<HTMLDivElement>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
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
      if (next) {
        setFocusedSessionId(next.id);
      }
    },
    [flat, focusIndex],
  );

  // Scroll the keyboard-focused row into view.
  useEffect(() => {
    if (focusIndex < 0 || !listRef.current) {
      return;
    }
    const row = listRef.current.querySelector<HTMLElement>(
      `[data-session-index="${focusIndex}"][data-session-focus]`,
    );
    row?.scrollIntoView({ block: "nearest" });
    // Arrow/Home/End navigation must move real DOM focus, not just paint a
    // visual highlight. Do not steal focus when a route/poll changes while the
    // user is typing elsewhere.
    if (listRef.current.contains(document.activeElement) && row !== document.activeElement) {
      row?.focus();
    }
  }, [focusIndex]);

  useEffect(() => {
    if (loading || !search) return;
    const count = allSessions.length;
    setAnnouncement(`${count} matching session${count === 1 ? "" : "s"}.`);
  }, [allSessions.length, loading, search]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 pb-1 pt-1">
        <span className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
          {hierarchyMode ? "Workstreams" : "Search results"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New session"
              onClick={rail.startNewSession}
              className="text-fg-muted hover:text-fg pointer-coarse:size-11"
            >
              <PlusIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New session · c</TooltipContent>
        </Tooltip>
      </div>

      <label className="relative mx-2 mb-1 block shrink-0">
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

      <div
        ref={listRef}
        role="region"
        aria-label={hierarchyMode ? "Workstreams" : "Session search results"}
        data-ope26-session-list
        onKeyDown={onKeyDown}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2"
      >
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {loading && allSessions.length === 0 ? (
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
        ) : flat.length === 0 && search ? (
          <div className="px-2 py-4 text-center text-xs text-fg-subtle">
            <p>No matching sessions.</p>
            <button
              type="button"
              className="mt-2 min-h-8 rounded px-2 underline hover:text-fg pointer-coarse:min-h-11"
              onClick={() => setSearchDraft("")}
            >
              Clear search
            </button>
          </div>
        ) : flat.length === 0 ? (
          <EmptySessions onStart={rail.startNewSession} />
        ) : (
          <>
            {pinnedNodes.length > 0 ? (
              <SessionGroup
                label="Pinned"
                nodes={pinnedNodes}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                onFocusSession={setFocusedSessionId}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onRevealActivePath={revealActivePath}
                childPages={childPages}
                onLoadMoreChildren={loadChildPage}
                onSelect={rail.openSession}
                onRename={context.updateSessionTitle}
                onPin={onPin}
              />
            ) : null}
            {forest.running.length > 0 ? (
              <SessionGroup
                label="Active"
                nodes={forest.running}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                onFocusSession={setFocusedSessionId}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onRevealActivePath={revealActivePath}
                childPages={childPages}
                onLoadMoreChildren={loadChildPage}
                onSelect={rail.openSession}
                onRename={context.updateSessionTitle}
                onPin={onPin}
              />
            ) : null}
            {forest.grouped.map((bucket) => (
              <SessionGroup
                key={bucket.group}
                label={bucket.label}
                nodes={bucket.sessions}
                flat={flat}
                activeSessionId={activeSessionId}
                focusIndex={focusIndex}
                onFocusSession={setFocusedSessionId}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onRevealActivePath={revealActivePath}
                childPages={childPages}
                onLoadMoreChildren={loadChildPage}
                onSelect={rail.openSession}
                onRename={context.updateSessionTitle}
                onPin={onPin}
              />
            ))}
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
    </div>
  );
}

function SessionGroup(props: {
  label: string;
  nodes: SessionTreeNode[];
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  onFocusSession: (sessionId: string) => void;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
  onRevealActivePath: () => void;
  childPages: ReadonlyMap<string, ChildPageState>;
  onLoadMoreChildren: (sessionId: string, cursor?: string) => Promise<void>;
  onSelect: (sessionId: string) => void;
  onRename: RenameFn;
  onPin: PinFn;
}) {
  return (
    <div role="group" aria-label={props.label} className="mb-1.5 min-w-0">
      <p
        id={`session-group-${props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        className="px-2 pb-0.5 pt-2 text-2xs font-medium uppercase tracking-wider text-fg-muted"
      >
        {props.label}
      </p>
      <div
        role="list"
        aria-label={`${props.label} sessions`}
        className="grid min-w-0 grid-cols-1 gap-px"
      >
        {props.nodes.map((node) => (
          <SessionTreeRow
            key={node.session.id}
            node={node}
            depth={0}
            flat={props.flat}
            activeSessionId={props.activeSessionId}
            focusIndex={props.focusIndex}
            onFocusSession={props.onFocusSession}
            expanded={props.expanded}
            onToggleExpand={props.onToggleExpand}
            onRevealActivePath={props.onRevealActivePath}
            childPages={props.childPages}
            onLoadMoreChildren={props.onLoadMoreChildren}
            onSelect={props.onSelect}
            onRename={props.onRename}
            onPin={props.onPin}
          />
        ))}
      </div>
    </div>
  );
}

/** Loaded node path from this ancestor to the URL-active session. */
function descendantPath(node: SessionTreeNode, id: string | null): SessionTreeNode[] | null {
  if (!id) return null;
  if (node.session.id === id) return [node];
  for (const child of node.children) {
    const path = descendantPath(child, id);
    if (path) return [node, ...path];
  }
  return null;
}

/** A node plus, when expanded, its spawned children rendered one level deeper. */
function SessionTreeRow(props: {
  node: SessionTreeNode;
  depth: number;
  flat: Session[];
  activeSessionId: string | null;
  focusIndex: number;
  onFocusSession: (sessionId: string) => void;
  expanded: ReadonlySet<string>;
  onToggleExpand: (sessionId: string) => void;
  onRevealActivePath: () => void;
  childPages: ReadonlyMap<string, ChildPageState>;
  onLoadMoreChildren: (sessionId: string, cursor?: string) => Promise<void>;
  onSelect: (sessionId: string) => void;
  onRename: RenameFn;
  onPin: PinFn;
}) {
  const { node } = props;
  const index = props.flat.indexOf(node.session);
  const directChildCount = node.session.treeStats?.directChildren ?? node.children.length;
  const childCount = node.session.treeStats?.totalDescendants ?? node.children.length;
  const hasChildren = directChildCount > 0 || node.children.length > 0;
  const treeHasActiveDescendant = Boolean(
    node.session.treeStats &&
    node.session.treeStats.runningDescendants +
      node.session.treeStats.queuedDescendants +
      node.session.treeStats.attentionDescendants >
      0,
  );
  const isExpanded = props.expanded.has(node.session.id);
  const childPage = props.childPages.get(node.session.id);
  // Keep the current session findable without exploding a ten-level chain.
  // The first collapsed ancestor gets one compact shortcut to the current leaf.
  const hiddenActivePath = !isExpanded ? descendantPath(node, props.activeSessionId) : null;
  const hiddenActiveSession =
    hiddenActivePath && hiddenActivePath.length > 1
      ? hiddenActivePath[hiddenActivePath.length - 1]!.session
      : null;
  return (
    <>
      <SessionRow
        session={node.session}
        index={index}
        depth={props.depth}
        childCount={childCount}
        hasChildren={hasChildren}
        expanded={isExpanded}
        hasActiveDescendant={node.hasActiveDescendant || treeHasActiveDescendant}
        onToggleExpand={() => props.onToggleExpand(node.session.id)}
        active={node.session.id === props.activeSessionId}
        focused={index >= 0 && index === props.focusIndex}
        onFocus={() => props.onFocusSession(node.session.id)}
        onSelect={props.onSelect}
        onRename={props.onRename}
        onPin={props.onPin}
      />
      {hiddenActiveSession ? (
        <ActivePathShortcut
          session={hiddenActiveSession}
          depth={props.depth + 1}
          hiddenLevels={hiddenActivePath!.length - 1}
          onReveal={props.onRevealActivePath}
        />
      ) : null}
      {childCount > 0 && isExpanded
        ? node.children.map((child) => (
            <SessionTreeRow
              key={child.session.id}
              node={child}
              depth={props.depth + 1}
              flat={props.flat}
              activeSessionId={props.activeSessionId}
              focusIndex={props.focusIndex}
              onFocusSession={props.onFocusSession}
              expanded={props.expanded}
              onToggleExpand={props.onToggleExpand}
              onRevealActivePath={props.onRevealActivePath}
              childPages={props.childPages}
              onLoadMoreChildren={props.onLoadMoreChildren}
              onSelect={props.onSelect}
              onRename={props.onRename}
              onPin={props.onPin}
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
            void props.onLoadMoreChildren(node.session.id, childPage.nextCursor ?? undefined)
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
    </>
  );
}

function ActivePathShortcut({
  session,
  depth,
  hiddenLevels,
  onReveal,
}: {
  session: Session;
  depth: number;
  hiddenLevels: number;
  onReveal: () => void;
}) {
  const rail = useRail();
  const app = useAppContext();
  const title = session.title?.trim() || session.initialMessage?.trim() || "Untitled session";
  const workspace = app.workspaces.find((candidate) => candidate.id === session.workspaceId);
  const state = sessionStateLabel(session, workspace);
  const style = { paddingLeft: 10 + visualTreeDepth(depth) * 12 };
  return (
    <div role="listitem" className="min-w-0" style={style}>
      <button
        type="button"
        onClick={onReveal}
        aria-label={`Show ${hiddenLevels}-level path to current session ${title}`}
        className={cn(
          "group flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-brand/20 bg-brand/5 px-2 text-left text-xs text-fg outline-none hover:border-brand/35 hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring/40",
          rail.isMobile && "h-12",
        )}
      >
        <LocateFixedIcon className="size-3.5 shrink-0 text-brand" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-medium">
            <span className="text-brand">Current</span> · {title}
          </span>
          <span className="mt-0.5 truncate text-2xs font-normal text-fg-subtle">
            {hiddenLevels} level{hiddenLevels === 1 ? "" : "s"} deeper · {state}
          </span>
        </span>
        <span className="shrink-0 text-2xs font-medium text-brand">Show path</span>
      </button>
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
    <button
      type="button"
      onClick={onClick}
      style={style}
      className="h-8 w-full rounded-md pr-2 text-left text-xs text-fg-subtle hover:bg-surface-2 hover:text-fg pointer-coarse:h-11"
    >
      {text}
    </button>
  ) : (
    <div style={style} className="flex h-8 items-center text-xs text-fg-subtle" role="status">
      {text}
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
  hasChildren: boolean;
  expanded: boolean;
  /** A descendant is live — a collapsed parent shows a quiet activity dot. */
  hasActiveDescendant: boolean;
  onToggleExpand: () => void;
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  onSelect: (sessionId: string) => void;
  onRename: RenameFn;
  onPin: PinFn;
}) {
  const rail = useRail();
  const app = useAppContext();
  const title =
    props.session.title?.trim() || props.session.initialMessage?.trim() || "Untitled session";
  const rename = useInlineRename(props.session, props.onRename);
  const hasChildren = props.hasChildren;
  const workspace = app.workspaces.find((candidate) => candidate.id === props.session.workspaceId);
  const stateLabel = sessionStateLabel(props.session, workspace);
  const descendantLabel = sessionDescendantLabel(props.session);
  const depthLabel = props.depth > MAX_VISUAL_TREE_DEPTH ? `Level ${props.depth + 1}` : null;
  const relativeTime = relativeTimeLabel(props.session.updatedAt);
  // Indent nested rows; the leading affordance is a chevron for parents, else a
  // spacer of the same width — reserved at every depth (root included) so every
  // status dot sits in one column and the left edge is even whether a row is a
  // leaf or a parent.
  const indentStyle =
    props.depth > 0 ? { paddingLeft: visualTreeDepth(props.depth) * 12 } : undefined;

  const rowClassName = cn(
    "group relative flex h-8 w-full items-center gap-1.5 rounded-md py-1 pl-2.5 pr-1.5 text-left text-sm transition-colors pointer-coarse:h-11 pointer-coarse:py-0",
    rail.isMobile && "h-12 py-1.5 pointer-coarse:h-12",
    "hover:bg-surface-2",
    props.active ? "bg-surface-3 font-medium text-fg" : "text-fg-muted",
    props.focused && !props.active ? "bg-surface-2/60" : "",
  );

  const lead = (
    <span className="flex shrink-0 items-center" style={indentStyle}>
      {hasChildren ? (
        <button
          type="button"
          aria-label={props.expanded ? "Collapse spawned sessions" : "Expand spawned sessions"}
          aria-expanded={props.expanded}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleExpand();
          }}
          className="inline-flex size-4 items-center justify-center rounded text-fg-subtle outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:size-11"
        >
          <ChevronRightIcon
            className={cn("size-3 transition-transform", props.expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="size-4" />
      )}
    </span>
  );

  // While renaming, the row body becomes an inline input. Keep it as a
  // listitem so the surrounding list semantics and the active accent bar hold.
  if (rename.editing) {
    return (
      <div role="listitem" className={rowClassName}>
        <ActiveAccent active={props.active} />
        {lead}
        <RailStatusDot status={props.session.status} />
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
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div role="listitem" title={`${title} — ${stateLabel}`} className={rowClassName}>
          <ActiveAccent active={props.active} />
          {lead}
          <button
            type="button"
            data-session-index={props.index}
            data-session-focus
            tabIndex={props.focused ? 0 : -1}
            aria-current={props.active ? "page" : undefined}
            aria-label={`Open ${title}. ${stateLabel}${
              props.session.pinned ? ". Pinned" : ""
            }${hasChildren ? `. ${props.childCount} spawned sessions` : ""}`}
            onFocus={props.onFocus}
            onClick={() => props.onSelect(props.session.id)}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
          >
            <RailStatusDot status={props.session.status} />
            <span className="sr-only">{stateLabel}. </span>
            {/* min-w-0 + truncate: the title must always ellipsis, never butt the
                rail border. */}
            <span className="flex min-w-0 flex-1 flex-col pr-1 leading-tight">
              <span className="truncate">{title}</span>
              {rail.isMobile ? (
                <span className="mt-0.5 truncate text-2xs font-normal text-fg-subtle">
                  {[stateLabel, depthLabel, descendantLabel, relativeTime]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </span>
            {/* A collapsed parent with a live child shows a quiet pulsing dot so
                the activity isn't hidden with the subtree; the count badge sits
                beside it. Both stay visible on hover (the time yields instead). */}
            {!rail.isMobile && hasChildren ? (
              <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums text-fg-muted">
                {!props.expanded && props.hasActiveDescendant ? (
                  <span className="relative inline-flex size-1.5 rounded-full bg-status-running">
                    <span className="absolute inset-0 animate-og-pulse rounded-full bg-status-running" />
                  </span>
                ) : null}
                <span aria-label={`${props.childCount} descendant sessions`}>
                  {props.childCount}
                </span>
              </span>
            ) : null}
            {/* Relative time is visible at rest (the list is grouped by recency),
                and steps aside on hover/focus so the rename overflow can slot in.
                On coarse pointers there is no hover, so the time stays visible. */}
            {!rail.isMobile ? (
              <span className="shrink-0 text-2xs tabular-nums text-fg transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:group-hover:opacity-100">
                {relativeTime}
              </span>
            ) : null}
          </button>
          <RowActionsMenu
            session={props.session}
            onRename={rename.startEditing}
            onPin={props.onPin}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem className="pointer-coarse:min-h-11" onSelect={rename.startEditing}>
          <PencilIcon className="size-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          className="pointer-coarse:min-h-11"
          onSelect={() => void props.onPin(props.session, !props.session.pinned)}
        >
          <PinIcon className={props.session.pinned ? "size-4 fill-current" : "size-4"} />
          {props.session.pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function sessionDescendantLabel(session: Session): string | null {
  const stats = session.treeStats;
  if (!stats || stats.totalDescendants === 0) return null;
  const live = stats.runningDescendants + stats.queuedDescendants;
  if (stats.attentionDescendants > 0) {
    return `${stats.attentionDescendants} need you · ${stats.totalDescendants} total`;
  }
  if (live > 0) return `${live} active · ${stats.totalDescendants} total`;
  return `${stats.totalDescendants} session${stats.totalDescendants === 1 ? "" : "s"}`;
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
}: {
  session: Session;
  onRename: () => void;
  onPin: PinFn;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${
            session.title?.trim() || session.initialMessage?.trim() || "Untitled session"
          }`}
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
        >
          <EllipsisIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-40"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem
          className="pointer-coarse:min-h-11"
          onSelect={onRename}
          // The menu item lives inside the row; stop the synthetic click from
          // bubbling to the row's onSelect (open-session).
          onClick={(event) => event.stopPropagation()}
        >
          <PencilIcon className="size-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          className="pointer-coarse:min-h-11"
          onSelect={() => void onPin(session, !session.pinned)}
          onClick={(event) => event.stopPropagation()}
        >
          <PinIcon className={session.pinned ? "size-4 fill-current" : "size-4"} />
          {session.pinned ? "Unpin" : "Pin"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Rail-local status dot with the app status tokens: running/queued pulse with
 * the running tone, requires-action pulses with the waiting tone, failures use
 * failed, and idle/terminal states fall back to cancelled.
 */
function RailStatusDot({ status }: { status: Session["status"] }) {
  const running = status === "running" || status === "queued" || status === "recovering";
  const needsAttention = status === "requires_action" || status === "waiting_capacity";
  const failed = status === "failed";
  const tone = running
    ? "bg-status-running"
    : needsAttention
      ? "bg-status-waiting"
      : failed
        ? "bg-status-failed"
        : "bg-status-cancelled";
  return (
    <span className={cn("relative inline-flex size-1.5 shrink-0 rounded-full", tone)}>
      {running || needsAttention ? (
        <span className={cn("absolute inset-0 animate-og-pulse rounded-full", tone)} />
      ) : null}
    </span>
  );
}

function EmptySessions({ onStart }: { onStart: () => void }) {
  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-center">
      <p className="text-xs text-fg-subtle">No sessions yet</p>
      <Button type="button" size="sm" onClick={onStart} className="mx-auto">
        <PlusIcon className="size-3.5" />
        Start your first session
      </Button>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New session"
            onClick={rail.startNewSession}
            className="text-fg-muted hover:text-fg"
          >
            <PlusIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">New session · c</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SessionListSkeleton() {
  return (
    <div className="grid gap-1 px-1 pt-2">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex h-8 items-center gap-2 px-1">
          <span className="size-1.5 shrink-0 rounded-full bg-surface-3" />
          <span className="h-3 flex-1 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
