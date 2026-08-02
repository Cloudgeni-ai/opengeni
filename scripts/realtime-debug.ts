import postgres from "postgres";

const sessionId = process.argv[2];
if (
  !sessionId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
) {
  console.error("usage: bun run debug:realtime <session-id>");
  process.exit(1);
}

const databaseUrl =
  process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_URL;
if (!databaseUrl) {
  console.error("OPENGENI_MIGRATIONS_DATABASE_URL or OPENGENI_DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  const [session, wake, modes, connections, ledger, delegations, history, turns, failures] =
    await Promise.all([
      sql`
      select id, status, active_turn_id, temporal_workflow_id, queue_head_position,
             queue_tail_position, updated_at
      from sessions
      where id = ${sessionId}
      limit 1
    `,
      sql`
      select wake_revision, delivered_revision, attempts, last_error, next_attempt_at
      from session_workflow_wake_outbox
      where session_id = ${sessionId}
      limit 1
    `,
      sql`
      select id, state, version, connection_epoch, end_reason, started_at, ended_at
      from session_realtime_modes
      where session_id = ${sessionId}
      order by started_at desc
      limit 10
    `,
      sql`
      select realtime_id, connection_epoch, promotion_mode, state,
             startup_acknowledged_at is not null as provider_started,
             failure_code, negotiated_at, closed_at
      from session_realtime_connections
      where session_id = ${sessionId}
      order by created_at desc
      limit 20
    `,
      sql`
      select realtime_id, direction, kind, count(*)::int as count,
             coalesce(sum(octet_length(coalesce(text, ''))), 0)::int as text_bytes,
             count(delegation_item_id)::int as delegation_items,
             count(turn_id)::int as linked_turns
      from session_realtime_entries
      where session_id = ${sessionId}
      group by realtime_id, direction, kind
      order by realtime_id desc, direction, kind
    `,
      sql`
      select calls.realtime_id, calls.connection_epoch, calls.sequence,
             turns.id as turn_id, turns.status as turn_status,
             progress.entry_count as progress_entries,
             progress.text_bytes as progress_text_bytes,
             progress.last_created_at as last_progress_at,
             progress.all_client_acked as progress_delivered_to_browser,
             terminals.kind as terminal_kind,
             terminals.client_acked_at is not null as delivered_to_browser
      from session_realtime_entries calls
      join session_turns turns on turns.id = calls.turn_id
      left join lateral (
        select count(*)::int as entry_count,
               coalesce(sum(octet_length(coalesce(entries.text, ''))), 0)::int as text_bytes,
               max(entries.created_at) as last_created_at,
               coalesce(bool_and(entries.client_acked_at is not null), false) as all_client_acked
        from session_realtime_entries entries
        where entries.turn_id = calls.turn_id
          and entries.direction = 'provider_out'
          and entries.kind = 'delegation_progress'
      ) progress on true
      left join session_realtime_entries terminals
        on terminals.turn_id = calls.turn_id
       and terminals.direction = 'provider_out'
       and terminals.kind in ('delegation_result', 'error')
      where calls.session_id = ${sessionId}
        and calls.kind = 'delegation_call'
      order by calls.created_at desc
      limit 20
    `,
      sql`
      select count(*)::int as active_items,
             coalesce(sum(octet_length(item::text)), 0)::int as serialized_bytes
      from session_history_items
      where session_id = ${sessionId} and active = true
    `,
      sql`
      select id, status, source, model, active_attempt_id, cancel_reason,
             started_at, finished_at, created_at,
             metadata -> 'realtimeDelegation' as realtime_delegation,
             metadata -> 'realtimeTailFlush' as realtime_tail_flush
      from session_turns
      where session_id = ${sessionId}
      order by created_at desc
      limit 10
    `,
      sql`
      select events.occurred_at, events.turn_id, turns.source, turns.model, events.payload
      from session_events events
      left join session_turns turns on turns.id = events.turn_id
      where events.session_id = ${sessionId} and events.type = 'turn.failed'
      order by events.sequence desc
      limit 10
    `,
    ]);

  console.log(
    JSON.stringify(
      {
        sessionId,
        session: session[0] ?? null,
        wake: wake[0] ?? null,
        history: history[0],
        turns,
        failures,
        modes,
        connections,
        ledger,
        delegations,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end();
}
