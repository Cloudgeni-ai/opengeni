import type { AgentTopologySession } from "@opengeni/sdk";

export type AgentTopologyFilter = "all" | "active" | "attention" | "paused" | "failed";

export type AgentTopologyNode = {
  session: AgentTopologySession;
  children: AgentTopologyNode[];
  detached: boolean;
  cycle: boolean;
};

export type AgentTopologySummary = {
  total: number;
  active: number;
  running: number;
  queued: number;
  attention: number;
  paused: number;
  failed: number;
};

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

export const AGENT_DIAGRAM_NODE_WIDTH = 224;
export const AGENT_DIAGRAM_NODE_HEIGHT = 96;
const AGENT_DIAGRAM_COLUMN_GAP = 48;
const AGENT_DIAGRAM_ROW_GAP = 64;
const AGENT_DIAGRAM_PADDING = 24;

export function isPausedAgent(session: AgentTopologySession): boolean {
  return session.pause.state === "paused";
}

export function isActiveAgent(session: AgentTopologySession): boolean {
  return (
    !isPausedAgent(session) &&
    (session.status === "running" ||
      session.status === "queued" ||
      session.status === "requires_action")
  );
}

export function summarizeAgentTopology(sessions: AgentTopologySession[]): AgentTopologySummary {
  const summary: AgentTopologySummary = {
    total: sessions.length,
    active: 0,
    running: 0,
    queued: 0,
    attention: 0,
    paused: 0,
    failed: 0,
  };
  for (const session of sessions) {
    if (isPausedAgent(session)) {
      summary.paused += 1;
      continue;
    }
    if (isActiveAgent(session)) summary.active += 1;
    if (session.status === "running") summary.running += 1;
    if (session.status === "queued") summary.queued += 1;
    if (session.status === "requires_action") summary.attention += 1;
    if (session.status === "failed") summary.failed += 1;
  }
  return summary;
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
    nodes.set(session.id, { session, children: [], detached: false, cycle: false });
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
): boolean {
  if (filter === "all") return true;
  if (filter === "active") {
    return (
      isActiveAgent(session) ||
      session.children.runningDescendants +
        session.children.queuedDescendants +
        session.children.attentionDescendants >
        0
    );
  }
  if (filter === "attention") {
    return (
      (!isPausedAgent(session) && session.status === "requires_action") ||
      session.children.attentionDescendants > 0
    );
  }
  if (filter === "paused") {
    return isPausedAgent(session) || session.children.pausedDescendants > 0;
  }
  return (
    (!isPausedAgent(session) && session.status === "failed") ||
    session.children.failedDescendants > 0
  );
}

/** Keep ancestors of matching nodes so filtered results retain their branch context. */
export function filterAgentTopology(
  roots: AgentTopologyNode[],
  filter: AgentTopologyFilter,
  query: string,
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
    const matches = agentMatchesFilter(node.session, filter) && matchesQuery;
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

/** Position a visible forest as a compact top-down decision tree. */
export function layoutAgentTopologyDiagram(
  roots: AgentTopologyNode[],
  collapsed: ReadonlySet<string>,
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
  const measure = (node: AgentTopologyNode): number => {
    const visibleChildren = collapsed.has(node.session.id) ? [] : node.children;
    const width = Math.max(
      1,
      visibleChildren.reduce((sum, child) => sum + measure(child), 0),
    );
    units.set(node.session.id, width);
    return width;
  };
  roots.forEach(measure);

  const pitch = AGENT_DIAGRAM_NODE_WIDTH + AGENT_DIAGRAM_COLUMN_GAP;
  const nodes: AgentTopologyDiagramNode[] = [];
  let maxDepth = 0;
  const place = (
    node: AgentTopologyNode,
    parentId: string | null,
    offsetUnits: number,
    depth: number,
  ): void => {
    const widthUnits = units.get(node.session.id) ?? 1;
    maxDepth = Math.max(maxDepth, depth);
    nodes.push({
      node,
      parentId,
      depth,
      x:
        AGENT_DIAGRAM_PADDING +
        (offsetUnits + widthUnits / 2) * pitch -
        AGENT_DIAGRAM_NODE_WIDTH / 2,
      y: AGENT_DIAGRAM_PADDING + depth * (AGENT_DIAGRAM_NODE_HEIGHT + AGENT_DIAGRAM_ROW_GAP),
    });
    if (collapsed.has(node.session.id)) return;
    let childOffset = offsetUnits;
    for (const child of centerPriority(node.children)) {
      place(child, node.session.id, childOffset, depth + 1);
      childOffset += units.get(child.session.id) ?? 1;
    }
  };

  let rootOffset = 0;
  for (const root of roots) {
    place(root, null, rootOffset, 0);
    rootOffset += units.get(root.session.id) ?? 1;
  }
  const totalUnits = Math.max(1, rootOffset);
  return {
    nodes,
    width: Math.ceil(AGENT_DIAGRAM_PADDING * 2 + totalUnits * pitch),
    height: Math.ceil(
      AGENT_DIAGRAM_PADDING * 2 +
        (maxDepth + 1) * AGENT_DIAGRAM_NODE_HEIGHT +
        maxDepth * AGENT_DIAGRAM_ROW_GAP,
    ),
  };
}
