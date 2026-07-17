import type { Session } from "@/types";

export const DEFAULT_VISIBLE_TREE_LEVELS = 3;
export const MAX_VISUAL_TREE_DEPTH = 3;

export function sessionStatusLabel(status: Session["status"]): string {
  switch (status) {
    case "requires_action":
      return "Needs you";
    case "waiting_capacity":
      return "Waiting for capacity";
    case "recovering":
      return "Recovering";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Idle";
  }
}

/** Honest user-facing state: lifecycle first, then the effective pause policy. */
export function sessionStateLabel(session: Session): string {
  const lifecycle = sessionStatusLabel(session.status);
  const attentionOrTerminal =
    session.status === "requires_action" ||
    session.status === "failed" ||
    session.status === "cancelled";

  const control = session.effectiveControl;
  if (control.state !== "paused") {
    return control.override ? `${lifecycle} · Resumed workstream` : lifecycle;
  }
  if (control.settlement) return "Pausing…";
  const blocker = control.primaryBlocker;
  const pause =
    blocker?.kind === "workspace"
      ? "Workspace paused"
      : control.directState === "paused" || blocker?.sessionId === session.id
        ? "Paused here"
        : `Paused by ${blocker?.displayName ?? "parent"}`;
  return attentionOrTerminal ? `${lifecycle} · ${pause}` : pause;
}

/** Root-to-parent path for the URL-active session, guarded against corrupt cycles. */
export function sessionAncestorPath(
  activeSessionId: string | null,
  parentOf: ReadonlyMap<string, string>,
): string[] {
  if (!activeSessionId) return [];
  const reversePath: string[] = [];
  const seen = new Set<string>([activeSessionId]);
  let cursor = parentOf.get(activeSessionId);
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    reversePath.push(cursor);
    cursor = parentOf.get(cursor);
  }
  return reversePath.reverse();
}

/** Expand only enough ancestors to show the default number of real tree levels. */
export function defaultExpandedAncestors(
  ancestorPath: readonly string[],
  manuallyCollapsed: ReadonlySet<string>,
  visibleLevels = DEFAULT_VISIBLE_TREE_LEVELS,
): ReadonlySet<string> {
  const expansionCount = Math.max(0, visibleLevels - 1);
  return new Set(
    ancestorPath.slice(0, expansionCount).filter((sessionId) => !manuallyCollapsed.has(sessionId)),
  );
}

export function visualTreeDepth(depth: number): number {
  return Math.min(MAX_VISUAL_TREE_DEPTH, Math.max(0, depth));
}
