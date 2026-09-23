// The For you feed ranks root workstreams using durable session-list truth.
// Human wait duration uses the oldest reported request timestamp, never a
// parent update timestamp multiplied by descendants. This is not billing.
import type { Session } from "../types";
import { rootNeedsYou } from "./needs-you";
import { sessionStateLabel } from "./session-rail";

export type PriorityTier = "blocked" | "broken" | "finished" | "waiting";

export type PriorityEntry = {
  session: Session;
  tier: PriorityTier;
  /** Position in the ranked queue; null for unranked self-resolving waits. */
  rank: number | null;
  /** One-line reason in the product's state voice. */
  reason: string;
  /** Minutes since the session was last updated. */
  waitingMinutes: number;
  /**
   * Tier-specific agent count for the ledger basis line: blocked = turns
   * visibly waiting on a human in this tree (>= 1); broken = 1; finished =
   * the whole tree's agents ("N agents' work"); waiting = 0.
   */
  waitingAgents: number;
  /** Oldest verified human wait; absent timestamp is explicitly unknown. */
  oldestHumanWaitMinutes?: number | null;
};

export type PriorityFeed = {
  blocked: PriorityEntry[];
  broken: PriorityEntry[];
  finished: PriorityEntry[];
  waiting: PriorityEntry[];
  /** Workstreams running without needing anyone, collapsed to counts. */
  healthy: { workstreams: number; agents: number };
  /** Blocked + broken — the rail badge number. */
  needsYou: number;
};

const FINISHED_LIMIT = 8;

function minutesSince(iso: string, now: Date): number {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
}

function treeAgents(session: Session): number {
  return 1 + (session.treeStats?.totalDescendants ?? 0);
}

// Attention-descendant roots are classified blocked before this runs, so live
// work here means only actually-executing descendants.
function treeHasLiveWork(session: Session): boolean {
  const stats = session.treeStats;
  if (!stats) return false;
  return stats.runningDescendants + stats.queuedDescendants > 0;
}

/** "25 m", "1 h 40 m", "3 d 2 h" — the mono ledger duration. */
export function formatAgentMinutes(minutes: number): string {
  if (minutes < 1) return "<1 m";
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} m` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days} d ${restHours} h` : `${days} d`;
}

/**
 * Build the feed from ROOT sessions (the rail's root page). Child rows are
 * ignored defensively: a tree surfaces through its root only.
 */
export function buildPriorityFeed(sessions: Session[], now: Date = new Date()): PriorityFeed {
  const roots = sessions.filter((session) => session.parentSessionId === null);

  const blocked: PriorityEntry[] = [];
  const broken: PriorityEntry[] = [];
  const finished: PriorityEntry[] = [];
  const waiting: PriorityEntry[] = [];
  let healthyWorkstreams = 0;
  let healthyAgents = 0;

  for (const session of roots) {
    const waitingMinutes = minutesSince(session.updatedAt, now);
    const reason = sessionStateLabel(session);
    const attentionDescendants = session.treeStats?.attentionDescendants ?? 0;
    if (session.status === "failed") {
      broken.push({
        session,
        tier: "broken",
        rank: null,
        reason,
        waitingMinutes,
        waitingAgents: 1,
      });
    } else if (rootNeedsYou(session)) {
      // A root whose own turn needs a human, OR a root whose spawned agents
      // do — an idle/running manager with a blocked child is still blocked
      // work, not "running fine". Failed roots were taken by the broken tier
      // above, so this branch is exactly requires_action or attention
      // descendants; the rail badge counts the same predicate.
      const waitingAgents = attentionDescendants + (session.status === "requires_action" ? 1 : 0);
      // "… for 10 h": how long the longest-waiting blocked agent has been
      // parked on a human, from the server's requires_action timestamps.
      const waitingTimes = [
        ...(session.status === "requires_action" ? [session.requiresActionSince] : []),
        ...(attentionDescendants > 0 ? [session.treeStats?.attentionSince] : []),
      ].filter(
        (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
      );
      const blockedSince = waitingTimes.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      const blockedFor = blockedSince
        ? ` for ${formatAgentMinutes(minutesSince(blockedSince, now))}`
        : "";
      blocked.push({
        session,
        tier: "blocked",
        rank: null,
        reason:
          session.status === "requires_action"
            ? `${reason}${blockedFor}`
            : `${attentionDescendants} spawned agent${
                attentionDescendants === 1 ? " needs" : "s need"
              } you${blockedFor}`,
        waitingMinutes,
        waitingAgents,
        oldestHumanWaitMinutes: blockedSince ? minutesSince(blockedSince, now) : null,
      });
    } else if (
      session.status === "waiting_capacity" ||
      session.status === "recovering" ||
      session.status === "queued"
    ) {
      waiting.push({
        session,
        tier: "waiting",
        rank: null,
        reason,
        waitingMinutes,
        waitingAgents: 0,
      });
    } else if (session.status === "running" || treeHasLiveWork(session)) {
      healthyWorkstreams += 1;
      healthyAgents += treeAgents(session);
    } else if (session.status === "idle") {
      finished.push({
        session,
        tier: "finished",
        rank: null,
        reason,
        waitingMinutes,
        waitingAgents: treeAgents(session),
      });
    }
    // Cancelled trees are deliberate terminal state: not in the feed at all.
  }

  // Oldest known human wait first. Unknown duration is never fabricated.
  blocked.sort((a, b) => (b.oldestHumanWaitMinutes ?? -1) - (a.oldestHumanWaitMinutes ?? -1));
  broken.sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  // Finished reads newest-first: the freshest result is the one to review.
  finished.sort((a, b) => a.waitingMinutes - b.waitingMinutes);
  finished.splice(FINISHED_LIMIT);
  waiting.sort((a, b) => b.waitingMinutes - a.waitingMinutes);

  let rank = 0;
  for (const entry of [...blocked, ...broken, ...finished]) {
    rank += 1;
    entry.rank = rank;
  }

  return {
    blocked,
    broken,
    finished,
    waiting,
    healthy: { workstreams: healthyWorkstreams, agents: healthyAgents },
    needsYou: blocked.length + broken.length,
  };
}
