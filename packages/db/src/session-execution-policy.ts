import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import { anyOf } from "./sql-arrays";
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
 * Cost follows the history since the last settings write, not the session's
 * length, and stays near constant when a person or API caller drives the
 * chat. The newest `turn.started` events after the boundary are read by a
 * backward walk of
 * session_events_workspace_session_type_sequence_idx that probes each
 * candidate's turn by primary key and stops at the first eligible one. An
 * eligible turn was queued after the boundary and so started after it.
 *
 * After a settings write only person/API turns are eligible, so a session that
 * a schedule or trigger keeps running would otherwise visit every automated
 * start since the write (thousands of turn probes, seconds per read in
 * production). So after a write the walk first reads at most
 * {@link RECENT_START_PROBES} starts. When those are all ineligible and more
 * exist, the answer comes from the cheaper of two exact reads:
 * - a session with at most {@link PERSON_API_TURN_CAP} person/API turns
 *   (counted through session_turns_session_person_api_idx) reads those turns:
 *   the eligible one with the newest start after the boundary;
 * - a session with more (a long API-driven chat) continues the start-by-start
 *   walk, whose cost follows the starts since the write, not its whole
 *   person/API history.
 * All paths pick the same turn. Without a write every started turn is
 * eligible, so the walk is not limited: it stops at the newest start whose
 * turn exists.
 * Joining all start events to all turns instead would hash the whole session
 * per read.
 *
 * The turn check is a scalar subquery, not EXISTS, so the planner cannot
 * flatten it into a join. A generic plan for a prepared statement does not
 * know how long the session is; given a join it may drive from every turn of
 * the session and sort, which costs tens of milliseconds to seconds on a long
 * session instead of one backward index probe.
 *
 * Each turn is read by id. Its session is compared with IS NOT DISTINCT FROM,
 * which is not an index operator: with `=` a generic plan that expects short
 * sessions may probe by (workspace, session) through
 * session_turns_session_position_idx and read every turn of the session for
 * each probe. sessionId is never null, so the two comparisons agree.
 */
function startedSessionTurnQuery(
  db: Database,
  workspaceId: string,
  sessionId: string | SQL,
  respectSettingsBoundary: boolean,
) {
  if (!respectSettingsBoundary) {
    const newestStartedTurn = sql`(
      select started.turn_id from ${schema.sessionEvents} started
      where started.workspace_id = ${workspaceId}
        and started.session_id = ${sessionId}
        and started.type = 'turn.started'
        and (
          select true from ${schema.sessionTurns} candidate
          where candidate.workspace_id = ${workspaceId}
            and candidate.id = started.turn_id
            and candidate.session_id is not distinct from ${sessionId}
          limit 1
        )
      order by started.sequence desc
      limit 1
    )`;
    return db
      .select(turnPolicyColumns)
      .from(schema.sessionTurns)
      .where(turnById(workspaceId, sessionId, newestStartedTurn))
      .limit(1);
  }
  // The latest explicit settings write, read once for every branch below.
  // Planning, not execution, dominates this statement's cost, and each extra
  // reference to a row-security table adds its policy expansion to planning.
  const settingsBoundary = sql`settings_boundary.sequence`;
  // Newest starts after the boundary, newest first; the first eligible one
  // is the answer. Without a write every started turn is eligible and the
  // walk is unlimited, so it stops at the newest start whose turn exists.
  // After a write the first walk reads at most the newest few starts.
  const startWalk = (limit: SQL) => sql`(
    select recent.turn_id from (
      select started.turn_id, started.sequence from ${schema.sessionEvents} started
      where started.workspace_id = ${workspaceId}
        and started.session_id = ${sessionId}
        and started.type = 'turn.started'
        and started.sequence > ${settingsBoundary}
      order by started.sequence desc
      ${limit}
    ) recent
    where (
      select true from ${schema.sessionTurns} candidate
      where candidate.workspace_id = ${workspaceId}
        and candidate.id = recent.turn_id
        and candidate.session_id is not distinct from ${sessionId}
        and coalesce(case when candidate.source in ('user', 'api') then (
          select min(accepted.sequence) from ${schema.sessionEvents} accepted
          where accepted.workspace_id = ${workspaceId}
            and accepted.session_id = ${sessionId}
            and accepted.turn_id = candidate.id
            and accepted.type = 'turn.queued'
        ) end, 0) > ${settingsBoundary}
      limit 1
    )
    order by recent.sequence desc
    limit 1
  )`;
  const recentWalk = startWalk(
    sql`limit case when ${settingsBoundary} >= 0 then ${sql.raw(String(RECENT_START_PROBES))} end`,
  );
  const fullWalk = startWalk(sql``);
  // True only when starts beyond the probed ones exist after the boundary.
  const olderStartsRemain = sql`exists (
    select 1 from ${schema.sessionEvents} started
    where started.workspace_id = ${workspaceId}
      and started.session_id = ${sessionId}
      and started.type = 'turn.started'
      and started.sequence > ${settingsBoundary}
    offset ${sql.raw(String(RECENT_START_PROBES))}
  )`;
  // True when the person/API read is the cheaper exact path: it costs one
  // lookup per person/API turn of the whole session, before or after the
  // write, so a long API-driven chat walks the starts instead.
  const fewPersonApiTurns = sql`(
    select pg_catalog.count(*) from (
      select 1 from ${schema.sessionTurns} person
      where person.workspace_id = ${workspaceId}
        and person.session_id = ${sessionId}
        and person.source in ('user', 'api')
      limit ${sql.raw(String(PERSON_API_TURN_CAP + 1))}
    ) counted
  ) <= ${sql.raw(String(PERSON_API_TURN_CAP))}`;
  // After a write only person/API turns queued after it are eligible; take the
  // one whose newest start is the newest, if that start is after the write.
  // Same predicate as the walk, driven from the few person/API turns instead
  // of every start. A turn's own events are read by turn id through
  // session_events_workspace_turn_type_idx: the session is compared with IS
  // NOT DISTINCT FROM and the aggregates read `sequence + 0`, so neither a
  // (workspace, session) range nor a max/min rewrite can turn each lookup into
  // a backward walk of the whole session's events.
  const personApiTurn = sql`(
    select person.id from ${schema.sessionTurns} person
    cross join lateral (
      select
        max(own.sequence + 0) filter (where own.type = 'turn.started') as started,
        min(own.sequence + 0) filter (where own.type = 'turn.queued') as queued
      from ${schema.sessionEvents} own
      where own.workspace_id = ${workspaceId}
        and own.turn_id = person.id
        and own.type in ('turn.started', 'turn.queued')
        and own.session_id is not distinct from ${sessionId}
    ) own_events
    where person.workspace_id = ${workspaceId}
      and person.session_id = ${sessionId}
      and person.source in ('user', 'api')
      and own_events.started > ${settingsBoundary}
      and coalesce(own_events.queued, 0) > ${settingsBoundary}
    order by own_events.started desc
    limit 1
  )`;
  // One scalar subquery over the boundary row, so the turn lookup keeps a
  // primary-key bound.
  const latestStartedTurnId = sql`(
    select coalesce(${recentWalk}, case when ${settingsBoundary} >= 0 and ${olderStartsRemain}
      then case when ${fewPersonApiTurns} then ${personApiTurn} else ${fullWalk} end end)
    from (
      select coalesce(max(boundary.sequence), -1) as sequence from ${schema.sessionEvents} boundary
      where boundary.workspace_id = ${workspaceId}
        and boundary.session_id = ${sessionId}
        and boundary.type = 'session.model_settings.updated'
    ) settings_boundary
  )`;
  return db
    .select(turnPolicyColumns)
    .from(schema.sessionTurns)
    .where(turnById(workspaceId, sessionId, latestStartedTurnId))
    .limit(1);
}

/** Starts read newest-first before a fallback read; see
 * {@link startedSessionTurnQuery}. After a write, a person's newest turn is
 * usually among them unless a schedule or trigger keeps running the chat. */
const RECENT_START_PROBES = 16;

/** Most person/API turns a session may have for the person/API read; see
 * {@link startedSessionTurnQuery}. */
const PERSON_API_TURN_CAP = 200;

const turnPolicyColumns = {
  id: schema.sessionTurns.id,
  model: schema.sessionTurns.model,
  reasoningEffort: schema.sessionTurns.reasoningEffort,
  latencyMode: schema.sessionTurns.latencyMode,
};

/** The chosen turn, read by id. The id is one scalar subquery so the lookup
 * keeps a primary-key bound; the session is compared with IS NOT DISTINCT FROM
 * (see startedSessionTurnQuery). */
function turnById(workspaceId: string, sessionId: string | SQL, turnId: SQL) {
  return and(
    eq(schema.sessionTurns.workspaceId, workspaceId),
    sql`${schema.sessionTurns.id} = ${turnId}`,
    sql`${schema.sessionTurns.sessionId} is not distinct from ${sessionId}`,
  );
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
      and(eq(schema.sessions.workspaceId, workspaceId), anyOf(schema.sessions.id, [...sessionIds])),
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
        anyOf(schema.sessions.id, [...new Set(rows.map((row) => row.id))]),
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
