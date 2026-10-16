import type { SessionAttachmentReadAccess } from "./session-file-attachments";
import { AsyncLocalStorage } from "node:async_hooks";
import { eq, sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgTransactionConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseBootConnectOptions } from "./boot-connect";

import {
  DatabaseTransactionError,
  isDatabasePersistenceFailure,
  runIdempotentPersistenceTransaction,
  type IdempotentPersistenceTransactionOptions,
} from "./persistence-errors";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "./lossless-json";
import * as schema from "./schema";
import { startDatabaseTiming } from "./database-timing";

// §7.7 driver widening (Step I). `Database` is the structural, cross-driver
// query-layer port: every helper in this file accepts `db: Database` and uses
// only the methods present on drizzle's base `PgDatabase` (select/insert/update/
// delete/transaction/execute). Widening from the concrete
// `PostgresJsDatabase<typeof schema>` to `PgDatabase<any, typeof schema>` is a
// pure TYPE change — no runtime behavior changes — that lets an embedded host
// inject ANY drizzle pg driver handle (node-postgres, neon-http, etc.) bound to
// Opengeni's schema, not just the postgres-js handle `createDb` builds. The
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

export type SessionRlsActorContext = {
  /** Server-authorized session attachment scope; never taken from request JSON. */
  sessionAttachmentReadAccess?: SessionAttachmentReadAccess;
  subjectId: string;
  /** Host-verified personal file ownership, never a request-supplied subject. */
  privateFileOwnerSubjectId?: string | null;
  initiatingHumanSubjectId?: string | null;
  /** Root reconstructed from a verified live agent attempt, never page input. */
  agentRootSessionId?: string | null;
};

/** Request-local proof from the signed published-Site gateway and live viewer cookie. */
export type SiteViewerRlsContext = Readonly<{ siteId: string; principal: string }>;
const siteViewerRlsContext = new AsyncLocalStorage<SiteViewerRlsContext>();
export function currentSiteViewerRlsContext(): SiteViewerRlsContext | undefined {
  return siteViewerRlsContext.getStore();
}
export function withSiteViewerRlsContext<T>(context: SiteViewerRlsContext, run: () => T): T {
  return siteViewerRlsContext.run(Object.freeze({ ...context }), run);
}

const sessionRlsActorContext = new AsyncLocalStorage<SessionRlsActorContext>();
export function currentSessionAttachmentReadAccess(): SessionAttachmentReadAccess | undefined {
  return sessionRlsActorContext.getStore()?.sessionAttachmentReadAccess;
}

/**
 * The ambient session RLS actor established by the caller, if any. Read-only:
 * helpers use it to decide whether the caller already owns session access and
 * must never mutate it.
 */
export function currentSessionRlsActorContext(): Readonly<SessionRlsActorContext> | undefined {
  return sessionRlsActorContext.getStore();
}

/**
 * Stable identity of the ambient session RLS actor: every field that
 * `setRlsContext` turns into database-visible GUCs or that scoped reads
 * consult. Two callers with equal keys see exactly the same rows, so the key
 * is safe for sharing a read result between them; `null` means no actor, in
 * which case the subject GUC stays empty for every such caller.
 */
export function currentSessionRlsActorIdentityKey(): string | null {
  const actor = sessionRlsActorContext.getStore();
  if (!actor) return null;
  return JSON.stringify([
    actor.subjectId,
    actor.initiatingHumanSubjectId ?? null,
    actor.privateFileOwnerSubjectId ?? null,
    actor.sessionAttachmentReadAccess ?? null,
    actor.agentRootSessionId ?? null,
    siteViewerRlsContext.getStore() ?? null,
  ]);
}

/**
 * The ambient session RLS actor's frozen initiating human: `undefined` when
 * there is no actor, `null` when the actor has no human. Reads that must act
 * for the turn's human take it from here, never from a caller argument.
 */
export function currentSessionRlsActorInitiatingHumanSubjectId(): string | null | undefined {
  const actor = sessionRlsActorContext.getStore();
  if (!actor) return undefined;
  return actor.initiatingHumanSubjectId ?? null;
}

export async function withSessionRlsActorContext<T>(
  actor: SessionRlsActorContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!actor.subjectId.trim()) {
    throw new Error("withSessionRlsActorContext: a non-empty subjectId is required");
  }
  if (
    actor.initiatingHumanSubjectId !== undefined &&
    actor.initiatingHumanSubjectId !== null &&
    !actor.initiatingHumanSubjectId.trim()
  ) {
    throw new Error(
      "withSessionRlsActorContext: initiatingHumanSubjectId must be null or non-empty",
    );
  }
  if (
    actor.privateFileOwnerSubjectId !== undefined &&
    actor.privateFileOwnerSubjectId !== null &&
    !actor.privateFileOwnerSubjectId.trim()
  ) {
    throw new Error(
      "withSessionRlsActorContext: privateFileOwnerSubjectId must be null or non-empty",
    );
  }
  return await sessionRlsActorContext.run(actor, fn);
}

type RlsContextSettings = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  privateFileOwnerSubjectId: string;
  initiatingHumanSubjectId: string;
  personalResourceHumanSubjectId: string;
  personalResourceActorSubjectId: string;
  agentRootSessionId: string;
  siteId: string;
  siteViewerPrincipal: string;
};

/**
 * RLS posture for the connection Opengeni's query layer runs over (Step I, §7.7).
 *
 * - `"force"` (DEFAULT — today's standalone behavior, byte-for-byte): Opengeni
 *   connects as a NON-OWNER role (`opengeni_app`) and every table carries
 *   `FORCE ROW LEVEL SECURITY`, so the workspace/account GUCs set by
 *   `setRlsContext` are the ONLY thing that admits rows — even the table owner
 *   is subject to RLS. This is the Fork-A isolation guarantee.
 * - `"scoped"` (embedded Fork-B opt-in): the host runs Opengeni's queries over a
 *   role that OWNS the dedicated schema (RLS need not be forced for that role),
 *   relying on the host's own tenant boundary. Opengeni STILL emits the
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
 * a non-`auth_users` user store) injects this closure so Opengeni never touches
 * `auth_users` directly. Returns the user id, or null when no such user exists.
 */
export type UserLookup = (db: Database, email: string) => Promise<string | null>;

export type ManagedUserProfile = {
  id: string;
  name: string | null;
  email: string;
};

/** Host identity projection used by organization administration rosters. */
export type UserProfileLookup = (
  db: Database,
  userIds: readonly string[],
) => Promise<ManagedUserProfile[]>;

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
  /** Host-provided user profile projection; unset → standalone `auth_users`. */
  userProfileLookup?: UserProfileLookup;
  /** postgres-js pool size; defaults to today's `10`. */
  max?: number;
  /**
   * How long a refused first connection is retried while the client has never
   * reached the server; defaults to the boot grace. 0 fails immediately.
   */
  bootConnectGraceMs?: number;
  /**
   * Use named prepared statements. Unset → {@link defaultDatabasePreparedStatements}:
   * on for a direct connection, off behind PgBouncer's port. Pass `false` for any
   * other transaction-pooling proxy.
   */
  preparedStatements?: boolean;
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
type DbBinding = {
  rlsStrategy: RlsStrategy;
  userLookup?: UserLookup;
  userProfileLookup?: UserProfileLookup;
};

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
 * resolves to `any`, erasing the per-row element type at the call site. Opengeni's
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

/** Jittered reconnect delay in seconds after `retries` consecutive connection failures. */
export function databaseReconnectBackoffSeconds(retries: number): number {
  return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 2);
}

/** PgBouncer's port, which Azure Flexible Server's built-in pooler always uses. */
const PGBOUNCER_PORT = "6432";

/**
 * Whether a pool should use named prepared statements when the operator has not
 * said. A direct Postgres connection should: postgres-js otherwise sends every
 * parameterized statement unnamed and must wait for a Describe reply before it
 * can Bind, so each such statement costs two round trips instead of one, and the
 * server re-parses and re-plans it every time. A transaction-pooling PgBouncer
 * must not: named statements live on one backend, the pooler hands the next
 * transaction a different one, and execution intermittently fails with
 * `prepared statement "s_N" does not exist`. Port 6432 is the only signal the URL
 * carries; other poolers need `preparedStatements: false` explicitly.
 */
export function defaultDatabasePreparedStatements(databaseUrl: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(databaseUrl)?.[1] ?? "";
  return !authority.split(",").some((host) => host.endsWith(`:${PGBOUNCER_PORT}`));
}

type PostgresSql = postgres.Sql | postgres.TransactionSql;

/**
 * Drizzle sends every query through `sql.unsafe(text, params)`, and postgres-js
 * never prepares `unsafe` queries unless asked per call, whatever the pool's
 * `prepare` option says. Ask on every call, including inside transactions and
 * savepoints, which hand Drizzle a fresh transaction-scoped `sql`. Queries without
 * parameters keep postgres-js's one-message simple protocol.
 */
function preparingUnsafe<T extends PostgresSql>(target: T): T {
  const wrapScoped = (args: unknown[]) =>
    args.map((arg) =>
      typeof arg === "function"
        ? (scoped: postgres.TransactionSql) =>
            (arg as (scoped: postgres.TransactionSql) => unknown)(preparingUnsafe(scoped))
        : arg,
    );
  return new Proxy(target, {
    get(base, property) {
      if (property === "unsafe") {
        return (query: string, parameters?: unknown[], options?: postgres.UnsafeQueryOptions) =>
          base.unsafe(query, parameters as never, { prepare: true, ...options });
      }
      if (property === "begin" || property === "savepoint") {
        const method = Reflect.get(base, property) as unknown;
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => method.apply(base, wrapScoped(args));
      }
      return Reflect.get(base, property);
    },
  });
}

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): DbClient {
  const preparedStatements =
    options.preparedStatements ?? defaultDatabasePreparedStatements(databaseUrl);
  // idle_timeout + max_lifetime recycle connections so a pooler-recycled backend
  // is never reused indefinitely, and bound each connection's prepared-statement
  // cache; application_name aids server-side diagnostics.
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    prepare: preparedStatements,
    idle_timeout: 30,
    max_lifetime: 1800,
    // postgres.js grows one pool-wide reconnect delay after every refused or
    // reset connection (3^n / 100 s, up to 20 s) and queues queries behind it.
    // After a restart or failover that left the server refusing connections
    // for a while, requests then hung for up to 20 s after it was back. Keep
    // the same jittered growth but cap it at 2 s.
    backoff: databaseReconnectBackoffSeconds,
    // A fresh pod can be refused for a moment while its network policy and DNS
    // settle; retry that first connection briefly instead of failing boot.
    ...databaseBootConnectOptions(databaseUrl, options.bootConnectGraceMs),
    // `connection` carries per-session Postgres STARTUP parameters. The exact
    // `application_name` is also the PgBouncer-compatible current-image receipt
    // for migration 0352's restrictive sessions policy; arbitrary custom startup
    // parameters are not portable through transaction poolers. `search_path`
    // (embedded only) is the supported, query-param-free way to scope a connection
    // to a dedicated schema — postgres-js IGNORES a URL `?search_path=`. Unset
    // searchPath → omit it so the server default (`public`) is unchanged for
    // standalone.
    connection: {
      application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME,
      ...(options.searchPath ? { search_path: options.searchPath } : {}),
      ...(options.isolationLevel ? { default_transaction_isolation: options.isolationLevel } : {}),
      // Prepared statements are for skipping the Describe round trip and the
      // re-parse. Keep planning per execution: a cached generic plan cannot see
      // bound values, so it cannot choose a partial index whose predicate names a
      // parameterized value, nor the selectivity of one workspace or subject.
      // Only direct connections prepare, so this startup parameter never reaches
      // a transaction pooler.
      ...(preparedStatements ? { plan_cache_mode: "force_custom_plan" } : {}),
    },
  });
  const db = drizzle(preparedStatements ? preparingUnsafe(client) : client, { schema });
  dbBindings.set(db as unknown as object, {
    rlsStrategy: options.rlsStrategy ?? "force",
    ...(options.userLookup ? { userLookup: options.userLookup } : {}),
    ...(options.userProfileLookup ? { userProfileLookup: options.userProfileLookup } : {}),
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
  binding: {
    rlsStrategy?: RlsStrategy;
    userLookup?: UserLookup;
    userProfileLookup?: UserProfileLookup;
  },
): void {
  dbBindings.set(db as unknown as object, {
    rlsStrategy: binding.rlsStrategy ?? "force",
    ...(binding.userLookup ? { userLookup: binding.userLookup } : {}),
    ...(binding.userProfileLookup ? { userProfileLookup: binding.userProfileLookup } : {}),
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
  await applyRlsScope(db, {
    accountId: context.accountId,
    workspaceId: context.workspaceId ?? null,
    locks: [],
    readParent: false,
  });
}

/** An advisory transaction lock taken while a scope is established. `key` is
 * either a literal key or a prefix completed with the scope's account id. */
type RlsScopeLock = {
  key: string | { accountPrefix: string };
  mode: "shared" | "exclusive";
  hash: "extended" | "text";
};

type RlsScopeInput = {
  /** The tenant account, or null to resolve it from `workspaceId` within the
   * same statement. */
  accountId: string | null;
  workspaceId: string | null;
  /** Authenticated subject for actor-private rows; overrides the ambient
   * session actor's subject. */
  subjectId?: string;
  /** Locks taken in this order, after the context is set. */
  locks: readonly RlsScopeLock[];
  /** Return the enclosing scope's settings so a nested scope can restore them. */
  readParent: boolean;
};

type AppliedRlsScope = {
  context: { accountId: string; workspaceId: string | null };
  parent: RlsContextSettings | null;
};

function sessionTenancyLock(workspaceId: string): RlsScopeLock {
  return { key: `session-tenancy:${workspaceId}`, mode: "shared", hash: "extended" };
}

function rlsScopeLockCall(lock: RlsScopeLock): SQL {
  const key =
    typeof lock.key === "string"
      ? sql`${lock.key}::text`
      : sql`(${lock.key.accountPrefix}::text || resolved.account_id)`;
  const hashed =
    lock.hash === "extended" ? sql`hashtextextended(${key}, 0)` : sql`hashtext(${key})`;
  return lock.mode === "shared"
    ? sql`pg_advisory_xact_lock_shared(${hashed})`
    : sql`pg_advisory_xact_lock(${hashed})`;
}

/**
 * Establish a transaction's whole RLS scope in ONE statement, on the backend
 * that runs the rest of the transaction: read the enclosing scope (nested
 * only), resolve the tenant account from the workspace when it is not known,
 * set the tenant, writer-capability, subject and session-actor GUCs, take the
 * scope's advisory locks in order, and read the applied tenant and subject
 * back. Each step is a MATERIALIZED CTE that selects from the previous one, so
 * PostgreSQL evaluates them in exactly that order. A missing workspace yields
 * no row and fails loud.
 *
 * Transaction-local writer identity covers supported injected/embedded
 * database handles whose connection-level application_name is host-owned.
 * Standalone createDb connections also carry version receipts in their exact
 * application_name, while old Opengeni binaries set neither current receipt.
 *
 * JIT is off for these short request transactions: row-level security
 * functions inflate planner cost estimates past jit_above_cost, so PostgreSQL
 * spent seconds compiling queries that execute in milliseconds (the session
 * list's tree-stats query: 0.4 s of work behind 3.8 s of JIT). Transaction-local,
 * so it is safe behind transaction poolers and never leaks to other work.
 */
async function applyRlsScope(db: Database, input: RlsScopeInput): Promise<AppliedRlsScope> {
  if (input.accountId !== null && input.accountId.trim() === "") {
    throw new Error("setRlsContext: a non-empty accountId is required to establish an RLS context");
  }
  if (input.accountId === null && !input.workspaceId) {
    throw new Error("an RLS scope needs an accountId or a workspaceId to resolve it from");
  }
  if (input.subjectId !== undefined && !input.subjectId.trim()) {
    throw new Error("setSubjectRlsContext: a non-empty subjectId is required");
  }
  const actor = sessionRlsActorContext.getStore();
  const siteViewer = siteViewerRlsContext.getStore();
  const subjectId = input.subjectId ?? actor?.subjectId;
  const account =
    input.accountId !== null
      ? sql`${input.accountId}::text`
      : sql`(select ${schema.workspaces.accountId}::text from ${schema.workspaces} where ${schema.workspaces.id} = ${input.workspaceId}::uuid)`;
  const settings: SQL[] = [
    sql`set_config('opengeni.account_id', resolved.account_id, true)`,
    sql`set_config('opengeni.workspace_id', ${input.workspaceId ?? ""}::text, true)`,
    sql`set_config('opengeni.lossless_content_writer', '1', true)`,
    sql`set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`,
    sql`set_config('opengeni.pending_tool_event_output_v1', '1', true)`,
    sql`set_config('opengeni.session_variable_set_attachments_v1', '1', true)`,
    sql`set_config('opengeni.shared_personal_choice_v1', '1', true)`,
    sql`set_config('opengeni.site_session_audience_v1', '1', true)`,
    sql`set_config('jit', 'off', true)`,
    sql`set_config('opengeni.agent_root_session_id', ${actor?.agentRootSessionId ?? ""}::text, true)`,
    sql`set_config('opengeni.site_id', ${siteViewer?.siteId ?? ""}::text, true)`,
    sql`set_config('opengeni.site_viewer_principal', ${siteViewer?.principal ?? ""}::text, true)`,
  ];
  if (subjectId !== undefined) {
    settings.push(sql`set_config('opengeni.subject_id', ${subjectId}::text, true)`);
  }
  if (actor) {
    settings.push(
      sql`set_config('opengeni.private_file_owner', ${actor.privateFileOwnerSubjectId ?? ""}::text, true)`,
      sql`set_config('opengeni.initiating_human_subject_id', ${actor.initiatingHumanSubjectId ?? ""}::text, true)`,
    );
  }
  const steps: SQL[] = [
    sql`parent as materialized (select
      current_setting('opengeni.account_id', true) as account_id,
      current_setting('opengeni.workspace_id', true) as workspace_id,
      current_setting('opengeni.subject_id', true) as subject_id,
      current_setting('opengeni.private_file_owner', true) as private_file_owner,
      current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id,
      current_setting('opengeni.personal_resource_human_subject_id', true) as personal_resource_human_subject_id,
      current_setting('opengeni.personal_resource_actor_subject_id', true) as personal_resource_actor_subject_id,
      current_setting('opengeni.agent_root_session_id', true) as agent_root_session_id,
      current_setting('opengeni.site_id', true) as site_id,
      current_setting('opengeni.site_viewer_principal', true) as site_viewer_principal)`,
    sql`resolved as materialized (select ${account} as account_id from parent)`,
    sql`scope as materialized (select ${sql.join(
      settings.map((setting, index) => sql`${setting} as ${sql.raw(`s${index}`)}`),
      sql`, `,
    )} from resolved where resolved.account_id is not null and resolved.account_id <> '')`,
  ];
  let last = "scope";
  input.locks.forEach((lock, index) => {
    const name = `lock_${index}`;
    steps.push(
      sql`${sql.raw(name)} as materialized (select ${rlsScopeLockCall(lock)} as locked from ${sql.raw(last)}, resolved)`,
    );
    last = name;
  });
  const [row] = await rawRows<{
    resolved_account_id: string;
    account_id: string | null;
    workspace_id: string | null;
    subject_id: string | null;
    parent_account_id: string | null;
    parent_workspace_id: string | null;
    parent_subject_id: string | null;
    parent_private_file_owner: string | null;
    parent_initiating_human_subject_id: string | null;
    parent_personal_resource_human_subject_id: string | null;
    parent_personal_resource_actor_subject_id: string | null;
    parent_agent_root_session_id: string | null;
    parent_site_id: string | null;
    parent_site_viewer_principal: string | null;
  }>(
    db,
    sql`with ${sql.join(steps, sql`, `)}
      select
        resolved.account_id as resolved_account_id,
        current_setting('opengeni.account_id', true) as account_id,
        current_setting('opengeni.workspace_id', true) as workspace_id,
        current_setting('opengeni.subject_id', true) as subject_id,
        parent.account_id as parent_account_id,
        parent.workspace_id as parent_workspace_id,
        parent.subject_id as parent_subject_id,
        parent.private_file_owner as parent_private_file_owner,
        parent.initiating_human_subject_id as parent_initiating_human_subject_id,
        parent.personal_resource_human_subject_id as parent_personal_resource_human_subject_id,
        parent.personal_resource_actor_subject_id as parent_personal_resource_actor_subject_id,
        parent.agent_root_session_id as parent_agent_root_session_id,
        parent.site_id as parent_site_id,
        parent.site_viewer_principal as parent_site_viewer_principal
      from ${sql.raw(last)}, resolved, parent`,
  );
  if (!row) {
    if (input.accountId === null) throw new Error(`Workspace not found: ${input.workspaceId}`);
    throw new Error("RLS context could not be applied on the active backend");
  }
  const expectedWorkspaceId = input.workspaceId ?? "";
  // A caller-supplied account is the expectation; otherwise the account the
  // same statement resolved from the workspace.
  const expectedAccountId = input.accountId ?? row.resolved_account_id;
  // Defense-in-depth: the applied values are read back by the same statement
  // on the backend that keeps them for the rest of the transaction. A
  // mismatch means the context was genuinely lost, so fail loud instead of
  // running scoped reads that would see zero rows (a phantom "not found").
  if (!expectedAccountId || (row.account_id ?? "") !== expectedAccountId) {
    throw new Error(
      `RLS context not applied on the active backend: expected account ${expectedAccountId}, got "${row.account_id ?? ""}"`,
    );
  }
  if ((row.workspace_id ?? "") !== expectedWorkspaceId) {
    throw new Error(
      `RLS context not applied on the active backend: expected workspace "${expectedWorkspaceId}", got "${row.workspace_id ?? ""}"`,
    );
  }
  if (subjectId !== undefined && (row.subject_id ?? "") !== subjectId) {
    throw new Error("Authenticated subject RLS context was not applied on the active backend");
  }
  return {
    context: { accountId: expectedAccountId, workspaceId: input.workspaceId },
    parent: input.readParent
      ? {
          accountId: row.parent_account_id ?? "",
          workspaceId: row.parent_workspace_id ?? "",
          subjectId: row.parent_subject_id ?? "",
          privateFileOwnerSubjectId: row.parent_private_file_owner ?? "",
          initiatingHumanSubjectId: row.parent_initiating_human_subject_id ?? "",
          personalResourceHumanSubjectId: row.parent_personal_resource_human_subject_id ?? "",
          personalResourceActorSubjectId: row.parent_personal_resource_actor_subject_id ?? "",
          agentRootSessionId: row.parent_agent_root_session_id ?? "",
          siteId: row.parent_site_id ?? "",
          siteViewerPrincipal: row.parent_site_viewer_principal ?? "",
        }
      : null,
  };
}

async function readRlsContextSettings(db: Database): Promise<RlsContextSettings> {
  const [settings] = await rawRows<{
    account_id: string | null;
    workspace_id: string | null;
    subject_id: string | null;
    private_file_owner: string | null;
    initiating_human_subject_id: string | null;
    personal_resource_human_subject_id: string | null;
    personal_resource_actor_subject_id: string | null;
    agent_root_session_id: string | null;
    site_id: string | null;
    site_viewer_principal: string | null;
  }>(
    db,
    sql`select
      current_setting('opengeni.account_id', true) as account_id,
      current_setting('opengeni.workspace_id', true) as workspace_id,
      current_setting('opengeni.subject_id', true) as subject_id,
      current_setting('opengeni.private_file_owner', true) as private_file_owner,
      current_setting('opengeni.initiating_human_subject_id', true) as initiating_human_subject_id,
      current_setting('opengeni.personal_resource_human_subject_id', true) as personal_resource_human_subject_id,
      current_setting('opengeni.personal_resource_actor_subject_id', true) as personal_resource_actor_subject_id,
      current_setting('opengeni.agent_root_session_id', true) as agent_root_session_id,
      current_setting('opengeni.site_id', true) as site_id,
      current_setting('opengeni.site_viewer_principal', true) as site_viewer_principal`,
  );
  return {
    accountId: settings?.account_id ?? "",
    workspaceId: settings?.workspace_id ?? "",
    subjectId: settings?.subject_id ?? "",
    privateFileOwnerSubjectId: settings?.private_file_owner ?? "",
    initiatingHumanSubjectId: settings?.initiating_human_subject_id ?? "",
    personalResourceHumanSubjectId: settings?.personal_resource_human_subject_id ?? "",
    personalResourceActorSubjectId: settings?.personal_resource_actor_subject_id ?? "",
    agentRootSessionId: settings?.agent_root_session_id ?? "",
    siteId: settings?.site_id ?? "",
    siteViewerPrincipal: settings?.site_viewer_principal ?? "",
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
    subject_id: string;
    private_file_owner: string;
    initiating_human_subject_id: string;
    personal_resource_human_subject_id: string;
    personal_resource_actor_subject_id: string;
    agent_root_session_id: string;
    site_id: string;
    site_viewer_principal: string;
  }>(
    db,
    sql`select
      set_config('opengeni.account_id', ${settings.accountId}, true) as account_id,
      set_config('opengeni.workspace_id', ${settings.workspaceId}, true) as workspace_id,
      set_config('opengeni.subject_id', ${settings.subjectId}, true) as subject_id,
      set_config('opengeni.private_file_owner', ${settings.privateFileOwnerSubjectId}, true) as private_file_owner,
      set_config('opengeni.initiating_human_subject_id', ${settings.initiatingHumanSubjectId}, true) as initiating_human_subject_id,
      set_config('opengeni.personal_resource_human_subject_id', ${settings.personalResourceHumanSubjectId}, true) as personal_resource_human_subject_id,
      set_config('opengeni.personal_resource_actor_subject_id', ${settings.personalResourceActorSubjectId}, true) as personal_resource_actor_subject_id,
      set_config('opengeni.agent_root_session_id', ${settings.agentRootSessionId}, true) as agent_root_session_id,
      set_config('opengeni.site_id', ${settings.siteId}, true) as site_id,
      set_config('opengeni.site_viewer_principal', ${settings.siteViewerPrincipal}, true) as site_viewer_principal`,
  );
  if (
    restored?.account_id !== settings.accountId ||
    restored.workspace_id !== settings.workspaceId ||
    restored.subject_id !== settings.subjectId ||
    restored.private_file_owner !== settings.privateFileOwnerSubjectId ||
    restored.initiating_human_subject_id !== settings.initiatingHumanSubjectId ||
    restored.personal_resource_human_subject_id !== settings.personalResourceHumanSubjectId ||
    restored.personal_resource_actor_subject_id !== settings.personalResourceActorSubjectId ||
    restored.agent_root_session_id !== settings.agentRootSessionId ||
    restored.site_id !== settings.siteId ||
    restored.site_viewer_principal !== settings.siteViewerPrincipal
  ) {
    throw new Error("RLS context could not be restored after a nested scope");
  }
}

/** Attribute only failures outside the application callback to our transaction
 * driver. BEGIN/COMMIT/ROLLBACK can throw raw postgres.js errors, unlike ORM
 * queries. This supplies provenance, never transaction retry permission. */
async function withDatabaseTransactionProvenance<T>(
  db: Database,
  fn: (db: Database) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  let entered = false;
  let callbackFailure: { error: unknown } | undefined;
  try {
    return await db.transaction(async (tx) => {
      entered = true;
      try {
        return await fn(tx as unknown as Database);
      } catch (error) {
        callbackFailure = { error };
        throw error;
      }
    }, transactionConfig);
  } catch (error) {
    // A provider/tool rejection propagated by a successful rollback is still
    // the provider/tool's error, even if it has a connection-looking code.
    if (callbackFailure && callbackFailure.error === error) throw error;
    if (!isDatabasePersistenceFailure(error)) throw error;
    throw new DatabaseTransactionError(
      entered ? "settlement" : "admission",
      error,
      callbackFailure?.error,
    );
  }
}

export async function withRlsContext<T>(
  db: Database,
  context: RlsContext,
  fn: (db: Database) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
  sessionTenancyFence: "shared" | "none" = "shared",
): Promise<T> {
  if (typeof context.accountId !== "string" || context.accountId.trim() === "") {
    throw new Error("setRlsContext: a non-empty accountId is required to establish an RLS context");
  }
  const workspaceId = context.workspaceId || null;
  return await withRlsScope(
    db,
    {
      accountId: context.accountId,
      workspaceId: context.workspaceId ?? null,
      locks:
        workspaceId && sessionTenancyFence === "shared" ? [sessionTenancyLock(workspaceId)] : [],
    },
    (scoped) => fn(scoped),
    transactionConfig,
  );
}

/**
 * Run `fn` in one transaction (or savepoint, when nested) whose RLS scope is
 * established by a single statement (see applyRlsScope). The callback gets the
 * resolved tenant context. A nested scope restores its parent's tenant and
 * actor settings when it returns.
 */
async function withRlsScope<T>(
  db: Database,
  scope: Omit<RlsScopeInput, "readParent">,
  fn: (db: Database, context: AppliedRlsScope["context"]) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  const restoreParentScope = isTransactionHandle(db);
  // Callback entry includes connection admission AND BEGIN/SAVEPOINT round-trip.
  // This is deliberately not advertised as pure pool wait.
  const admission = startDatabaseTiming(
    restoreParentScope ? "savepoint_admission" : "transaction_admission",
  );
  try {
    return await withDatabaseTransactionProvenance(
      db,
      async (tx) => {
        admission("completed");
        const setup = startDatabaseTiming("rls_setup");
        const scoped = tx as unknown as Database;
        let applied: AppliedRlsScope;
        try {
          // One statement sets the scope, takes its locks and reads the applied
          // tenant back on this transaction's backend (see applyRlsScope).
          applied = await applyRlsScope(scoped, { ...scope, readParent: restoreParentScope });
          setup("completed");
        } catch (error) {
          setup("failed");
          throw error;
        }
        const callback = startDatabaseTiming("scoped_callback");
        let value: T;
        try {
          value = await fn(scoped, applied.context);
          callback("completed");
        } catch (error) {
          callback("failed");
          throw error;
        }
        // A nested transaction is a savepoint, and SET LOCAL survives successful
        // savepoint release. Restore the parent tenant and actor proof together;
        // writer/protocol capabilities intentionally remain transaction-wide.
        if (applied.parent) await restoreRlsContextSettings(scoped, applied.parent);
        return value;
      },
      transactionConfig,
    );
  } catch (error) {
    // No-op after callback entry; only admission failures are counted here.
    admission("failed");
    throw error;
  }
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
  // The tenant account is resolved inside the scope's setup statement.
  return await withRlsScope(
    db,
    { accountId: null, workspaceId, locks: [sessionTenancyLock(workspaceId)] },
    (scoped) => fn(scoped),
    transactionConfig,
  );
}

type SessionActivityGate = {
  db: SessionActivityDatabase;
  owner: boolean;
};

/** True for an open transaction (or savepoint) handle rather than a pool handle. */
export function isTransactionHandle(db: Database): boolean {
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
  // A restored activity scope can be followed by another workspace scope, or
  // by a SECURITY DEFINER lifecycle that opens and finalizes its own gate in
  // the same outer transaction. Keep the guards deferred after proving this
  // scope's final state so those later writes reach their own finalizer instead
  // of firing the commit guard at the first session update.
  await db.execute(
    sql`set constraints sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard deferred`,
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
  fenceMode: "shared" | "none" = "shared",
  organizationMembershipFence = false,
): Promise<T> {
  if (typeof context.accountId !== "string" || context.accountId.trim() === "") {
    throw new Error("setRlsContext: a non-empty accountId is required to establish an RLS context");
  }
  return await withSessionActivityRlsScope(
    db,
    { accountId: context.accountId, workspaceId: context.workspaceId },
    fn,
    transactionConfig,
    fenceMode,
    organizationMembershipFence,
  );
}

async function withSessionActivityRlsScope<T>(
  db: Database,
  scope: { accountId: string | null; workspaceId: string; subjectId?: string },
  fn: (db: SessionActivityDatabase) => Promise<T>,
  transactionConfig: PgTransactionConfig | undefined,
  fenceMode: "shared" | "none",
  organizationMembershipFence: boolean,
): Promise<T> {
  await assertSessionActivityGateEntry(db);
  // Only callers that reauthorize or mutate under the membership lifecycle
  // lock take it, always exclusively, and before even a shared tenancy fence:
  // an exclusive tenancy/control waiter can otherwise complete the same lock
  // cycle. The turn claim deliberately takes no membership fence at all. The
  // scope's setup statement takes both in this order.
  const locks: RlsScopeLock[] = [
    ...(organizationMembershipFence
      ? [
          {
            key: { accountPrefix: "organization-membership:" },
            mode: "exclusive",
            hash: "extended",
          } satisfies RlsScopeLock,
        ]
      : []),
    ...(fenceMode === "shared" ? [sessionTenancyLock(scope.workspaceId)] : []),
  ];
  return await withRlsScope(
    db,
    {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      ...(scope.subjectId !== undefined ? { subjectId: scope.subjectId } : {}),
      locks,
    },
    async (scopedDb, context) => {
      const gate = await beginSessionActivityGate(scopedDb, scope.workspaceId);
      const value = await fn(gate.db);
      // The finalizer must never trust tenant GUCs that arbitrary callback code
      // could have changed. Nested RLS helpers restore their parent scope; this
      // assertion is the fail-closed commit-boundary proof for every other path.
      await assertRlsContextApplied(gate.db, context);
      if (gate.owner) {
        await finalizeSessionActivityGate(gate.db, scope.workspaceId);
      }
      return value;
    },
    transactionConfig,
  );
}

/**
 * `organizationMembershipFence` is required when the callback takes the
 * organization-membership lifecycle lock (for example external-actor
 * reauthorization): that lock precedes the session-tenancy fence and the
 * canonical control/workspace/session prefix, never follows it.
 */
export async function withWorkspaceSessionActivityRls<T>(
  db: Database,
  workspaceId: string,
  fn: (db: SessionActivityDatabase) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
  organizationMembershipFence = false,
): Promise<T> {
  // The tenant account is resolved inside the scope's setup statement.
  return await withSessionActivityRlsScope(
    db,
    { accountId: null, workspaceId },
    fn,
    transactionConfig,
    "shared",
    organizationMembershipFence,
  );
}

/**
 * Run one of several ordered workspace activity scopes inside a caller-owned
 * transaction. Each scope is fully finalized before restoring the caller's
 * gate GUCs, so the next workspace can reuse the same outer transaction.
 */
export async function withRestoredSessionActivityRlsContext<T>(
  db: Database,
  context: RlsContext & { workspaceId: string },
  fn: (db: SessionActivityDatabase) => Promise<T>,
): Promise<T> {
  if (!isTransactionHandle(db)) {
    throw new Error("Sequential workspace activity scopes require a caller-owned transaction");
  }
  const [prior] = await rawRows<{ state: string; workspace_id: string }>(
    db,
    sql`select
      coalesce(current_setting('opengeni.session_activity_gate_state', true), '') as state,
      coalesce(
        current_setting('opengeni.session_activity_gate_workspace_id', true), ''
      ) as workspace_id`,
  );
  try {
    return await withRlsContext(db, context, async (scopedDb) => {
      const gate = await beginSessionActivityGate(scopedDb, context.workspaceId);
      if (!gate.owner) {
        throw new Error("Sequential workspace activity scope unexpectedly reused an open gate");
      }
      const value = await fn(gate.db);
      await assertRlsContextApplied(gate.db, context);
      await finalizeSessionActivityGate(gate.db, context.workspaceId);
      return value;
    });
  } finally {
    await db.execute(sql`select
      set_config('opengeni.session_activity_gate_state', ${prior?.state ?? ""}, true),
      set_config(
        'opengeni.session_activity_gate_workspace_id', ${prior?.workspace_id ?? ""}, true
      )`);
  }
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
  sessionTenancyFence: "shared" | "none" = "shared",
): Promise<T> {
  if (!subjectId.trim()) {
    throw new Error("withWorkspaceSubjectRls: a non-empty subjectId is required");
  }
  return await withRlsScope(
    db,
    {
      accountId: null,
      workspaceId,
      subjectId,
      locks: sessionTenancyFence === "shared" ? [sessionTenancyLock(workspaceId)] : [],
    },
    (scoped) => fn(scoped),
    transactionConfig,
  );
}

export async function withWorkspaceSubjectSessionActivityRls<T>(
  db: Database,
  workspaceId: string,
  subjectId: string,
  fn: (db: SessionActivityDatabase) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
  fenceMode: "shared" | "none" = "shared",
  organizationMembershipFence = false,
): Promise<T> {
  if (!subjectId.trim()) {
    throw new Error("withWorkspaceSubjectSessionActivityRls: a non-empty subjectId is required");
  }
  return await withSessionActivityRlsScope(
    db,
    { accountId: null, workspaceId, subjectId },
    fn,
    transactionConfig,
    fenceMode,
    organizationMembershipFence,
  );
}

/** Apply and verify actor-private RLS on an already transaction-pinned handle,
 * in one statement that sets the subject and reads it back. */
export async function setSubjectRlsContext(db: Database, subjectId: string): Promise<void> {
  if (!subjectId.trim()) {
    throw new Error("setSubjectRlsContext: a non-empty subjectId is required");
  }
  const [applied] = await rawRows<{ subject_id: string | null }>(
    db,
    sql`with applied as materialized (
      select set_config('opengeni.subject_id', ${subjectId}::text, true) as subject_id
    ) select current_setting('opengeni.subject_id', true) as subject_id from applied`,
  );
  if ((applied?.subject_id ?? "") !== subjectId) {
    throw new Error("Authenticated subject RLS context was not applied on the active backend");
  }
}

export async function withWorkspaceUsageLock<T>(
  db: Database,
  workspaceId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsScope(
    db,
    {
      accountId: null,
      workspaceId,
      locks: [
        sessionTenancyLock(workspaceId),
        { key: `usage:${workspaceId}`, mode: "exclusive", hash: "text" },
      ],
    },
    (scoped) => fn(scoped),
  );
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
