import type { AgentTopologySession } from "@opengeni/sdk";

/**
 * The Agents page's views. "All" is the default; the other three are the only
 * numbers the page shows, because they are the only states someone acts on:
 * - attention: an agent waits on a person (approval or answer).
 * - running: an agent is working on its own right now, including one that is
 *   queued to start, recovering after a worker restart or waiting for model
 *   capacity. None of those need anyone.
 * - failed: a top-level workstream failed in the last day. A spawned agent's
 *   failure is reported to the agent that spawned it, which carries on, so it
 *   is not counted; an older failure stays visible under All without nagging.
 */
export type AgentTopologyFilter = "all" | "attention" | "running" | "failed";

export type AgentTopologyNode = {
  session: AgentTopologySession;
  children: AgentTopologyNode[];
  detached: boolean;
  cycle: boolean;
};

export type AgentTopologySummary = {
  /** Agents at any depth waiting on a person. */
  attention: number;
  /** Agents at any depth working on their own. */
  running: number;
  /** Top-level workstreams that failed in the last day. */
  failed: number;
  /** A tree was larger than the server counts, so the numbers are a floor. */
  capped: boolean;
};

/** Statuses of an agent that is working without anyone: running, starting or about to continue. */
export const LIVE_AGENT_STATUSES = [
  "running",
  "recovering",
  "queued",
  "waiting_capacity",
] as const satisfies readonly AgentTopologySession["status"][];

/** How far back a failed workstream still counts as recent. */
export const RECENT_FAILURE_HOURS = 24;
const RECENT_FAILURE_MS = RECENT_FAILURE_HOURS * 60 * 60 * 1000;

export type AgentTopologyDiagramNode = {
  node: AgentTopologyNode;
  parentId: string | null;
  depth: number;
  x: number;
  y: number;
};

export type AgentTopologyDiagramLayout = {
  nodes: AgentTopologyDiagramNode[];
  width: number;
  height: number;
  /** Card width: columns stretch to fill the available width. */
  nodeWidth: number;
};

export type AgentTopologyLimits = {
  maxDepth: number | null;
  maxChildren: number | null;
  maxNodes: number;
};

export type LimitedAgentTopology = {
  roots: AgentTopologyNode[];
  visibleCount: number;
  hiddenCount: number;
  hiddenByParent: ReadonlyMap<string, number>;
};

export const AGENT_DIAGRAM_NODE_WIDTH = 240;
const AGENT_DIAGRAM_NODE_MIN_WIDTH = 200;
const AGENT_DIAGRAM_NODE_MAX_WIDTH = 280;
export const AGENT_DIAGRAM_NODE_HEIGHT = 88;
const AGENT_DIAGRAM_COLUMN_GAP = 24;
const AGENT_DIAGRAM_ROW_GAP = 40;
const AGENT_DIAGRAM_PADDING = 0;
/** Space between bands of workstreams, less than a level so bands never read as one tree. */
const AGENT_DIAGRAM_BAND_GAP = 24;

type RollingAgentTopologySession = Omit<AgentTopologySession, "goal" | "relatedWork"> &
  Partial<Pick<AgentTopologySession, "goal" | "relatedWork">>;

/** Additive same-major fields may be absent while older API replicas drain. */
export function normalizeAgentTopologySession(session: AgentTopologySession): AgentTopologySession {
  const rolling = session as RollingAgentTopologySession;
  return {
    ...session,
    goal: rolling.goal ?? null,
    relatedWork: rolling.relatedWork ?? {
      claims: [],
      claimsTruncated: false,
      match: null,
      possibleOverlap: false,
      advisoryOnly: true,
      noAdditionalAccess: true,
    },
  };
}

export function normalizeAgentTopologySessions(
  sessions: AgentTopologySession[],
): AgentTopologySession[] {
  return sessions.map(normalizeAgentTopologySession);
}

export function isPausedAgent(session: AgentTopologySession): boolean {
  return session.pause.state === "paused";
}

/** Working on its own right now (running, queued, recovering, waiting for capacity). */
export function isRunningAgent(session: AgentTopologySession): boolean {
  return (
    !isPausedAgent(session) &&
    (LIVE_AGENT_STATUSES as readonly AgentTopologySession["status"][]).includes(session.status)
  );
}

/** Waiting on a person: an approval or an answer. */
export function agentNeedsYou(session: AgentTopologySession): boolean {
  return !isPausedAgent(session) && session.status === "requires_action";
}

export function isActiveAgent(session: AgentTopologySession): boolean {
  return isRunningAgent(session) || agentNeedsYou(session);
}

/** A top-level workstream that failed within the last day. */
export function isRecentlyFailedWorkstream(
  session: AgentTopologySession,
  now: number = Date.now(),
): boolean {
  if (session.parentSessionId !== null || isPausedAgent(session)) return false;
  if (session.status !== "failed") return false;
  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt <= RECENT_FAILURE_MS;
}

/**
 * The page's three numbers, from top-level workstreams only: each one's own
 * state plus the server's counts for everything below it, so a branch that is
 * collapsed or not loaded yet still counts. Children and search results are
 * already inside their workstream's counts and are skipped.
 */
export function summarizeAgentTopology(
  sessions: AgentTopologySession[],
  now: number = Date.now(),
): AgentTopologySummary {
  const summary: AgentTopologySummary = {
    attention: 0,
    running: 0,
    failed: 0,
    capped: false,
  };
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.parentSessionId !== null || seen.has(session.id)) continue;
    seen.add(session.id);
    if (agentNeedsYou(session)) summary.attention += 1;
    if (isRunningAgent(session)) summary.running += 1;
    if (isRecentlyFailedWorkstream(session, now)) summary.failed += 1;
    summary.attention += session.children.attentionDescendants;
    summary.running += session.children.runningDescendants + session.children.queuedDescendants;
    if (session.children.truncated) summary.capped = true;
  }
  return summary;
}

/** Merge a refreshed or paged compact response without dropping prior pages. */
export function mergeAgentTopologySessions(
  current: AgentTopologySession[],
  incoming: AgentTopologySession[],
  maxSessions: number,
): AgentTopologySession[] {
  const sessions = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) {
    if (sessions.size >= maxSessions && !sessions.has(session.id)) continue;
    sessions.set(session.id, session);
  }
  return [...sessions.values()];
}

/**
 * Roots that were loaded only because they were live or had just failed, and
 * are now neither live nor on the first page nor paged in by hand. Their last
 * known state would be stale, so they leave the collection.
 */
export function staleLiveRootIds(
  previousLiveOnly: ReadonlySet<string>,
  current: ReadonlySet<string>,
  paged: ReadonlySet<string>,
): Set<string> {
  const stale = new Set<string>();
  for (const id of previousLiveOnly) {
    if (!current.has(id) && !paged.has(id)) stale.add(id);
  }
  return stale;
}

/** Drop whole workstreams: the roots and every loaded agent below them. */
export function withoutAgentTopologyRoots(
  sessions: AgentTopologySession[],
  rootIds: ReadonlySet<string>,
): AgentTopologySession[] {
  if (rootIds.size === 0) return sessions;
  return sessions.filter(
    (session) => !rootIds.has(session.id) && !rootIds.has(session.rootSessionId),
  );
}

export function canStartAgentTopologyRootRead(requestInFlight: boolean): boolean {
  return !requestInFlight;
}

export function selectAgentTopologyBranchesToLoad(
  candidates: string[],
  loadedBranches: ReadonlySet<string>,
  inFlightBranches: ReadonlySet<string>,
  maxConcurrency: number,
): string[] {
  const available = Math.max(0, maxConcurrency - inFlightBranches.size);
  if (available === 0) return [];
  return candidates
    .filter((id) => !loadedBranches.has(id) && !inFlightBranches.has(id))
    .slice(0, available);
}

function compareAgentSessions(left: AgentTopologySession, right: AgentTopologySession): number {
  const activeDelta = Number(isActiveAgent(right)) - Number(isActiveAgent(left));
  if (activeDelta !== 0) return activeDelta;
  const attentionDelta =
    Number(right.status === "requires_action") - Number(left.status === "requires_action");
  if (attentionDelta !== 0) return attentionDelta;
  const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return updatedDelta || left.id.localeCompare(right.id);
}

/** Build a cycle-safe forest from server-authored session parent identities. */
export function buildAgentTopology(sessions: AgentTopologySession[]): AgentTopologyNode[] {
  const unique = new Map(sessions.map((session) => [session.id, session]));
  const nodes = new Map<string, AgentTopologyNode>();
  for (const session of unique.values()) {
    nodes.set(session.id, {
      session,
      children: [],
      detached: false,
      cycle: false,
    });
  }

  const roots: AgentTopologyNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.session.parentSessionId;
    if (!parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (!parent) {
      node.detached = true;
      roots.push(node);
      continue;
    }

    // Following parent pointers before linking makes a malformed historical
    // cycle visible as detached roots instead of recursing forever in the UI.
    const seen = new Set<string>([node.session.id]);
    let cursor: AgentTopologySession | undefined = parent.session;
    let cycle = false;
    while (cursor) {
      if (seen.has(cursor.id)) {
        cycle = true;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parentSessionId ? unique.get(cursor.parentSessionId) : undefined;
    }
    if (cycle) {
      node.detached = true;
      node.cycle = true;
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const sortTree = (node: AgentTopologyNode): void => {
    node.children.sort((a, b) => compareAgentSessions(a.session, b.session));
    node.children.forEach(sortTree);
  };
  roots.sort((a, b) => compareAgentSessions(a.session, b.session));
  roots.forEach(sortTree);
  return roots;
}

export function agentMatchesFilter(
  session: AgentTopologySession,
  filter: AgentTopologyFilter,
  now: number = Date.now(),
): boolean {
  if (filter === "all") return true;
  if (filter === "attention") {
    return agentNeedsYou(session) || session.children.attentionDescendants > 0;
  }
  if (filter === "running") {
    return (
      isRunningAgent(session) ||
      session.children.runningDescendants + session.children.queuedDescendants > 0
    );
  }
  return isRecentlyFailedWorkstream(session, now);
}

/**
 * Whether expanding this node can reveal a descendant the current view is
 * about. Under All, only branches with live work open by themselves; quiet
 * trees stay folded until someone opens them.
 */
export function agentHasMatchingDescendants(
  session: AgentTopologySession,
  filter: AgentTopologyFilter,
): boolean {
  const { runningDescendants, queuedDescendants, attentionDescendants } = session.children;
  if (filter === "all") return runningDescendants + queuedDescendants + attentionDescendants > 0;
  if (filter === "attention") return attentionDescendants > 0;
  if (filter === "running") return runningDescendants + queuedDescendants > 0;
  return false;
}

/** Keep ancestors of matching nodes so filtered results retain their branch context. */
export function filterAgentTopology(
  roots: AgentTopologyNode[],
  filter: AgentTopologyFilter,
  query: string,
  now: number = Date.now(),
): AgentTopologyNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visit = (node: AgentTopologyNode): AgentTopologyNode | null => {
    const children = node.children
      .map(visit)
      .filter((child): child is AgentTopologyNode => !!child);
    const title = node.session.title?.trim() || "Untitled agent";
    const matchesQuery =
      normalizedQuery.length === 0 ||
      title.toLocaleLowerCase().includes(normalizedQuery) ||
      node.session.id.toLocaleLowerCase().includes(normalizedQuery);
    const matches = agentMatchesFilter(node.session, filter, now) && matchesQuery;
    return matches || children.length > 0 ? { ...node, children } : null;
  };
  return roots.map(visit).filter((node): node is AgentTopologyNode => !!node);
}

export function countTopologyDescendants(node: AgentTopologyNode): number {
  return node.children.reduce((count, child) => count + 1 + countTopologyDescendants(child), 0);
}

/** Bound rendering cost while retaining exact omitted-descendant counts. */
export function limitAgentTopology(
  roots: AgentTopologyNode[],
  limits: AgentTopologyLimits,
): LimitedAgentTopology {
  const totalCount = roots.reduce((count, root) => count + 1 + countTopologyDescendants(root), 0);
  const hiddenByParent = new Map<string, number>();
  let remaining = Math.max(1, limits.maxNodes);
  let visibleCount = 0;

  const subtreeSize = (node: AgentTopologyNode): number => 1 + countTopologyDescendants(node);
  const visit = (node: AgentTopologyNode, depth: number): AgentTopologyNode | null => {
    if (remaining <= 0) return null;
    remaining -= 1;
    visibleCount += 1;
    if (limits.maxDepth !== null && depth >= limits.maxDepth) {
      const hidden = countTopologyDescendants(node);
      if (hidden > 0) hiddenByParent.set(node.session.id, hidden);
      return { ...node, children: [] };
    }

    const allowedChildren =
      limits.maxChildren === null ? node.children : node.children.slice(0, limits.maxChildren);
    let hidden = node.children
      .slice(allowedChildren.length)
      .reduce((count, child) => count + subtreeSize(child), 0);
    const children: AgentTopologyNode[] = [];
    for (const child of allowedChildren) {
      const visibleChild = visit(child, depth + 1);
      if (visibleChild) children.push(visibleChild);
      else hidden += subtreeSize(child);
    }
    if (hidden > 0) hiddenByParent.set(node.session.id, hidden);
    return { ...node, children };
  };

  const limitedRoots: AgentTopologyNode[] = [];
  for (const root of roots) {
    const visibleRoot = visit(root, 0);
    if (visibleRoot) limitedRoots.push(visibleRoot);
  }
  return {
    roots: limitedRoots,
    visibleCount,
    hiddenCount: totalCount - visibleCount,
    hiddenByParent,
  };
}

/**
 * Position a visible forest as compact top-down trees. Each workstream keeps
 * its own subtree; workstreams sit side by side and wrap into a new band when
 * the next one would not fit in `maxWidth` (one band when it is omitted).
 */
export function layoutAgentTopologyDiagram(
  roots: AgentTopologyNode[],
  collapsed: ReadonlySet<string>,
  maxWidth: number = Number.POSITIVE_INFINITY,
): AgentTopologyDiagramLayout {
  const centerPriority = (children: AgentTopologyNode[]): AgentTopologyNode[] => {
    if (children.length < 3) return children;
    const slots = new Array<AgentTopologyNode>(children.length);
    const center = Math.floor((children.length - 1) / 2);
    slots[center] = children[0]!;
    let left = center - 1;
    let right = center + 1;
    let placeRight = children.length % 2 === 0;
    for (const child of children.slice(1)) {
      if ((placeRight && right < slots.length) || left < 0) slots[right++] = child;
      else slots[left--] = child;
      placeRight = !placeRight;
    }
    return slots;
  };
  const units = new Map<string, number>();
  const depths = new Map<string, number>();
  const measure = (node: AgentTopologyNode): number => {
    const visibleChildren = collapsed.has(node.session.id) ? [] : node.children;
    let deepest = 0;
    const width = Math.max(
      1,
      visibleChildren.reduce((sum, child) => {
        const childUnits = measure(child);
        deepest = Math.max(deepest, 1 + (depths.get(child.session.id) ?? 0));
        return sum + childUnits;
      }, 0),
    );
    units.set(node.session.id, width);
    depths.set(node.session.id, deepest);
    return width;
  };
  roots.forEach(measure);

  // A band holds whole workstreams; the last card in a band needs no gap after it.
  const available = maxWidth - AGENT_DIAGRAM_PADDING * 2 + AGENT_DIAGRAM_COLUMN_GAP;
  const columns = Number.isFinite(available)
    ? Math.max(1, Math.floor(available / (AGENT_DIAGRAM_NODE_MIN_WIDTH + AGENT_DIAGRAM_COLUMN_GAP)))
    : 0;
  // One column (a phone) takes the whole width; wider layouts cap the card.
  const nodeWidth =
    columns === 0
      ? AGENT_DIAGRAM_NODE_WIDTH
      : columns === 1
        ? Math.max(AGENT_DIAGRAM_NODE_MIN_WIDTH, Math.floor(available - AGENT_DIAGRAM_COLUMN_GAP))
        : Math.min(
            AGENT_DIAGRAM_NODE_MAX_WIDTH,
            Math.floor(available / columns - AGENT_DIAGRAM_COLUMN_GAP),
          );
  const pitch = nodeWidth + AGENT_DIAGRAM_COLUMN_GAP;
  // On one column (a phone) a parent sits over its first child, so the part of
  // a wide tree that is on screen always starts with the parent and its most
  // important child; wider layouts center parents over their children.
  const alignStart = columns === 1;
  const levelHeight = AGENT_DIAGRAM_NODE_HEIGHT + AGENT_DIAGRAM_ROW_GAP;
  const nodes: AgentTopologyDiagramNode[] = [];
  const place = (
    node: AgentTopologyNode,
    parentId: string | null,
    originX: number,
    offsetUnits: number,
    originY: number,
    depth: number,
  ): void => {
    const widthUnits = units.get(node.session.id) ?? 1;
    nodes.push({
      node,
      parentId,
      depth,
      x: originX + (alignStart ? offsetUnits : offsetUnits + widthUnits / 2 - 0.5) * pitch,
      y: originY + depth * levelHeight,
    });
    if (collapsed.has(node.session.id)) return;
    let childOffset = offsetUnits;
    for (const child of alignStart ? node.children : centerPriority(node.children)) {
      place(child, node.session.id, originX, childOffset, originY, depth + 1);
      childOffset += units.get(child.session.id) ?? 1;
    }
  };

  let bandX = 0;
  let bandY = 0;
  let bandHeight = 0;
  let widest = 0;
  for (const root of roots) {
    const width = (units.get(root.session.id) ?? 1) * pitch;
    const depth = depths.get(root.session.id) ?? 0;
    const height = (depth + 1) * AGENT_DIAGRAM_NODE_HEIGHT + depth * AGENT_DIAGRAM_ROW_GAP;
    if (bandX > 0 && bandX + width > available) {
      bandY += bandHeight + AGENT_DIAGRAM_BAND_GAP;
      bandX = 0;
      bandHeight = 0;
    }
    place(root, null, AGENT_DIAGRAM_PADDING + bandX, 0, AGENT_DIAGRAM_PADDING + bandY, 0);
    bandX += width;
    widest = Math.max(widest, bandX);
    bandHeight = Math.max(bandHeight, height);
  }
  return {
    nodes,
    width: Math.ceil(
      AGENT_DIAGRAM_PADDING * 2 + Math.max(widest, pitch) - AGENT_DIAGRAM_COLUMN_GAP,
    ),
    height: Math.ceil(
      AGENT_DIAGRAM_PADDING * 2 + bandY + Math.max(bandHeight, AGENT_DIAGRAM_NODE_HEIGHT),
    ),
    nodeWidth,
  };
}
