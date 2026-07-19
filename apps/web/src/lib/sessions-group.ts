// Pure helpers behind the rail's session list: relative-time labels, recency
// bucketing (Today / Yesterday / Previous 7 days / Older), and the ordering
// rule — RUNNING sessions pinned to the very top, then most-recent activity
// first within each recency group.
import type { Session, SessionStatus } from "@/types";

export type SessionRecencyGroup = "today" | "yesterday" | "previous7" | "older";

export const SESSION_GROUP_LABELS: Record<SessionRecencyGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  previous7: "Previous 7 days",
  older: "Older",
};

/** The render order of recency groups, top → bottom. */
export const SESSION_GROUP_ORDER: SessionRecencyGroup[] = [
  "today",
  "yesterday",
  "previous7",
  "older",
];

/** Live states that earn the pinned-to-top, breathing-dot treatment. */
const RUNNING_STATUSES = new Set<SessionStatus>([
  "running",
  "queued",
  "waiting_capacity",
  "recovering",
  "requires_action",
]);

export function isRunningStatus(status: SessionStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

/** Most-recent activity timestamp for a session (updatedAt, then createdAt). */
export function sessionActivityTime(session: Session): number {
  const updated = Date.parse(session.updatedAt);
  if (!Number.isNaN(updated)) {
    return updated;
  }
  const created = Date.parse(session.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/** Deterministic newest-first ordering for every flat or forest session list. */
export function compareSessionActivity(left: Session, right: Session): number {
  return sessionActivityTime(right) - sessionActivityTime(left) || right.id.localeCompare(left.id);
}

/** Deterministic personal-pin order: newest pin first, then descending id. */
export function compareSessionPins(left: Session, right: Session): number {
  const leftPinnedAt = Date.parse(left.pinnedAt ?? "");
  const rightPinnedAt = Date.parse(right.pinnedAt ?? "");
  const leftTime = Number.isNaN(leftPinnedAt) ? 0 : leftPinnedAt;
  const rightTime = Number.isNaN(rightPinnedAt) ? 0 : rightPinnedAt;
  return rightTime - leftTime || right.id.localeCompare(left.id);
}

/** Split explicit personal pins from ordinary rows without changing the input. */
export function partitionPinnedSessions(sessions: Session[]): {
  pinned: Session[];
  ordinary: Session[];
} {
  const pinned: Session[] = [];
  const ordinary: Session[] = [];
  for (const session of sessions) {
    (session.pinned ? pinned : ordinary).push(session);
  }
  return { pinned: pinned.sort(compareSessionPins), ordinary };
}

/**
 * Which recency bucket a timestamp falls into, relative to `now`. "Today" and
 * "Yesterday" are calendar-local; "Previous 7 days" is the rest of the trailing
 * week; everything earlier is "Older".
 */
export function recencyGroupFor(timestampMs: number, now: Date = new Date()): SessionRecencyGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeekWindow = startOfToday - 7 * 24 * 60 * 60 * 1000;
  if (timestampMs >= startOfToday) {
    return "today";
  }
  if (timestampMs >= startOfYesterday) {
    return "yesterday";
  }
  if (timestampMs >= startOfWeekWindow) {
    return "previous7";
  }
  return "older";
}

export type SessionRecencyBucket = {
  group: SessionRecencyGroup;
  label: string;
  sessions: Session[];
};

export type GroupedSessions = {
  /** Running sessions, pinned above every recency group, most-recent first. */
  running: Session[];
  /** Non-running sessions bucketed by recency (empty buckets dropped). */
  grouped: SessionRecencyBucket[];
};

/**
 * Order + bucket the sessions for the rail. Running sessions are lifted into a
 * synthetic, always-first position regardless of recency (rendered with a
 * "running" marker); the remainder are bucketed by recency, most-recent first
 * within each bucket. Empty groups are dropped.
 */
export function groupSessionsForRail(sessions: Session[], now: Date = new Date()): GroupedSessions {
  const running = sessions
    .filter((session) => isRunningStatus(session.status))
    .sort(compareSessionActivity);
  const rest = sessions
    .filter((session) => !isRunningStatus(session.status))
    .sort(compareSessionActivity);

  const buckets = new Map<SessionRecencyGroup, Session[]>();
  for (const session of rest) {
    const group = recencyGroupFor(sessionActivityTime(session), now);
    const list = buckets.get(group) ?? [];
    list.push(session);
    buckets.set(group, list);
  }

  const grouped: SessionRecencyBucket[] = [];
  for (const group of SESSION_GROUP_ORDER) {
    const list = buckets.get(group);
    if (list && list.length > 0) {
      grouped.push({
        group,
        label: SESSION_GROUP_LABELS[group],
        sessions: list,
      });
    }
  }
  return { running, grouped };
}

/* ----------------------------------------------------------------------------
   Lineage nesting for the rail

   The rail nests spawned worker sessions under the manager that spawned them
   (parentSessionId). A session is a ROOT in the rail when it has no parent OR
   its parent isn't in the loaded page (an orphan child renders at the root, as
   before). Roots are pinned/bucketed exactly like the flat list — but a root
   counts as "running" when it OR any descendant is active, so a manager whose
   only activity is a live child still floats to the top.
   -------------------------------------------------------------------------- */

export type SessionTreeNode = {
  session: Session;
  children: SessionTreeNode[];
  /** A descendant (any depth, not the node itself) is running/queued/awaiting action. */
  hasActiveDescendant: boolean;
};

/**
 * Merge two projections of the same session for the rail. Detail/SSE data is
 * fresher for lifecycle fields, but detail reads intentionally omit treeStats.
 * An omitted list-only field must not make the selected row forget its loaded
 * hierarchy summary (and therefore lose its disclosure control).
 */
export function mergeSessionForRail(current: Session, incoming: Session): Session {
  if (incoming.treeStats !== undefined || current.treeStats === undefined) {
    return incoming;
  }
  return { ...incoming, treeStats: current.treeStats };
}

export type SessionForest = {
  running: SessionTreeNode[];
  grouped: {
    group: SessionRecencyGroup;
    label: string;
    sessions: SessionTreeNode[];
  }[];
};

export type PinnedRailSections = {
  /** Complete loaded hierarchy, used for expansion and lineage lookups. */
  complete: SessionForest;
  /** Every explicit pin is an independently ordered shortcut root. */
  pinned: SessionTreeNode[];
  /** The ordinary hierarchy with every pin-owned subtree removed. */
  ordinary: SessionForest;
};

/** Whether the node's own status, or any descendant, is in a live state. */
export function nodeIsActive(node: SessionTreeNode): boolean {
  const stats = node.session.treeStats;
  const summarizedActive = Boolean(
    stats && stats.runningDescendants + stats.queuedDescendants + stats.attentionDescendants > 0,
  );
  return isRunningStatus(node.session.status) || node.hasActiveDescendant || summarizedActive;
}

/** Bucket already-built roots using the rail's activity and recency rules. */
export function categorizeRailRoots(
  rootNodes: SessionTreeNode[],
  now: Date = new Date(),
): SessionForest {
  const running = rootNodes
    .filter((node) => nodeIsActive(node))
    .sort((a, b) => compareSessionActivity(a.session, b.session));
  const rest = rootNodes
    .filter((node) => !nodeIsActive(node))
    .sort((a, b) => compareSessionActivity(a.session, b.session));

  const buckets = new Map<SessionRecencyGroup, SessionTreeNode[]>();
  for (const node of rest) {
    const group = recencyGroupFor(sessionActivityTime(node.session), now);
    const list = buckets.get(group) ?? [];
    list.push(node);
    buckets.set(group, list);
  }
  const grouped: SessionForest["grouped"] = [];
  for (const group of SESSION_GROUP_ORDER) {
    const list = buckets.get(group);
    if (list && list.length > 0) {
      grouped.push({
        group,
        label: SESSION_GROUP_LABELS[group],
        sessions: list,
      });
    }
  }
  return { running, grouped };
}

/**
 * Build the rail forest: roots (parentSessionId null, or parent absent from the
 * page) at the top level, spawned children nested beneath their parent, each
 * subtree ordered most-recent-first. Running roots (self or via a live
 * descendant) are pinned above the recency buckets. A `seen` guard makes a
 * pathological parent cycle in the loaded page terminate rather than recurse
 * forever.
 */
export function buildRailForest(sessions: Session[], now: Date = new Date()): SessionForest {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const childrenOf = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const session of sessions) {
    const parentId = session.parentSessionId;
    if (parentId && parentId !== session.id && byId.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(session);
      childrenOf.set(parentId, list);
    } else {
      roots.push(session);
    }
  }

  const build = (session: Session, seen: Set<string>): SessionTreeNode => {
    const children = seen.has(session.id)
      ? []
      : (childrenOf.get(session.id) ?? [])
          .sort(compareSessionActivity)
          .map((child) => build(child, new Set(seen).add(session.id)));
    const hasActiveDescendant = children.some((child) => nodeIsActive(child));
    return { session, children, hasActiveDescendant };
  };

  const rootNodes = roots.map((session) => build(session, new Set()));
  const reachable = new Set<string>();
  const markReachable = (node: SessionTreeNode): void => {
    if (reachable.has(node.session.id)) {
      return;
    }
    reachable.add(node.session.id);
    for (const child of node.children) {
      markReachable(child);
    }
  };
  for (const node of rootNodes) {
    markReachable(node);
  }
  for (const session of sessions) {
    if (!reachable.has(session.id)) {
      rootNodes.push({ session, children: [], hasActiveDescendant: false });
      reachable.add(session.id);
    }
  }
  return categorizeRailRoots(rootNodes, now);
}

type RemovedCounts = {
  total: number;
  running: number;
  queued: number;
  attention: number;
  paused: number;
  failed: number;
};

function emptyRemovedCounts(): RemovedCounts {
  return { total: 0, running: 0, queued: 0, attention: 0, paused: 0, failed: 0 };
}

function addRemovedCounts(target: RemovedCounts, source: RemovedCounts): void {
  target.total += source.total;
  target.running += source.running;
  target.queued += source.queued;
  target.attention += source.attention;
  target.paused += source.paused;
  target.failed += source.failed;
}

function subtreeCounts(node: SessionTreeNode): RemovedCounts {
  const status = node.session.status;
  const counts: RemovedCounts = {
    total: 1,
    running: status === "running" || status === "recovering" ? 1 : 0,
    queued: status === "queued" || status === "waiting_capacity" ? 1 : 0,
    attention: status === "requires_action" ? 1 : 0,
    paused: node.session.effectiveControl.state === "paused" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
  };
  const stats = node.session.treeStats;
  if (stats) {
    counts.total += stats.totalDescendants;
    counts.running += stats.runningDescendants;
    counts.queued += stats.queuedDescendants;
    counts.attention += stats.attentionDescendants;
    counts.paused += stats.pausedDescendants;
    counts.failed += stats.failedDescendants;
  } else {
    for (const child of node.children) addRemovedCounts(counts, subtreeCounts(child));
  }
  return counts;
}

function prunePinnedSubtreesWithCounts(
  node: SessionTreeNode,
  keepRoot: boolean,
): { node: SessionTreeNode | null; removed: RemovedCounts } {
  if (node.session.pinned && !keepRoot) {
    return { node: null, removed: subtreeCounts(node) };
  }

  const removed = emptyRemovedCounts();
  let removedDirectChildren = 0;
  const children: SessionTreeNode[] = [];
  for (const child of node.children) {
    const result = prunePinnedSubtreesWithCounts(child, false);
    addRemovedCounts(removed, result.removed);
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
  return {
    node: {
      session,
      children,
      hasActiveDescendant: children.some((child) => nodeIsActive(child)),
    },
    removed,
  };
}

/**
 * Remove explicit pinned roots below `node`. `keepRoot` is used to build one
 * pin shortcut: that pin stays, but any nested explicit pin is promoted to its
 * own globally ordered shortcut instead of appearing twice.
 */
export function prunePinnedSubtrees(
  node: SessionTreeNode,
  keepRoot = false,
): SessionTreeNode | null {
  return prunePinnedSubtreesWithCounts(node, keepRoot).node;
}

function forestRoots(forest: SessionForest): SessionTreeNode[] {
  return [...forest.running, ...forest.grouped.flatMap((bucket) => bucket.sessions)];
}

/** Build the complete, explicit-pin, and ordinary rail projections together. */
export function buildPinnedRailSections(
  sessions: Session[],
  now: Date = new Date(),
): PinnedRailSections {
  const complete = buildRailForest(sessions, now);
  const roots = forestRoots(complete);
  const nodesById = new Map<string, SessionTreeNode>();
  const visit = (node: SessionTreeNode): void => {
    if (nodesById.has(node.session.id)) return;
    nodesById.set(node.session.id, node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);

  const { pinned: pinnedSessions } = partitionPinnedSessions(sessions);
  const pinned = pinnedSessions.flatMap((session) => {
    const completeNode = nodesById.get(session.id) ?? {
      session,
      children: [],
      hasActiveDescendant: false,
    };
    const pruned = prunePinnedSubtrees(completeNode, true);
    return pruned ? [pruned] : [];
  });
  const ordinaryRoots = roots.flatMap((root) => {
    const pruned = prunePinnedSubtrees(root);
    return pruned ? [pruned] : [];
  });

  return {
    complete,
    pinned,
    ordinary: categorizeRailRoots(ordinaryRoots, now),
  };
}

/** Flatten the forest to the rows currently VISIBLE, given the expanded set —
 *  a node, then its children only when the node is expanded (depth-first). The
 *  rail's keyboard navigation walks this. */
export function visibleTreeRows(
  roots: SessionTreeNode[],
  expanded: ReadonlySet<string>,
): { node: SessionTreeNode; depth: number }[] {
  const rows: { node: SessionTreeNode; depth: number }[] = [];
  const walk = (node: SessionTreeNode, depth: number): void => {
    rows.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.session.id)) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  };
  for (const node of roots) walk(node, 0);
  return rows;
}

export function visibleForestRows(
  forest: SessionForest,
  expanded: ReadonlySet<string>,
): { node: SessionTreeNode; depth: number }[] {
  return visibleTreeRows(forestRoots(forest), expanded);
}

/** Compact relative-time label, e.g. "now", "5m", "3h", "2d", "Mar 4". */
export function relativeTimeLabel(value: string, now: Date = new Date()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const diffSeconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
  if (diffSeconds < 45) {
    return "now";
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
