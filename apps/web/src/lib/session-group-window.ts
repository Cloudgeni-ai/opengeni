import type { SessionTreeNode } from "./sessions-group";

/** Display disclosure is independent of API page size and retained page caches. */
export const SESSION_GROUP_VISIBLE_STEP = 4;

/** Fill a display step even when it straddles the retained server page. */
export function sessionGroupDisclosurePlan(
  visibleCount: number,
  loadedCount: number,
  hasMore: boolean,
  failed: boolean,
): { nextCount: number; needsPage: boolean } {
  const nextCount = failed
    ? visibleCount
    : Math.max(
        SESSION_GROUP_VISIBLE_STEP,
        Math.min(visibleCount, loadedCount) + SESSION_GROUP_VISIBLE_STEP,
      );
  return {
    nextCount,
    needsPage: failed || loadedCount <= visibleCount || (hasMore && loadedCount < nextCount),
  };
}

function containsSession(node: SessionTreeNode, sessionId: string): boolean {
  return (
    node.session.id === sessionId ||
    node.children.some((child) => containsSession(child, sessionId))
  );
}

/** Keep the selected workstream visible without exceeding the group's window. */
export function sessionGroupWindowNodes(
  nodes: readonly SessionTreeNode[],
  visibleCount: number,
  selectedSessionId: string | null,
): SessionTreeNode[] {
  const limit = Math.max(SESSION_GROUP_VISIBLE_STEP, visibleCount);
  const visible = nodes.slice(0, limit);
  if (!selectedSessionId || visible.some((node) => containsSession(node, selectedSessionId))) {
    return visible;
  }
  const selected = nodes.slice(limit).find((node) => containsSession(node, selectedSessionId));
  if (selected) visible[visible.length - 1] = selected;
  return visible;
}
