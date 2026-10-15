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
 *
 * Cost is bounded by recent history, not session length: the newest
 * `turn.started` event is found by a backward walk of
 * session_events_workspace_session_type_sequence_idx that probes each
 * candidate's turn by primary key and stops at the first eligible one. With a
 * settings boundary the walk also stops at the boundary, because an eligible
 * turn was queued after it and so started after it. Joining all start events
 * to all turns instead would hash the whole session per read.
 */
function startedSessionTurnQuery(
  db: Database,
  workspaceId: string,
  sessionId: string | SQL,
  respectSettingsBoundary: boolean,
) {
  // Coalesce inside the scalar subquery: the comparison then reads a plain
  // parameter, which row-level security accepts as an index bound. An outer
  // COALESCE is not leakproof, so RLS would demote the bound to a filter.
  const settingsBoundary = sql`(
    select coalesce(max(boundary.sequence), -1) from ${schema.sessionEvents} boundary
    where boundary.workspace_id = ${workspaceId}
      and boundary.session_id = ${sessionId}
      and boundary.type = 'session.model_settings.updated'
  )`;
  const latestStartedTurnId = sql`(
    select started.turn_id from ${schema.sessionEvents} started
    where started.workspace_id = ${workspaceId}
      and started.session_id = ${sessionId}
      and started.type = 'turn.started'
      ${respectSettingsBoundary ? sql`and started.sequence > ${settingsBoundary}` : sql``}
      and exists (
        select 1 from ${schema.sessionTurns} candidate
        where candidate.workspace_id = started.workspace_id
          and candidate.session_id = started.session_id
          and candidate.id = started.turn_id
          ${
            respectSettingsBoundary
              ? sql`and coalesce(case when candidate.source in ('user', 'api') then (
                  select min(accepted.sequence) from ${schema.sessionEvents} accepted
                  where accepted.workspace_id = ${workspaceId}
                    and accepted.session_id = ${sessionId}
                    and accepted.turn_id = candidate.id
                    and accepted.type = 'turn.queued'
                ) end, 0) > ${settingsBoundary}`
              : sql``
          }
      )
    order by started.sequence desc
    limit 1
  )`;
  return db
    .select({
      id: schema.sessionTurns.id,
      model: schema.sessionTurns.model,
      reasoningEffort: schema.sessionTurns.reasoningEffort,
      latencyMode: schema.sessionTurns.latencyMode,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        sql`${schema.sessionTurns.id} = ${latestStartedTurnId}`,
      ),
    )
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
  const policies = await effectiveSessionPolicyQuery(db, workspaceId, [
    ...new Set(rows.map((row) => row.id)),
  ]);
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

/** The statement behind {@link withEffectiveSessionPolicy}: one bounded
 * lateral lookup per listed session. Call inside the caller's RLS boundary. */
export function effectiveSessionPolicyQuery(
  db: Database,
  workspaceId: string,
  sessionIds: readonly string[],
) {
  const latest = startedSessionTurnQuery(db, workspaceId, sql`${schema.sessions.id}`, true).as(
    "latest_started_policy",
  );
  return db
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
        inArray(schema.sessions.id, [...sessionIds]),
      ),
    );
}

/** Compact-list model projection with a fixed per-row cost.
 *
 * Each listed session gets two backward probes of
 * session_events_workspace_session_type_sequence_idx (its latest
 * `turn.started` and its latest explicit `session.model_settings.updated`)
 * and one primary-key lookup of the started turn.
 * The latest started turn's policy wins unless the settings write is newer (or
 * no turn has started), in which case the stored defaults are current. Unlike
 * {@link withEffectiveSessionPolicy} it never walks older turns, so a long
 * session costs the same as a new one. Read projection only.
 */
export async function withSessionListModelPolicy<T extends PolicyRow>(
  db: Database,
  workspaceId: string,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  // Probe the latest start event alone, then look its turn up by primary key.
  // Joining inside the LIMIT would keep scanning older events whenever a start
  // has no turn row (imported history), which is exactly the unbounded walk
  // this projection exists to avoid.
  const started = db
    .select({ sequence: schema.sessionEvents.sequence, turnId: schema.sessionEvents.turnId })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sql`${schema.sessions.id}`),
        eq(schema.sessionEvents.type, "turn.started"),
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1)
    .as("latest_started_turn_event");
  const settings = db
    .select({ sequence: schema.sessionEvents.sequence })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sql`${schema.sessions.id}`),
        eq(schema.sessionEvents.type, "session.model_settings.updated"),
      ),
    )
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1)
    .as("latest_model_settings_write");
  // Stored defaults and both probes share one statement snapshot, so a
  // concurrent settings write cannot pair a newer boundary with stale defaults.
  // A start without its turn row (imported history) falls back to defaults.
  const startedIsCurrent = sql`${schema.sessionTurns.id} is not null and ${started.sequence} > coalesce(${settings.sequence}, -1)`;
  const policies = await db
    .select({
      id: schema.sessions.id,
      model: sql<string>`case when ${startedIsCurrent} then ${schema.sessionTurns.model} else ${schema.sessions.model} end`,
      reasoningEffort: sql<string>`case when ${startedIsCurrent} then ${schema.sessionTurns.reasoningEffort} else ${schema.sessions.reasoningEffort} end`,
      latencyMode: sql<string>`case when ${startedIsCurrent} then ${schema.sessionTurns.latencyMode} else ${schema.sessions.latencyMode} end`,
    })
    .from(schema.sessions)
    .leftJoinLateral(started, sql`true`)
    .leftJoin(
      schema.sessionTurns,
      and(
        eq(schema.sessionTurns.workspaceId, schema.sessions.workspaceId),
        eq(schema.sessionTurns.sessionId, schema.sessions.id),
        eq(schema.sessionTurns.id, started.turnId),
      ),
    )
    .leftJoinLateral(settings, sql`true`)
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
