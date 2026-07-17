#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import postgres, { type Sql } from "postgres";

type Phase = "legacy" | "canonical";
type Digest = { rows: number; sha256: string };
type Manifest = {
  schemaVersion: 2;
  digestAlgorithm: typeof DIGEST_ALGORITHM;
  phase: Phase;
  capturedAt: string;
  sourceRevision: string;
  databaseVersion: string;
  categories: Record<string, Digest>;
};

const DIGEST_ALGORITHM = "postgres-jsonb-row-sha256-length-framed-v1" as const;

const mode = stringArgument("--mode");
if (mode !== "capture" && mode !== "verify") {
  throw new Error("--mode must be capture or verify");
}
const manifestPath = resolve(
  stringArgument("--manifest") ??
    `${process.env.OPENGENI_EVIDENCE_DIR ?? "/tmp"}/release-continuity.json`,
);
const databaseUrl = process.env.OPENGENI_DATABASE_URL;
if (!databaseUrl) throw new Error("OPENGENI_DATABASE_URL is required");
const sourceRevision = process.env.OPENGENI_SOURCE_REVISION;
if (!sourceRevision || !/^[0-9a-f]{40}$/u.test(sourceRevision)) {
  throw new Error("OPENGENI_SOURCE_REVISION must be the exact 40-character source SHA");
}

const database = postgres(databaseUrl, { max: 2, idle_timeout: 5, connect_timeout: 10 });
try {
  if (mode === "capture") await capture(database, manifestPath);
  else await verify(database, manifestPath);
} finally {
  await database.end().catch(() => undefined);
}

async function capture(sql: Sql, path: string): Promise<void> {
  const phase = await schemaPhase(sql);
  if (phase !== "legacy" && !process.argv.includes("--allow-canonical-capture")) {
    throw new Error("Capture must run against the drained legacy schema");
  }
  const running = await scalar(
    sql,
    "select count(*)::integer as value from session_turns where status = 'running'",
  );
  if (running !== 0)
    throw new Error(`Continuity capture requires zero running turns; found ${running}`);
  const [{ capturedAt, databaseVersion }] = await sql<
    { capturedAt: Date; databaseVersion: string }[]
  >`
    select clock_timestamp() as "capturedAt", version() as "databaseVersion"
  `;
  if (!capturedAt || !databaseVersion) throw new Error("Could not bind the database boundary");
  const cutoff = capturedAt.toISOString();
  const categories = await digestCategories(sql, phase, cutoff);
  const manifest: Manifest = {
    schemaVersion: 2,
    digestAlgorithm: DIGEST_ALGORITHM,
    phase,
    capturedAt: cutoff,
    sourceRevision,
    databaseVersion,
    categories,
  };
  await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ mode: "capture", manifestPath: path, phase, categories, manifest })}\n`,
  );
}

async function verify(sql: Sql, path: string): Promise<void> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
  if (manifest.schemaVersion !== 2 || manifest.digestAlgorithm !== DIGEST_ALGORITHM) {
    throw new Error("Unsupported continuity manifest");
  }
  const phase = await schemaPhase(sql);
  if (manifest.phase === "legacy" && phase !== "canonical") {
    throw new Error(`Expected canonical schema after cutover; found ${phase}`);
  }
  const categories = await digestCategories(sql, phase, manifest.capturedAt);
  const failures: string[] = [];
  if (manifest.sourceRevision !== sourceRevision) {
    failures.push(
      `source revision changed from ${manifest.sourceRevision} to ${sourceRevision} during cutover`,
    );
  }
  for (const [name, expected] of Object.entries(manifest.categories)) {
    const actual = categories[name];
    if (!actual) failures.push(`${name}: category missing after cutover`);
    else if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256) {
      failures.push(
        `${name}: expected ${expected.rows}/${expected.sha256}, got ${actual.rows}/${actual.sha256}`,
      );
    }
  }
  if (phase === "canonical") {
    const overrides = await scalar(
      sql,
      "select count(*)::integer as value from sessions where subtree_run_override_revision is not null",
    );
    if (overrides !== 0) failures.push(`migration created ${overrides} run overrides`);
    const activeAttempts = await scalar(
      sql,
      "select count(*)::integer as value from session_turn_attempts where state in ('claimed','running')",
    );
    if (activeAttempts !== 0) failures.push(`migration left ${activeAttempts} live attempt owners`);
    const missingWakes = await scalar(
      sql,
      `select count(*)::integer as value
       from opengeni_private.list_continuable_sessions(null, null) continuable
       left join session_workflow_wake_outbox wake on wake.session_id = continuable.session_id
       where wake.session_id is null or wake.wake_revision <= wake.delivered_revision`,
    );
    if (missingWakes !== 0)
      failures.push(`${missingWakes} continuable sessions have no pending wake`);
  }
  const receipt = {
    schemaVersion: 1,
    mode: "verify",
    verifiedAt: new Date().toISOString(),
    manifestPath: path,
    baselinePhase: manifest.phase,
    currentPhase: phase,
    sourceRevision,
    categories,
    failures,
  };
  const receiptPath = resolve(
    stringArgument("--receipt") ?? path.replace(/\.json$/u, ".verified.json"),
  );
  await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...receipt, receiptPath })}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

async function digestCategories(
  sql: Sql,
  phase: Phase,
  cutoff: string,
): Promise<Record<string, Digest>> {
  const common: Record<string, Query> = {
    sessions_immutable: {
      text: `select id::text, account_id::text, workspace_id::text,
                    parent_session_id::text, initial_message, title, title_source, instructions,
                    resources, tools, metadata - 'childNotificationsMode' as metadata,
                    model, sandbox_backend, sandbox_os,
                    sandbox_group_id::text, active_sandbox_id::text, active_epoch, working_dir,
                    variable_set_id::text, rig_id::text, rig_version_id::text,
                    first_party_mcp_permissions, create_idempotency_key,
                    temporal_workflow_id, active_turn_id::text, last_input_tokens,
                    compact_requested, last_sequence, codex_pinned_credential_id::text,
                    codex_last_credential_id::text, codex_pin_source, created_at
             from sessions`,
    },
    turns_immutable: {
      text: `select id::text, account_id::text, workspace_id::text, session_id::text,
                    trigger_event_id::text, temporal_workflow_id, status, source, position::text,
                    prompt, resources, tools, model, reasoning_effort, sandbox_backend,
                    sandbox_os, metadata, version, execution_generation, lineage,
                    cancelled_by, cancel_reason, toolspace_call_count, started_at, finished_at,
                    created_at, updated_at
             from session_turns`,
    },
    conversation_history: {
      text: `select id::text, account_id::text, workspace_id::text, session_id::text,
                    turn_id::text, position::text, item, active,
                    producer_codex_credential_id::text, created_at
             from session_history_items`,
    },
    approval_run_states: {
      text: `select id::text, account_id::text, workspace_id::text, session_id::text,
                    turn_id::text, state_version, serialized_run_state, pending_approvals,
                    frozen_codex_credential_id::text, created_at
             from agent_run_states`,
    },
    capacity_waiters: {
      text: `select id::text, account_id::text, workspace_id::text, session_id::text,
                    goal_id::text, blocked_turn_id::text, workflow_id, generation, status,
                    goal_version, policy_hash, earliest_reset_at, next_check_at, reset_kind,
                    refresh_attempt, wake_revision, observed_wake_revision, last_wake_reason,
                    resumed_update_id::text, created_at
             from codex_capacity_waiters`,
    },
    internal_update_identities: {
      text: `select id::text, account_id::text, workspace_id::text, session_id::text,
                    classification, summary, state, delivered_turn_id::text,
                    delivered_at, created_at
             from session_system_updates`,
    },
    internal_update_outbox_identities: {
      text: `select id::text, account_id::text, workspace_id::text,
                    source_session_id::text, target_session_id::text,
                    classification, summary, status, attempts, update_id::text,
                    last_error, delivered_at, created_at
             from session_system_update_outbox`,
    },
    pre_cutover_events: {
      text: `select id::text, account_id::text, workspace_id::text, session_id::text,
                    turn_id::text, sequence, type, client_event_id, payload, occurred_at, created_at
             from session_events where created_at <= $1::timestamptz`,
      parameters: [cutoff],
    },
    pre_cutover_audit: {
      text: `select id::text, account_id::text, workspace_id::text, subject_id,
                    action, target_type, target_id, metadata, occurred_at
             from audit_events where occurred_at <= $1::timestamptz`,
      parameters: [cutoff],
    },
  };
  const projected = phase === "legacy" ? legacyProjectionQueries() : canonicalProjectionQueries();
  const result: Record<string, Digest> = {};
  for (const [name, query] of Object.entries({ ...common, ...projected })) {
    try {
      result[name] = await streamDigest(sql, query);
    } catch (error) {
      throw new Error(`Continuity category ${name} failed`, { cause: error });
    }
  }
  return result;
}

function legacyProjectionQueries(): Record<string, Query> {
  return {
    lifecycle_fates: {
      text: `select session.id::text,
                    case
                      when session.status <> 'paused' then session.status
                      when active_turn.status is not null then active_turn.status
                      when exists (
                        select 1 from session_turns queued
                        where queued.workspace_id = session.workspace_id
                          and queued.session_id = session.id and queued.status = 'queued'
                      ) then 'queued'
                      else coalesce((
                        select event.payload ->> 'status'
                        from session_events event
                        where event.workspace_id = session.workspace_id
                          and event.session_id = session.id
                          and event.type = 'session.status.changed'
                          and event.payload ->> 'status' in (
                            'queued','running','idle','requires_action','recovering',
                            'waiting_capacity','failed','cancelled'
                          )
                        order by event.sequence desc, event.id desc limit 1
                      ), 'idle')
                    end as status
             from sessions session
             left join session_turns active_turn
               on active_turn.workspace_id = session.workspace_id
              and active_turn.id = session.active_turn_id`,
    },
    legacy_blocked_fates: {
      text: `select session.id::text
             from sessions session
             join workspaces workspace on workspace.id = session.workspace_id
             where session.control_state = 'paused'
                or workspace.inference_state = 'paused'`,
    },
    goal_fates: { text: projectedGoalQuery(true) },
  };
}

function canonicalProjectionQueries(): Record<string, Query> {
  return {
    lifecycle_fates: {
      text: `select id::text, status from sessions`,
    },
    legacy_blocked_fates: {
      text: `select session.id::text
             from sessions session
             join workspace_inference_controls control
               on control.workspace_id = session.workspace_id
             where session.direct_control_state = 'paused' or control.workspace_state = 'paused'`,
    },
    goal_fates: { text: projectedGoalQuery(false) },
  };
}

function projectedGoalQuery(legacy: boolean): string {
  const converted = legacy
    ? "goal.status = 'paused' and goal.paused_reason = 'user_pause' and session.control_state = 'paused'"
    : "false";
  return `select goal.id::text, goal.session_id::text, goal.text, goal.success_criteria,
                 goal.evidence,
                 case when ${converted} then 'active' else goal.status end as status,
                 case when ${converted} then null else goal.rationale end as rationale,
                 case when ${converted} then null else goal.paused_reason end as paused_reason,
                 case when ${converted} then 0 else goal.auto_continuations end as auto_continuations,
                 case when ${converted} then 0 else goal.no_progress_streak end as no_progress_streak,
                 case when ${converted} then null else goal.last_continuation_turn_id::text end
                   as last_continuation_turn_id,
                 case when ${converted} then null else goal.version_at_last_continuation end
                   as version_at_last_continuation,
                 case when ${converted} then goal.version + 1 else goal.version end as version,
                 goal.max_auto_continuations, goal.created_by, goal.metadata, goal.created_at
          from session_goals goal
          join sessions session
            on session.workspace_id = goal.workspace_id and session.id = goal.session_id`;
}

type Query = {
  text: string;
  parameters?: Array<string | number | boolean | Date | null>;
};

async function streamDigest(sql: Sql, query: Query): Promise<Digest> {
  const hash = createHash("sha256");
  let rows = 0;
  const source = inlineQueryParameters(query);
  // Hash each serialized row in PostgreSQL and stream only its fixed-size
  // digest plus original byte length. Large history/event payloads therefore
  // never enter the operator process, while the outer digest remains ordered
  // and length-framed. Every category projects its globally unique `id`, so
  // the outermost ORDER BY is both deterministic and migration-stable.
  const hashedQuery = `
    select octet_length(encoded.payload)::bigint as row_bytes,
           encode(sha256(encoded.payload), 'hex') as row_sha256
    from (${source}) source
    cross join lateral (
      select convert_to(to_jsonb(source)::text, 'UTF8') as payload
    ) encoded
    order by source.id
  `;
  await sql
    .unsafe<{ row_bytes: number | string; row_sha256: string }[]>(hashedQuery)
    .cursor(10_000, (batch) => {
      for (const row of batch) {
        const byteLength = Number(row.row_bytes);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
          throw new Error(`Invalid continuity row byte length: ${row.row_bytes}`);
        }
        if (!/^[0-9a-f]{64}$/u.test(row.row_sha256)) {
          throw new Error("Invalid continuity row digest returned by PostgreSQL");
        }
        const length = Buffer.allocUnsafe(8);
        length.writeBigUInt64BE(BigInt(byteLength));
        hash.update(length);
        hash.update(Buffer.from(row.row_sha256, "hex"));
        rows += 1;
      }
    });
  return { rows, sha256: hash.digest("hex") };
}

function inlineQueryParameters(query: Query): string {
  let text = query.text;
  const parameters = query.parameters ?? [];
  for (let index = parameters.length; index >= 1; index -= 1) {
    text = text.replaceAll(`$${index}`, sqlLiteral(parameters[index - 1]));
  }
  if (/\$\d+/u.test(text)) {
    throw new Error("Continuity query contains an unbound parameter");
  }
  return text;
}

function sqlLiteral(value: string | number | boolean | Date | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Continuity query parameter must be finite");
    return String(value);
  }
  const text = value instanceof Date ? value.toISOString() : value;
  return `'${text.replaceAll("'", "''")}'`;
}

async function schemaPhase(sql: Sql): Promise<Phase> {
  const [row] = await sql<{ legacy: boolean; canonical: boolean }[]>`
    select
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'sessions'
          and column_name = 'control_state'
      ) as legacy,
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'sessions'
          and column_name = 'direct_control_state'
      ) as canonical
  `;
  if (row?.legacy === row?.canonical) {
    throw new Error("Database is neither an exact legacy nor canonical control schema");
  }
  return row.legacy ? "legacy" : "canonical";
}

async function scalar(sql: Sql, query: string): Promise<number> {
  const rows = await sql.unsafe(query);
  const value = Number(rows[0]?.value);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid count from: ${query}`);
  return value;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
