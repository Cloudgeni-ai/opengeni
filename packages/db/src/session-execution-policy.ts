import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";

/** Actual execution evidence, independent of later default-setting commands. */
export function latestStartedSessionTurnQuery(
  db: Database,
  workspaceId: string,
  sessionId: string | SQL,
) {
  return startedSessionTurnQuery(db, workspaceId, sessionId, false);
}

/** Effective defaults exclude turns accepted before an explicit settings write,
 * even when those turns start later. After an explicit write, automated
 * per-occurrence overrides cannot replace defaults. A later human/API turn can.
 * Original queue admission, not the mutable approval/recovery trigger, orders
 * that choice. Actual latest-started identity is unchanged.
 */
function startedSessionTurnQuery(
  db: Database,
  workspaceId: string,
  sessionId: string | SQL,
  respectSettingsBoundary: boolean,
) {
  return db
    .select({
      id: schema.sessionTurns.id,
      model: schema.sessionTurns.model,
      reasoningEffort: schema.sessionTurns.reasoningEffort,
      latencyMode: schema.sessionTurns.latencyMode,
    })
    .from(schema.sessionEvents)
    .innerJoin(
      schema.sessionTurns,
      and(
        eq(schema.sessionEvents.workspaceId, schema.sessionTurns.workspaceId),
        eq(schema.sessionEvents.sessionId, schema.sessionTurns.sessionId),
        eq(schema.sessionEvents.turnId, schema.sessionTurns.id),
      ),
    )
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        eq(schema.sessionEvents.type, "turn.started"),
        ...(respectSettingsBoundary
          ? [
              sql`coalesce(case when ${schema.sessionTurns.source} in ('user', 'api') then (
              select min(accepted.sequence) from ${schema.sessionEvents} accepted
              where accepted.workspace_id = ${workspaceId}
                and accepted.session_id = ${sessionId}
                and accepted.turn_id = ${schema.sessionTurns.id}
                and accepted.type = 'turn.queued'
            ) end, 0) > coalesce((
              select max(boundary.sequence) from ${schema.sessionEvents} boundary
              where boundary.workspace_id = ${workspaceId}
                and boundary.session_id = ${sessionId}
                and boundary.type = 'session.model_settings.updated'
            ), -1)`,
            ]
          : []),
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1);
}

type PolicyRow = Pick<
  typeof schema.sessions.$inferSelect,
  "id" | "model" | "reasoningEffort" | "latencyMode"
>;

/** Read projection only: never overwrite stored settings or accepted turns.
 * Call inside the caller's existing workspace/subject RLS boundary.
 * One bounded lateral lookup per listed session, not one network call per row.
 */
export async function withEffectiveSessionPolicy<T extends PolicyRow>(
  db: Database,
  workspaceId: string,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const latest = startedSessionTurnQuery(db, workspaceId, sql`${schema.sessions.id}`, true).as(
    "latest_started_policy",
  );
  const policies = await db
    .select({
      id: schema.sessions.id,
      // Row and event policy share one statement snapshot. A concurrent
      // settings write must not combine a newer boundary with stale row defaults.
      model: sql<string>`coalesce(${latest.model}, ${schema.sessions.model})`,
      reasoningEffort: sql<string>`coalesce(${latest.reasoningEffort}, ${schema.sessions.reasoningEffort})`,
      latencyMode: sql<string>`coalesce(${latest.latencyMode}, ${schema.sessions.latencyMode})`,
    })
    .from(schema.sessions)
    .leftJoinLateral(latest, sql`true`)
    .where(
      and(
        eq(schema.sessions.workspaceId, workspaceId),
        inArray(schema.sessions.id, [...new Set(rows.map((row) => row.id))]),
      ),
    );
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  return rows.map((row) => {
    const policy = byId.get(row.id);
    return policy?.model
      ? {
          ...row,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort ?? row.reasoningEffort,
          latencyMode: policy.latencyMode ?? row.latencyMode,
        }
      : row;
  });
}
