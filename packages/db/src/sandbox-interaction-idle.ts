import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

export const INTERACTION_ONLY_IDLE_BUCKETS = ["lt_30m", "30m_2h", "2h_6h", "gte_6h"] as const;
export type InteractionOnlyIdleBucket = (typeof INTERACTION_ONLY_IDLE_BUCKETS)[number];

export type InteractionOnlyLeaseCandidate = {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
};

export function interactionOnlyIdleBucket(idleMs: number): InteractionOnlyIdleBucket {
  if (idleMs < 30 * 60_000) return "lt_30m";
  if (idleMs < 2 * 60 * 60_000) return "30m_2h";
  if (idleMs < 6 * 60 * 60_000) return "2h_6h";
  return "gte_6h";
}

/**
 * Read-only inventory of warm leases whose ONLY holders are Browser/Computer
 * interaction holders, bucketed by time since the newest interaction activity
 * (holder heartbeat, controller heartbeat, or last use). Interaction holders
 * deliberately never expire by timestamp, so such a box stays warm until its
 * session ends or the provider deadline; this makes that visible. Candidates
 * come from the sanctioned cross-workspace warm-lease list; each workspace is
 * then read under its own RLS scope. No lock beyond the snapshot is taken.
 */
export async function countInteractionOnlyWarmLeasesByIdle(
  db: Database,
  candidates: InteractionOnlyLeaseCandidate[],
  options: { now?: Date; maxWorkspaces?: number } = {},
): Promise<Record<InteractionOnlyIdleBucket, number>> {
  const nowMs = (options.now ?? new Date()).getTime();
  const counts = Object.fromEntries(INTERACTION_ONLY_IDLE_BUCKETS.map((b) => [b, 0])) as Record<
    InteractionOnlyIdleBucket,
    number
  >;
  const byWorkspace = new Map<string, InteractionOnlyLeaseCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.accountId}:${candidate.workspaceId}`;
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), candidate]);
  }
  const workspaces = [...byWorkspace.values()].slice(0, options.maxWorkspaces ?? 500);
  for (const group of workspaces) {
    const { accountId, workspaceId } = group[0]!;
    const groupIds = group.map((candidate) => candidate.sandboxGroupId);
    const rows = await withRlsContext(
      db,
      { accountId, workspaceId },
      async (scoped) =>
        await rawRows<{ last_activity_at: Date | string | null }>(
          scoped,
          sql`
            select max(greatest(
              holder.last_heartbeat_at,
              browser.controller_heartbeat_at, browser.last_used_at,
              computer.controller_heartbeat_at, computer.last_used_at
            )) as last_activity_at
            from sandbox_leases lease
            join sandbox_lease_holders holder
              on holder.lease_id = lease.id and holder.workspace_id = lease.workspace_id
            left join browser_sessions browser
              on holder.holder_id = 'browser-session:' || browser.id::text
              and browser.workspace_id = lease.workspace_id
            left join computer_sessions computer
              on holder.holder_id = 'computer-session:' || computer.id::text
              and computer.workspace_id = lease.workspace_id
            where lease.account_id = ${accountId}
              and lease.workspace_id = ${workspaceId}
              and lease.sandbox_group_id in ${sql`(${sql.join(
                groupIds.map((id) => sql`${id}`),
                sql`, `,
              )})`}
              and lease.liveness = 'warm'
            group by lease.id
            having bool_and(holder.kind = 'interaction')
          `,
        ),
      undefined,
      "none",
    );
    for (const row of rows) {
      const last = row.last_activity_at ? new Date(row.last_activity_at).getTime() : Number.NaN;
      counts[
        interactionOnlyIdleBucket(Number.isFinite(last) ? Math.max(0, nowMs - last) : Infinity)
      ] += 1;
    }
  }
  return counts;
}
