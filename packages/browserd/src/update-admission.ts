/** How long after a browser or computer session's last request an agent update
 * waits. A restart mid-task fails the agent's next calls while it lasts, even
 * for sessions that survive it; agents pause between steps for a model turn,
 * rarely this long. */
export const RECENT_USE_UPDATE_HOLD_MS = 3 * 60_000;

/** Content-free ownership evidence for an update hold. Never include page
 * titles, URLs, command text, local paths or credentials. */
export interface UpdateBlocker {
  kind: string;
  resourceId?: string;
  count: number;
}

/** Host update diagnostics cross controller/workspace boundaries. Keep private
 * session identities local and bound the reply independently of session count. */
export function summarizeUpdateBlockers(blockers: readonly UpdateBlocker[]): UpdateBlocker[] {
  const counts = new Map<string, number>();
  for (const blocker of blockers) {
    const kind = counts.has(blocker.kind) || counts.size < 32 ? blocker.kind : "other_work";
    counts.set(kind, Math.min(0xffff_ffff, (counts.get(kind) ?? 0) + blocker.count));
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => ({ kind, count }));
}
