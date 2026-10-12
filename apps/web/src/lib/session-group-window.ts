import type { SessionTreeNode } from "./sessions-group";

/** Display disclosure is independent of API page size and retained page caches. */
export const SESSION_GROUP_VISIBLE_STEP = 4;

/** One rendered, expanded session group that can use spare rail height. */
export type SessionGroupFillCandidate = {
  key: string;
  /** Root rows already loaded for the group. */
  loaded: number;
  /** Rows shown without automatic fill: the initial step or a manual disclosure. */
  base: number;
  /** The server can return more rows for this group. */
  hasMore: boolean;
};

/**
 * Plan the extra rows each group shows to use spare rail height.
 *
 * Spare rows go top-down to groups that still hide rows. Rows already planned
 * or restored but not loaded yet count against the spare space, so slow pages
 * never cause over-allocation. Rows are taken back bottom-up only when `shrink` is set
 * (the rail viewport itself got shorter); content growth from manual
 * disclosure or new sessions never retracts rows the reader can already see.
 * Groups absent from `candidates` (collapsed or no longer rendered) drop
 * their fill.
 */
export function planSessionGroupFill(
  candidates: readonly SessionGroupFillCandidate[],
  current: ReadonlyMap<string, number>,
  freeRows: number,
  shrink: boolean,
): Map<string, number> {
  const next = new Map<string, number>();
  const shown = new Map<string, number>();
  let pending = 0;
  for (const candidate of candidates) {
    const fill = Math.max(0, current.get(candidate.key) ?? 0);
    const rendered = Math.max(0, Math.min(fill, candidate.loaded - candidate.base));
    shown.set(candidate.key, rendered);
    // An exhausted group can never render rows it does not have.
    next.set(candidate.key, candidate.hasMore ? fill : rendered);
    // Unloaded rows of the manual window will appear without new fill.
    if (candidate.hasMore) pending += Math.max(0, candidate.base + fill - candidate.loaded);
  }
  if (freeRows >= pending) {
    let available = freeRows - pending;
    for (const candidate of candidates) {
      const fill = next.get(candidate.key)!;
      if (candidate.hasMore) {
        next.set(candidate.key, fill + available);
        available = 0;
        continue;
      }
      const hidden = Math.max(0, candidate.loaded - candidate.base - fill);
      if (hidden === 0) continue;
      if (hidden <= available + 1) {
        // Showing a group's last hidden rows also removes its "Show more"
        // control, which takes about one row of height.
        next.set(candidate.key, fill + hidden);
        available -= hidden - 1;
      } else {
        next.set(candidate.key, fill + available);
        available = 0;
      }
    }
  } else if (shrink && freeRows < 0) {
    // Unloaded rows cannot cause the overflow; drop them, then visible fill.
    let excess = -freeRows;
    for (const candidate of [...candidates].reverse()) {
      const fill = shown.get(candidate.key)!;
      const removed = Math.min(fill, excess);
      next.set(candidate.key, fill - removed);
      excess -= removed;
    }
  }
  for (const [key, fill] of next) if (fill === 0) next.delete(key);
  return next;
}

/** True when two fill plans show the same rows. */
export function sameSessionGroupFill(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, fill] of left) if (right.get(key) !== fill) return false;
  return true;
}

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
