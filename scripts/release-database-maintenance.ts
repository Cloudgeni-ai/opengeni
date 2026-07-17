#!/usr/bin/env bun
import { createHash } from "node:crypto";
import postgres, { type Sql } from "postgres";
import {
  historyCallId,
  historyItemType,
  interruptedToolCallResult,
  TOOL_RESULT_TYPE_BY_CALL_TYPE,
} from "../packages/db/src/session-tool-call-settlement";
import {
  sanitizeEventPayload,
  sanitizeModelPayload,
} from "../packages/db/src/event-payload-sanitizer";

type Command = "drain-running-turns";

type RunningTurn = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  executionGeneration: number;
  activeAttemptId: string | null;
  lastSequence: number;
};

type PendingCall = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  callId: string;
  callType: string;
  callItem: Record<string, unknown>;
  resultItem: Record<string, unknown> | null;
  resultRecordedAt: Date | null;
  createdAt: Date;
};

export type ReleaseDrainReceipt = {
  schemaVersion: 1;
  command: Command;
  runId: string;
  sourceRevision: string;
  completedAt: string;
  recoveredTurnCount: number;
  recoveredTurnIdentitySha256: string;
  closedToolCallCount: number;
  remainingRunningTurnCount: number;
};

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command !== "drain-running-turns") {
    throw new Error("command must be drain-running-turns");
  }
  const runId = argument("--run-id");
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(runId)) {
    throw new Error("--run-id must be a lowercase DNS label of at most 40 characters");
  }
  const sourceRevision = process.env.OPENGENI_SOURCE_REVISION;
  if (!sourceRevision || !/^[0-9a-f]{40}$/u.test(sourceRevision)) {
    throw new Error("OPENGENI_SOURCE_REVISION must be the exact 40-character source SHA");
  }
  const databaseUrl = process.env.OPENGENI_MIGRATIONS_DATABASE_URL;
  if (!databaseUrl) throw new Error("OPENGENI_MIGRATIONS_DATABASE_URL is required");

  const database = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    const receipt = await drainLegacyRunningTurns(database, runId, sourceRevision);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await database.end().catch(() => undefined);
  }
}

/**
 * Convert every exact legacy turn owner left after Temporal termination into
 * ownerless recovery work. This is a one-way cutover operator, not a runtime
 * fallback: it refuses the canonical schema and preserves the same logical turn
 * outside the human prompt queue.
 */
export async function drainLegacyRunningTurns(
  database: Sql,
  runId: string,
  sourceRevision: string,
): Promise<ReleaseDrainReceipt> {
  return await database.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    await sql.unsafe("set local lock_timeout = '5s'");
    await sql.unsafe("set local statement_timeout = '5min'");
    await sql`select pg_advisory_xact_lock(hashtextextended('opengeni:release-running-turn-drain', 0))`;

    const [{ legacy, canonical } = { legacy: false, canonical: false }] = await sql<
      Array<{ legacy: boolean; canonical: boolean }>
    >`
      select
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'sessions' and column_name = 'control_state'
        ) as legacy,
        to_regclass(current_schema() || '.workspace_inference_controls') is not null as canonical
    `;
    if (!legacy || canonical) {
      throw new Error("running-turn drain requires the exact legacy session-control schema");
    }

    const running = await sql<RunningTurn[]>`
      select
        turn.account_id::text as "accountId",
        turn.workspace_id::text as "workspaceId",
        turn.session_id::text as "sessionId",
        turn.id::text as "turnId",
        turn.trigger_event_id::text as "triggerEventId",
        turn.temporal_workflow_id as "temporalWorkflowId",
        turn.execution_generation as "executionGeneration",
        turn.active_attempt_id::text as "activeAttemptId",
        session.last_sequence as "lastSequence"
      from session_turns turn
      join sessions session
        on session.workspace_id = turn.workspace_id and session.id = turn.session_id
      where turn.status = 'running'
      order by turn.workspace_id, turn.session_id, turn.id
      for update of session, turn
    `;

    const duplicateSessions = new Set<string>();
    const observedSessions = new Set<string>();
    for (const turn of running) {
      const key = `${turn.workspaceId}:${turn.sessionId}`;
      if (observedSessions.has(key)) duplicateSessions.add(key);
      observedSessions.add(key);
    }
    if (duplicateSessions.size > 0) {
      throw new Error(`${duplicateSessions.size} sessions own multiple running turns`);
    }

    const invalidOwners = await sql<Array<{ count: number }>>`
      select count(*)::integer as count
      from session_turns turn
      join sessions session
        on session.workspace_id = turn.workspace_id and session.id = turn.session_id
      where turn.status = 'running'
        and (
          turn.active_attempt_id is null
          or turn.execution_generation < 1
          or session.active_turn_id is distinct from turn.id
          or session.status <> 'running'
          or session.temporal_workflow_id is distinct from turn.temporal_workflow_id
        )
    `;
    if (Number(invalidOwners[0]?.count ?? 0) !== 0) {
      throw new Error(`${invalidOwners[0]?.count ?? 0} running turns have invalid exact ownership`);
    }

    const identityHash = createHash("sha256");
    let closedToolCallCount = 0;
    for (const turn of running) {
      if (!turn.activeAttemptId)
        throw new Error(`running turn ${turn.turnId} has no attempt owner`);
      closedToolCallCount += await closeLegacyPendingToolCalls(sql, turn, "production maintenance");

      const now = new Date();
      let sequence = Number(turn.lastSequence);
      await sql`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, turn_id,
          turn_generation, turn_attempt_id, turn_association, payload, occurred_at
        ) values
          (
            ${turn.accountId}, ${turn.workspaceId}, ${turn.sessionId}, ${++sequence},
            'turn.recovery.requested', ${turn.turnId}, ${turn.executionGeneration},
            ${turn.activeAttemptId}, 'current',
            ${sql.json(
              sanitizeEventPayload({
                triggerEventId: turn.triggerEventId,
                reason: "production_maintenance",
              }),
            )},
            ${now}
          ),
          (
            ${turn.accountId}, ${turn.workspaceId}, ${turn.sessionId}, ${++sequence},
            'session.status.changed', ${turn.turnId}, ${turn.executionGeneration},
            ${turn.activeAttemptId}, 'current',
            ${sql.json(sanitizeEventPayload({ status: "recovering" }))},
            ${now}
          )
      `;
      const updatedTurn = await sql<Array<{ id: string }>>`
        update session_turns
        set status = 'recovering', active_attempt_id = null, finished_at = null,
            cancelled_by = null, cancel_reason = null, version = version + 1,
            metadata = metadata - 'dispatchAttempt', updated_at = ${now}
        where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}
          and id = ${turn.turnId} and status = 'running'
          and active_attempt_id = ${turn.activeAttemptId}
        returning id::text as id
      `;
      if (updatedTurn.length !== 1) {
        throw new Error(`running turn ${turn.turnId} changed while maintenance held its lock`);
      }
      const updatedSession = await sql<Array<{ id: string }>>`
        update sessions
        set status = 'recovering', active_turn_id = ${turn.turnId},
            last_sequence = ${sequence}, updated_at = ${now}
        where workspace_id = ${turn.workspaceId} and id = ${turn.sessionId}
          and status = 'running' and active_turn_id = ${turn.turnId}
        returning id::text as id
      `;
      if (updatedSession.length !== 1) {
        throw new Error(`session ${turn.sessionId} changed while maintenance held its lock`);
      }
      await sql`
        insert into audit_events (
          account_id, workspace_id, subject_id, action, target_type, target_id, metadata, occurred_at
        ) values (
          ${turn.accountId}, ${turn.workspaceId}, ${`maintenance:${runId}`},
          'session.release.running_turn_recovered', 'session', ${turn.sessionId},
          ${sql.json({
            turnId: turn.turnId,
            attemptId: turn.activeAttemptId,
            executionGeneration: turn.executionGeneration,
            sourceRevision,
          })},
          ${now}
        )
      `;
      updateIdentityDigest(identityHash, turn.turnId);
    }

    const [{ count: remaining } = { count: -1 }] = await sql<Array<{ count: number }>>`
      select count(*)::integer as count from session_turns where status = 'running'
    `;
    if (Number(remaining) !== 0) {
      throw new Error(`${remaining} running turns remain after maintenance drain`);
    }
    return {
      schemaVersion: 1,
      command: "drain-running-turns",
      runId,
      sourceRevision,
      completedAt: new Date().toISOString(),
      recoveredTurnCount: running.length,
      recoveredTurnIdentitySha256: identityHash.digest("hex"),
      closedToolCallCount,
      remainingRunningTurnCount: Number(remaining),
    };
  });
}

async function closeLegacyPendingToolCalls(
  sql: Sql,
  turn: RunningTurn,
  reason: string,
): Promise<number> {
  const pending = await sql<PendingCall[]>`
    select id::text as id, account_id::text as "accountId",
           workspace_id::text as "workspaceId", session_id::text as "sessionId",
           turn_id::text as "turnId", execution_generation as "executionGeneration",
           attempt_id::text as "attemptId", call_id as "callId", call_type as "callType",
           call_item as "callItem", result_item as "resultItem",
           result_recorded_at as "resultRecordedAt", created_at as "createdAt"
    from session_pending_tool_calls
    where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}
      and turn_id = ${turn.turnId}
    order by created_at, id
    for update
  `;
  if (pending.length === 0) return 0;
  const invalidCall = pending.find(
    (call) =>
      call.attemptId !== turn.activeAttemptId ||
      call.executionGeneration !== turn.executionGeneration,
  );
  if (invalidCall) {
    throw new Error(`pending tool call ${invalidCall.id} does not belong to the exact turn owner`);
  }

  const history = await sql<Array<{ item: Record<string, unknown> }>>`
    select item from session_history_items
    where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}
      and turn_id = ${turn.turnId} and active = true
    order by position
  `;
  const [{ maxPosition } = { maxPosition: "-1" }] = await sql<Array<{ maxPosition: string }>>`
    select coalesce(max(position), -1)::text as "maxPosition"
    from session_history_items
    where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}
  `;
  let nextPosition = Math.floor(Number(maxPosition)) + 1;
  let sequence = turn.lastSequence;
  const resolutions = pending.map((call) => {
    const resultType = TOOL_RESULT_TYPE_BY_CALL_TYPE[call.callType];
    const existingCall = history.find(
      ({ item }) => historyItemType(item) === call.callType && historyCallId(item) === call.callId,
    );
    const existingResult = resultType
      ? history.find(
          ({ item }) => historyItemType(item) === resultType && historyCallId(item) === call.callId,
        )
      : undefined;
    const interrupted = interruptedToolCallResult({
      callType: call.callType,
      callId: call.callId,
      callItem: call.callItem,
      reason,
    });
    return {
      call,
      existingCall,
      existingResult,
      rawCallIsValid: historyItemType(call.callItem) === call.callType,
      result: existingResult?.item ?? call.resultItem ?? interrupted,
      interrupted: !existingResult && !call.resultItem,
    };
  });

  for (const resolution of resolutions) {
    if (
      !resolution.existingResult &&
      !resolution.existingCall &&
      resolution.result &&
      resolution.rawCallIsValid
    ) {
      await insertHistoryItem(sql, turn, nextPosition++, resolution.call.callItem);
    }
  }
  const orderedResults = [...resolutions].sort(
    (left, right) =>
      (left.call.resultRecordedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (right.call.resultRecordedAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
  );
  for (const resolution of orderedResults) {
    if (!resolution.existingResult && resolution.result && resolution.rawCallIsValid) {
      await insertHistoryItem(sql, turn, nextPosition++, resolution.result);
    }
    await sql`
      insert into session_events (
        account_id, workspace_id, session_id, sequence, type, turn_id,
        turn_generation, turn_attempt_id, turn_association, payload
      ) values (
        ${turn.accountId}, ${turn.workspaceId}, ${turn.sessionId}, ${++sequence},
        'agent.toolCall.output', ${turn.turnId}, ${resolution.call.executionGeneration},
        ${resolution.call.attemptId}, 'current',
        ${sql.json(
          sanitizeEventPayload({
            id: resolution.call.callId,
            output: resolution.interrupted
              ? {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Tool execution was interrupted by ${reason}; its side-effect outcome is unknown.`,
                    },
                  ],
                }
              : ((resolution.existingResult?.item ?? resolution.call.resultItem)?.output ??
                resolution.existingResult?.item ??
                resolution.call.resultItem),
            recovery: {
              interrupted: resolution.interrupted,
              outcome: resolution.interrupted ? "unknown" : "durable_result_found",
              reason,
              unsupportedCallShape:
                resolution.interrupted && (!resolution.result || !resolution.rawCallIsValid),
            },
          }),
        )}
      )
    `;
  }
  await sql`
    delete from session_pending_tool_calls
    where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}
      and turn_id = ${turn.turnId}
  `;
  turn.lastSequence = sequence;
  return pending.length;
}

async function insertHistoryItem(
  sql: Sql,
  turn: RunningTurn,
  position: number,
  item: Record<string, unknown>,
): Promise<void> {
  await sql`
    insert into session_history_items (
      account_id, workspace_id, session_id, turn_id, position, item, active
    ) values (
      ${turn.accountId}, ${turn.workspaceId}, ${turn.sessionId}, ${turn.turnId},
      ${position}, ${sql.json(sanitizeModelPayload(item))}, true
    )
  `;
}

function updateIdentityDigest(hash: ReturnType<typeof createHash>, identity: string): void {
  const bytes = Buffer.from(identity);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) await main();
