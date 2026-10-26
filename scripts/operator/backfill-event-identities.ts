/** Explicit online maintenance; never imported by API/worker startup. */
import { open, readFile, rename } from "node:fs/promises";
import { parseArgs } from "node:util";
import postgres, { type Sql } from "postgres";

export type IdentityCheckpoint = {
  version: 1;
  database: string;
  upperId: string | null;
  afterId: string | null;
  scanned: number;
  updated: number;
  statementWalBytes: number;
  batches: number;
  startedAt: string;
  updatedAt: string;
  startWalLsn: string;
  done: boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function readCheckpoint(value: unknown): IdentityCheckpoint {
  if (!value || typeof value !== "object") throw Error("Invalid checkpoint");
  const state = value as IdentityCheckpoint;
  if (
    state.version !== 1 ||
    typeof state.database !== "string" ||
    !state.database ||
    ![state.upperId, state.afterId].every(
      (id) => id === null || (typeof id === "string" && uuid.test(id)),
    ) ||
    (state.afterId !== null && (state.upperId === null || state.afterId > state.upperId)) ||
    ![state.scanned, state.updated, state.statementWalBytes, state.batches].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    typeof state.done !== "boolean" ||
    typeof state.startWalLsn !== "string" ||
    !/^[0-9A-F]+\/[0-9A-F]+$/.test(state.startWalLsn) ||
    ![state.startedAt, state.updatedAt].every(
      (t) => typeof t === "string" && Number.isFinite(Date.parse(t)),
    )
  ) {
    throw Error("Invalid checkpoint");
  }
  return state;
}

export async function inspectIdentityBackfill(sql: Sql) {
  // FORCE RLS applies to ordinary owners. Never silently certify a zero-row run
  // through a tenant-scoped connection, or relax live table policies to proceed.
  const [role] = await sql`select current_database() as database, rolsuper, rolbypassrls
    from pg_roles where rolname=current_user`;
  if (!role || !(role.rolsuper || role.rolbypassrls))
    throw Error("Maintenance requires an existing superuser or BYPASSRLS operator connection");
  const [state] =
    await sql`select (select id from session_events order by id desc limit 1) as upper_id,
    pg_current_wal_insert_lsn()::text as wal_lsn`;
  return {
    database: String(role.database),
    upperId: state!.upper_id as string | null,
    walLsn: String(state!.wal_lsn),
  };
}

export type IdentityBatchOptions = {
  batchSize: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  expectedBackendPid?: number;
};
export function validateBatchOptions(options: IdentityBatchOptions) {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw Error(`${name} must be a positive integer`);
  }
}

export async function backfillIdentityBatch(
  sql: Sql,
  state: IdentityCheckpoint,
  options: IdentityBatchOptions,
) {
  readCheckpoint(state);
  validateBatchOptions(options);
  if (state.done || state.upperId === null) return { ...state, done: true };
  const result = await sql.begin(async (tx) => {
    if (options.expectedBackendPid !== undefined) {
      const [connection] = await tx`select pg_backend_pid() as pid`;
      if (connection!.pid !== options.expectedBackendPid)
        throw Error("Maintenance connection changed; resume from the last checkpoint");
    }
    await tx`select set_config('lock_timeout',${`${options.lockTimeoutMs}ms`},true),
      set_config('statement_timeout',${`${options.statementTimeoutMs}ms`},true)`;
    // Walk the primary key, including rows with no identity. A NULL result is
    // not a completion marker; checkpoint the scanned frontier, not only updates.
    // No SKIP LOCKED: a failed/blocked batch must never advance past missed rows.
    // Keep the UUID output type: `id::text` would make ORDER BY id resolve to
    // the cast output alias and sort the entire range instead of walking its index.
    const ids = await tx`select id from session_events
      where id<=${state.upperId}::uuid ${state.afterId ? tx`and id>${state.afterId}::uuid` : tx``}
      order by id limit ${options.batchSize}`;
    if (ids.length === 0)
      return { scanned: 0, updated: 0, walBytes: 0, afterId: state.upperId, done: true };
    // EXPLAIN executes the UPDATE and supplies this statement's WAL (not the
    // whole server's concurrent WAL). RETURNING makes the changed-row count
    // observable in the root plan without returning event content to the client.
    const planRows = await tx`explain(analyze,buffers,wal,format json)
      update session_events e set
        tool_name=case when e.type='agent.toolCall.created' then coalesce(e.tool_name,e.payload->>'name') else e.tool_name end,
        tool_call_id=coalesce(e.tool_call_id,e.payload->>'callId',e.payload->>'call_id',e.payload->>'id')
      where e.id=any(${ids.map((row) => row.id)}::uuid[])
        and e.type in ('agent.toolCall.created','agent.toolCall.output')
        and ((e.type='agent.toolCall.created' and e.tool_name is null and e.payload->>'name' is not null)
          or (e.tool_call_id is null and coalesce(e.payload->>'callId',e.payload->>'call_id',e.payload->>'id') is not null))
      returning e.id`;
    const report = planRows[0]!["QUERY PLAN"][0];
    const plan = report.Plan;
    return {
      scanned: ids.length,
      updated: Number(plan["Actual Rows"]),
      walBytes: Number(plan["WAL Bytes"] ?? 0),
      afterId: String(ids.at(-1)!.id),
      done: ids.length < options.batchSize || ids.at(-1)!.id === state.upperId,
      sqlMs: Number(report["Execution Time"]),
      sharedHitBlocks: Number(plan["Shared Hit Blocks"]),
      sharedDirtiedBlocks: Number(plan["Shared Dirtied Blocks"]),
    };
  });
  return {
    ...state,
    afterId: result.afterId,
    scanned: state.scanned + result.scanned,
    updated: state.updated + result.updated,
    statementWalBytes: state.statementWalBytes + result.walBytes,
    batches: state.batches + 1,
    done: result.done,
    updatedAt: new Date().toISOString(),
  };
}

export async function saveIdentityCheckpoint(path: string, state: IdentityCheckpoint) {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  // Only after commit. Losing this rename can repeat an idempotent batch, never
  // skip it. The checkpoint's directory must already exist on durable storage.
  await rename(temporary, path);
}

export async function runIdentityBackfill(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      apply: { type: "boolean", default: false },
      checkpoint: { type: "string" },
      "batch-size": { type: "string", default: "500" },
      "pause-ms": { type: "string", default: "100" },
      "lock-timeout-ms": { type: "string", default: "1000" },
      "statement-timeout-ms": { type: "string", default: "10000" },
      "max-batches": { type: "string" },
    },
    strict: true,
  });
  if (!values.checkpoint) throw Error("Pass --checkpoint with a durable local file path");
  if (!env.OPENGENI_MAINTENANCE_DATABASE_URL)
    throw Error("Set OPENGENI_MAINTENANCE_DATABASE_URL to the operator database connection");
  const options = {
    batchSize: Number(values["batch-size"]),
    lockTimeoutMs: Number(values["lock-timeout-ms"]),
    statementTimeoutMs: Number(values["statement-timeout-ms"]),
  };
  validateBatchOptions(options);
  const pauseMs = Number(values["pause-ms"]),
    maxBatches = values["max-batches"] === undefined ? Infinity : Number(values["max-batches"]);
  if (
    !Number.isSafeInteger(pauseMs) ||
    pauseMs < 0 ||
    (maxBatches !== Infinity && (!Number.isSafeInteger(maxBatches) || maxBatches < 1))
  )
    throw Error("Invalid pacing or max-batches option");
  const sql = postgres(env.OPENGENI_MAINTENANCE_DATABASE_URL, {
    max: 1,
    prepare: false,
    // This connection owns a session advisory lock for the entire run. Do not
    // rotate it on the driver's default lifetime or during a pacing interval.
    max_lifetime: 0,
    idle_timeout: 0,
    connection: {
      application_name: "opengeni-event-identity-backfill",
      row_security: "off",
      statement_timeout: options.statementTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
    },
  });
  let stop = false;
  const stopAfterBatch = () => {
    stop = true;
  };
  process.on("SIGTERM", stopAfterBatch);
  process.on("SIGINT", stopAfterBatch);
  try {
    const observed = await inspectIdentityBackfill(sql);
    let expectedBackendPid: number | undefined;
    if (values.apply) {
      // Lock before loading the checkpoint. Pin subsequent batches to this
      // backend identity so an idle reconnect cannot lose single-run ownership.
      const [lock] = await sql`select pg_backend_pid() as pid,
        pg_try_advisory_lock(hashtextextended('opengeni-event-identity-backfill',0)) as acquired`;
      if (!lock?.acquired)
        throw Error("Another event identity backfill is running in this database");
      expectedBackendPid = Number(lock.pid);
    }
    let state: IdentityCheckpoint;
    try {
      state = readCheckpoint(JSON.parse(await readFile(values.checkpoint, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const at = new Date().toISOString();
      state = {
        version: 1,
        database: observed.database,
        upperId: observed.upperId,
        afterId: null,
        scanned: 0,
        updated: 0,
        statementWalBytes: 0,
        batches: 0,
        startedAt: at,
        updatedAt: at,
        startWalLsn: observed.walLsn,
        done: observed.upperId === null,
      };
    }
    if (state.database !== observed.database)
      throw Error("Checkpoint database name does not match connection");
    console.log(JSON.stringify({ event: "start", apply: values.apply, state, options, pauseMs }));
    if (!values.apply) return; // Inspection is bounded; no full-table preview scan.
    await saveIdentityCheckpoint(values.checkpoint, state);
    let completed = 0;
    while (!state.done && completed < maxBatches) {
      if (stop) break;
      const started = performance.now();
      const previous = state;
      state = await backfillIdentityBatch(sql, state, {
        ...options,
        expectedBackendPid: expectedBackendPid!,
      });
      await saveIdentityCheckpoint(values.checkpoint, state);
      console.log(
        JSON.stringify({
          event: "batch",
          elapsedMs: performance.now() - started,
          scanned: state.scanned - previous.scanned,
          updated: state.updated - previous.updated,
          statementWalBytes: state.statementWalBytes - previous.statementWalBytes,
          state,
        }),
      );
      completed++;
      if (!state.done && !stop && completed < maxBatches)
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    const [wal] = await sql`select pg_current_wal_insert_lsn()::text as end_lsn,
      pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${state.startWalLsn}::pg_lsn)::text as server_wal_bytes`;
    console.log(
      JSON.stringify({
        event: state.done ? "complete" : "paused",
        state,
        wal,
        walNote:
          "statementWalBytes excludes commits; server_wal_bytes includes all concurrent database traffic",
      }),
    );
  } finally {
    process.off("SIGTERM", stopAfterBatch);
    process.off("SIGINT", stopAfterBatch);
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) await runIdentityBackfill(process.argv.slice(2));
