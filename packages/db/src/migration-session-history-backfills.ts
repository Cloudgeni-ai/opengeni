import { createHash } from "node:crypto";
import type postgres from "postgres";

export const SESSION_HISTORY_REPAIR = "0821_session_history_owner_backfill_repair.sql";
export const SESSION_HISTORY_REPAIR_SOURCE = `-- deployment-mode: rolling
-- opengeni:session-history-owner-backfill-v1
-- Repair already-ledgered 0809/0811 no-ops using owner-only policies and
-- independently committed, workspace-fenced batches. Never relax FORCE RLS.
-- The codec-aware migration runner executes this exact stage and removes its
-- temporary owner policies on success or failure. Old runners fail closed.
DO $$ BEGIN
  RAISE EXCEPTION 'session history backfill requires the current migration runner';
END $$;
`;

const hintFile = "0809_session_open_settlement_index.sql";
const usageFile = "0811_session_events_usage_source_key_backfill.sql";
const historicalHashes: Record<string, string> = {
  [hintFile]: "2c6889be458d3468e4e1bbe84ba2c8e7f9b1f7ff5e583069944906d85d03a1a7",
  [usageFile]: "ec0f4262af88dec2d3878a6f7a171d2390a5bb08c8bafcdec1e5c0bd98fb4642",
};

function assertHistoricalSource(file: string, source: string): void {
  if (createHash("sha256").update(source).digest("hex") !== historicalHashes[file]) {
    throw new Error(
      `${file}: session backfill compatibility requires the immutable deployed source`,
    );
  }
}

const hintUpdate = `UPDATE session_attempt_interruptions interruption
SET attempt_quiesced = true
FROM session_turn_attempts attempt
WHERE attempt.workspace_id = interruption.workspace_id
  AND attempt.id = interruption.attempt_id
  AND attempt.quiesced_at IS NOT NULL
  AND NOT interruption.attempt_quiesced;`;

/** 0809 already holds DDL locks on both tables. Never wait for a workspace
 * fence behind those locks: suppress only its fence trigger while the locks
 * exclude concurrent writers, then restore it and FORCE in the same transaction. */
export function sessionHistoryCompatibilitySql(file: string, source: string): string {
  if (file !== hintFile) return source;
  assertHistoricalSource(file, source);
  if (source.split(hintUpdate).length !== 2) throw new Error(`${file}: backfill anchor drift`);
  return source.replace(
    hintUpdate,
    `ALTER TABLE session_attempt_interruptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_attempt_interruptions DISABLE TRIGGER session_tenancy_workspace_fence;
${hintUpdate}
ALTER TABLE session_attempt_interruptions ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE session_turn_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_attempt_interruptions FORCE ROW LEVEL SECURITY;`,
  );
}

export const SESSION_HISTORY_CAPABILITY = "opengeni.session_history_owner_backfill_v1";
const tables = [
  "session_attempt_interruptions",
  "session_turn_attempts",
  "session_events",
  "session_turns",
  "sessions",
] as const;

export function sessionHistoryPolicySql(
  action: "install" | "remove",
  selected: readonly string[],
): string {
  return selected
    .map((table) => {
      if (!tables.includes(table as (typeof tables)[number]))
        throw new Error("Unknown session backfill table");
      const name = `${table}_history_owner_backfill`;
      const drop = `DROP POLICY IF EXISTS ${name} ON ${table};`;
      if (action === "remove") return drop;
      const predicate = `(current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner)
      FROM pg_catalog.pg_class c WHERE c.oid = '${table}'::regclass)
      AND pg_catalog.current_setting('${SESSION_HISTORY_CAPABILITY}', true) = '1')`;
      if (table === "sessions" || table === "session_turns" || table === "session_turn_attempts")
        return `${drop}
CREATE POLICY ${name} ON ${table} FOR SELECT USING (${predicate});`;
      return `${drop}
CREATE POLICY ${name} ON ${table} FOR ALL USING (${predicate}) WITH CHECK (${predicate});`;
    })
    .join("\n");
}

type Backfill = { tables: readonly string[]; candidates: string; update: string };
const hint: Backfill = {
  tables: ["session_attempt_interruptions", "session_turn_attempts", "sessions"],
  candidates: `SELECT interruption.id, interruption.workspace_id
FROM session_attempt_interruptions interruption
JOIN session_turn_attempts attempt ON attempt.workspace_id = interruption.workspace_id
  AND attempt.id = interruption.attempt_id
WHERE attempt.quiesced_at IS NOT NULL AND NOT interruption.attempt_quiesced`,
  update: `UPDATE session_attempt_interruptions target SET attempt_quiesced = true
FROM candidates WHERE target.id = candidates.id RETURNING target.id`,
};
const usage: Backfill = {
  tables: ["session_events", "session_turns", "sessions"],
  candidates: `SELECT usage_event.id, usage_event.workspace_id
FROM session_turns open_turn JOIN session_events usage_event
  ON usage_event.workspace_id = open_turn.workspace_id AND usage_event.turn_id = open_turn.id
  AND usage_event.type = 'agent.model.usage'
WHERE open_turn.finished_at IS NULL AND usage_event.usage_source_key IS NULL
  AND NULLIF(usage_event.payload ->> 'sourceKey', '') IS NOT NULL`,
  update: `UPDATE session_events target SET usage_source_key = NULLIF(target.payload ->> 'sourceKey', '')
FROM candidates WHERE target.id = candidates.id RETURNING target.id`,
};

export function sessionHistoryBackfillPlan(
  file: string,
  source: string,
): readonly Backfill[] | null {
  if (file === usageFile) {
    assertHistoricalSource(file, source);
    return [usage];
  }
  if (file === SESSION_HISTORY_REPAIR) {
    if (source !== SESSION_HISTORY_REPAIR_SOURCE)
      throw new Error(`${file}: session history stage source drift`);
    return [hint, usage];
  }
  return null;
}

function batchSql(backfill: Backfill): string {
  const tableAlias = backfill === hint ? "interruption" : "usage_event";
  return `WITH candidates AS MATERIALIZED (
${backfill.candidates}
  AND ${tableAlias}.workspace_id = pg_catalog.current_setting('opengeni.session_history_backfill_workspace')::uuid
ORDER BY ${tableAlias}.id LIMIT 1000 FOR UPDATE OF ${tableAlias}
), backfilled AS (${backfill.update}) SELECT id FROM backfilled;`;
}

/** The static guard checks exactly the SQL executed below, including policy
 * proofs and transaction-local activation. It does not exempt these filenames. */
export function sessionHistoryRlsExecutableSql(file: string, source: string): string {
  const compatible = sessionHistoryCompatibilitySql(file, source);
  const plan = sessionHistoryBackfillPlan(file, source);
  if (!plan) return compatible;
  return plan
    .map(
      (backfill) => `${sessionHistoryPolicySql("install", backfill.tables)}
SELECT pg_catalog.set_config('${SESSION_HISTORY_CAPABILITY}', '1', true);
${batchSql(backfill)}
${sessionHistoryPolicySql("remove", backfill.tables)}`,
    )
    .join("\n");
}

export async function executeSessionHistoryBackfills(
  sql: postgres.Sql,
  plan: readonly Backfill[],
): Promise<void> {
  for (const backfill of plan) {
    // Commit policy DDL before scanning: never retain ACCESS EXCLUSIVE table
    // locks for the backfill or wait for a workspace fence behind such a lock.
    try {
      for (const table of backfill.tables) {
        await sql.begin(async (tx) => {
          await tx`select set_config('lock_timeout', '1s', true)`;
          await tx.unsafe(sessionHistoryPolicySql("install", [table]));
        });
      }
      for (;;) {
        const exhausted = await sql.begin(async (tx) => {
          await tx`select set_config('lock_timeout','1s',true), set_config('statement_timeout','30s',true),
            set_config(${SESSION_HISTORY_CAPABILITY},'1',true),
            set_config('opengeni.subject_id','',true),
            set_config('opengeni.sandbox_recovery_protocol_v2','1',true),
            set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
          // No row or DDL lock precedes this fence. Candidate discovery can race
          // a delete or turn finish; an empty update is not global exhaustion.
          const [candidate] = await tx.unsafe<{ workspace_id: string }[]>(
            `${backfill.candidates} LIMIT 1`,
          );
          if (!candidate) return true;
          await tx`select acquire_session_tenancy_fence(${candidate.workspace_id}::uuid)`;
          await tx`select set_config('opengeni.session_history_backfill_workspace',${candidate.workspace_id},true)`;
          await tx.unsafe(batchSql(backfill));
          return false;
        });
        if (exhausted) break;
      }
    } finally {
      for (const table of backfill.tables) {
        await sql.begin(async (tx) => {
          await tx`select set_config('lock_timeout','1s',true)`;
          await tx.unsafe(sessionHistoryPolicySql("remove", [table]));
        });
      }
    }
  }
}
