import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

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
      where meaningful.workspace_id = ${workspaceId} and meaningful.session_id = ${sessionId}
        and ${meaningfulSessionEventSql("meaningful")}
      order by meaningful.sequence desc limit 1
    ), 0)`;
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
