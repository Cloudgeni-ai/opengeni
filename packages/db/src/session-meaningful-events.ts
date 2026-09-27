import { Column, getTableName, is, sql, type SQL, type SQLWrapper } from "drizzle-orm";

function correlatedReference(reference: SQLWrapper): SQLWrapper {
  // Drizzle's single-table SELECT projection removes Column table qualifiers,
  // including inside nested SQL. Here that would bind workspace_id/session_id
  // to the inner event row and turn correlation into a tautology. Identifiers
  // retain the exact outer table (or alias) through that projection rewrite.
  return is(reference, Column)
    ? sql`${sql.identifier(getTableName(reference.table))}.${sql.identifier(reference.name)}`
    : reference;
}

/** Attention is conversational output or an actionable boundary, not activity.
 * Keep this allow-list shared by rail, tree and consumption queries. */
export const MEANINGFUL_SESSION_EVENT_TYPES = [
  "agent.message.completed",
  "turn.completed",
  "turn.failed",
  "session.requiresAction",
  "session.humanInput.requested",
  "tool.auth_needed",
  "credential.auth_needed",
  "goal.completed",
  "goal.paused",
  "goal.progress",
  "goal.rewrite.proposed",
  "rig.setup.failed",
  "sandbox.operation.failed",
  "sandbox.box.lost",
  "workspace.revision.degraded",
  "machine.op.failed",
  "machine.link.lost",
  "session.event.envelope_omitted",
] as const;

export function meaningfulSessionEventSql(alias: string): SQL {
  const e = sql.identifier(alias);
  // These are code-owned literals, not request values. Literal predicates let
  // PostgreSQL use the matching partial index even with a generic cached plan.
  return sql`${e}.type in (${sql.join(
    MEANINGFUL_SESSION_EVENT_TYPES.map((type) => sql.raw(`'${type}'`)),
    sql`, `,
  )})
    and ${e}.duplicate_of_event_id is null
    and (${e}.turn_association is null or ${e}.turn_association = 'current')
    and (${e}.type <> 'agent.message.completed' or coalesce(${e}.payload ->> 'text', '') <> '')
    and (${e}.type <> 'turn.completed' or (
      not (${e}.payload ?| array['maintenance', 'segmentLimit'])
      and coalesce(nullif(${e}.payload -> 'output', 'null'::jsonb), ${e}.payload -> 'result') is not null
      and coalesce(nullif(${e}.payload -> 'output', 'null'::jsonb), ${e}.payload -> 'result') not in ('null'::jsonb, '""'::jsonb)
    ))`;
}

/** A stored audit preview can still need attention, but cannot stand in for
 * consumption of the original content, even when the reader returned it whole. */
export function completeMeaningfulSessionEventSql(alias: string): SQL {
  const e = sql.identifier(alias);
  return sql`${meaningfulSessionEventSql(alias)}
    and coalesce(${e}.payload -> 'truncation' ->> 'truncated', 'false') <> 'true'
    and coalesce(${e}.payload ->> 'sourceOmitted', 'false') <> 'true'`;
}

/** One reverse partial-index probe, independent of the raw-delta tail length.
 * Derivation also repairs historical bookkeeping-only dots without changing
 * personal state or rewriting append-only events. */
export function meaningfulSessionSequenceSql(
  workspaceId: SQLWrapper,
  sessionId: SQLWrapper,
): SQL<number> {
  return sql<number>`coalesce((
      select meaningful.sequence from session_events meaningful
      where meaningful.workspace_id = ${correlatedReference(workspaceId)} and meaningful.session_id = ${correlatedReference(sessionId)}
        and ${meaningfulSessionEventSql("meaningful")}
      order by meaningful.sequence desc limit 1
    ), 0)`;
}

/** The child's newest ordinary turn outcomes, newest first. Only a
 * result-bearing `turn.completed` here is the child's current answer: an older
 * answer behind a newer failed, cancelled, superseded, or segment-limited turn
 * is never reported as the result. A segment-limit completion (`max_turns`,
 * `budget_exhausted`) is the outcome of the turn that stopped there, and its
 * empty output means "no answer". Only standalone maintenance is not an
 * outcome.
 *
 * `goalContinuationOnly` marks a turn claimed only to continue the child's
 * goal: a goal-routed turn to which no other input (a message, a Steer, a
 * child or command result) was ever delivered. Such a turn follows an answer
 * rather than producing the task's result, so the caller walks back past it.
 * Each outcome probe walks the (workspace, session, type, sequence) index
 * backwards within `limit`, and only the selected rows' payloads are read.
 * The child's delivered input is scanned once for all selected turns.
 *
 * `goalActivatedAt` is the newest `goal.set` or `goal.resumed` event: goal
 * continuation turns never run across an idle boundary that reported the goal
 * inactive, so a continuation walk stops there instead of reaching output a
 * result for an earlier run already reported. */
export function childRecentTurnOutcomesSql(
  workspaceId: SQLWrapper,
  sessionId: SQLWrapper,
  limit: number,
): SQL {
  return sql`with latest as materialized (
    select outcome.sequence, outcome.turn_id from session_events outcome
    where outcome.workspace_id = ${workspaceId} and outcome.session_id = ${sessionId}
      and outcome.type in ('turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded')
      and outcome.duplicate_of_event_id is null
      and (outcome.turn_association is null or outcome.turn_association = 'current')
      and (outcome.type <> 'turn.completed' or not (outcome.payload ? 'maintenance'))
    order by outcome.sequence desc limit ${limit}
  ), goal_turns as materialized (
    select turn.id from session_turns turn
    where turn.workspace_id = ${workspaceId} and turn.session_id = ${sessionId}
      and turn.id in (select latest.turn_id from latest where latest.turn_id is not null)
      and turn.source = 'goal'
  ), goal_turns_with_input as materialized (
    select distinct input.delivered_turn_id as id from session_system_updates input
    where input.workspace_id = ${workspaceId} and input.session_id = ${sessionId}
      and input.delivered_turn_id in (select goal_turns.id from goal_turns)
      and input.kind <> 'goal_continuation'
  ), goal_activation as (
    select max(activation.sequence) as sequence from (
      (select event.sequence from session_events event
        where event.workspace_id = ${workspaceId} and event.session_id = ${sessionId}
          and event.type = 'goal.set'
        order by event.sequence desc limit 1)
      union all
      (select event.sequence from session_events event
        where event.workspace_id = ${workspaceId} and event.session_id = ${sessionId}
          and event.type = 'goal.resumed'
        order by event.sequence desc limit 1)
    ) activation
  )
  select outcome.sequence, outcome.type, outcome.payload,
    outcome.payload_codec_version as "payloadCodecVersion",
    (latest.turn_id in (select goal_turns.id from goal_turns)
      and latest.turn_id not in (select goal_turns_with_input.id from goal_turns_with_input))
      is true as "goalContinuationOnly",
    coalesce((select goal_activation.sequence from goal_activation), 0) as "goalActivatedAt"
  from latest
  join session_events outcome
    on outcome.workspace_id = ${workspaceId} and outcome.session_id = ${sessionId}
      and outcome.sequence = latest.sequence
  order by outcome.sequence desc`;
}

/** Bound indexed candidate rows BEFORE testing payload size/completeness. Without
 * this boundary, a long run of oversized answers can cause an unbounded scan. */
export function childLifecycleEvidenceCandidatesSql(
  workspaceId: SQLWrapper,
  sessionId: SQLWrapper,
): SQL {
  return sql`with candidates as materialized (
    select meaningful.* from session_events meaningful
    where meaningful.workspace_id = ${workspaceId} and meaningful.session_id = ${sessionId}
      and ${meaningfulSessionEventSql("meaningful")}
    order by meaningful.sequence desc limit 32
  )
  select candidates.sequence, candidates.type, candidates.payload,
    candidates.payload_codec_version as "payloadCodecVersion" from candidates
  where ${completeMeaningfulSessionEventSql("candidates")}
    -- Inspection cap only: the 8 KiB evidence budget applies after logical
    -- decoding in boundedChildLifecycleEvidence, not to this stored encoding.
    and octet_length(candidates.payload::text) <= 65536
  order by candidates.sequence desc`;
}
