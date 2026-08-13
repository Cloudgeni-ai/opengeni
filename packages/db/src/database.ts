import { eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgTransactionConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  runIdempotentPersistenceTransaction,
  type IdempotentPersistenceTransactionOptions,
} from "./persistence-errors";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "./lossless-json";
import * as schema from "./schema";

// §7.7 driver widening (Step I). `Database` is the structural, cross-driver
// query-layer port: every helper in this file accepts `db: Database` and uses
// only the methods present on drizzle's base `PgDatabase` (select/insert/update/
// delete/transaction/execute). Widening from the concrete
// `PostgresJsDatabase<typeof schema>` to `PgDatabase<any, typeof schema>` is a
// pure TYPE change — no runtime behavior changes — that lets an embedded host
// inject ANY drizzle pg driver handle (node-postgres, neon-http, etc.) bound to
// OpenGeni's schema, not just the postgres-js handle `createDb` builds. The
// `any` for the query-result HKT is deliberate: it keeps `db.execute(sql\`…\`)`
// callable across drivers whose raw-result shapes differ (postgres-js returns a
// row array; node-postgres returns `{ rows }`). The three raw `db.execute(…)`
// reads that index a row array (`getManagedUserByEmail` here is the only
// host-facing one — see `userLookup`) stay postgres-js-shaped for standalone;
// `userLookup` is the injection seam for hosts on a different driver.
// `PostgresJsDatabase<typeof schema>` is assignable to this, so standalone is
// unaffected.

export type Database = PgDatabase<any, typeof schema>;

declare const sessionActivityDatabaseBrand: unique symbol;

/**
 * A workspace-scoped transaction whose session activity commit gate is open.
 * Session-row writers accept this narrower handle so new call sites cannot
 * accidentally bypass the once-per-transaction revision finalizer.
 */
export type SessionActivityDatabase = Database & {
  readonly [sessionActivityDatabaseBrand]: true;
};

export type DbClient = {
  db: Database;
  close: () => Promise<void>;
};

export type RlsContext = {
  accountId: string;
  workspaceId?: string | null;
};

type RlsContextSettings = {
  accountId: string;
  workspaceId: string;
};

/**
 * RLS posture for the connection OpenGeni's query layer runs over (Step I, §7.7).
 *
 * - `"force"` (DEFAULT — today's standalone behavior, byte-for-byte): OpenGeni
 *   connects as a NON-OWNER role (`opengeni_app`) and every table carries
 *   `FORCE ROW LEVEL SECURITY`, so the workspace/account GUCs set by
 *   `setRlsContext` are the ONLY thing that admits rows — even the table owner
 *   is subject to RLS. This is the Fork-A isolation guarantee.
 * - `"scoped"` (embedded Fork-B opt-in): the host runs OpenGeni's queries over a
 *   role that OWNS the dedicated schema (RLS need not be forced for that role),
 *   relying on the host's own tenant boundary. OpenGeni STILL emits the
 *   `set_config('opengeni.account_id'/'workspace_id', …)` GUCs defensively on
 *   every scoped query, so the application query path is byte-identical between
 *   the two strategies and the app code is RLS-mode-agnostic. The strategy is a
 *   declared posture (consumed by `provisionRoles` and as a documented
 *   invariant), NOT a query-path branch — there is deliberately no `if
 *   (strategy === …)` anywhere in the helpers below. Picking `"scoped"` does not
 *   relax any GUC; it only changes which DB role the host provisions/connects as
 *   and asserts that the host accepts owning the isolation boundary.
 */
export type RlsStrategy = "force" | "scoped";

/**
 * Resolve a host-IdP/Better-Auth user *identifier* by email. Injected via
 * `createDb({ userLookup })` (Step I). UNSET → today's raw parameterized select
 * against Better Auth's `auth_users` table (see `getManagedUserByEmail`), which
 * relies on the postgres-js array-shaped `db.execute` result. An embedded host
 * whose identity lives elsewhere (a different IdP table, a different driver, or
 * a non-`auth_users` user store) injects this closure so OpenGeni never touches
 * `auth_users` directly. Returns the user id, or null when no such user exists.
 */
export type UserLookup = (db: Database, email: string) => Promise<string | null>;

export type CreateDbOptions = {
  /**
   * The Postgres `search_path` for this connection (Step I, §7.8 runtime half).
   * UNSET → today's behavior: NO `search_path` startup parameter is sent, so the
   * server default applies (`public` for standalone, where every table + the
   * `vector` extension + `gen_random_uuid()` live). For an embedded dedicated
   * schema, pass e.g. `"opengeni,opengeni_private,public"` — postgres-js sends
   * it as a per-session startup parameter (the supported, query-param-free way;
   * URL `?search_path=` is IGNORED by postgres-js). Keep `public` LAST so the
   * `vector` type and `gen_random_uuid()` (which live in `public` on the
   * pgvector image) still resolve — the schema-isolation contract live footgun.
   */
  searchPath?: string;
  /** RLS posture; defaults to `"force"` (today's standalone). */
  rlsStrategy?: RlsStrategy;
  /** Host-provided user-by-email resolver; unset → today's raw `auth_users` query. */
  userLookup?: UserLookup;
  /** postgres-js pool size; defaults to today's `10`. */
  max?: number;
  /**
   * Connection-local default transaction isolation sent in the postgres-js
   * startup parameters. This is intentionally not a role/database default:
   * tests and embedded callers can exercise a different ambient isolation
   * without mutating a shared PostgreSQL role or affecting other connections.
   */
  isolationLevel?: postgres.ConnectionParameters["default_transaction_isolation"];
};

/**
 * The active RLS strategy + userLookup for an injected `Database`, recorded in a
 * side WeakMap so helpers (and `getManagedUserByEmail`) can consult the host's
 * binding without changing every call signature. A handle with no recorded
 * config (e.g. one built outside `createDb`, or in a test) falls back to the
 * standalone defaults: `rlsStrategy: "force"`, raw `auth_users` lookup.
 */
type DbBinding = { rlsStrategy: RlsStrategy; userLookup?: UserLookup };

const dbBindings = new WeakMap<object, DbBinding>();

/** The strategy bound to a handle (or the `"force"` default). */
export function rlsStrategyFor(db: Database): RlsStrategy {
  return dbBindings.get(db as unknown as object)?.rlsStrategy ?? "force";
}

/**
 * Run a raw SQL query and read its rows as a typed array.
 *
 * Why this exists: the Step I driver widening (`Database = PgDatabase<any, …>`)
 * deliberately sets the query-result HKT to `any` so `db.execute(…)` is callable
 * across drivers whose raw-result shapes differ (postgres-js → row array;
 * node-postgres → `{ rows }`). A side effect is that `db.execute<T>(…)` now
 * resolves to `any`, erasing the per-row element type at the call site. OpenGeni's
 * OWN internal raw queries usually run over the postgres-js handle `createDb`
 * builds (array result), while an embedded host may inject a node-postgres style
 * driver (`{ rows }`). Normalize those two standard shapes in one place; reject
 * an unknown driver result rather than silently treating it as an empty query.
 */
export async function rawRows<T extends Record<string, unknown>>(
  executor: Pick<Database, "execute">,
  query: SQL,
): Promise<T[]> {
  const result = await executor.execute<T>(query);
  if (Array.isArray(result)) {
    return result as unknown as T[];
  }
  const rows = (result as unknown as { rows?: unknown }).rows;
  if (Array.isArray(rows)) {
    return rows as T[];
  }
  throw new Error("Unsupported database execute() result shape");
}

export type SandboxProviderReadLockIdentity = {
  workspaceId: string;
  sandboxGroupId: string;
  leaseEpoch: number;
  instanceId: string;
};

export class SandboxProviderReadLockUnavailableError extends Error {
  constructor() {
    super("Sandbox provider reads are temporarily busy. Retry the request.");
    this.name = "SandboxProviderReadLockUnavailableError";
  }
}

const SANDBOX_PROVIDER_READ_LOCK_WAIT_MS = 15_000;
const SANDBOX_PROVIDER_READ_LOCK_POLL_MAX_MS = 200;

function sandboxProviderReadLockKey(identity: SandboxProviderReadLockIdentity): string {
  return [
    "sandbox-provider-read",
    identity.workspaceId,
    identity.sandboxGroupId,
    identity.leaseEpoch,
    identity.instanceId,
  ].join(":");
}

async function waitForSandboxProviderReadLockPoll(
  delayMs: number,
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Cross-process exclusive boundary for one exact live provider instance's
 * API-direct read request. Modal accepts concurrent commands from one attached
 * handle, but independent API replicas reconstruct different handles; issuing
 * overlapping command groups through those handles can make an otherwise valid
 * read fail transiently. Keep concurrency inside one batched request while
 * serializing only separate requests that target the same lease identity.
 *
 * The callback intentionally runs while one transaction-pinned DB connection
 * holds the advisory lock. The direct lease holder separately prevents drain,
 * and the abort-aware bounded poll prevents a disconnected HTTP request from
 * occupying the connection indefinitely.
 */
export async function withSandboxProviderReadLock<T>(
  db: Database,
  identity: SandboxProviderReadLockIdentity,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const key = sandboxProviderReadLockKey(identity);
  const deadline = Date.now() + SANDBOX_PROVIDER_READ_LOCK_WAIT_MS;
  return await db.transaction(async (lockedDb) => {
    let pollMs = 20;
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      const [row] = await rawRows<{ acquired: boolean }>(
        lockedDb,
        sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`,
      );
      if (row?.acquired === true) return await fn();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new SandboxProviderReadLockUnavailableError();
      await waitForSandboxProviderReadLockPoll(Math.min(pollMs, remainingMs), signal);
      pollMs = Math.min(pollMs * 2, SANDBOX_PROVIDER_READ_LOCK_POLL_MAX_MS);
    }
  });
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): DbClient {
  // `prepare: false` is REQUIRED for Azure Database for PostgreSQL Flexible
  // Server's transaction-pooling PgBouncer: postgres-js's default named prepared
  // statements (`s_N`) are bound to one backend, but a transaction pooler hands
  // each transaction a different backend, so a later `execute` intermittently
  // throws `prepared statement "s_N" does not exist`. Every RLS read in this
  // module (set_config + SELECT inside one db.transaction) rides on this pool, so
  // the failure surfaces as a "worked, then didn't" credential/permission read.
  // idle_timeout + max_lifetime recycle connections so a pooler-recycled backend
  // is never reused indefinitely; application_name aids server-side diagnostics.
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    prepare: false,
    idle_timeout: 30,
    max_lifetime: 1800,
    // `connection` carries per-session Postgres STARTUP parameters. `application_name`
    // (always) aids server-side diagnostics; `search_path` (embedded only) is the
    // supported, query-param-free way to scope a connection to a dedicated schema —
    // postgres-js IGNORES a URL `?search_path=`. Unset searchPath → omit it so the
    // server default (`public`) is unchanged for standalone.
    connection: {
      application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
      ...(options.searchPath ? { search_path: options.searchPath } : {}),
      ...(options.isolationLevel ? { default_transaction_isolation: options.isolationLevel } : {}),
    },
  });
  const db = drizzle(client, { schema });
  dbBindings.set(db as unknown as object, {
    rlsStrategy: options.rlsStrategy ?? "force",
    ...(options.userLookup ? { userLookup: options.userLookup } : {}),
  });
  return {
    db,
    close: async () => {
      await client.end();
    },
  };
}

/**
 * Register a host's `rlsStrategy`/`userLookup` against an externally-constructed
 * `Database` handle (e.g. one the embedded host built from its own driver and
 * injected, rather than via `createDb`). Lets the same WeakMap-backed lookups
 * work for injected handles. Standalone never calls this (it uses `createDb`).
 */
export function registerDbBinding(
  db: Database,
  binding: { rlsStrategy?: RlsStrategy; userLookup?: UserLookup },
): void {
  dbBindings.set(db as unknown as object, {
    rlsStrategy: binding.rlsStrategy ?? "force",
    ...(binding.userLookup ? { userLookup: binding.userLookup } : {}),
  });
}

export async function setRlsContext(db: Database, context: RlsContext): Promise<void> {
  // Fail loud on an empty/blank account id: a "" account would set an RLS GUC
  // that matches no tenant row, silently returning zero rows from every scoped
  // read (a phantom "not found" / "no active subscription"). An RLS context with
  // no account is always a bug at the call site, never a valid query scope.
  if (typeof context.accountId !== "string" || context.accountId.trim() === "") {
    throw new Error("setRlsContext: a non-empty accountId is required to establish an RLS context");
  }
  await db.execute(sql`select set_config('opengeni.account_id', ${context.accountId}, true)`);
  await db.execute(
    sql`select set_config('opengeni.workspace_id', ${context.workspaceId ?? ""}, true)`,
  );
  // Transaction-local writer identity covers supported injected/embedded
  // database handles whose connection-level application_name is host-owned.
  // Old OpenGeni binaries do not set this GUC, so migration-installed update
  // fences can distinguish their partial writes without inspecting content.
  await db.execute(sql`select set_config('opengeni.lossless_content_writer', '1', true)`);
  await db.execute(sql`select
    set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
    -- Migration 0229 uses this transaction-local generation marker to reject a
    -- legacy API replica that tries to introduce hidden turn instructions while
    -- still allowing that replica to process ordinary null-instruction work.
    set_config('opengeni.turn_instructions_protocol_v1', '1', true)`);
}

async function readRlsContextSettings(db: Database): Promise<RlsContextSettings> {
  const [settings] = await rawRows<{
    account_id: string | null;
    workspace_id: string | null;
  }>(
    db,
    sql`select
      current_setting('opengeni.account_id', true) as account_id,
      current_setting('opengeni.workspace_id', true) as workspace_id`,
  );
  return {
    accountId: settings?.account_id ?? "",
    workspaceId: settings?.workspace_id ?? "",
  };
}

async function assertRlsContextApplied(db: Database, context: RlsContext): Promise<void> {
  const applied = await readRlsContextSettings(db);
  const expectedWorkspaceId = context.workspaceId ?? "";
  if (applied.accountId !== context.accountId) {
    throw new Error(
      `RLS context not applied on the active backend: expected account ${context.accountId}, got "${applied.accountId}"`,
    );
  }
  if (applied.workspaceId !== expectedWorkspaceId) {
    throw new Error(
      `RLS context not applied on the active backend: expected workspace "${expectedWorkspaceId}", got "${applied.workspaceId}"`,
    );
  }
}

async function restoreRlsContextSettings(
  db: Database,
  settings: RlsContextSettings,
): Promise<void> {
  const [restored] = await rawRows<{
    account_id: string;
    workspace_id: string;
  }>(
    db,
    sql`select
      set_config('opengeni.account_id', ${settings.accountId}, true) as account_id,
      set_config('opengeni.workspace_id', ${settings.workspaceId}, true) as workspace_id`,
  );
  if (
    restored?.account_id !== settings.accountId ||
    restored.workspace_id !== settings.workspaceId
  ) {
    throw new Error("RLS context could not be restored after a nested scope");
  }
}

export async function withRlsContext<T>(
  db: Database,
  context: RlsContext,
  fn: (db: Database) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  const restoreParentScope = isTransactionHandle(db);
  return await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const parentScope = restoreParentScope ? await readRlsContextSettings(scoped) : null;
    await setRlsContext(scoped, context);
    // Defense-in-depth: read the LOCAL GUC back on THIS backend BEFORE running
    // the scoped query. The set_config and this read share one db.transaction,
    // which a transaction pooler pins to a single backend — so a mismatch here
    // means the context was genuinely lost (a torn transaction / pooler backend
    // swap), not normal operation. Without this guard such an event runs the
    // scoped read with an empty account_id and returns zero RLS-visible rows,
    // manufacturing a phantom "no active subscription" from a credential that is
    // in fact active. Convert that silent false into a loud, root-cause-bearing
    // error so the caller can retry rather than permanently mis-decide.
    await assertRlsContextApplied(scoped, context);
    const value = await fn(scoped);
    // A nested transaction is a savepoint, and SET LOCAL survives successful
    // savepoint release. Restore only the tenant scope the nested helper owns;
    // writer/protocol capabilities intentionally remain transaction-wide.
    if (parentScope) await restoreRlsContextSettings(scoped, parentScope);
    return value;
  }, transactionConfig);
}

/**
 * Run one bounded database operation on a transaction-pinned backend.
 *
 * Callers that also have an application deadline should check their abort
 * signal before returning from `fn`; throwing there rolls the transaction back
 * even when the application deadline won a surrounding Promise race.
 */
export async function withDatabaseStatementTimeout<T>(
  db: Database,
  timeoutMs: number,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("withDatabaseStatementTimeout requires a positive timeout");
  }
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    await scoped.execute(
      sql`select set_config('statement_timeout', ${`${boundedTimeoutMs}ms`}, true)`,
    );
    return await fn(scoped);
  });
}

export async function rlsContextForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<RlsContext> {
  const [row] = await db
    .select({ accountId: schema.workspaces.accountId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return { accountId: row.accountId, workspaceId };
}

export async function withWorkspaceRls<T>(
  db: Database,
  workspaceId: string,
  fn: (db: Database) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  return await withRlsContext(
    db,
    await rlsContextForWorkspace(db, workspaceId),
    fn,
    transactionConfig,
  );
}

type SessionActivityGate = {
  db: SessionActivityDatabase;
  owner: boolean;
};

function isTransactionHandle(db: Database): boolean {
  return typeof (db as Database & { rollback?: unknown }).rollback === "function";
}

async function assertSessionActivityGateEntry(db: Database): Promise<void> {
  if (!isTransactionHandle(db)) return;
  const [gate] = await rawRows<{ state: string | null }>(
    db,
    sql`
      select nullif(
        current_setting('opengeni.session_activity_gate_state', true),
        ''
      ) as state
    `,
  );
  if (gate?.state === null || gate === undefined) {
    throw new Error("Session activity commit gate must start at the outer transaction boundary");
  }
}

async function beginSessionActivityGate(
  db: Database,
  workspaceId: string,
): Promise<SessionActivityGate> {
  const [gate] = await rawRows<{
    prior_state: string | null;
    prior_workspace_id: string | null;
  }>(
    db,
    sql`
      with current_gate as materialized (
        select
          nullif(current_setting('opengeni.session_activity_gate_state', true), '') as prior_state,
          nullif(current_setting('opengeni.session_activity_gate_workspace_id', true), '') as prior_workspace_id
      )
      select
        prior_state,
        prior_workspace_id,
        case
          when prior_state is null
            then set_config('opengeni.session_activity_gate_state', 'open', true)
          else prior_state
        end as effective_state,
        case
          when prior_state is null
            then set_config('opengeni.session_activity_gate_workspace_id', ${workspaceId}, true)
          else prior_workspace_id
        end as effective_workspace_id
      from current_gate
    `,
  );
  if (!gate) {
    throw new Error("Session activity commit gate could not be opened");
  }
  if (gate.prior_state === null) {
    return { db: db as SessionActivityDatabase, owner: true };
  }
  if (gate.prior_state === "open" && gate.prior_workspace_id === workspaceId) {
    return { db: db as SessionActivityDatabase, owner: false };
  }
  throw new Error("Session activity commit gate is already owned by another transaction scope");
}

async function finalizeSessionActivityGate(
  db: SessionActivityDatabase,
  workspaceId: string,
): Promise<void> {
  // Resolve every deferred FK/constraint before taking the shared workspace
  // counter. The only row writes after that point stamp session rows already
  // modified and therefore already owned by this transaction.
  await db.execute(
    sql`select set_config('opengeni.session_activity_gate_state', 'preparing', true)`,
  );
  await db.execute(sql`set constraints all immediate`);
  // The first flush proves every pre-existing deferred obligation. Re-defer
  // only our commit guard so the marker-clearing writes below queue a fresh
  // proof against the final row state, then force that proof before returning.
  await db.execute(
    sql`set constraints sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard deferred`,
  );
  const [result] = await rawRows<{
    had_pending: boolean;
    pending_count: number;
    revision: string | null;
    stamped_count: number;
  }>(
    db,
    sql`
      with gate as materialized (
        select set_config('opengeni.session_activity_gate_state', 'finalizing', true) as state
      ),
      pending as materialized (
        select ${schema.sessions.id}
        from ${schema.sessions}
        cross join gate
        where ${schema.sessions.workspaceId} = ${workspaceId}
          and ${schema.sessions.activityRevisionPendingXid}
            = pg_current_xact_id()::text::bigint
      ),
      advanced as (
        update ${schema.workspaceSessionActivityRevisions} as counter
        set revision = counter.revision + 1
        where counter.workspace_id = ${workspaceId}
          and exists (select 1 from pending)
        returning counter.revision
      ),
      stamped as (
        update ${schema.sessions} as session
        set
          activity_revision = advanced.revision,
          activity_revision_pending_xid = null
        from advanced
        where session.workspace_id = ${workspaceId}
          and session.activity_revision_pending_xid
            = pg_current_xact_id()::text::bigint
        returning session.id
      ),
      stats as materialized (
        select
          exists (select 1 from pending) as had_pending,
          (select count(*)::integer from pending) as pending_count,
          (select revision::text from advanced) as revision,
          (select count(*)::integer from stamped) as stamped_count
      ),
      finalized as materialized (
        select
          had_pending,
          pending_count,
          revision,
          stamped_count,
          set_config('opengeni.session_activity_gate_state', 'finalized', true) as state
        from stats
      )
      select had_pending, pending_count, revision, stamped_count
      from finalized
    `,
  );
  if (!result) {
    throw new Error("Session activity commit gate did not return a finalization result");
  }
  if (result.had_pending && result.revision === null) {
    throw new Error("Workspace session activity counter is unavailable");
  }
  if (result.stamped_count !== result.pending_count) {
    throw new Error("Session activity commit gate did not stamp every pending row");
  }
  await db.execute(
    sql`set constraints sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard immediate`,
  );
}

/**
 * Run one workspace transaction with explicit once-per-transaction session
 * activity finalization. Nested callers reuse the outer gate; only its owner
 * finalizes immediately before the enclosing RLS transaction commits.
 */
export async function withSessionActivityRlsContext<T>(
  db: Database,
  context: RlsContext & { workspaceId: string },
  fn: (db: SessionActivityDatabase) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  await assertSessionActivityGateEntry(db);
  return await withRlsContext(
    db,
    context,
    async (scopedDb) => {
      const gate = await beginSessionActivityGate(scopedDb, context.workspaceId);
      const value = await fn(gate.db);
      // The finalizer must never trust tenant GUCs that arbitrary callback code
      // could have changed. Nested RLS helpers restore their parent scope; this
      // assertion is the fail-closed commit-boundary proof for every other path.
      await assertRlsContextApplied(gate.db, context);
      if (gate.owner) {
        await finalizeSessionActivityGate(gate.db, context.workspaceId);
      }
      return value;
    },
    transactionConfig,
  );
}

export async function withWorkspaceSessionActivityRls<T>(
  db: Database,
  workspaceId: string,
  fn: (db: SessionActivityDatabase) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  return await withSessionActivityRlsContext(
    db,
    { ...(await rlsContextForWorkspace(db, workspaceId)), workspaceId },
    fn,
    transactionConfig,
  );
}

/**
 * Open one nested savepoint without losing the gate brand. Drizzle correctly
 * preserves the backend-local gate GUCs, but its structural transaction type
 * cannot express that provenance; keep the single trusted rebrand here.
 */
export async function withSessionActivitySavepoint<T>(
  db: SessionActivityDatabase,
  fn: (db: SessionActivityDatabase) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => await fn(tx as unknown as SessionActivityDatabase));
}

export async function retrySessionActivityRls<T>(
  db: Database,
  workspaceId: string,
  options: IdempotentPersistenceTransactionOptions,
  fn: (db: SessionActivityDatabase) => Promise<T>,
): Promise<T> {
  return await runIdempotentPersistenceTransaction(options, async () => {
    return await withWorkspaceSessionActivityRls(db, workspaceId, fn);
  });
}

export async function retryWorkspacePersistence<T>(
  db: Database,
  workspaceId: string,
  options: IdempotentPersistenceTransactionOptions,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await runIdempotentPersistenceTransaction(options, async () => {
    return await withWorkspaceRls(db, workspaceId, fn);
  });
}

export async function retryRlsPersistence<T>(
  db: Database,
  context: RlsContext,
  options: IdempotentPersistenceTransactionOptions,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await runIdempotentPersistenceTransaction(options, async () => {
    return await withRlsContext(db, context, fn);
  });
}

/**
 * Personal workspace data needs both tenant and authenticated-principal GUCs.
 * `session_pins` uses this helper so FORCE RLS rejects another member's rows
 * even if a future query accidentally omits its explicit subject predicate.
 */
export async function withWorkspaceSubjectRls<T>(
  db: Database,
  workspaceId: string,
  subjectId: string,
  fn: (db: Database) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  if (!subjectId.trim()) {
    throw new Error("withWorkspaceSubjectRls: a non-empty subjectId is required");
  }
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(
    db,
    context,
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, subjectId);
      return await fn(scopedDb);
    },
    transactionConfig,
  );
}

export async function withWorkspaceSubjectSessionActivityRls<T>(
  db: Database,
  workspaceId: string,
  subjectId: string,
  fn: (db: SessionActivityDatabase) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  if (!subjectId.trim()) {
    throw new Error("withWorkspaceSubjectSessionActivityRls: a non-empty subjectId is required");
  }
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withSessionActivityRlsContext(
    db,
    { ...context, workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, subjectId);
      return await fn(scopedDb);
    },
    transactionConfig,
  );
}

/** Apply and verify actor-private RLS on an already transaction-pinned handle. */
export async function setSubjectRlsContext(db: Database, subjectId: string): Promise<void> {
  if (!subjectId.trim()) {
    throw new Error("setSubjectRlsContext: a non-empty subjectId is required");
  }
  await db.execute(sql`select set_config('opengeni.subject_id', ${subjectId}, true)`);
  const applied = await db.execute<{ subject_id: string | null }>(
    sql`select current_setting('opengeni.subject_id', true) as subject_id`,
  );
  if ((applied[0]?.subject_id ?? "") !== subjectId) {
    throw new Error("Authenticated subject RLS context was not applied on the active backend");
  }
}

export async function withWorkspaceUsageLock<T>(
  db: Database,
  workspaceId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    await scopedDb.execute(sql`select pg_advisory_xact_lock(hashtext(${`usage:${workspaceId}`}))`);
    return await fn(scopedDb);
  });
}

export async function withAccountRls<T>(
  db: Database,
  accountId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, { accountId, workspaceId: null }, fn);
}

/** Internal lookup for the host binding attached to a database handle. */
export function dbBindingFor(db: Database): DbBinding | undefined {
  return dbBindings.get(db as unknown as object);
}
