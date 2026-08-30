// Pure helpers behind the rail's session list: relative-time labels, recency
// bucketing (Today / Yesterday / Previous 7 days / Older), and the ordering
// rule — RUNNING sessions pinned to the very top, then most-recent activity
// first within each recency group.
import { formatWaitingSince } from "@/lib/format";
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

function hasActiveEffectiveControl(session: Session): boolean {
  return (session.effectiveControl?.state ?? "active") === "active";
}

function isEffectivelyRunning(session: Session): boolean {
  if (session.backgroundCommandActivity) return true;
  return hasActiveEffectiveControl(session) && isRunningStatus(session.status);
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
  const running = sessions.filter(isEffectivelyRunning).sort(compareSessionActivity);
  const rest = sessions
    .filter((session) => !isEffectivelyRunning(session))
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

export type RailAggregateStatusKind =
  | "send_failed"
  | "needs_attention"
  | "failed"
  | "active"
  | "unread"
  | "active_work"
  | "neutral";

export type RailAggregateStatus = {
  kind: RailAggregateStatusKind;
  /** Number of sessions represented by the winning status. */
  count: number;
  /** Total sessions represented by the node or section. */
  total: number;
  label: string;
  /**
   * `needs_attention` only: when the longest-waiting represented session
   * entered `requires_action` (the earliest known `requiresActionSince` /
   * `treeStats.attentionSince`). Absent when no server reported it.
   */
  attentionSince?: string;
};

type RailStatusCounts = {
  total: number;
  sendFailed: number;
  attention: number;
  /** Earliest known requires_action entry across the counted `attention` sessions. */
  attentionSince: string | null;
  failed: number;
  active: number;
  unread: number;
  activeWork: number;
};

function earliestIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function ownRailStatusCounts(
  session: Session,
  localDeliveryAttention: ReadonlyMap<string, number>,
): RailStatusCounts {
  return {
    total: 1,
    sendFailed: localDeliveryAttention.get(session.id) ?? 0,
    attention: session.status === "requires_action" ? 1 : 0,
    attentionSince:
      session.status === "requires_action" ? (session.requiresActionSince ?? null) : null,
    // Failed is a review signal in the rail, not a permanent copy of the
    // lifecycle badge. Opening the session (or a parent agent consuming its
    // result) acknowledges the failure together with the unread frontier.
    failed: session.status === "failed" && session.unread ? 1 : 0,
    active:
      session.backgroundCommandActivity ||
      (hasActiveEffectiveControl(session) &&
        (session.status === "running" ||
          session.status === "queued" ||
          session.status === "recovering" ||
          session.status === "waiting_capacity"))
        ? 1
        : 0,
    unread: session.unread ? 1 : 0,
    activeWork: session.activelyWorking ? 1 : 0,
  };
}

function addRailStatusCounts(target: RailStatusCounts, source: RailStatusCounts): void {
  target.total += source.total;
  target.sendFailed += source.sendFailed;
  target.attention += source.attention;
  target.attentionSince = earliestIso(target.attentionSince, source.attentionSince);
  target.failed += source.failed;
  target.active += source.active;
  target.unread += source.unread;
  target.activeWork += source.activeWork;
}

function railStatusCounts(
  node: SessionTreeNode,
  localDeliveryAttention: ReadonlyMap<string, number>,
): RailStatusCounts {
  const counts = ownRailStatusCounts(node.session, localDeliveryAttention);
  const stats = node.session.treeStats;
  if (stats) {
    counts.total += stats.totalDescendants;
    counts.attention += stats.attentionDescendants;
    counts.attentionSince = earliestIso(counts.attentionSince, stats.attentionSince);
    counts.failed += stats.unreadFailedDescendants ?? stats.failedDescendants;
    counts.active += stats.runningDescendants + stats.queuedDescendants;
    counts.unread += stats.unreadDescendants ?? 0;
    counts.activeWork += stats.activelyWorkingDescendants ?? 0;

    // Scheduled-task grouping appends older root runs as synthetic children of
    // the newest run. They are not part of that run's server treeStats, unlike
    // ordinary spawned children, so include only those extra roots here.
    for (const child of node.children) {
      if (child.session.parentSessionId !== node.session.id) {
        addRailStatusCounts(counts, railStatusCounts(child, localDeliveryAttention));
      } else {
        counts.sendFailed += loadedLocalDeliveryFailureCount(child, localDeliveryAttention);
      }
    }
  } else {
    for (const child of node.children) {
      addRailStatusCounts(counts, railStatusCounts(child, localDeliveryAttention));
    }
  }
  return counts;
}

/**
 * Durable treeStats already account for ordinary descendants' lifecycle state,
 * but browser-local delivery failures have no server aggregate. Fold only that
 * local fact through the loaded child tree so collapsed parents stay truthful.
 */
function loadedLocalDeliveryFailureCount(
  node: SessionTreeNode,
  localDeliveryAttention: ReadonlyMap<string, number>,
): number {
  return (
    (localDeliveryAttention.get(node.session.id) ?? 0) +
    node.children.reduce(
      (total, child) => total + loadedLocalDeliveryFailureCount(child, localDeliveryAttention),
      0,
    )
  );
}

/** One status for a collapsed parent or workstream, including all descendants. */
export function summarizeRailNodes(
  nodes: readonly SessionTreeNode[],
  localDeliveryAttention: ReadonlyMap<string, number> = new Map(),
  now: Date = new Date(),
): RailAggregateStatus {
  const counts: RailStatusCounts = {
    total: 0,
    sendFailed: 0,
    attention: 0,
    attentionSince: null,
    failed: 0,
    active: 0,
    unread: 0,
    activeWork: 0,
  };
  for (const node of nodes) {
    addRailStatusCounts(counts, railStatusCounts(node, localDeliveryAttention));
  }

  if (counts.sendFailed > 0) {
    return {
      kind: "send_failed",
      count: counts.sendFailed,
      total: counts.total,
      label: `${counts.sendFailed} message${counts.sendFailed === 1 ? "" : "s"} not sent`,
    };
  }

  if (counts.attention > 0) {
    // "2 need you · 10h": how long the longest-waiting one has been blocked on
    // a human, so a parked child is never silent in a collapsed parent row.
    const waiting = counts.attentionSince ? formatWaitingSince(counts.attentionSince, now) : "";
    return {
      kind: "needs_attention",
      count: counts.attention,
      total: counts.total,
      label: `${counts.attention} need${counts.attention === 1 ? "s" : ""} you${
        waiting ? ` · ${waiting}` : ""
      }`,
      ...(counts.attentionSince ? { attentionSince: counts.attentionSince } : {}),
    };
  }
  if (counts.failed > 0) {
    return {
      kind: "failed",
      count: counts.failed,
      total: counts.total,
      label: `${counts.failed} failed`,
    };
  }
  if (counts.active > 0) {
    return {
      kind: "active",
      count: counts.active,
      total: counts.total,
      label: `${counts.active} working`,
    };
  }
  if (counts.unread > 0) {
    return {
      kind: "unread",
      count: counts.unread,
      total: counts.total,
      label: `${counts.unread} unread`,
    };
  }
  if (counts.activeWork > 0) {
    return {
      kind: "active_work",
      count: counts.activeWork,
      total: counts.total,
      label: `${counts.activeWork} actively working`,
    };
  }
  return {
    kind: "neutral",
    count: 0,
    total: counts.total,
    label: counts.total > 0 ? "Read" : "Empty",
  };
}

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
    group: string;
    label: string;
    sessions: SessionTreeNode[];
  }[];
};

export type SessionBrowseGroupBy = "activity" | "created" | "creator";
export type SessionBrowseDateField = "activity" | "created";
export type SessionBrowseDateRange = "any" | "today" | "week" | "month";

export function sessionCreatorKey(session: Session): string {
  return `${session.createdBy.kind}:${session.createdBy.subjectId}`;
}

export function sessionCreatorLabel(session: Session): string {
  const explicit = session.createdBy.label?.trim();
  if (explicit) return explicit;
  if (session.createdBy.subjectId === "unattributed-legacy") return "Unattributed";
  if (session.createdBy.kind === "service") {
    return `Service · ${session.createdBy.subjectId}`;
  }
  return session.createdBy.subjectId;
}

export type SessionCreatorOption = {
  value: string;
  label: string;
};

/**
 * Loaded creator choices with identity-specific labels only when frozen display
 * labels collide. The subject ID remains opaque; it is displayed, not parsed.
 */
export function sessionCreatorLabelMap(sessions: Session[]): ReadonlyMap<string, string> {
  const byKey = new Map<
    string,
    { label: string; kind: Session["createdBy"]["kind"]; subjectId: string }
  >();
  for (const session of sessions) {
    byKey.set(sessionCreatorKey(session), {
      label: sessionCreatorLabel(session),
      kind: session.createdBy.kind,
      subjectId: session.createdBy.subjectId,
    });
  }

  const labelCounts = new Map<string, number>();
  for (const creator of byKey.values()) {
    labelCounts.set(creator.label, (labelCounts.get(creator.label) ?? 0) + 1);
  }

  return new Map(
    [...byKey.entries()]
      .map(([value, creator]) => ({
        value,
        label:
          labelCounts.get(creator.label) === 1
            ? creator.label
            : `${creator.label} · ${creator.kind === "service" ? "Service" : "Subject"} · ${creator.subjectId}`,
      }))
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
      )
      .map((creator) => [creator.value, creator.label]),
  );
}

export function sessionCreatorOptions(sessions: Session[]): SessionCreatorOption[] {
  return [...sessionCreatorLabelMap(sessions)].map(([value, label]) => ({ value, label }));
}

function browseTimestamp(session: Session, field: SessionBrowseDateField): number {
  if (field === "activity") return sessionActivityTime(session);
  const created = Date.parse(session.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

export function filterSessionsForBrowse(
  sessions: Session[],
  options: {
    creator: string | null;
    dateField: SessionBrowseDateField;
    dateRange: SessionBrowseDateRange;
    now?: Date;
  },
): Session[] {
  const now = options.now ?? new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const threshold =
    options.dateRange === "today"
      ? startOfToday
      : options.dateRange === "week"
        ? startOfToday - 6 * 24 * 60 * 60 * 1000
        : options.dateRange === "month"
          ? startOfToday - 29 * 24 * 60 * 60 * 1000
          : null;
  return sessions.filter(
    (session) =>
      (!options.creator || sessionCreatorKey(session) === options.creator) &&
      (threshold === null || browseTimestamp(session, options.dateField) >= threshold),
  );
}

/** Flat browse projection used only when the operator selects custom grouping. */
export function groupSessionsForBrowse(
  sessions: Session[],
  groupBy: Exclude<SessionBrowseGroupBy, "activity">,
  options: {
    now?: Date;
    creatorLabels?: ReadonlyMap<string, string>;
  } = {},
): SessionForest {
  const now = options.now ?? new Date();
  const running = sessions
    .filter(isEffectivelyRunning)
    .sort(compareSessionActivity)
    .map((session) => ({ session, children: [], hasActiveDescendant: false }));
  const rest = sessions.filter((session) => !isEffectivelyRunning(session));
  if (groupBy === "created") {
    const buckets = new Map<SessionRecencyGroup, Session[]>();
    for (const session of rest) {
      const group = recencyGroupFor(browseTimestamp(session, "created"), now);
      const list = buckets.get(group) ?? [];
      list.push(session);
      buckets.set(group, list);
    }
    return {
      running,
      grouped: SESSION_GROUP_ORDER.flatMap((group) => {
        const list = buckets.get(group);
        if (!list?.length) return [];
        const label =
          group === "today"
            ? "Created today"
            : group === "yesterday"
              ? "Created yesterday"
              : group === "previous7"
                ? "Created in previous 7 days"
                : "Created earlier";
        return [
          {
            group: `created:${group}`,
            label,
            sessions: list
              .sort(
                (left, right) =>
                  browseTimestamp(right, "created") - browseTimestamp(left, "created"),
              )
              .map((session) => ({ session, children: [], hasActiveDescendant: false })),
          },
        ];
      }),
    };
  }

  const creatorLabels = options.creatorLabels ?? sessionCreatorLabelMap(sessions);
  const creators = new Map<string, { label: string; sessions: Session[] }>();
  for (const session of rest) {
    const key = sessionCreatorKey(session);
    const bucket = creators.get(key) ?? {
      label: creatorLabels.get(key) ?? sessionCreatorLabel(session),
      sessions: [],
    };
    bucket.sessions.push(session);
    creators.set(key, bucket);
  }
  return {
    running,
    grouped: [...creators.entries()]
      .sort(([, left], [, right]) => left.label.localeCompare(right.label))
      .map(([key, bucket]) => ({
        group: `creator:${key}`,
        label: bucket.label,
        sessions: bucket.sessions.sort(compareSessionActivity).map((session) => ({
          session,
          children: [],
          hasActiveDescendant: false,
        })),
      })),
  };
}

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
  return isEffectivelyRunning(node.session) || node.hasActiveDescendant || summarizedActive;
}

/** Bucket already-built roots using the rail's activity and recency rules. */
/**
 * The scheduled task a session was created for, or null. The worker stamps this
 * onto every session it generates for a run; it is deliberately read from
 * metadata rather than a column, because that is where the scheduler writes it.
 * A session a human started never carries the key, so it never groups.
 */
export function scheduledTaskIdOf(session: Session): string | null {
  const value = (session.metadata as Record<string, unknown> | undefined)?.scheduledTaskId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Collapse repeat runs of one scheduled task into a single rail entry.
 *
 * A schedule that fires hourly would otherwise push every other session out of
 * the rail, so runs of the same task fold together. This deliberately does NOT
 * introduce a scheduled-task row type: the newest run IS the entry, and the
 * older runs become its children, so the group renders and behaves exactly like
 * an ordinary session with spawned children. Clicking it opens the latest run,
 * expanding it reveals the rest, and each one stays individually openable.
 *
 * A task with a single run is left completely alone - one session is not a
 * flood, and wrapping it would only add a disclosure with nothing behind it.
 *
 * `roots` arrives running-first-then-recency, not purely newest-first, so the
 * members are re-sorted by activity here: the umbrella must be the latest run,
 * and the runs behind it must read newest to oldest. The group keeps the list
 * position of whichever member ranked highest in the incoming order, so folding
 * never pushes a live run down the rail.
 */
export function groupScheduledRuns(roots: SessionTreeNode[]): SessionTreeNode[] {
  const membersByTask = new Map<string, SessionTreeNode[]>();
  for (const node of roots) {
    const taskId = scheduledTaskIdOf(node.session);
    if (!taskId) continue;
    const members = membersByTask.get(taskId) ?? [];
    members.push(node);
    membersByTask.set(taskId, members);
  }
  for (const members of membersByTask.values()) {
    members.sort((left, right) => compareSessionActivity(left.session, right.session));
  }
  const grouped: SessionTreeNode[] = [];
  const emitted = new Set<string>();
  for (const node of roots) {
    const taskId = scheduledTaskIdOf(node.session);
    const members = taskId ? (membersByTask.get(taskId) ?? []) : [];
    if (members.length < 2) {
      grouped.push(node);
      continue;
    }
    if (emitted.has(taskId!)) continue;
    emitted.add(taskId!);
    const [latestRun, ...olderRuns] = members as [SessionTreeNode, ...SessionTreeNode[]];
    grouped.push({
      ...latestRun,
      // The latest run's own spawned children stay first; previous runs follow,
      // so a subagent of the latest run never sorts below an older run.
      children: [...latestRun.children, ...olderRuns],
      hasActiveDescendant:
        latestRun.hasActiveDescendant ||
        olderRuns.some((run) => nodeIsActive(run) || run.hasActiveDescendant),
    });
  }
  return grouped;
}

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
  unreadFailed: number;
  unread: number;
  activeWork: number;
};

function emptyRemovedCounts(): RemovedCounts {
  return {
    total: 0,
    running: 0,
    queued: 0,
    attention: 0,
    paused: 0,
    failed: 0,
    unreadFailed: 0,
    unread: 0,
    activeWork: 0,
  };
}

function addRemovedCounts(target: RemovedCounts, source: RemovedCounts): void {
  target.total += source.total;
  target.running += source.running;
  target.queued += source.queued;
  target.attention += source.attention;
  target.paused += source.paused;
  target.failed += source.failed;
  target.unreadFailed += source.unreadFailed;
  target.unread += source.unread;
  target.activeWork += source.activeWork;
}

function subtreeCounts(node: SessionTreeNode): RemovedCounts {
  const status = node.session.status;
  const active = hasActiveEffectiveControl(node.session);
  const counts: RemovedCounts = {
    total: 1,
    running: active && (status === "running" || status === "recovering") ? 1 : 0,
    queued: active && (status === "queued" || status === "waiting_capacity") ? 1 : 0,
    attention: status === "requires_action" ? 1 : 0,
    paused: node.session.effectiveControl?.state === "paused" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    unreadFailed: status === "failed" && node.session.unread ? 1 : 0,
    unread: node.session.unread ? 1 : 0,
    activeWork: node.session.activelyWorking ? 1 : 0,
  };
  const stats = node.session.treeStats;
  if (stats) {
    counts.total += stats.totalDescendants;
    counts.running += stats.runningDescendants;
    counts.queued += stats.queuedDescendants;
    counts.attention += stats.attentionDescendants;
    counts.paused += stats.pausedDescendants;
    counts.failed += stats.failedDescendants;
    counts.unreadFailed += stats.unreadFailedDescendants ?? stats.failedDescendants;
    counts.unread += stats.unreadDescendants ?? 0;
    counts.activeWork += stats.activelyWorkingDescendants ?? 0;
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
          ...(stats.unreadFailedDescendants !== undefined
            ? {
                unreadFailedDescendants: Math.max(
                  0,
                  stats.unreadFailedDescendants - removed.unreadFailed,
                ),
              }
            : {}),
          ...(stats.unreadDescendants !== undefined
            ? { unreadDescendants: Math.max(0, stats.unreadDescendants - removed.unread) }
            : {}),
          ...(stats.activelyWorkingDescendants !== undefined
            ? {
                activelyWorkingDescendants: Math.max(
                  0,
                  stats.activelyWorkingDescendants - removed.activeWork,
                ),
              }
            : {}),
          // The pruned subtree may have held the oldest waiter; keep the server
          // timestamp only while some counted attention descendant remains.
          ...(stats.attentionSince !== undefined
            ? {
                attentionSince:
                  stats.attentionDescendants - removed.attention > 0 ? stats.attentionSince : null,
              }
            : {}),
          truncated: stats.truncated,
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

/**
 * Rows as the rail will actually render them.
 *
 * Hierarchy mode nests spawned sessions under their parent, so lineage stays.
 * Search results and browse groupings are deliberately flat - a partial match
 * set is not a tree, and a browse bucket is a list - so every row there IS
 * top-level and must say so. Both flat consumers (`buildPinnedRailSections`
 * and `groupSessionsForBrowse`) read this one projection; a row that renders at
 * the top level while still naming an absent parent is the bug this prevents.
 */
export function projectRailSessions(sessions: Session[], hierarchyMode: boolean): Session[] {
  return hierarchyMode
    ? sessions
    : sessions.map((session) => ({ ...session, parentSessionId: null }));
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
    ordinary: categorizeRailRoots(groupScheduledRuns(ordinaryRoots), now),
  };
}

/** The selected descendant under a collapsed node, projected one level deeper. */
export function selectedDescendantNode(
  node: SessionTreeNode,
  selectedSessionId: string | null,
): SessionTreeNode | null {
  if (!selectedSessionId || node.session.id === selectedSessionId) return null;
  for (const child of node.children) {
    if (child.session.id === selectedSessionId) return child;
    const selected = selectedDescendantNode(child, selectedSessionId);
    if (selected) return selected;
  }
  return null;
}

/** Flatten the forest to the rows currently VISIBLE, given the expanded set —
 *  a node, then its children only when the node is expanded (depth-first).
 *  A collapsed branch keeps its selected descendant visible as one ordinary
 *  child row, matching the rail projection. Keyboard navigation walks this. */
export function visibleTreeRows(
  roots: SessionTreeNode[],
  expanded: ReadonlySet<string>,
  selectedSessionId: string | null = null,
): { node: SessionTreeNode; depth: number }[] {
  const rows: { node: SessionTreeNode; depth: number }[] = [];
  const walk = (node: SessionTreeNode, depth: number): void => {
    rows.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.session.id)) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    } else {
      const selected = selectedDescendantNode(node, selectedSessionId);
      if (selected) rows.push({ node: selected, depth: depth + 1 });
    }
  };
  for (const node of roots) walk(node, 0);
  return rows;
}

export function visibleForestRows(
  forest: SessionForest,
  expanded: ReadonlySet<string>,
  selectedSessionId: string | null = null,
): { node: SessionTreeNode; depth: number }[] {
  return visibleTreeRows(forestRoots(forest), expanded, selectedSessionId);
}

/* --------------------------------------------------------------------------
   Workstream sections. The hierarchy rail groups ordinary roots by their ROOT
   session's channel, with unfiled roots in Recents.
   -------------------------------------------------------------------------- */

export type ChannelRailSection = {
  /** Stable render key: the channel id, or "recents" for unfiled roots. */
  key: string;
  channelId: string | null;
  /** User-facing workstream name. */
  name: string;
  sessions: SessionTreeNode[];
};

/**
 * Group an ordinary rail forest's roots by channel. Channels render in the
 * given (server-defined) order — pinned projects first, then ordinary ones —
 * including empty ones, so a just-created project is immediately visible.
 * The catch-all "Default" section for unfiled roots follows them (only when
 * it has members). Within a section, active roots
 * keep floating above recency-ordered idle ones because the incoming forest
 * is flattened in that order. A root whose channel no longer exists folds
 * into Default rather than disappearing.
 */
export function channelRailSections(
  forest: SessionForest,
  channels: readonly { id: string; name: string }[],
): ChannelRailSection[] {
  const roots = [...forest.running, ...forest.grouped.flatMap((bucket) => bucket.sessions)];
  const byChannel = new Map<string | null, SessionTreeNode[]>();
  for (const node of roots) {
    const channelId = node.session.channelId ?? null;
    const known = channelId !== null && channels.some((channel) => channel.id === channelId);
    const key = known ? channelId : null;
    const list = byChannel.get(key) ?? [];
    list.push(node);
    byChannel.set(key, list);
  }
  for (const list of byChannel.values()) {
    list.sort((left, right) => {
      const leftRank = nodeIsActive(left) ? 0 : left.session.activelyWorking ? 1 : 2;
      const rightRank = nodeIsActive(right) ? 0 : right.session.activelyWorking ? 1 : 2;
      return leftRank - rightRank || compareSessionActivity(left.session, right.session);
    });
  }
  const sections: ChannelRailSection[] = [];
  sections.push(
    ...channels.map((channel) => ({
      key: channel.id,
      channelId: channel.id,
      name: channel.name,
      sessions: byChannel.get(channel.id) ?? [],
    })),
  );
  const defaultSessions = byChannel.get(null) ?? [];
  if (defaultSessions.length > 0) {
    sections.push({ key: "default", channelId: null, name: "Default", sessions: defaultSessions });
  }
  return sections;
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
