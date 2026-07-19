import type {
  AccessContext,
  AccessGrant,
  ApiKey,
  BillingBalance,
  CapabilityCatalogItem,
  CapabilityInstallation,
  CapabilityInstallationStatus,
  CapabilityKind,
  CapabilityPack,
  CapabilitySource,
  ConnectionKind,
  ConnectionMetadata,
  ConnectionStatus,
  McpServerConnectionRef,
  FileAsset,
  FileStatus,
  FileUploadStatus,
  KnowledgeMemory,
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  KnowledgeSourceRef,
  ManagedAccount,
  Permission,
  PackInstallation,
  PackInstallationStatus,
  ResourceRef,
  SandboxBackend,
  SandboxOs,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRun,
  ScheduledTaskRunMode,
  ScheduledTaskRunStatus,
  ScheduledTaskScheduleSpec,
  ScheduledTaskStatus,
  ScheduledTaskTriggerType,
  Session,
  SessionListResponse,
  SessionEvent,
  SessionEventType,
  SessionGoal,
  SessionGoalCreatedBy,
  SessionGoalStatus,
  LineageNode,
  SessionMcpServerMetadata,
  SessionStatus,
  SessionTurn,
  SessionQueueSnapshot,
  SessionSystemUpdate,
  SessionSystemUpdateKind,
  SessionSystemUpdateState,
  SystemUpdateClassification,
  SessionTurnSource,
  SessionTurnStatus,
  SocialConnection,
  SocialConnectionStatus,
  SocialPost,
  SocialProvider,
  ToolRef,
  ReasoningEffort,
  UsageEvent,
  Workspace,
  WorkspaceControlEvent,
  VariableSet,
  VariableSetVariableMetadata,
  WorkspaceMember,
  WorkspaceRegisteredPack,
  Rig,
  RigVersion,
  RigVerificationHealth,
  RigChange,
  RigChangeKind,
  RigChangeStatus,
  RigCheck,
  GitCredentialProvider,
  GitCredentialRepositoryRef,
} from "@opengeni/contracts";
import {
  GitCredentialRepositoryRef as GitCredentialRepositoryRefContract,
  reasoningEffortForMetadata,
  resolveWorkspaceMemoryEnabled,
  RigChange as RigChangeContract,
  SessionSystemUpdatePayload,
} from "@opengeni/contracts";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { boundModelToolOutputItem, isCodexBilledModel } from "@opengeni/codex";
// Re-exported so consumers get the whole codex-billed detection surface (the pure
// prefix test + the credential-aware predicates below) from a single import.
export { isCodexBilledModel } from "@opengeni/codex";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  ilike,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgDatabase, PgTransactionConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { isDeepStrictEqual } from "node:util";
import postgres from "postgres";
import { decryptEnvironmentValue } from "./environment-crypto";
import { sanitizeEventPayload, sanitizeModelPayload } from "./event-payload-sanitizer";
import {
  closePendingSessionToolCallsInTransaction,
  historyCallId,
  historyItemType,
  TOOL_RESULT_TYPE_BY_CALL_TYPE,
} from "./session-tool-call-settlement";
import {
  closeSessionTurnAttemptInTransaction,
  evaluateSessionControl,
  evaluateSessionControls,
  lockWorkspaceInferenceControl,
  registerInternalUpdateWakeInTransaction,
  registerSessionTurnAttemptClaim,
  serializeEffectiveSessionControl,
  SessionControlInvariantError,
  type SessionTurnAttemptOutcome,
} from "./session-control";
import * as schema from "./schema";
import {
  AGENT_VISIBLE_MEMORY_STATUSES,
  hashMemoryText,
  isMemoryTextTooLong,
  MEMORY_VISIBLE_RECORD_CAP,
  MEMORY_BLOCK_RECORD_LIMIT,
  MEMORY_TEXT_MAX_CHARS,
  MEMORY_NEAR_DUP_COSINE_THRESHOLD,
  MEMORY_NEAR_DUP_NEIGHBORS,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
  renderWorkspaceMemoryBlock,
  sanitizeMemoryText,
  WORKSPACE_MEMORY_BLOCK_EMPTY,
  type MemoryBlockRecord,
} from "./memory-domain";

export { sql as dbSql } from "drizzle-orm";
export * from "./session-control";
export * from "./session-queue-commands";
export { interruptedToolCallResult } from "./session-tool-call-settlement";
export { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
export {
  decryptEnvironmentValue as decryptVariableSetValue,
  encryptEnvironmentValue as encryptVariableSetValue,
} from "./environment-crypto";
export {
  sanitizeEventPayload,
  sanitizeEventString,
  sanitizeModelPayload,
} from "./event-payload-sanitizer";
export { sanitizeMemoryText } from "./memory-domain";
// Re-exported so external consumers can `import { migrate } from "@opengeni/db"`.
// The `@opengeni/db/migrate` subpath stays available too (internal callers + the
// db:migrate script use it). Re-exporting does NOT run migrate.ts's
// `import.meta.main` block — that only fires when migrate.ts is the entry.
export { migrate, runMigrations } from "./migrate";
// Step I SDK entry points for the embedded topology: a host drives migration +
// role provisioning over an explicit admin connection + target schema. Importing
// these does NOT run the modules' `import.meta.main` CLI blocks.
export {
  provisionRoles,
  type ProvisionResult,
  type ProvisionRolesOptions,
} from "./provision-roles";
// Workspace Memory V1 pure domain surface (gates, render, canonical prompt text).
export * from "./memory-domain";

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

export type DbClient = {
  db: Database;
  close: () => Promise<void>;
};

export type RlsContext = {
  accountId: string;
  workspaceId?: string | null;
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
   * pgvector image) still resolve — the SPIKE-1 live footgun.
   */
  searchPath?: string;
  /** RLS posture; defaults to `"force"` (today's standalone). */
  rlsStrategy?: RlsStrategy;
  /** Host-provided user-by-email resolver; unset → today's raw `auth_users` query. */
  userLookup?: UserLookup;
  /** postgres-js pool size; defaults to today's `10`. */
  max?: number;
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
 * OWN internal raw queries (sandbox-lease reaping, warm-meter reads, group
 * session-id lists) ALWAYS run over the postgres-js handle `createDb` builds,
 * whose `.execute` returns an array of rows — so this helper re-applies that
 * array-of-`T` typing in ONE documented place instead of scattering casts. It is
 * NOT a cross-driver abstraction: a host on a non-array driver must override the
 * specific helper (today only `userLookup`), not call internal raw queries.
 */
async function rawRows<T extends Record<string, unknown>>(
  executor: Pick<Database, "execute">,
  query: SQL,
): Promise<T[]> {
  const result = await executor.execute<T>(query);
  return result as unknown as T[];
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
      application_name: "opengeni",
      ...(options.searchPath ? { search_path: options.searchPath } : {}),
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
}

export async function withRlsContext<T>(
  db: Database,
  context: RlsContext,
  fn: (db: Database) => Promise<T>,
  transactionConfig?: PgTransactionConfig,
): Promise<T> {
  return await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
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
    const applied = await tx.execute<{ account_id: string | null }>(
      sql`select current_setting('opengeni.account_id', true) as account_id`,
    );
    const appliedAccountId = applied[0]?.account_id ?? "";
    if (appliedAccountId !== context.accountId) {
      throw new Error(
        `RLS context not applied on the active backend: expected account ${context.accountId}, got "${appliedAccountId}"`,
      );
    }
    return await fn(scoped);
  }, transactionConfig);
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
): Promise<T> {
  return await withRlsContext(db, await rlsContextForWorkspace(db, workspaceId), fn);
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
      await scopedDb.execute(sql`select set_config('opengeni.subject_id', ${subjectId}, true)`);
      const applied = await scopedDb.execute<{ subject_id: string | null }>(
        sql`select current_setting('opengeni.subject_id', true) as subject_id`,
      );
      if ((applied[0]?.subject_id ?? "") !== subjectId) {
        throw new Error("Authenticated subject RLS context was not applied on the active backend");
      }
      return await fn(scopedDb);
    },
    transactionConfig,
  );
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

export const allWorkspacePermissions: Permission[] = [
  "workspace:read",
  "workspace:admin",
  "members:manage",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "connections:read",
  "connections:write",
  "variable-sets:manage",
  "variable-sets:use",
  "mcp_servers:attach",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
];

export const allAccountPermissions: Permission[] = [
  "account:read",
  "account:admin",
  "members:manage",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "api_keys:manage",
];

export type BootstrapWorkspaceInput = {
  accountExternalSource: string;
  accountExternalId: string;
  accountName: string;
  workspaceExternalSource: string;
  workspaceExternalId: string;
  workspaceName: string;
  subjectId: string;
  subjectLabel?: string;
  accountPermissions?: Permission[];
  workspacePermissions?: Permission[];
};

function samePermissionSet(left: readonly string[], right: readonly Permission[]): boolean {
  return left.length === right.length && right.every((permission) => left.includes(permission));
}

export async function bootstrapWorkspace(
  db: Database,
  input: BootstrapWorkspaceInput,
): Promise<AccessContext> {
  return await db.transaction(async (tx) => {
    let [account] = await tx
      .select()
      .from(schema.managedAccounts)
      .where(
        and(
          eq(schema.managedAccounts.externalSource, input.accountExternalSource),
          eq(schema.managedAccounts.externalId, input.accountExternalId),
        ),
      )
      .limit(1);
    if (!account) {
      [account] = await tx
        .insert(schema.managedAccounts)
        .values({
          name: input.accountName,
          externalSource: input.accountExternalSource,
          externalId: input.accountExternalId,
        })
        .onConflictDoUpdate({
          target: [schema.managedAccounts.externalSource, schema.managedAccounts.externalId],
          set: {
            name: input.accountName,
            updatedAt: new Date(),
          },
        })
        .returning();
    } else if (account.name !== input.accountName) {
      [account] = await tx
        .update(schema.managedAccounts)
        .set({ name: input.accountName, updatedAt: new Date() })
        .where(eq(schema.managedAccounts.id, account.id))
        .returning();
    }
    if (!account) {
      throw new Error("Failed to bootstrap account");
    }
    let [workspace] = await tx
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.externalSource, input.workspaceExternalSource),
          eq(schema.workspaces.externalId, input.workspaceExternalId),
        ),
      )
      .limit(1);
    if (!workspace) {
      [workspace] = await tx
        .insert(schema.workspaces)
        .values({
          accountId: account.id,
          name: input.workspaceName,
          externalSource: input.workspaceExternalSource,
          externalId: input.workspaceExternalId,
        })
        .onConflictDoUpdate({
          target: [schema.workspaces.externalSource, schema.workspaces.externalId],
          set: {
            name: input.workspaceName,
            updatedAt: new Date(),
          },
        })
        .returning();
    } else if (workspace.name !== input.workspaceName) {
      [workspace] = await tx
        .update(schema.workspaces)
        .set({ name: input.workspaceName, updatedAt: new Date() })
        .where(eq(schema.workspaces.id, workspace.id))
        .returning();
    }
    if (!workspace) {
      throw new Error("Failed to bootstrap workspace");
    }
    await setRlsContext(tx as unknown as Database, {
      accountId: workspace.accountId,
      workspaceId: workspace.id,
    });
    const [workspaceControl] = await tx
      .select({ workspaceId: schema.workspaceInferenceControls.workspaceId })
      .from(schema.workspaceInferenceControls)
      .where(eq(schema.workspaceInferenceControls.workspaceId, workspace.id))
      .limit(1);
    if (!workspaceControl) {
      await tx
        .insert(schema.workspaceInferenceControls)
        .values({ workspaceId: workspace.id, accountId: workspace.accountId })
        .onConflictDoNothing();
    }
    const workspacePermissions = input.workspacePermissions ?? allWorkspacePermissions;
    const [membership] = await tx
      .select()
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, workspace.id),
          eq(schema.workspaceMemberships.subjectId, input.subjectId),
        ),
      )
      .limit(1);
    const subjectLabel = input.subjectLabel ?? null;
    if (!membership) {
      await tx
        .insert(schema.workspaceMemberships)
        .values({
          accountId: account.id,
          workspaceId: workspace.id,
          subjectId: input.subjectId,
          subjectLabel,
          role: "owner",
          permissions: workspacePermissions,
        })
        .onConflictDoUpdate({
          target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
          set: {
            subjectLabel,
            role: "owner",
            permissions: workspacePermissions,
            updatedAt: new Date(),
          },
        });
    } else if (
      membership.accountId !== account.id ||
      membership.subjectLabel !== subjectLabel ||
      membership.role !== "owner" ||
      !samePermissionSet(membership.permissions, workspacePermissions)
    ) {
      await tx
        .update(schema.workspaceMemberships)
        .set({
          accountId: account.id,
          subjectLabel,
          role: "owner",
          permissions: workspacePermissions,
          updatedAt: new Date(),
        })
        .where(eq(schema.workspaceMemberships.id, membership.id));
    }
    return {
      mode: input.accountExternalSource === "opengeni:local" ? "local" : "configured",
      subjectId: input.subjectId,
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
      accountGrants: [
        {
          accountId: account.id,
          subjectId: input.subjectId,
          ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
          role: "owner",
          permissions: input.accountPermissions ?? allAccountPermissions,
        },
      ],
      workspaceGrants: [
        {
          workspaceId: workspace.id,
          accountId: account.id,
          subjectId: input.subjectId,
          ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
          permissions: workspacePermissions,
        },
      ],
      defaultAccountId: account.id,
      defaultWorkspaceId: workspace.id,
    };
  });
}

export async function ensureManagedAccessForUser(
  db: Database,
  input: {
    userId: string;
    email: string;
    name: string;
  },
): Promise<AccessContext> {
  const subjectId = `user:${input.userId}`;
  const subjectLabel = input.email || input.name;
  return await db.transaction(async (tx) => {
    const accountName = input.name || input.email;
    let [account] = await tx
      .select()
      .from(schema.managedAccounts)
      .where(
        and(
          eq(schema.managedAccounts.externalSource, "better-auth:user"),
          eq(schema.managedAccounts.externalId, input.userId),
        ),
      )
      .limit(1);
    if (!account) {
      [account] = await tx
        .insert(schema.managedAccounts)
        .values({
          name: accountName,
          externalSource: "better-auth:user",
          externalId: input.userId,
        })
        .onConflictDoUpdate({
          target: [schema.managedAccounts.externalSource, schema.managedAccounts.externalId],
          set: { name: accountName, updatedAt: new Date() },
        })
        .returning();
    } else if (account.name !== accountName) {
      [account] = await tx
        .update(schema.managedAccounts)
        .set({ name: accountName, updatedAt: new Date() })
        .where(eq(schema.managedAccounts.id, account.id))
        .returning();
    }
    if (!account) {
      throw new Error("Failed to ensure managed account");
    }
    let [defaultWorkspace] = await tx
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.externalSource, "better-auth:user"),
          eq(schema.workspaces.externalId, `${input.userId}:default`),
        ),
      )
      .limit(1);
    if (!defaultWorkspace) {
      [defaultWorkspace] = await tx
        .insert(schema.workspaces)
        .values({
          accountId: account.id,
          name: "Default workspace",
          slug: "default",
          externalSource: "better-auth:user",
          externalId: `${input.userId}:default`,
        })
        .onConflictDoUpdate({
          target: [schema.workspaces.externalSource, schema.workspaces.externalId],
          set: { name: "Default workspace", updatedAt: new Date() },
        })
        .returning();
    } else if (defaultWorkspace.name !== "Default workspace") {
      [defaultWorkspace] = await tx
        .update(schema.workspaces)
        .set({ name: "Default workspace", updatedAt: new Date() })
        .where(eq(schema.workspaces.id, defaultWorkspace.id))
        .returning();
    }
    if (!defaultWorkspace) {
      throw new Error("Failed to ensure default workspace");
    }
    await setRlsContext(tx as unknown as Database, {
      accountId: defaultWorkspace.accountId,
      workspaceId: defaultWorkspace.id,
    });
    const [workspaceControl] = await tx
      .select({ workspaceId: schema.workspaceInferenceControls.workspaceId })
      .from(schema.workspaceInferenceControls)
      .where(eq(schema.workspaceInferenceControls.workspaceId, defaultWorkspace.id))
      .limit(1);
    if (!workspaceControl) {
      await tx
        .insert(schema.workspaceInferenceControls)
        .values({ workspaceId: defaultWorkspace.id, accountId: defaultWorkspace.accountId })
        .onConflictDoNothing();
    }
    // The remainder lists every membership in the account, so restore account-
    // scoped RLS after the exact-workspace control-row insert.
    await setRlsContext(tx as unknown as Database, {
      accountId: defaultWorkspace.accountId,
      workspaceId: null,
    });
    const [membership] = await tx
      .select()
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, defaultWorkspace.id),
          eq(schema.workspaceMemberships.subjectId, subjectId),
        ),
      )
      .limit(1);
    if (!membership) {
      await tx
        .insert(schema.workspaceMemberships)
        .values({
          accountId: account.id,
          workspaceId: defaultWorkspace.id,
          subjectId,
          subjectLabel,
          role: "owner",
          permissions: allWorkspacePermissions,
        })
        .onConflictDoUpdate({
          target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
          set: {
            subjectLabel,
            role: "owner",
            permissions: allWorkspacePermissions,
            updatedAt: new Date(),
          },
        });
    } else if (
      membership.accountId !== account.id ||
      membership.subjectLabel !== subjectLabel ||
      membership.role !== "owner" ||
      !samePermissionSet(membership.permissions, allWorkspacePermissions)
    ) {
      await tx
        .update(schema.workspaceMemberships)
        .set({
          accountId: account.id,
          subjectLabel,
          role: "owner",
          permissions: allWorkspacePermissions,
          updatedAt: new Date(),
        })
        .where(eq(schema.workspaceMemberships.id, membership.id));
    }
    const memberships = await tx
      .select({
        membership: schema.workspaceMemberships,
        workspace: schema.workspaces,
      })
      .from(schema.workspaceMemberships)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id),
      )
      .where(eq(schema.workspaceMemberships.subjectId, subjectId))
      .orderBy(desc(schema.workspaces.createdAt));
    return {
      mode: "managed",
      subjectId,
      subjectLabel,
      accountGrants: [
        {
          accountId: account.id,
          subjectId,
          subjectLabel,
          role: "owner",
          permissions: allAccountPermissions,
        },
      ],
      workspaceGrants: memberships.map((row) => ({
        workspaceId: row.workspace.id,
        accountId: row.workspace.accountId,
        subjectId,
        subjectLabel,
        permissions: row.membership.permissions as Permission[],
      })),
      defaultAccountId: account.id,
      defaultWorkspaceId: defaultWorkspace.id,
    };
  });
}

export async function getWorkspace(db: Database, workspaceId: string): Promise<Workspace | null> {
  const [row] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return row ? mapWorkspace(row, await workspaceControlProjection(db, row.id)) : null;
}

export async function getManagedAccount(
  db: Database,
  accountId: string,
): Promise<ManagedAccount | null> {
  const [row] = await db
    .select()
    .from(schema.managedAccounts)
    .where(eq(schema.managedAccounts.id, accountId))
    .limit(1);
  return row ? mapAccount(row) : null;
}

export async function requireWorkspace(db: Database, workspaceId: string): Promise<Workspace> {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

export async function listWorkspacesForSubject(
  db: Database,
  subjectId: string,
  limit = 100,
): Promise<Workspace[]> {
  const rows = await db
    .select({ workspace: schema.workspaces })
    .from(schema.workspaceMemberships)
    .innerJoin(schema.workspaces, eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id))
    .where(eq(schema.workspaceMemberships.subjectId, subjectId))
    .orderBy(desc(schema.workspaces.createdAt))
    .limit(limit);
  return await Promise.all(
    rows.map(async (row) =>
      mapWorkspace(row.workspace, await workspaceControlProjection(db, row.workspace.id)),
    ),
  );
}

export async function countWorkspacesForAccount(db: Database, accountId: string): Promise<number> {
  const [{ count } = { count: 0 }] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.accountId, accountId));
  return Number(count);
}

export async function createWorkspace(
  db: Database,
  input: {
    accountId: string;
    name: string;
    slug?: string | null;
    externalSource?: string | null;
    externalId?: string | null;
    agentInstructions?: string | null;
  },
): Promise<Workspace> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.workspaces)
      .values({
        accountId: input.accountId,
        name: input.name,
        slug: input.slug ?? null,
        externalSource: input.externalSource ?? null,
        externalId: input.externalId ?? null,
        agentInstructions: input.agentInstructions ?? null,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create workspace");
    }
    await setRlsContext(tx as unknown as Database, {
      accountId: row.accountId,
      workspaceId: row.id,
    });
    await tx.insert(schema.workspaceInferenceControls).values({
      workspaceId: row.id,
      accountId: row.accountId,
    });
    return mapWorkspace(row, {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    });
  });
}

export async function grantWorkspaceAccess(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    subjectLabel?: string;
    role?: string;
    permissions: Permission[];
  },
): Promise<void> {
  await db
    .insert(schema.workspaceMemberships)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? null,
      role: input.role ?? "member",
      permissions: input.permissions,
    })
    .onConflictDoUpdate({
      target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
      set: {
        subjectLabel: input.subjectLabel ?? null,
        role: input.role ?? "member",
        permissions: input.permissions,
        updatedAt: new Date(),
      },
    });
}

export async function updateWorkspace(
  db: Database,
  workspaceId: string,
  input: {
    name?: string;
    slug?: string | null;
    agentInstructions?: string | null;
  },
): Promise<Workspace> {
  const [row] = await db
    .update(schema.workspaces)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.agentInstructions !== undefined
        ? { agentInstructions: input.agentInstructions }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaces.id, workspaceId))
    .returning();
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return mapWorkspace(row, await workspaceControlProjection(db, workspaceId));
}

// Deep-merge (top-level) a settings patch into workspaces.settings, atomically.
// jsonb `||` overwrites matching keys and preserves unknown ones, so a newer
// setting a caller doesn't know about survives the write.
export async function updateWorkspaceSettings(
  db: Database,
  workspaceId: string,
  patch: Record<string, unknown>,
): Promise<Workspace> {
  const [row] = await db
    .update(schema.workspaces)
    .set({
      settings: sql`${schema.workspaces.settings} || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaces.id, workspaceId))
    .returning();
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return mapWorkspace(row, await workspaceControlProjection(db, workspaceId));
}

export async function setWorkspaceDefaultRig(
  db: Database,
  workspaceId: string,
  rigId: string | null,
): Promise<Workspace> {
  const [row] = await db
    .update(schema.workspaces)
    .set({
      defaultRigId: rigId,
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaces.id, workspaceId))
    .returning();
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return mapWorkspace(row, await workspaceControlProjection(db, workspaceId));
}

export async function getWorkspaceGrant(
  db: Database,
  subjectId: string,
  workspaceId: string,
): Promise<AccessGrant | null> {
  const [row] = await db
    .select({
      membership: schema.workspaceMemberships,
      workspace: schema.workspaces,
    })
    .from(schema.workspaceMemberships)
    .innerJoin(schema.workspaces, eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id))
    .where(
      and(
        eq(schema.workspaceMemberships.subjectId, subjectId),
        eq(schema.workspaceMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row
    ? {
        workspaceId: row.workspace.id,
        accountId: row.workspace.accountId,
        subjectId: row.membership.subjectId,
        ...(row.membership.subjectLabel ? { subjectLabel: row.membership.subjectLabel } : {}),
        permissions: row.membership.permissions as Permission[],
      }
    : null;
}

export async function listWorkspaceMembers(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceMemberships)
      .where(eq(schema.workspaceMemberships.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceMemberships.createdAt));
    return rows.map(mapWorkspaceMember);
  });
}

export async function removeWorkspaceMember(
  db: Database,
  workspaceId: string,
  subjectId: string,
): Promise<boolean> {
  // A removed principal must not regain stale organization preferences if the
  // same stable subject is invited again later. Set the target subject GUC so
  // FORCE RLS permits deleting only that member's personal rows, and make the
  // cleanup + membership removal one transaction.
  return await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (scopedDb) => {
    // Lock the membership before cleanup so concurrent removals preserve the
    // previous one-winner/one-no-op behavior while snapshots are still visible
    // to the subject-scoped FORCE-RLS policy.
    const [membership] = await scopedDb
      .select({ id: schema.workspaceMemberships.id })
      .from(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, workspaceId),
          eq(schema.workspaceMemberships.subjectId, subjectId),
        ),
      )
      .for("update")
      .limit(1);
    if (!membership) {
      return false;
    }

    await scopedDb
      .delete(schema.sessionListSnapshots)
      .where(
        and(
          eq(schema.sessionListSnapshots.workspaceId, workspaceId),
          eq(schema.sessionListSnapshots.subjectId, subjectId),
        ),
      );
    await scopedDb
      .delete(schema.sessionPins)
      .where(
        and(
          eq(schema.sessionPins.workspaceId, workspaceId),
          eq(schema.sessionPins.subjectId, subjectId),
        ),
      );

    const rows = await scopedDb
      .delete(schema.workspaceMemberships)
      .where(
        and(
          eq(schema.workspaceMemberships.workspaceId, workspaceId),
          eq(schema.workspaceMemberships.subjectId, subjectId),
        ),
      )
      .returning({ id: schema.workspaceMemberships.id });
    return rows.length > 0;
  });
}

/**
 * Resolve a managed user email to its user id.
 *
 * STANDALONE (default, unchanged): the `auth_users` table is owned by Better
 * Auth and is NOT in the Drizzle schema, so this runs the raw parameterized
 * select below — matching emails case-insensitively, returning the id or null.
 *
 * EMBEDDED (Step I `userLookup` port): when the handle was built via
 * `createDb({ userLookup })` (or registered with `registerDbBinding`), this
 * delegates to the host's resolver instead — so a host whose identity lives in
 * a different IdP/table/driver never forces OpenGeni to touch `auth_users`. The
 * raw query also assumes the postgres-js array-shaped `db.execute` result; the
 * port is the cross-driver escape hatch for that too.
 *
 * Used to add an already-registered user to a workspace; email invites for
 * unknown users are deferred.
 */
export async function getManagedUserByEmail(db: Database, email: string): Promise<string | null> {
  const binding = dbBindings.get(db as unknown as object);
  if (binding?.userLookup) {
    return await binding.userLookup(db, email);
  }
  const rows = await db.execute(sql<{ id: string }>`
    select id from auth_users where lower(email) = lower(${email}) limit 1
  `);
  return (rows as unknown as Array<{ id?: string }>)[0]?.id ?? null;
}

export async function deleteWorkspace(db: Database, workspaceId: string): Promise<void> {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
}

export async function createApiKey(
  db: Database,
  input: {
    accountId: string;
    workspaceId?: string | null;
    name: string;
    prefix: string;
    keyHash: string;
    permissions: Permission[];
    expiresAt?: Date | null;
  },
): Promise<ApiKey> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId ?? null },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.apiKeys)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId ?? null,
          name: input.name,
          prefix: input.prefix,
          keyHash: input.keyHash,
          permissions: input.permissions,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create API key");
      }
      return mapApiKey(row);
    },
  );
}

export async function listApiKeys(db: Database, workspaceId: string): Promise<ApiKey[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.workspaceId, workspaceId))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows.map(mapApiKey);
  });
}

export async function countActiveApiKeysForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.workspaceId, workspaceId),
          sql`${schema.apiKeys.revokedAt} is null`,
          sql`(${schema.apiKeys.expiresAt} is null or ${schema.apiKeys.expiresAt} > now())`,
        ),
      );
    return Number(count);
  });
}

export async function revokeApiKey(
  db: Database,
  workspaceId: string,
  apiKeyId: string,
): Promise<ApiKey> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.apiKeys)
      .set({
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.apiKeys.workspaceId, workspaceId), eq(schema.apiKeys.id, apiKeyId)))
      .returning();
    if (!row) {
      throw new Error(`API key not found: ${apiKeyId}`);
    }
    return mapApiKey(row);
  });
}

export async function findActiveApiKeyByHash(
  db: Database,
  keyHash: string,
): Promise<ApiKey | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.api_key_hash', ${keyHash}, true)`);
    const [row] = await tx
      .select()
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.keyHash, keyHash),
          sql`${schema.apiKeys.revokedAt} is null`,
          sql`(${schema.apiKeys.expiresAt} is null or ${schema.apiKeys.expiresAt} > now())`,
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    const now = new Date();
    await tx
      .update(schema.apiKeys)
      .set({ lastUsedAt: now, updatedAt: now })
      .where(eq(schema.apiKeys.id, row.id));
    return mapApiKey({ ...row, lastUsedAt: now });
  });
}

export type GitHubInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function upsertGitHubInstallation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    installationId: number;
    accountLogin?: string | null;
    accountType?: string | null;
  },
): Promise<GitHubInstallation> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.githubInstallations)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          installationId: input.installationId,
          accountLogin: input.accountLogin ?? null,
          accountType: input.accountType ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.githubInstallations.workspaceId,
            schema.githubInstallations.installationId,
          ],
          set: {
            accountId: input.accountId,
            accountLogin: input.accountLogin ?? null,
            accountType: input.accountType ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) {
        throw new Error("Failed to upsert GitHub installation");
      }
      return mapGitHubInstallation(row);
    },
  );
}

export async function listGitHubInstallationsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<GitHubInstallation[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.githubInstallations.updatedAt));
    return rows.map(mapGitHubInstallation);
  });
}

export async function listGitHubInstallationIdsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<number[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({ installationId: schema.githubInstallations.installationId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.githubInstallations.updatedAt));
    return rows.map((row) => row.installationId);
  });
}

export async function recordUsageEvent(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId?: string | null;
    eventType: string;
    quantity: number;
    unit: string;
    sourceResourceType?: string | null;
    sourceResourceId?: string | null;
    idempotencyKey: string;
    occurredAt?: Date;
  },
): Promise<UsageEvent> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.usageEvents)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId ?? null,
          eventType: input.eventType,
          quantity: input.quantity,
          unit: input.unit,
          sourceResourceType: input.sourceResourceType ?? null,
          sourceResourceId: input.sourceResourceId ?? null,
          idempotencyKey: input.idempotencyKey,
          occurredAt: input.occurredAt ?? new Date(),
        })
        .onConflictDoNothing({ target: schema.usageEvents.idempotencyKey })
        .returning();
      if (row) {
        return mapUsageEvent(row);
      }
      const [existing] = await scopedDb
        .select()
        .from(schema.usageEvents)
        .where(eq(schema.usageEvents.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (!existing) {
        throw new Error("Failed to record usage event");
      }
      return mapUsageEvent(existing);
    },
  );
}

export async function listUsageEvents(
  db: Database,
  input: {
    accountId: string;
    workspaceId?: string;
    limit?: number;
  },
): Promise<UsageEvent[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId ?? null },
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.usageEvents)
        .where(
          input.workspaceId
            ? and(
                eq(schema.usageEvents.accountId, input.accountId),
                eq(schema.usageEvents.workspaceId, input.workspaceId),
              )
            : eq(schema.usageEvents.accountId, input.accountId),
        )
        .orderBy(desc(schema.usageEvents.occurredAt), desc(schema.usageEvents.recordedAt))
        .limit(input.limit ?? 100);
      return rows.map(mapUsageEvent);
    },
  );
}

export async function sumUsageQuantity(
  db: Database,
  input: {
    accountId?: string;
    workspaceId?: string;
    eventType: string;
    since?: Date;
  },
): Promise<number> {
  const context = input.workspaceId
    ? await rlsContextForWorkspace(db, input.workspaceId)
    : input.accountId
      ? { accountId: input.accountId, workspaceId: null }
      : null;
  if (!context) {
    throw new Error("Usage quantity queries require accountId or workspaceId");
  }
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.usageEvents.eventType, input.eventType),
      ...(input.accountId ? [eq(schema.usageEvents.accountId, input.accountId)] : []),
      ...(input.workspaceId ? [eq(schema.usageEvents.workspaceId, input.workspaceId)] : []),
      ...(input.since ? [gt(schema.usageEvents.occurredAt, input.since)] : []),
    ];
    const [{ total } = { total: 0 }] = await scopedDb
      .select({
        total: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
      })
      .from(schema.usageEvents)
      .where(and(...clauses));
    return Number(total);
  });
}

export async function applyCreditLedgerEntry(
  db: Database,
  input: {
    accountId: string;
    workspaceId?: string | null;
    type: string;
    amountMicros: number;
    sourceType?: string | null;
    sourceId?: string | null;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<BillingBalance> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId ?? null },
    async (scopedDb) => {
      await scopedDb
        .insert(schema.creditLedgerEntries)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId ?? null,
          type: input.type,
          amountMicros: input.amountMicros,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata ?? {},
          occurredAt: input.occurredAt ?? new Date(),
        })
        .onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey });
      return await getBillingBalance(scopedDb, input.accountId);
    },
  );
}

export async function applyCreditDebitUpToBalance(
  db: Database,
  input: {
    accountId: string;
    workspaceId?: string | null;
    type: string;
    requestedAmountMicros: number;
    sourceType?: string | null;
    sourceId?: string | null;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<{ balance: BillingBalance; debitedMicros: number }> {
  if (input.requestedAmountMicros <= 0) {
    return { balance: await getBillingBalance(db, input.accountId), debitedMicros: 0 };
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId ?? null },
    async (scopedDb) => {
      await scopedDb.execute(sql`select pg_advisory_xact_lock(hashtext(${input.accountId}))`);
      const before = await getBillingBalance(scopedDb, input.accountId);
      const candidateDebitMicros = Math.min(
        input.requestedAmountMicros,
        Math.max(0, before.balanceMicros),
      );
      let debitedMicros = 0;
      if (candidateDebitMicros > 0) {
        const inserted = await scopedDb
          .insert(schema.creditLedgerEntries)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId ?? null,
            type: input.type,
            amountMicros: -candidateDebitMicros,
            sourceType: input.sourceType ?? null,
            sourceId: input.sourceId ?? null,
            idempotencyKey: input.idempotencyKey,
            metadata: {
              ...input.metadata,
              requestedAmountMicros: input.requestedAmountMicros,
              debitedMicros: candidateDebitMicros,
            },
            occurredAt: input.occurredAt ?? new Date(),
          })
          .onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey })
          .returning({ id: schema.creditLedgerEntries.id });
        debitedMicros = inserted.length === 1 ? candidateDebitMicros : 0;
      }
      return { balance: await getBillingBalance(scopedDb, input.accountId), debitedMicros };
    },
  );
}

export async function hasCreditLedgerEntry(
  db: Database,
  accountId: string,
  idempotencyKey: string,
): Promise<boolean> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ id: schema.creditLedgerEntries.id })
      .from(schema.creditLedgerEntries)
      .where(
        and(
          eq(schema.creditLedgerEntries.accountId, accountId),
          eq(schema.creditLedgerEntries.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

export async function getBillingCustomer(
  db: Database,
  accountId: string,
  provider = "stripe",
): Promise<{
  accountId: string;
  provider: string;
  providerCustomerId: string;
  email: string | null;
} | null> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.billingCustomers)
      .where(
        and(
          eq(schema.billingCustomers.accountId, accountId),
          eq(schema.billingCustomers.provider, provider),
        ),
      )
      .limit(1);
    return row
      ? {
          accountId: row.accountId,
          provider: row.provider,
          providerCustomerId: row.providerCustomerId,
          email: row.email,
        }
      : null;
  });
}

export async function upsertBillingCustomer(
  db: Database,
  input: {
    accountId: string;
    provider?: string;
    providerCustomerId: string;
    email?: string | null;
  },
): Promise<void> {
  await withAccountRls(db, input.accountId, async (scopedDb) => {
    await scopedDb
      .insert(schema.billingCustomers)
      .values({
        accountId: input.accountId,
        provider: input.provider ?? "stripe",
        providerCustomerId: input.providerCustomerId,
        email: input.email ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.billingCustomers.accountId, schema.billingCustomers.provider],
        set: {
          providerCustomerId: input.providerCustomerId,
          email: input.email ?? null,
          updatedAt: new Date(),
        },
      });
  });
}

export async function recordStripeWebhookEvent(
  db: Database,
  input: {
    id: string;
    type: string;
    livemode: boolean;
    payload: unknown;
  },
): Promise<boolean> {
  const [row] = await db
    .insert(schema.stripeWebhookEvents)
    .values({
      id: input.id,
      type: input.type,
      livemode: String(input.livemode),
      payload: input.payload,
    })
    .onConflictDoNothing({ target: schema.stripeWebhookEvents.id })
    .returning({ id: schema.stripeWebhookEvents.id });
  return Boolean(row);
}

export async function isStripeWebhookProcessed(db: Database, id: string): Promise<boolean> {
  const [row] = await db
    .select({ processedAt: schema.stripeWebhookEvents.processedAt })
    .from(schema.stripeWebhookEvents)
    .where(eq(schema.stripeWebhookEvents.id, id))
    .limit(1);
  return Boolean(row?.processedAt);
}

export async function markStripeWebhookProcessed(db: Database, id: string): Promise<void> {
  await db
    .update(schema.stripeWebhookEvents)
    .set({ processedAt: new Date() })
    .where(eq(schema.stripeWebhookEvents.id, id));
}

export async function getBillingBalance(db: Database, accountId: string): Promise<BillingBalance> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [{ balance } = { balance: 0 }] = await scopedDb
      .select({
        balance: sql<number>`coalesce(sum(${schema.creditLedgerEntries.amountMicros}), 0)`,
      })
      .from(schema.creditLedgerEntries)
      .where(eq(schema.creditLedgerEntries.accountId, accountId));
    return {
      accountId,
      balanceMicros: Number(balance),
      currency: "usd",
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function countScheduledTasksForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.workspaceId, workspaceId));
    return Number(count);
  });
}

export type AppendEventInput = {
  type: SessionEventType;
  payload?: unknown;
  clientEventId?: string;
  turnId?: string | null;
  turnGeneration?: number | null;
  turnAttemptId?: string | null;
  turnAssociation?: "current" | "late_rejected" | "duplicate" | null;
  duplicateOfEventId?: string | null;
  duplicateReason?: string | null;
  producerId?: string;
  producerSeq?: number;
  occurredAt?: Date;
};

export type CreateScheduledTaskInput = {
  id?: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  variableSetId?: string | null;
  // The rig each run binds to (M3); active version resolved per fire at dispatch.
  rigId?: string | null;
  rigDefaultVariableSetsAuthorized?: boolean;
  metadata: Record<string, unknown>;
};

export type UpdateScheduledTaskInput = Partial<{
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  variableSetId: string | null;
  rigId: string | null;
  rigDefaultVariableSetsAuthorized: boolean;
  metadata: Record<string, unknown>;
}>;

export type CreatePackInstallationInput = {
  accountId: string;
  workspaceId: string;
  packId: string;
  metadata?: Record<string, unknown>;
};

export type RegisterWorkspacePackInput = {
  accountId: string;
  workspaceId: string;
  pack: CapabilityPack;
};

export type CreateKnowledgeMemoryInput = {
  accountId: string;
  workspaceId: string;
  status?: KnowledgeMemoryStatus | undefined;
  kind?: KnowledgeMemoryKind | undefined;
  scope?: string | undefined;
  text: string;
  sourceRefs?: KnowledgeSourceRef[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdBySessionId?: string | null | undefined;
};

export type UpdateKnowledgeMemoryInput = {
  status?: KnowledgeMemoryStatus | undefined;
  kind?: KnowledgeMemoryKind | undefined;
  scope?: string | undefined;
  text?: string | undefined;
  sourceRefs?: KnowledgeSourceRef[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  reviewedBy?: string | null | undefined;
  pinned?: boolean | undefined;
};

export type ListKnowledgeMemoryOptions = {
  query?: string | undefined;
  status?: KnowledgeMemoryStatus | KnowledgeMemoryStatus[] | undefined;
  kind?: KnowledgeMemoryKind | undefined;
  scope?: string | undefined;
  limit?: number | undefined;
};

export type CreateSocialConnectionInput = {
  accountId: string;
  workspaceId: string;
  provider: SocialProvider;
  accountHandle: string;
  accountName?: string | null;
  externalAccountId?: string | null;
  status: SocialConnectionStatus;
  scopes?: string[];
  credentialRef?: string | null;
  tokenMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CreateSocialPostInput = {
  accountId: string;
  workspaceId: string;
  connectionId: string;
  externalPostId?: string | null;
  url?: string | null;
  authorHandle?: string | null;
  text: string;
  publishedAt: Date;
  metrics?: Record<string, number>;
  raw?: Record<string, unknown>;
};

export type CreateConnectionInput = {
  accountId: string;
  workspaceId: string;
  subjectId?: string | null;
  providerDomain: string;
  kind: ConnectionKind;
  status?: ConnectionStatus;
  credentialEncrypted: string;
  grantedScopes?: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdBySubjectId?: string | null;
  updatedBySubjectId?: string | null;
};

export type UpdateConnectionInput = {
  workspaceId: string;
  connectionId: string;
  visibleToSubjectId?: string | null;
  expectedVersion?: number | undefined;
  subjectId?: string | null;
  providerDomain?: string;
  kind?: ConnectionKind;
  status?: ConnectionStatus;
  credentialEncrypted?: string;
  grantedScopes?: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  updatedBySubjectId?: string | null;
};

export type ConnectionCredentialForBroker = {
  id: string;
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  providerDomain: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  credential: Record<string, unknown>;
  grantedScopes: string[];
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  version: number;
  metadata: Record<string, unknown>;
};

export type IntegrationOAuthClientForUse = {
  id: string;
  issuer: string;
  authorizationServer: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpointAuthMethod: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredIntegrationOAuthClient = {
  id: string;
  issuer: string;
  authorizationServer: string;
  clientId: string;
  clientSecretEncrypted: string | null;
  tokenEndpointAuthMethod: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type StoreIntegrationOAuthClientInput = {
  issuer: string;
  authorizationServer: string;
  clientId: string;
  clientSecretEncrypted?: string | null;
  tokenEndpointAuthMethod?: string;
  metadata?: Record<string, unknown>;
};

export type ReplaceIntegrationOAuthClientInput = StoreIntegrationOAuthClientInput;

export type ConsumeOAuthStateNonceInput = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  nonce: string;
  expiresAt: Date;
  now: Date;
};

export type CreateCapabilityCatalogItemInput = {
  accountId: string;
  workspaceId: string;
  id: string;
  kind: Exclude<CapabilityKind, "pack">;
  source: CapabilitySource;
  name: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  homepageUrl?: string | null;
  endpointUrl?: string | null;
  installUrl?: string | null;
  authModel?: string | null;
  metadata?: Record<string, unknown>;
};

export type ImportBatch = {
  id: string;
  source: string;
  snapshotDate: string;
  snapshotRef: string | null;
  attributionNote: string;
  importedCount: number;
  skippedCount: number;
  quarantinedCount: number;
  logoFailureCount: number;
  staleCount: number;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateImportBatchInput = {
  source: string;
  snapshotDate: Date;
  snapshotRef?: string | null;
  attributionNote: string;
  importedCount?: number;
  skippedCount?: number;
  quarantinedCount?: number;
  logoFailureCount?: number;
  staleCount?: number;
  details?: Record<string, unknown>;
};

export type UpdateImportBatchCountsInput = {
  importedCount: number;
  skippedCount: number;
  quarantinedCount: number;
  logoFailureCount: number;
  staleCount: number;
  details?: Record<string, unknown>;
};

export type RegistryCapabilityCatalogItemInput = {
  id: string;
  providerDomain: string;
  name: string;
  description?: string | null;
  mcpUrl: string;
  transport: string;
  authKind: "oauth2" | "api_key" | "none" | "unknown";
  credentialFacts: Array<Record<string, unknown>>;
  tier: "verified" | "community";
  provenance: string;
  logoAssetPath?: string | null;
  importBatchId: string;
  scopesHint?: string[];
  homepageUrl?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type RegistryCatalogSurfaceKey = {
  id: string;
  providerDomain: string;
  mcpUrl: string;
};

export type EnableCapabilityInstallationInput = {
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  kind: CapabilityKind;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type EnabledMcpCapabilityServer = {
  capabilityId: string;
  id: string;
  name: string;
  url: string;
  allowedTools?: string[];
  timeoutMs?: number;
  cacheToolsList?: boolean;
  /**
   * Credential request headers stored encrypted at enable time
   * (AES-256-GCM under the workspace-variableSets key). Decrypted only at
   * the runtime boundary that builds the MCP client; never exposed by the
   * capability API surface.
   */
  headersEncrypted?: Record<string, string>;
  connectionRef?: McpServerConnectionRef;
};

export type CreateSessionMcpServerInput = {
  id: string;
  name?: string | null;
  url: string;
  allowedTools?: string[] | null;
  timeoutMs?: number | null;
  cacheToolsList?: boolean | null;
  requireApproval?: boolean | string[] | null;
  headersEncrypted?: Record<string, string>;
};

export type UpdateSessionMcpServerCredentialsInput = {
  id: string;
  headersEncrypted: Record<string, string>;
};

export type UpdateSessionMcpServerCredentialsResult = {
  servers: SessionMcpServerMetadata[];
  missingIds: string[];
};

export type SessionMcpServerForRun = SessionMcpServerMetadata & {
  allowedTools?: string[];
  timeoutMs?: number;
  cacheToolsList?: boolean;
  requireApproval?: boolean | string[];
  headers: Record<string, string>;
};

export type EnqueueSessionTurnInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  source: SessionTurnSource;
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  sandboxOs?: SandboxOs | null;
  metadata: Record<string, unknown>;
  lineage?: Record<string, unknown>;
  /** Steer inserts before all waiting prompts; Send appends after them. */
  placement?: "head" | "tail";
};

export async function createFileUpload(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    fileId: string;
    filename: string;
    safeFilename: string;
    contentType: string;
    sizeBytes: number;
    sha256?: string | null;
    bucket: string;
    objectKey: string;
    expiresAt: Date;
  },
): Promise<{ file: FileAsset; uploadId: string; expiresAt: string }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [fileRow] = await tx
          .insert(schema.files)
          .values({
            id: input.fileId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            filename: input.filename,
            safeFilename: input.safeFilename,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256 ?? null,
            bucket: input.bucket,
            objectKey: input.objectKey,
            status: "pending_upload",
          })
          .returning();
        if (!fileRow) {
          throw new Error("Failed to create file");
        }
        const [uploadRow] = await tx
          .insert(schema.fileUploads)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            fileId: fileRow.id,
            status: "pending",
            expiresAt: input.expiresAt,
          })
          .returning({ id: schema.fileUploads.id, expiresAt: schema.fileUploads.expiresAt });
        if (!uploadRow) {
          throw new Error("Failed to create file upload");
        }
        return {
          file: mapFile(fileRow),
          uploadId: uploadRow.id,
          expiresAt: uploadRow.expiresAt.toISOString(),
        };
      }),
  );
}

export async function getFile(
  db: Database,
  workspaceId: string,
  fileId: string,
): Promise<FileAsset | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, fileId)))
      .limit(1);
    return row ? mapFile(row) : null;
  });
}

export async function requireFile(
  db: Database,
  workspaceId: string,
  fileId: string,
): Promise<FileAsset> {
  const file = await getFile(db, workspaceId, fileId);
  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }
  return file;
}

export async function getFileUpload(
  db: Database,
  workspaceId: string,
  uploadId: string,
): Promise<{ id: string; status: FileUploadStatus; expiresAt: Date; file: FileAsset } | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        id: schema.fileUploads.id,
        status: schema.fileUploads.status,
        expiresAt: schema.fileUploads.expiresAt,
        file: schema.files,
      })
      .from(schema.fileUploads)
      .innerJoin(schema.files, eq(schema.fileUploads.fileId, schema.files.id))
      .where(
        and(eq(schema.fileUploads.workspaceId, workspaceId), eq(schema.fileUploads.id, uploadId)),
      )
      .limit(1);
    return row
      ? {
          id: row.id,
          status: row.status as FileUploadStatus,
          expiresAt: row.expiresAt,
          file: mapFile(row.file),
        }
      : null;
  });
}

export async function completeFileUpload(
  db: Database,
  workspaceId: string,
  uploadId: string,
): Promise<FileAsset> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [uploadRow] = await tx
          .select()
          .from(schema.fileUploads)
          .where(
            and(
              eq(schema.fileUploads.workspaceId, workspaceId),
              eq(schema.fileUploads.id, uploadId),
            ),
          )
          .for("update")
          .limit(1);
        if (!uploadRow) {
          throw new Error(`File upload not found: ${uploadId}`);
        }
        const [fileRow] = await tx
          .select()
          .from(schema.files)
          .where(
            and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, uploadRow.fileId)),
          )
          .for("update")
          .limit(1);
        if (!fileRow) {
          throw new Error(`File not found for upload: ${uploadId}`);
        }
        // The API route normally handles this fast path, but the second half of
        // a concurrent finalize race can enter this transaction after the first
        // caller committed. Locking makes the retry return the original ready
        // asset rather than writing a second transition or failing a client that
        // never received the first response.
        if (uploadRow.status === "completed" && fileRow.status === "ready") {
          return mapFile(fileRow);
        }
        if (uploadRow.status !== "pending") {
          throw new Error(`File upload is ${uploadRow.status}: ${uploadId}`);
        }
        const now = new Date();
        const [updatedFile] = await tx
          .update(schema.files)
          .set({
            status: "ready",
            updatedAt: now,
          })
          .where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, fileRow.id)))
          .returning();
        await tx
          .update(schema.fileUploads)
          .set({
            status: "completed",
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.fileUploads.workspaceId, workspaceId),
              eq(schema.fileUploads.id, uploadId),
            ),
          );
        if (!updatedFile) {
          throw new Error("Failed to complete file upload");
        }
        return mapFile(updatedFile);
      }),
  );
}

export async function markFileUploadFailed(
  db: Database,
  workspaceId: string,
  uploadId: string,
  fileId: string,
  uploadStatus: "failed" | "expired" = "failed",
): Promise<void> {
  const now = new Date();
  await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx
          .update(schema.fileUploads)
          .set({ status: uploadStatus, updatedAt: now })
          .where(
            and(
              eq(schema.fileUploads.workspaceId, workspaceId),
              eq(schema.fileUploads.id, uploadId),
            ),
          );
        await tx
          .update(schema.files)
          .set({ status: "failed", updatedAt: now })
          .where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, fileId)));
      }),
  );
}

export type FileUploadCleanupClaimResult =
  | { outcome: "claimed" }
  | { outcome: "completed"; file: FileAsset }
  | { outcome: "unavailable"; status: FileUploadStatus };

/**
 * Atomically fence a pending direct upload before deleting its provider object.
 * The lock order intentionally matches completeFileUpload (upload, then file),
 * so cleanup and finalize cannot leave a ready row pointing at a deleted key.
 */
export async function claimFileUploadCleanup(
  db: Database,
  input: {
    workspaceId: string;
    uploadId: string;
    fileId: string;
  },
): Promise<FileUploadCleanupClaimResult> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [upload] = await tx
          .select({ status: schema.fileUploads.status, fileId: schema.fileUploads.fileId })
          .from(schema.fileUploads)
          .where(
            and(
              eq(schema.fileUploads.workspaceId, input.workspaceId),
              eq(schema.fileUploads.id, input.uploadId),
            ),
          )
          .for("update")
          .limit(1);
        if (!upload || upload.fileId !== input.fileId) {
          return { outcome: "unavailable", status: "failed" };
        }
        const [file] = await tx
          .select()
          .from(schema.files)
          .where(
            and(eq(schema.files.workspaceId, input.workspaceId), eq(schema.files.id, input.fileId)),
          )
          .for("update")
          .limit(1);
        if (!file) {
          return { outcome: "unavailable", status: upload.status as FileUploadStatus };
        }
        if (upload.status === "completed" && file.status === "ready") {
          return { outcome: "completed", file: mapFile(file) };
        }
        if (upload.status !== "pending") {
          return { outcome: "unavailable", status: upload.status as FileUploadStatus };
        }
        const now = new Date();
        await tx
          .update(schema.fileUploads)
          .set({ status: "cleanup_pending", updatedAt: now })
          .where(
            and(
              eq(schema.fileUploads.workspaceId, input.workspaceId),
              eq(schema.fileUploads.id, input.uploadId),
              eq(schema.fileUploads.status, "pending"),
            ),
          );
        await tx
          .update(schema.files)
          .set({ status: "failed", updatedAt: now })
          .where(
            and(eq(schema.files.workspaceId, input.workspaceId), eq(schema.files.id, input.fileId)),
          );
        return { outcome: "claimed" };
      }),
  );
}

export type ExpiredFileUploadCleanupClaim = {
  uploadId: string;
  accountId: string;
  workspaceId: string;
  fileId: string;
  objectKey: string;
};

/**
 * Claim a bounded cross-workspace batch of expired direct uploads for object
 * cleanup. The SECURITY DEFINER function is the sole FORCE-RLS bypass and
 * atomically moves each row to `cleanup_pending` under `FOR UPDATE SKIP
 * LOCKED`. A worker crash or provider-delete failure leaves the claim
 * reclaimable after `claimTimeoutMs`; object deletes are idempotent.
 */
export async function claimExpiredFileUploadCleanup(
  db: Database,
  input: {
    graceMs: number;
    claimTimeoutMs: number;
    limit: number;
  },
): Promise<ExpiredFileUploadCleanupClaim[]> {
  const rows = await rawRows<{
    upload_id: string;
    account_id: string;
    workspace_id: string;
    file_id: string;
    object_key: string;
  }>(
    db,
    sql`
      select upload_id, account_id, workspace_id, file_id, object_key
      from opengeni_private.claim_expired_file_upload_cleanup(
        ${input.graceMs},
        ${input.claimTimeoutMs},
        ${input.limit}
      )
    `,
  );
  return rows.map((row) => ({
    uploadId: row.upload_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    fileId: row.file_id,
    objectKey: row.object_key,
  }));
}

/** Settle one successfully deleted cleanup claim. Idempotent on its terminal state. */
export async function completeFileUploadCleanup(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    uploadId: string;
    fileId: string;
    terminalStatus: "failed" | "expired";
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [upload] = await tx
          .select({ status: schema.fileUploads.status, fileId: schema.fileUploads.fileId })
          .from(schema.fileUploads)
          .where(
            and(
              eq(schema.fileUploads.workspaceId, input.workspaceId),
              eq(schema.fileUploads.id, input.uploadId),
            ),
          )
          .for("update")
          .limit(1);
        if (!upload || upload.fileId !== input.fileId) {
          return false;
        }
        if (upload.status === input.terminalStatus) {
          return true;
        }
        if (upload.status !== "cleanup_pending") {
          return false;
        }
        const now = new Date();
        const settled = await tx
          .update(schema.fileUploads)
          .set({ status: input.terminalStatus, updatedAt: now })
          .where(
            and(
              eq(schema.fileUploads.workspaceId, input.workspaceId),
              eq(schema.fileUploads.id, input.uploadId),
              eq(schema.fileUploads.status, "cleanup_pending"),
            ),
          )
          .returning({ id: schema.fileUploads.id });
        if (settled.length === 0) {
          return false;
        }
        await tx
          .update(schema.files)
          .set({ status: "failed", updatedAt: now })
          .where(
            and(eq(schema.files.workspaceId, input.workspaceId), eq(schema.files.id, input.fileId)),
          );
        return true;
      }),
  );
}

/** Settle one successfully deleted global expiry-reaper claim. */
export async function completeExpiredFileUploadCleanup(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    uploadId: string;
    fileId: string;
  },
): Promise<boolean> {
  return await completeFileUploadCleanup(db, { ...input, terminalStatus: "expired" });
}

export async function enablePackInstallation(
  db: Database,
  input: CreatePackInstallationInput,
): Promise<PackInstallation> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      const existing = await getPackInstallation(scopedDb, input.workspaceId, input.packId);
      if (existing) {
        const [row] = await scopedDb
          .update(schema.packInstallations)
          .set({
            status: "active",
            metadata: input.metadata ?? existing.metadata,
            enabledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.packId, input.packId),
            ),
          )
          .returning();
        if (!row) {
          throw new Error(`Pack installation not found: ${input.packId}`);
        }
        return mapPackInstallation(row);
      }
      const [row] = await scopedDb
        .insert(schema.packInstallations)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          packId: input.packId,
          status: "active",
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) {
        throw new Error("Failed to enable pack installation");
      }
      return mapPackInstallation(row);
    },
  );
}

export async function listPackInstallations(
  db: Database,
  workspaceId: string,
): Promise<PackInstallation[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.packInstallations)
      .where(eq(schema.packInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.packInstallations.updatedAt));
    return rows.map(mapPackInstallation);
  });
}

export async function getPackInstallation(
  db: Database,
  workspaceId: string,
  packId: string,
): Promise<PackInstallation | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.packInstallations)
      .where(
        and(
          eq(schema.packInstallations.workspaceId, workspaceId),
          eq(schema.packInstallations.packId, packId),
        ),
      )
      .limit(1);
    return row ? mapPackInstallation(row) : null;
  });
}

export async function updatePackInstallationStatus(
  db: Database,
  workspaceId: string,
  packId: string,
  status: PackInstallationStatus,
): Promise<PackInstallation> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.packInstallations)
      .set({
        status,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.packInstallations.workspaceId, workspaceId),
          eq(schema.packInstallations.packId, packId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Pack installation not found: ${packId}`);
    }
    return mapPackInstallation(row);
  });
}

export async function registerWorkspacePack(
  db: Database,
  input: RegisterWorkspacePackInput,
): Promise<{ pack: WorkspaceRegisteredPack; created: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      const [row] = await scopedDb
        .insert(schema.workspacePacks)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          packId: input.pack.id,
          manifest: input.pack as unknown as Record<string, unknown>,
        })
        .onConflictDoUpdate({
          target: [schema.workspacePacks.workspaceId, schema.workspacePacks.packId],
          set: {
            manifest: input.pack as unknown as Record<string, unknown>,
            updatedAt: now,
          },
        })
        .returning();
      if (!row) {
        throw new Error("Failed to register workspace pack");
      }
      return {
        pack: mapWorkspacePack(row),
        created: row.createdAt.getTime() === row.updatedAt.getTime(),
      };
    },
  );
}

export async function listWorkspacePacks(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceRegisteredPack[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspacePacks)
      .where(eq(schema.workspacePacks.workspaceId, workspaceId))
      .orderBy(asc(schema.workspacePacks.packId));
    return rows.map(mapWorkspacePack);
  });
}

export async function getWorkspacePack(
  db: Database,
  workspaceId: string,
  packId: string,
): Promise<WorkspaceRegisteredPack | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspacePacks)
      .where(
        and(
          eq(schema.workspacePacks.workspaceId, workspaceId),
          eq(schema.workspacePacks.packId, packId),
        ),
      )
      .limit(1);
    return row ? mapWorkspacePack(row) : null;
  });
}

export async function deleteWorkspacePack(
  db: Database,
  workspaceId: string,
  packId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.workspacePacks)
      .where(
        and(
          eq(schema.workspacePacks.workspaceId, workspaceId),
          eq(schema.workspacePacks.packId, packId),
        ),
      )
      .returning({ id: schema.workspacePacks.id });
    return rows.length > 0;
  });
}

const registryCapabilitySource = "registry" as CapabilitySource;

export async function createImportBatch(
  db: Database,
  input: CreateImportBatchInput,
): Promise<ImportBatch> {
  const [row] = await db
    .insert(schema.importBatches)
    .values({
      source: input.source,
      snapshotDate: input.snapshotDate,
      snapshotRef: input.snapshotRef ?? null,
      attributionNote: input.attributionNote,
      importedCount: input.importedCount ?? 0,
      skippedCount: input.skippedCount ?? 0,
      quarantinedCount: input.quarantinedCount ?? 0,
      logoFailureCount: input.logoFailureCount ?? 0,
      staleCount: input.staleCount ?? 0,
      details: input.details ?? {},
    })
    .returning();
  if (!row) {
    throw new Error("Failed to create import batch");
  }
  return mapImportBatch(row);
}

export async function updateImportBatchCounts(
  db: Database,
  id: string,
  input: UpdateImportBatchCountsInput,
): Promise<ImportBatch> {
  const [row] = await db
    .update(schema.importBatches)
    .set({
      importedCount: input.importedCount,
      skippedCount: input.skippedCount,
      quarantinedCount: input.quarantinedCount,
      logoFailureCount: input.logoFailureCount,
      staleCount: input.staleCount,
      ...(input.details ? { details: input.details } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.importBatches.id, id))
    .returning();
  if (!row) {
    throw new Error(`Import batch not found: ${id}`);
  }
  return mapImportBatch(row);
}

export async function upsertRegistryCapabilityCatalogItem(
  db: Database,
  input: RegistryCapabilityCatalogItemInput,
): Promise<CapabilityCatalogItem> {
  const now = new Date();
  const metadata = {
    registry: "integrations.sh",
    providerDomain: input.providerDomain,
    scopesHint: input.scopesHint ?? [],
    ...input.metadata,
  };
  const values = {
    id: input.id,
    accountId: null,
    workspaceId: null,
    kind: "mcp" as Exclude<CapabilityKind, "pack">,
    source: registryCapabilitySource,
    name: input.name,
    description: input.description ?? null,
    category: "integrations",
    tags: input.tags ?? ["mcp", "integration", input.tier],
    homepageUrl: input.homepageUrl ?? `https://${input.providerDomain}`,
    endpointUrl: input.mcpUrl,
    installUrl: input.homepageUrl ?? `https://${input.providerDomain}`,
    authModel: input.authKind === "none" ? null : "credential_ref",
    providerDomain: input.providerDomain,
    surfaceType: "mcp",
    transport: input.transport,
    mcpUrl: input.mcpUrl,
    authKind: input.authKind,
    credentialFacts: input.credentialFacts,
    tier: input.tier,
    provenance: input.provenance,
    logoAssetPath: input.logoAssetPath ?? null,
    importBatchId: input.importBatchId,
    stale: false,
    staleAt: null,
    metadata,
    updatedAt: now,
  };
  const updateValues = {
    id: values.id,
    kind: values.kind,
    name: values.name,
    description: values.description,
    category: values.category,
    tags: values.tags,
    homepageUrl: values.homepageUrl,
    endpointUrl: values.endpointUrl,
    installUrl: values.installUrl,
    authModel: values.authModel,
    surfaceType: values.surfaceType,
    transport: values.transport,
    authKind: values.authKind,
    credentialFacts: values.credentialFacts,
    tier: values.tier,
    provenance: values.provenance,
    logoAssetPath: sql`coalesce(excluded.logo_asset_path, ${schema.capabilityCatalogItems.logoAssetPath})`,
    importBatchId: values.importBatchId,
    stale: false,
    staleAt: null,
    metadata: values.metadata,
    updatedAt: values.updatedAt,
  };
  const [row] = await db
    .insert(schema.capabilityCatalogItems)
    .values(values)
    .onConflictDoUpdate({
      target: [
        schema.capabilityCatalogItems.source,
        schema.capabilityCatalogItems.providerDomain,
        schema.capabilityCatalogItems.mcpUrl,
      ],
      set: updateValues,
    })
    .returning();
  if (!row) {
    throw new Error("Failed to upsert registry capability catalog item");
  }
  return mapCapabilityCatalogItem(row);
}

export async function listRegistryCatalogSurfaceKeys(
  db: Database,
): Promise<RegistryCatalogSurfaceKey[]> {
  const rows = await db
    .select({
      id: schema.capabilityCatalogItems.id,
      providerDomain: schema.capabilityCatalogItems.providerDomain,
      mcpUrl: schema.capabilityCatalogItems.mcpUrl,
    })
    .from(schema.capabilityCatalogItems)
    .where(eq(schema.capabilityCatalogItems.source, registryCapabilitySource));
  return rows.flatMap((row) =>
    row.providerDomain && row.mcpUrl
      ? [{ id: row.id, providerDomain: row.providerDomain, mcpUrl: row.mcpUrl }]
      : [],
  );
}

export async function markStaleRegistryCatalogItems(
  db: Database,
  activeKeys: Iterable<{ providerDomain: string; mcpUrl: string }>,
  importBatchId: string,
): Promise<number> {
  const active = new Set([...activeKeys].map((key) => `${key.providerDomain}\n${key.mcpUrl}`));
  const existing = await listRegistryCatalogSurfaceKeys(db);
  const stale = existing.filter((row) => !active.has(`${row.providerDomain}\n${row.mcpUrl}`));
  if (stale.length === 0) {
    return 0;
  }
  const now = new Date();
  const updated = await db
    .update(schema.capabilityCatalogItems)
    .set({
      stale: true,
      staleAt: now,
      importBatchId,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.capabilityCatalogItems.source, registryCapabilitySource),
        inArray(
          schema.capabilityCatalogItems.id,
          stale.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: schema.capabilityCatalogItems.id });
  return updated.length;
}

export async function upsertCapabilityCatalogItem(
  db: Database,
  input: CreateCapabilityCatalogItemInput,
): Promise<CapabilityCatalogItem> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      const values = {
        id: input.id,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        source: input.source,
        name: input.name,
        description: input.description ?? null,
        category: input.category ?? "custom",
        tags: input.tags ?? [],
        homepageUrl: input.homepageUrl ?? null,
        endpointUrl: input.endpointUrl ?? null,
        installUrl: input.installUrl ?? null,
        authModel: input.authModel ?? null,
        providerDomain: null,
        surfaceType: null,
        transport: null,
        mcpUrl: null,
        authKind: null,
        credentialFacts: [],
        tier: null,
        provenance: null,
        logoAssetPath: null,
        importBatchId: null,
        stale: false,
        staleAt: null,
        metadata: input.metadata ?? {},
        updatedAt: now,
      };
      const updateValues = {
        kind: values.kind,
        source: values.source,
        name: values.name,
        description: values.description,
        category: values.category,
        tags: values.tags,
        homepageUrl: values.homepageUrl,
        endpointUrl: values.endpointUrl,
        installUrl: values.installUrl,
        authModel: values.authModel,
        providerDomain: values.providerDomain,
        surfaceType: values.surfaceType,
        transport: values.transport,
        mcpUrl: values.mcpUrl,
        authKind: values.authKind,
        credentialFacts: values.credentialFacts,
        tier: values.tier,
        provenance: values.provenance,
        logoAssetPath: values.logoAssetPath,
        importBatchId: values.importBatchId,
        stale: values.stale,
        staleAt: values.staleAt,
        metadata: values.metadata,
        updatedAt: values.updatedAt,
      };
      const [row] = await scopedDb
        .insert(schema.capabilityCatalogItems)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.capabilityCatalogItems.workspaceId, schema.capabilityCatalogItems.id],
          set: updateValues,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to upsert capability catalog item");
      }
      return mapCapabilityCatalogItem(row);
    },
  );
}

export async function listCapabilityCatalogItems(
  db: Database,
  workspaceId: string,
): Promise<CapabilityCatalogItem[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.capabilityCatalogItems)
      .where(
        or(
          eq(schema.capabilityCatalogItems.workspaceId, workspaceId),
          and(
            isNull(schema.capabilityCatalogItems.workspaceId),
            or(
              ne(schema.capabilityCatalogItems.source, registryCapabilitySource),
              eq(schema.capabilityCatalogItems.stale, false),
            ),
          ),
        ),
      )
      .orderBy(asc(schema.capabilityCatalogItems.kind), asc(schema.capabilityCatalogItems.name));
    return rows.map(mapCapabilityCatalogItem);
  });
}

export async function getCapabilityCatalogItem(
  db: Database,
  workspaceId: string,
  capabilityId: string,
): Promise<CapabilityCatalogItem | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.capabilityCatalogItems)
      .where(
        and(
          eq(schema.capabilityCatalogItems.id, capabilityId),
          or(
            eq(schema.capabilityCatalogItems.workspaceId, workspaceId),
            isNull(schema.capabilityCatalogItems.workspaceId),
          ),
        ),
      )
      .orderBy(asc(sql`(${schema.capabilityCatalogItems.workspaceId} is null)`))
      .limit(1);
    return row ? mapCapabilityCatalogItem(row) : null;
  });
}

export async function enableCapabilityInstallation(
  db: Database,
  input: EnableCapabilityInstallationInput,
): Promise<CapabilityInstallation> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      // Read the raw row (not the redacted mapping) so an omitted config
      // preserves stored credential-header ciphertext instead of the redaction.
      const [existing] = await scopedDb
        .select()
        .from(schema.capabilityInstallations)
        .where(
          and(
            eq(schema.capabilityInstallations.workspaceId, input.workspaceId),
            eq(schema.capabilityInstallations.capabilityId, input.capabilityId),
          ),
        )
        .limit(1);
      if (existing) {
        const [row] = await scopedDb
          .update(schema.capabilityInstallations)
          .set({
            kind: input.kind,
            status: "active",
            config: input.config ?? existing.config,
            metadata: input.metadata ?? existing.metadata,
            enabledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.capabilityInstallations.workspaceId, input.workspaceId),
              eq(schema.capabilityInstallations.capabilityId, input.capabilityId),
            ),
          )
          .returning();
        if (!row) {
          throw new Error(`Capability installation not found: ${input.capabilityId}`);
        }
        return mapCapabilityInstallation(row);
      }
      const [row] = await scopedDb
        .insert(schema.capabilityInstallations)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          capabilityId: input.capabilityId,
          kind: input.kind,
          status: "active",
          config: input.config ?? {},
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) {
        throw new Error("Failed to enable capability installation");
      }
      return mapCapabilityInstallation(row);
    },
  );
}

export async function disableCapabilityInstallation(
  db: Database,
  workspaceId: string,
  capabilityId: string,
): Promise<CapabilityInstallation> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.capabilityInstallations)
      .set({
        status: "disabled",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.capabilityInstallations.workspaceId, workspaceId),
          eq(schema.capabilityInstallations.capabilityId, capabilityId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Capability installation not found: ${capabilityId}`);
    }
    return mapCapabilityInstallation(row);
  });
}

export async function listCapabilityInstallations(
  db: Database,
  workspaceId: string,
): Promise<CapabilityInstallation[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.capabilityInstallations)
      .where(eq(schema.capabilityInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.capabilityInstallations.updatedAt));
    return rows.map(mapCapabilityInstallation);
  });
}

export async function getCapabilityInstallation(
  db: Database,
  workspaceId: string,
  capabilityId: string,
): Promise<CapabilityInstallation | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.capabilityInstallations)
      .where(
        and(
          eq(schema.capabilityInstallations.workspaceId, workspaceId),
          eq(schema.capabilityInstallations.capabilityId, capabilityId),
        ),
      )
      .limit(1);
    return row ? mapCapabilityInstallation(row) : null;
  });
}

export async function listEnabledMcpCapabilityServers(
  db: Database,
  workspaceId: string,
): Promise<EnabledMcpCapabilityServer[]> {
  const rows = await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb
        .select({
          item: schema.capabilityCatalogItems,
          installation: schema.capabilityInstallations,
        })
        .from(schema.capabilityInstallations)
        .innerJoin(
          schema.capabilityCatalogItems,
          and(
            or(
              eq(
                schema.capabilityInstallations.workspaceId,
                schema.capabilityCatalogItems.workspaceId,
              ),
              isNull(schema.capabilityCatalogItems.workspaceId),
            ),
            eq(schema.capabilityInstallations.capabilityId, schema.capabilityCatalogItems.id),
          ),
        )
        .where(
          and(
            eq(schema.capabilityInstallations.workspaceId, workspaceId),
            eq(schema.capabilityInstallations.kind, "mcp"),
            eq(schema.capabilityInstallations.status, "active"),
          ),
        )
        .orderBy(asc(schema.capabilityCatalogItems.name)),
  );

  // A workspace-scoped catalog row and a global registry row can share the
  // same capability id; the join then matches one installation twice. Keep
  // one row per installation, preferring the workspace-scoped catalog row
  // (same precedence as getCapabilityCatalogItem).
  const preferredByInstallation = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = preferredByInstallation.get(row.installation.id);
    if (!existing || (existing.item.workspaceId === null && row.item.workspaceId !== null)) {
      preferredByInstallation.set(row.installation.id, row);
    }
  }

  return [...preferredByInstallation.values()].flatMap(({ item, installation }) => {
    if (!item.endpointUrl || !mcpConnectivityOk(installation.metadata)) {
      return [];
    }
    const headersEncrypted = encryptedHeadersConfig(installation.config.headersEncrypted);
    const connectionRef = connectionRefConfig(installation.config.connectionRef);
    if (item.authModel && !headersEncrypted && !connectionRef) {
      // Credential-gated MCPs are runnable only when either legacy static
      // credential headers or the connections broker ref were stored at enable
      // time.
      return [];
    }
    const metadata = item.metadata;
    const config = installation.config;
    const allowedTools = stringArrayConfig(config.allowedTools ?? metadata.allowedTools);
    const timeoutMs = positiveIntegerConfig(config.timeoutMs ?? metadata.timeoutMs);
    const cacheToolsList = booleanConfig(config.cacheToolsList ?? metadata.cacheToolsList);
    return [
      {
        capabilityId: item.id,
        id: mcpServerIdForCapability(item.id, metadata),
        name: item.name,
        url: item.endpointUrl,
        ...(allowedTools ? { allowedTools } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(cacheToolsList !== undefined ? { cacheToolsList } : {}),
        ...(headersEncrypted ? { headersEncrypted } : {}),
        ...(connectionRef ? { connectionRef } : {}),
      },
    ];
  });
}

/**
 * Decrypts an enabled capability MCP's stored credential headers. Returns
 * null when the server has none, and "unavailable" when headers exist but
 * cannot be recovered (missing key or failed decryption) — in which case the
 * server must be skipped rather than connected without credentials.
 */
export function decryptedCapabilityHeaders(
  server: EnabledMcpCapabilityServer,
  encryptionKey: Uint8Array | null,
): Record<string, string> | null | "unavailable" {
  if (!server.headersEncrypted || Object.keys(server.headersEncrypted).length === 0) {
    return null;
  }
  if (!encryptionKey) {
    return "unavailable";
  }
  try {
    return Object.fromEntries(
      Object.entries(server.headersEncrypted).map(([name, value]) => [
        name,
        decryptEnvironmentValue(encryptionKey, value),
      ]),
    );
  } catch {
    return "unavailable";
  }
}

/**
 * Returns the encrypted credential-header map stored on a capability
 * installation, or null when none is stored. This is the only read path for
 * the ciphertext besides listEnabledMcpCapabilityServers; the generic
 * installation mapping redacts it to header names.
 */
export async function getStoredCapabilityHeaderCiphertext(
  db: Database,
  workspaceId: string,
  capabilityId: string,
): Promise<Record<string, string> | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ config: schema.capabilityInstallations.config })
      .from(schema.capabilityInstallations)
      .where(
        and(
          eq(schema.capabilityInstallations.workspaceId, workspaceId),
          eq(schema.capabilityInstallations.capabilityId, capabilityId),
        ),
      )
      .limit(1);
    return row ? (encryptedHeadersConfig(row.config.headersEncrypted) ?? null) : null;
  });
}

export function mcpServerIdForCapability(
  capabilityId: string,
  metadata: Record<string, unknown> = {},
): string {
  const explicit = typeof metadata.mcpServerId === "string" ? metadata.mcpServerId.trim() : "";
  if (/^[A-Za-z0-9_-]+$/.test(explicit)) {
    return explicit;
  }
  const body =
    capabilityId
      .replace(/^[^:]+:/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 44) || "mcp";
  return `cap-${body}-${shortHash(capabilityId)}`;
}

const connectionMetadataColumns = {
  id: schema.connections.id,
  accountId: schema.connections.accountId,
  workspaceId: schema.connections.workspaceId,
  subjectId: schema.connections.subjectId,
  providerDomain: schema.connections.providerDomain,
  kind: schema.connections.kind,
  status: schema.connections.status,
  grantedScopes: schema.connections.grantedScopes,
  expiresAt: schema.connections.expiresAt,
  lastRefreshAt: schema.connections.lastRefreshAt,
  lastUsedAt: schema.connections.lastUsedAt,
  lastError: schema.connections.lastError,
  version: schema.connections.version,
  metadata: schema.connections.metadata,
  createdBySubjectId: schema.connections.createdBySubjectId,
  updatedBySubjectId: schema.connections.updatedBySubjectId,
  createdAt: schema.connections.createdAt,
  updatedAt: schema.connections.updatedAt,
};

function connectionSubjectVisibility(subjectId?: string | null): SQL {
  return subjectId
    ? or(isNull(schema.connections.subjectId), eq(schema.connections.subjectId, subjectId))!
    : isNull(schema.connections.subjectId);
}

export async function createConnection(
  db: Database,
  input: CreateConnectionInput,
): Promise<ConnectionMetadata> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.connections)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId ?? null,
          providerDomain: input.providerDomain,
          kind: input.kind,
          status: input.status ?? "active",
          credentialEncrypted: input.credentialEncrypted,
          grantedScopes: input.grantedScopes ?? [],
          expiresAt: input.expiresAt ?? null,
          metadata: input.metadata ?? {},
          createdBySubjectId: input.createdBySubjectId ?? null,
          updatedBySubjectId: input.updatedBySubjectId ?? input.createdBySubjectId ?? null,
        })
        .returning(connectionMetadataColumns);
      if (!row) {
        throw new Error("Failed to create connection");
      }
      return mapConnectionMetadata(row);
    },
  );
}

export async function listConnectionsMetadata(
  db: Database,
  workspaceId: string,
  subjectId?: string | null,
): Promise<ConnectionMetadata[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select(connectionMetadataColumns)
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          connectionSubjectVisibility(subjectId),
        ),
      )
      .orderBy(desc(schema.connections.createdAt));
    return rows.map(mapConnectionMetadata);
  });
}

export async function getConnectionMetadata(
  db: Database,
  workspaceId: string,
  connectionId: string,
  subjectId?: string | null,
): Promise<ConnectionMetadata | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select(connectionMetadataColumns)
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, connectionId),
          connectionSubjectVisibility(subjectId),
        ),
      )
      .limit(1);
    return row ? mapConnectionMetadata(row) : null;
  });
}

export async function updateConnection(
  db: Database,
  input: UpdateConnectionInput,
): Promise<ConnectionMetadata | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const set = {
      updatedAt: new Date(),
      ...(input.providerDomain !== undefined ? { providerDomain: input.providerDomain } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.credentialEncrypted !== undefined
        ? {
            credentialEncrypted: input.credentialEncrypted,
            version: sql`${schema.connections.version} + 1`,
            lastError: null,
          }
        : {}),
      ...(input.grantedScopes !== undefined ? { grantedScopes: input.grantedScopes } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.updatedBySubjectId !== undefined
        ? { updatedBySubjectId: input.updatedBySubjectId }
        : {}),
    };
    const [row] = await scopedDb
      .update(schema.connections)
      .set(set)
      .where(
        and(
          eq(schema.connections.workspaceId, input.workspaceId),
          eq(schema.connections.id, input.connectionId),
          connectionSubjectVisibility(input.visibleToSubjectId),
          ...(input.expectedVersion !== undefined
            ? [eq(schema.connections.version, input.expectedVersion)]
            : []),
        ),
      )
      .returning(connectionMetadataColumns);
    return row ? mapConnectionMetadata(row) : null;
  });
}

export async function revokeConnection(
  db: Database,
  workspaceId: string,
  connectionId: string,
  updatedBySubjectId?: string | null,
): Promise<ConnectionMetadata | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.connections)
      .set({
        status: "revoked",
        // The version bump invalidates any in-flight refresh's (id, version) CAS,
        // so a racing refresh cannot commit and flip the row back to active.
        version: sql`${schema.connections.version} + 1`,
        updatedBySubjectId: updatedBySubjectId ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, connectionId),
          // Same visibility rule as get/update: shared rows plus the caller's own
          // subject rows. Cross-subject revocation (admin janitorial) arrives with
          // the subject-connections UX in I5, deliberately not before.
          connectionSubjectVisibility(updatedBySubjectId),
        ),
      )
      .returning(connectionMetadataColumns);
    return row ? mapConnectionMetadata(row) : null;
  });
}

export async function loadConnectionCredentialForBroker(
  db: Database,
  settings: Settings,
  input: {
    workspaceId: string;
    connectionId?: string;
    providerDomain: string;
    kind?: ConnectionKind;
    subjectId?: string | null;
    allowSubjectOwned?: boolean;
  },
): Promise<ConnectionCredentialForBroker | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "connection credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  const subjectPredicate = input.allowSubjectOwned
    ? connectionSubjectVisibility(input.subjectId)
    : isNull(schema.connections.subjectId);
  const conditions: SQL[] = [
    eq(schema.connections.workspaceId, input.workspaceId),
    subjectPredicate,
  ];
  if (input.connectionId) {
    conditions.push(eq(schema.connections.id, input.connectionId));
  } else {
    conditions.push(eq(schema.connections.providerDomain, input.providerDomain));
    if (input.kind) {
      conditions.push(eq(schema.connections.kind, input.kind));
    }
  }
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    // Prefer active rows: a revoke bumps updatedAt, so recency alone would let a
    // freshly revoked connection shadow an active replacement for the provider.
    const [row] = await scopedDb
      .select()
      .from(schema.connections)
      .where(and(...conditions))
      .orderBy(
        desc(sql`(${schema.connections.status} = 'active')`),
        desc(schema.connections.updatedAt),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    let credential: unknown;
    try {
      credential = JSON.parse(decryptEnvironmentValue(key, row.credentialEncrypted));
    } catch (error) {
      throw new Error(
        `connection credential could not be decrypted for ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
      throw new Error(`connection credential bundle for ${row.id} is not a JSON object`);
    }
    return {
      id: row.id,
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      subjectId: row.subjectId,
      providerDomain: row.providerDomain,
      kind: row.kind as ConnectionKind,
      status: row.status as ConnectionStatus,
      credential: credential as Record<string, unknown>,
      grantedScopes: row.grantedScopes,
      expiresAt: row.expiresAt,
      lastRefreshAt: row.lastRefreshAt,
      version: row.version,
      metadata: row.metadata,
    };
  });
}

export async function recordConnectionTokenRefresh(
  db: Database,
  input: {
    id: string;
    version: number;
    workspaceId: string;
    credentialEncrypted: string;
    expiresAt: Date | null;
    grantedScopes?: string[];
    lastRefreshAt: Date;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const set = {
      credentialEncrypted: input.credentialEncrypted,
      expiresAt: input.expiresAt,
      lastRefreshAt: input.lastRefreshAt,
      status: "active",
      lastError: null,
      version: sql`${schema.connections.version} + 1`,
      updatedAt: new Date(),
      ...(input.grantedScopes !== undefined ? { grantedScopes: input.grantedScopes } : {}),
    };
    const updated = await scopedDb
      .update(schema.connections)
      .set(set)
      .where(
        and(
          eq(schema.connections.id, input.id),
          eq(schema.connections.workspaceId, input.workspaceId),
          eq(schema.connections.version, input.version),
          // A refresh may only ever renew a live credential; revoked/errored rows
          // stay dead even if a status change somewhere forgot to bump version.
          eq(schema.connections.status, "active"),
        ),
      )
      .returning({ id: schema.connections.id });
    return updated.length > 0;
  });
}

export async function setConnectionStatus(
  db: Database,
  workspaceId: string,
  status: ConnectionStatus,
  lastError: string | null,
  guard: { id: string; version: number },
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.connections)
      .set({
        status,
        lastError,
        version: sql`${schema.connections.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, guard.id),
          eq(schema.connections.version, guard.version),
        ),
      )
      .returning({ id: schema.connections.id });
    return updated.length > 0;
  });
}

export async function recordConnectionUsed(
  db: Database,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.connections)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.id, connectionId),
        ),
      );
  });
}

export async function loadIntegrationOAuthClient(
  db: Database,
  settings: Settings,
  issuer: string,
): Promise<IntegrationOAuthClientForUse | null> {
  const [row] = await db
    .select()
    .from(schema.integrationOauthClients)
    .where(eq(schema.integrationOauthClients.issuer, issuer))
    .limit(1);
  if (!row) {
    return null;
  }
  let clientSecret: string | null = null;
  if (row.clientSecretEncrypted) {
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new Error(
        "OAuth client secret present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
      );
    }
    clientSecret = decryptEnvironmentValue(key, row.clientSecretEncrypted);
  }
  return {
    id: row.id,
    issuer: row.issuer,
    authorizationServer: row.authorizationServer,
    clientId: row.clientId,
    clientSecret,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function storeIntegrationOAuthClient(
  db: Database,
  input: StoreIntegrationOAuthClientInput,
): Promise<StoredIntegrationOAuthClient> {
  const [inserted] = await db
    .insert(schema.integrationOauthClients)
    .values({
      issuer: input.issuer,
      authorizationServer: input.authorizationServer,
      clientId: input.clientId,
      clientSecretEncrypted: input.clientSecretEncrypted ?? null,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "none",
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: schema.integrationOauthClients.issuer,
    })
    .returning();
  if (inserted) {
    return mapStoredIntegrationOAuthClient(inserted);
  }
  const [winner] = await db
    .select()
    .from(schema.integrationOauthClients)
    .where(eq(schema.integrationOauthClients.issuer, input.issuer))
    .limit(1);
  if (!winner) {
    throw new Error(
      `OAuth client registration conflict winner not found for issuer ${input.issuer}`,
    );
  }
  return mapStoredIntegrationOAuthClient(winner);
}

export async function replaceIntegrationOAuthClient(
  db: Database,
  input: ReplaceIntegrationOAuthClientInput,
): Promise<StoredIntegrationOAuthClient> {
  const [row] = await db
    .insert(schema.integrationOauthClients)
    .values({
      issuer: input.issuer,
      authorizationServer: input.authorizationServer,
      clientId: input.clientId,
      clientSecretEncrypted: input.clientSecretEncrypted ?? null,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "none",
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: schema.integrationOauthClients.issuer,
      set: {
        authorizationServer: input.authorizationServer,
        clientId: input.clientId,
        clientSecretEncrypted: input.clientSecretEncrypted ?? null,
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "none",
        metadata: input.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error(`OAuth client registration replacement failed for issuer ${input.issuer}`);
  }
  return mapStoredIntegrationOAuthClient(row);
}

function mapStoredIntegrationOAuthClient(
  row: typeof schema.integrationOauthClients.$inferSelect,
): StoredIntegrationOAuthClient {
  return {
    id: row.id,
    issuer: row.issuer,
    authorizationServer: row.authorizationServer,
    clientId: row.clientId,
    clientSecretEncrypted: row.clientSecretEncrypted,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function consumeIntegrationOAuthStateNonce(
  db: Database,
  input: ConsumeOAuthStateNonceInput,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .delete(schema.integrationOauthStateNonces)
        .where(
          and(
            eq(schema.integrationOauthStateNonces.workspaceId, input.workspaceId),
            lt(schema.integrationOauthStateNonces.expiresAt, input.now),
          ),
        );
      const inserted = await scopedDb
        .insert(schema.integrationOauthStateNonces)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          nonce: input.nonce,
          expiresAt: input.expiresAt,
          usedAt: input.now,
        })
        .onConflictDoNothing({ target: schema.integrationOauthStateNonces.nonce })
        .returning({ nonce: schema.integrationOauthStateNonces.nonce });
      return inserted.length > 0;
    },
  );
}

export async function createKnowledgeMemory(
  db: Database,
  input: CreateKnowledgeMemoryInput,
): Promise<KnowledgeMemory> {
  const text = requireDbString(input.text, "knowledge memory text");
  const scope = cleanDbString(input.scope) ?? "workspace";
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.knowledgeMemories)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          status: input.status ?? "proposed",
          kind: input.kind ?? "semantic",
          scope,
          text,
          textHash: hashMemoryText(text),
          sourceRefs: input.sourceRefs ?? [],
          confidence: confidenceToStorage(input.confidence ?? 0.5),
          metadata: input.metadata ?? {},
          createdBySessionId: input.createdBySessionId ?? null,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create knowledge memory");
      }
      return mapKnowledgeMemory(row);
    },
  );
}

export async function updateKnowledgeMemory(
  db: Database,
  workspaceId: string,
  memoryId: string,
  input: UpdateKnowledgeMemoryInput,
  embedder?: MemoryEmbedder,
): Promise<KnowledgeMemory> {
  const reviewStatus = input.status === "approved" || input.status === "rejected";
  const scope =
    input.scope !== undefined ? requireDbString(input.scope, "knowledge memory scope") : undefined;
  const reviewedBy =
    input.reviewedBy === null
      ? null
      : input.reviewedBy !== undefined
        ? requireDbString(input.reviewedBy, "knowledge memory reviewer")
        : undefined;

  // A text edit is a human audit action: it bypasses the dedup/cap gates (an
  // authorized curator's edit is intentional) but still sanitizes + redacts,
  // recomputes text_hash, and re-embeds fail-soft so the row stays coherent.
  type MemoryTextUpdate = {
    text: string;
    textHash: string;
    embedding: number[] | null;
    embeddingModel: string | null;
    updateEmbedding: boolean;
  };
  const embedForMemoryUpdate = async (
    sanitizedText: string,
  ): Promise<{ embedding: number[] | null; embeddingModel: string | null }> => {
    let embedding: number[] | null = null;
    let embeddingModel: string | null = null;
    if (embedder) {
      try {
        const [vector] = await embedder.embedMany([sanitizedText]);
        if (vector && vector.length > 0) {
          embedding = vector;
          embeddingModel = embedder.model;
        }
      } catch (error) {
        console.warn("workspace memory edit: embedding failed; storing keyword-only", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { embedding, embeddingModel };
  };

  let textUpdate: MemoryTextUpdate | undefined;
  if (input.text !== undefined) {
    const { text: sanitizedText } = sanitizeMemoryText(input.text);
    if (sanitizedText.length === 0) {
      throw new Error("Memory text is empty after sanitization; nothing to save.");
    }
    if (isMemoryTextTooLong(sanitizedText)) {
      throw new Error(
        `Memory text is too long (${sanitizedText.length} chars; max ${MEMORY_TEXT_MAX_CHARS}).`,
      );
    }
    const { embedding, embeddingModel } = await embedForMemoryUpdate(sanitizedText);
    textUpdate = {
      text: sanitizedText,
      textHash: hashMemoryText(sanitizedText),
      embedding,
      embeddingModel,
      updateEmbedding: true,
    };
  }

  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [existing] = await scopedDb
      .select({
        id: schema.knowledgeMemories.id,
        status: schema.knowledgeMemories.status,
        text: schema.knowledgeMemories.text,
        textHash: schema.knowledgeMemories.textHash,
        embedding: schema.knowledgeMemories.embedding,
      })
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          eq(schema.knowledgeMemories.id, memoryId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error(`Knowledge memory not found: ${memoryId}`);
    }
    const nextStatus = (input.status ?? existing.status) as KnowledgeMemoryStatus;
    const wasVisible = agentVisibleMemoryStatuses.includes(
      existing.status as (typeof agentVisibleMemoryStatuses)[number],
    );
    const willBeVisible = agentVisibleMemoryStatuses.includes(
      nextStatus as (typeof agentVisibleMemoryStatuses)[number],
    );
    if (willBeVisible) {
      const [{ visibleCount } = { visibleCount: 0 }] = await scopedDb
        .select({
          visibleCount: sql<number>`count(*)::int`,
        })
        .from(schema.knowledgeMemories)
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, workspaceId),
            inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
            ne(schema.knowledgeMemories.id, memoryId),
          ),
        );
      if (Number(visibleCount) >= MEMORY_VISIBLE_RECORD_CAP) {
        throw new Error(
          `Workspace's visible memory is full (${MEMORY_VISIBLE_RECORD_CAP} visible records). Correct or supersede stale memories before adding new ones.`,
        );
      }
    }
    if (!wasVisible && willBeVisible && textUpdate === undefined) {
      const { text: sanitizedText } = sanitizeMemoryText(existing.text);
      if (sanitizedText.length === 0) {
        throw new Error("Memory text is empty after sanitization; nothing to save.");
      }
      if (isMemoryTextTooLong(sanitizedText)) {
        throw new Error(
          `Memory text is too long (${sanitizedText.length} chars; max ${MEMORY_TEXT_MAX_CHARS}).`,
        );
      }
      const textChanged = sanitizedText !== existing.text;
      const missingEmbedding = existing.embedding == null;
      const { embedding, embeddingModel } =
        textChanged || missingEmbedding
          ? await embedForMemoryUpdate(sanitizedText)
          : { embedding: null, embeddingModel: null };
      textUpdate = {
        text: sanitizedText,
        textHash: hashMemoryText(sanitizedText),
        embedding,
        embeddingModel,
        updateEmbedding: textChanged || missingEmbedding,
      };
    }
    const nextTextHash = textUpdate?.textHash ?? existing.textHash;
    if (!wasVisible && willBeVisible && nextTextHash) {
      const duplicate = await findVisibleMemoryByTextHash(
        scopedDb,
        workspaceId,
        nextTextHash,
        memoryId,
      );
      if (duplicate) {
        throw new Error(visibleTextHashConflictMessage(duplicate));
      }
    }
    let row: typeof schema.knowledgeMemories.$inferSelect | undefined;
    try {
      const rows = await scopedDb.transaction(
        async (tx) =>
          await tx
            .update(schema.knowledgeMemories)
            .set({
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
              ...(scope !== undefined ? { scope } : {}),
              ...(textUpdate !== undefined
                ? {
                    text: textUpdate.text,
                    textHash: textUpdate.textHash,
                    ...(textUpdate.updateEmbedding
                      ? {
                          embedding: textUpdate.embedding,
                          embeddingModel: textUpdate.embeddingModel,
                        }
                      : {}),
                  }
                : {}),
              ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
              ...(input.confidence !== undefined
                ? { confidence: confidenceToStorage(input.confidence) }
                : {}),
              ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
              ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
              // Re-proposing clears review metadata; an explicit reviewedBy in the same
              // update still wins via the later spread.
              ...(input.status === "proposed" ? { reviewedBy: null, reviewedAt: null } : {}),
              ...(reviewedBy !== undefined ? { reviewedBy } : {}),
              ...(reviewStatus ? { reviewedAt: new Date() } : {}),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.knowledgeMemories.workspaceId, workspaceId),
                eq(schema.knowledgeMemories.id, memoryId),
              ),
            )
            .returning(),
      );
      row = rows[0];
    } catch (error) {
      if (!isVisibleTextHashUniqueViolation(error) || !nextTextHash) {
        throw error;
      }
      const duplicate = await findVisibleMemoryByTextHash(
        scopedDb,
        workspaceId,
        nextTextHash,
        memoryId,
      );
      throw new Error(visibleTextHashConflictMessage(duplicate), { cause: error });
    }
    if (!row) {
      throw new Error(`Knowledge memory not found: ${memoryId}`);
    }
    return mapKnowledgeMemory(row);
  });
}

export async function getKnowledgeMemory(
  db: Database,
  workspaceId: string,
  memoryId: string,
): Promise<KnowledgeMemory | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          eq(schema.knowledgeMemories.id, memoryId),
        ),
      )
      .limit(1);
    return row ? mapKnowledgeMemory(row) : null;
  });
}

export async function listKnowledgeMemories(
  db: Database,
  workspaceId: string,
  options: ListKnowledgeMemoryOptions = {},
): Promise<KnowledgeMemory[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const conditions: SQL[] = [eq(schema.knowledgeMemories.workspaceId, workspaceId)];
    if (options.status) {
      conditions.push(
        Array.isArray(options.status)
          ? inArray(schema.knowledgeMemories.status, options.status)
          : eq(schema.knowledgeMemories.status, options.status),
      );
    }
    if (options.kind) {
      conditions.push(eq(schema.knowledgeMemories.kind, options.kind));
    }
    const scope = cleanDbString(options.scope);
    if (scope) {
      conditions.push(eq(schema.knowledgeMemories.scope, scope));
    }
    const query = cleanDbString(options.query);
    if (query) {
      conditions.push(
        sql`to_tsvector('simple', ${schema.knowledgeMemories.text}) @@ plainto_tsquery('simple', ${query})`,
      );
    }
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const rows = await scopedDb
      .select()
      .from(schema.knowledgeMemories)
      .where(and(...conditions))
      .orderBy(desc(schema.knowledgeMemories.updatedAt))
      .limit(limit);
    return rows.map(mapKnowledgeMemory);
  });
}

// ===========================================================================
// Workspace Memory V1 — agent-writable, hybrid-searchable memory over
// knowledge_memories. saveWorkspaceMemory is the single write gate; every write
// path (first-party tools, REST, future reflector) funnels through it. The
// embedder is a minimal structural port so packages/db need not depend on
// packages/documents; callers pass getDocumentServices().embedder.
// ===========================================================================

export type MemoryEmbedder = {
  model: string;
  embedMany: (texts: string[]) => Promise<number[][]>;
};

export type WorkspaceMemoryOrigin = "agent" | "human";

export type SaveWorkspaceMemoryInput = {
  accountId: string;
  workspaceId: string;
  text: string;
  kind?: KnowledgeMemoryKind | undefined;
  confidence?: number | undefined; // 0-1
  pinned?: boolean | undefined;
  replacesId?: string | null | undefined; // short or full id of the record this supersedes
  sessionId?: string | null | undefined; // provenance + event linkage
  origin?: WorkspaceMemoryOrigin | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type SaveWorkspaceMemoryResult = {
  memory: KnowledgeMemory;
  // true → a matching record already existed; nothing new was inserted (NOOP).
  deduped: boolean;
  dedupeReason: "exact" | "near" | null;
  // the record that `replacesId` retired, if any.
  superseded: KnowledgeMemory | null;
  supersededId: string | null;
  // true when `replacesId` matched the same row and the row was updated in place
  // instead of being superseded by a new/existing row.
  updated: boolean;
  redactionCount: number;
  embedded: boolean;
};

export type CorrectWorkspaceMemoryInput = {
  accountId: string;
  workspaceId: string;
  id: string; // short or full id
  reason?: string | undefined;
  replacementText?: string | undefined;
  sessionId?: string | null | undefined;
};

export type CorrectWorkspaceMemoryResult = {
  action: "archived" | "superseded" | "updated";
  // the record that was archived, superseded, or updated in place.
  memory: KnowledgeMemory;
  // the replacement record when replacementText was supplied, else null.
  replacement: KnowledgeMemory | null;
};

export type WorkspaceMemorySearchMode = "hybrid" | "vector" | "keyword";

export type WorkspaceMemorySearchInput = {
  query: string;
  kind?: KnowledgeMemoryKind | undefined;
  limit?: number | undefined;
  mode?: WorkspaceMemorySearchMode | undefined;
};

export type WorkspaceMemorySearchResult = {
  memory: KnowledgeMemory;
  score: number;
  matchType: WorkspaceMemorySearchMode;
  vectorScore: number | null;
  keywordScore: number | null;
};

function memoryVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

const agentVisibleMemoryStatuses = [...AGENT_VISIBLE_MEMORY_STATUSES];
const visibleTextHashUniqueIndexName = "knowledge_memories_workspace_visible_text_hash_uq";

function isVisibleTextHashUniqueViolation(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
    message?: unknown;
    cause?: unknown;
  } | null;
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const constraint = candidate.constraint ?? candidate.constraint_name;
  if (candidate.code === "23505" && constraint === visibleTextHashUniqueIndexName) {
    return true;
  }
  if (
    typeof candidate.message === "string" &&
    candidate.message.includes(visibleTextHashUniqueIndexName) &&
    (candidate.code === "23505" ||
      candidate.message.includes("duplicate key value violates unique constraint"))
  ) {
    return true;
  }
  return isVisibleTextHashUniqueViolation(candidate.cause);
}

async function findVisibleMemoryByTextHash(
  scopedDb: Database,
  workspaceId: string,
  textHash: string,
  excludeId?: string,
): Promise<typeof schema.knowledgeMemories.$inferSelect | null> {
  const filters = [
    eq(schema.knowledgeMemories.workspaceId, workspaceId),
    eq(schema.knowledgeMemories.textHash, textHash),
    inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
  ];
  if (excludeId) {
    filters.push(ne(schema.knowledgeMemories.id, excludeId));
  }
  const [row] = await scopedDb
    .select()
    .from(schema.knowledgeMemories)
    .where(and(...filters))
    .orderBy(desc(schema.knowledgeMemories.updatedAt))
    .limit(1);
  return row ?? null;
}

function visibleTextHashConflictMessage(
  existing: Pick<KnowledgeMemory, "id"> | { id: string } | null,
): string {
  const suffix = existing ? ` Existing memory id: ${existing.id}.` : "";
  return `Memory text duplicates an existing visible memory.${suffix} Search memory and update, archive, or supersede the existing record instead.`;
}

function hasMetadataOrigin(metadata: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(metadata, "origin");
}

function saveMemoryMetadata(input: SaveWorkspaceMemoryInput): Record<string, unknown> {
  return {
    ...(input.metadata ?? {}),
    ...(input.origin ? { origin: input.origin } : {}),
  };
}

function inPlaceSaveMemoryMetadata(
  existing: Record<string, unknown>,
  input: SaveWorkspaceMemoryInput,
): Record<string, unknown> | undefined {
  if (input.metadata === undefined && (!input.origin || hasMetadataOrigin(existing))) {
    return undefined;
  }
  const merged = {
    ...existing,
    ...(input.metadata ?? {}),
  };
  if (hasMetadataOrigin(existing)) {
    merged.origin = existing.origin;
  } else if (input.origin) {
    merged.origin = input.origin;
  }
  return merged;
}

// Resolve a short prefix or full uuid to the full id within a workspace. Full
// uuid lookup is status-agnostic so correction/archive paths can still surface a
// clear terminal-row result; prefix lookup is restricted to non-terminal rows
// because short ids are shown only for records an agent can legitimately target.
// Returns null when nothing matches; throws on an ambiguous live prefix.
async function resolveWorkspaceMemoryId(
  scopedDb: Database,
  workspaceId: string,
  rawId: string,
): Promise<string | null> {
  const candidate = rawId.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(candidate)) {
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)) {
    const [match] = await scopedDb
      .select({ id: schema.knowledgeMemories.id })
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          eq(schema.knowledgeMemories.id, candidate),
        ),
      )
      .limit(1);
    return match?.id ?? null;
  }
  const matches = await scopedDb
    .select({ id: schema.knowledgeMemories.id })
    .from(schema.knowledgeMemories)
    .where(
      and(
        eq(schema.knowledgeMemories.workspaceId, workspaceId),
        sql`${schema.knowledgeMemories.id}::text like ${`${candidate}%`}`,
        ne(schema.knowledgeMemories.status, "archived"),
        ne(schema.knowledgeMemories.status, "superseded"),
        ne(schema.knowledgeMemories.status, "rejected"),
      ),
    )
    .limit(2);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous memory id "${rawId}": it matches multiple live memory records. Run memory_search and use the full id from the intended record.`,
    );
  }
  return matches[0]!.id;
}

export async function saveWorkspaceMemory(
  db: Database,
  input: SaveWorkspaceMemoryInput,
  embedder?: MemoryEmbedder,
): Promise<SaveWorkspaceMemoryResult> {
  const { text: sanitizedText, redactionCount } = sanitizeMemoryText(input.text);
  if (sanitizedText.length === 0) {
    throw new Error("Memory text is empty after sanitization; nothing to save.");
  }
  if (isMemoryTextTooLong(sanitizedText)) {
    throw new Error(
      `Memory text is too long (${sanitizedText.length} chars; max ${MEMORY_TEXT_MAX_CHARS}). Store one crisp fact per record.`,
    );
  }
  const textHash = hashMemoryText(sanitizedText);
  const kind: KnowledgeMemoryKind = input.kind ?? "semantic";

  // Embed fail-soft, OUTSIDE the transaction: a provider error must never block a
  // write (the row stays keyword-searchable). Mirrors indexDocumentNow.
  let embedding: number[] | null = null;
  let embeddingModel: string | null = null;
  if (embedder) {
    try {
      const [vector] = await embedder.embedMany([sanitizedText]);
      if (vector && vector.length > 0) {
        embedding = vector;
        embeddingModel = embedder.model;
      }
    } catch (error) {
      console.warn("workspace memory save: embedding failed; saving keyword-only", {
        workspaceId: input.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    // Resolve the supersession target first so an invalid replaces_id fails before
    // we insert anything (cross-workspace ids are RLS-invisible → treated as not found).
    let replacesFullId: string | null = null;
    let replacesRow: typeof schema.knowledgeMemories.$inferSelect | null = null;
    if (input.replacesId) {
      replacesFullId = await resolveWorkspaceMemoryId(
        scopedDb,
        input.workspaceId,
        input.replacesId,
      );
      if (!replacesFullId) {
        throw new Error(
          `replaces_id "${input.replacesId}" does not match a memory in this workspace.`,
        );
      }
      const [row] = await scopedDb
        .select()
        .from(schema.knowledgeMemories)
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
            eq(schema.knowledgeMemories.id, replacesFullId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new Error(
          `replaces_id "${input.replacesId}" does not match a memory in this workspace.`,
        );
      }
      replacesRow = row;
    }

    const updateReplacesInPlace = async (): Promise<SaveWorkspaceMemoryResult> => {
      if (!replacesFullId) {
        throw new Error("Cannot update a memory in place without replaces_id.");
      }
      // A caller can "replace" a row with text that exact/near-dedups only to
      // that same row. In that case there is no supersession target; keep the
      // row live and update its text/vector metadata so the call still has an
      // observable effect.
      const normalizedTextChanged = replacesRow
        ? hashMemoryText(replacesRow.text) !== textHash
        : true;
      const metadata = replacesRow
        ? inPlaceSaveMemoryMetadata(replacesRow.metadata, input)
        : undefined;
      const [updated] = await scopedDb
        .update(schema.knowledgeMemories)
        .set({
          text: sanitizedText,
          textHash,
          ...(normalizedTextChanged
            ? {
                // New text with no fresh vector must clear the old vector. Keeping a
                // stale vector would make vector search return this row for the old
                // text's meaning; keyword search still covers the new text.
                embedding,
                embeddingModel,
              }
            : {}),
          ...(input.kind !== undefined ? { kind } : {}),
          ...(input.confidence !== undefined
            ? { confidence: confidenceToStorage(input.confidence) }
            : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
            eq(schema.knowledgeMemories.id, replacesFullId),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error(
          `replaces_id "${input.replacesId}" does not match a memory in this workspace.`,
        );
      }
      return {
        memory: mapKnowledgeMemory(updated),
        deduped: false,
        dedupeReason: null,
        superseded: null,
        supersededId: null,
        updated: true,
        redactionCount,
        embedded: embedding !== null,
      };
    };

    const dedupeToExisting = async (
      row: typeof schema.knowledgeMemories.$inferSelect,
      dedupeReason: "exact" | "near",
    ): Promise<SaveWorkspaceMemoryResult> => {
      if (replacesFullId && row.id === replacesFullId) {
        return await updateReplacesInPlace();
      }
      let superseded: KnowledgeMemory | null = null;
      if (replacesFullId) {
        const [old] = await scopedDb
          .update(schema.knowledgeMemories)
          .set({
            status: "superseded",
            supersededById: row.id,
            validUntil: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
              eq(schema.knowledgeMemories.id, replacesFullId),
            ),
          )
          .returning();
        if (!old) {
          throw new Error(
            `replaces_id "${input.replacesId}" does not match a memory in this workspace.`,
          );
        }
        superseded = mapKnowledgeMemory(old);
      }
      return {
        memory: mapKnowledgeMemory(row),
        deduped: true,
        dedupeReason,
        superseded,
        supersededId: superseded?.id ?? null,
        updated: false,
        redactionCount,
        embedded: embedding !== null,
      };
    };

    // Exact-dup gate: same normalized text among agent-visible rows → NOOP.
    const exactMatches = await scopedDb
      .select()
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
          eq(schema.knowledgeMemories.textHash, textHash),
          inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
        ),
      )
      .orderBy(
        replacesFullId
          ? sql`case when ${schema.knowledgeMemories.id} = ${replacesFullId} then 1 else 0 end`
          : schema.knowledgeMemories.updatedAt,
      )
      .limit(replacesFullId ? 2 : 1);
    const exact = exactMatches.find((row) => row.id !== replacesFullId) ?? exactMatches[0];
    if (exact) {
      return await dedupeToExisting(exact, "exact");
    }

    // Near-dup gate: top-N cosine neighbours among agent-visible rows with a
    // vector from the SAME model; similarity ≥ threshold → NOOP. This check is
    // advisory: cosine similarity cannot be protected by a unique index, unlike
    // the exact text_hash gate below.
    if (embedding && embeddingModel) {
      const distance = sql<number>`${schema.knowledgeMemories.embedding} <=> ${memoryVectorLiteral(embedding)}::vector`;
      const neighbours = await scopedDb
        .select({
          id: schema.knowledgeMemories.id,
          distance,
        })
        .from(schema.knowledgeMemories)
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
            inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
            eq(schema.knowledgeMemories.embeddingModel, embeddingModel),
            sql`${schema.knowledgeMemories.embedding} is not null`,
          ),
        )
        .orderBy(distance)
        .limit(MEMORY_NEAR_DUP_NEIGHBORS);
      const duplicateNeighbours = neighbours.filter(
        (row) => 1 - Number(row.distance) >= MEMORY_NEAR_DUP_COSINE_THRESHOLD,
      );
      const nearest =
        duplicateNeighbours.find((row) => row.id !== replacesFullId) ?? duplicateNeighbours[0];
      if (nearest) {
        const [row] = await scopedDb
          .select()
          .from(schema.knowledgeMemories)
          .where(
            and(
              eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
              eq(schema.knowledgeMemories.id, nearest.id),
            ),
          )
          .limit(1);
        if (row) {
          return await dedupeToExisting(row, "near");
        }
      }
    }

    // Per-workspace visible-record cap: fail actionably rather than silently drop.
    const [{ visibleCount } = { visibleCount: 0 }] = await scopedDb
      .select({
        visibleCount: sql<number>`count(*)::int`,
      })
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
          inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
        ),
      );
    const replacesVisible = replacesRow
      ? agentVisibleMemoryStatuses.includes(
          replacesRow.status as (typeof agentVisibleMemoryStatuses)[number],
        )
      : false;
    const effectiveVisibleCount = Number(visibleCount) - (replacesVisible ? 1 : 0);
    if (effectiveVisibleCount >= MEMORY_VISIBLE_RECORD_CAP) {
      throw new Error(
        `Workspace's visible memory is full (${MEMORY_VISIBLE_RECORD_CAP} visible records). Correct or supersede stale memories before adding new ones.`,
      );
    }

    const sourceRefs: KnowledgeSourceRef[] = input.sessionId
      ? [{ kind: "session_event", id: input.sessionId, metadata: {} }]
      : [];
    let inserted: typeof schema.knowledgeMemories.$inferSelect | undefined;
    try {
      const rows = await scopedDb.transaction(
        async (tx) =>
          await tx
            .insert(schema.knowledgeMemories)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              status: "active",
              kind,
              scope: "workspace",
              text: sanitizedText,
              textHash,
              sourceRefs,
              confidence: confidenceToStorage(input.confidence ?? 0.5),
              pinned: input.pinned ?? false,
              metadata: saveMemoryMetadata(input),
              createdBySessionId: input.sessionId ?? null,
              supersedesId: replacesFullId,
              ...(embedding ? { embedding, embeddingModel } : {}),
            })
            .returning(),
      );
      inserted = rows[0];
    } catch (error) {
      if (!isVisibleTextHashUniqueViolation(error)) {
        throw error;
      }
      const winner = await findVisibleMemoryByTextHash(scopedDb, input.workspaceId, textHash);
      if (!winner) {
        throw error;
      }
      return await dedupeToExisting(winner, "exact");
    }
    if (!inserted) {
      throw new Error("Failed to save workspace memory");
    }

    let superseded: KnowledgeMemory | null = null;
    if (replacesFullId) {
      const [old] = await scopedDb
        .update(schema.knowledgeMemories)
        .set({
          status: "superseded",
          supersededById: inserted.id,
          validUntil: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
            eq(schema.knowledgeMemories.id, replacesFullId),
          ),
        )
        .returning();
      superseded = old ? mapKnowledgeMemory(old) : null;
    }

    return {
      memory: mapKnowledgeMemory(inserted),
      deduped: false,
      dedupeReason: null,
      superseded,
      supersededId: superseded?.id ?? null,
      updated: false,
      redactionCount,
      embedded: embedding !== null,
    };
  });
}

export async function correctWorkspaceMemory(
  db: Database,
  input: CorrectWorkspaceMemoryInput,
  embedder?: MemoryEmbedder,
): Promise<CorrectWorkspaceMemoryResult> {
  const replacementText = input.replacementText?.trim();
  if (replacementText) {
    // Correction WITH a replacement is a full supersede through the one write gate.
    const [old] = await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
      const fullId = await resolveWorkspaceMemoryId(scopedDb, input.workspaceId, input.id);
      if (!fullId) {
        return [] as (typeof schema.knowledgeMemories.$inferSelect)[];
      }
      return await scopedDb
        .select()
        .from(schema.knowledgeMemories)
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
            eq(schema.knowledgeMemories.id, fullId),
          ),
        )
        .limit(1);
    });
    if (!old) {
      throw new Error(`Memory "${input.id}" not found in this workspace.`);
    }
    const result = await saveWorkspaceMemory(
      db,
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        text: replacementText,
        kind: old.kind as KnowledgeMemoryKind,
        pinned: old.pinned,
        replacesId: old.id,
        sessionId: input.sessionId ?? null,
        origin: "agent",
      },
      embedder,
    );
    if (result.superseded) {
      return {
        action: "superseded",
        memory: result.superseded,
        replacement: result.memory,
      };
    }
    return {
      action: "updated",
      memory: result.memory,
      replacement: null,
    };
  }

  // No replacement → archive the record.
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const fullId = await resolveWorkspaceMemoryId(scopedDb, input.workspaceId, input.id);
    if (!fullId) {
      throw new Error(`Memory "${input.id}" not found in this workspace.`);
    }
    const [existing] = await scopedDb
      .select()
      .from(schema.knowledgeMemories)
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
          eq(schema.knowledgeMemories.id, fullId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error(`Memory "${input.id}" not found in this workspace.`);
    }
    const correctionReason = cleanDbString(input.reason);
    const [archived] = await scopedDb
      .update(schema.knowledgeMemories)
      .set({
        status: "archived",
        validUntil: new Date(),
        updatedAt: new Date(),
        ...(correctionReason
          ? { metadata: { ...(existing.metadata ?? {}), correctionReason } }
          : {}),
      })
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, input.workspaceId),
          eq(schema.knowledgeMemories.id, fullId),
        ),
      )
      .returning();
    if (!archived) {
      throw new Error(`Memory "${input.id}" not found in this workspace.`);
    }
    return { action: "archived", memory: mapKnowledgeMemory(archived), replacement: null };
  });
}

export async function searchWorkspaceMemories(
  db: Database,
  workspaceId: string,
  input: WorkspaceMemorySearchInput,
  embedder?: MemoryEmbedder,
): Promise<WorkspaceMemorySearchResult[]> {
  const query = requireDbString(input.query, "memory search query");
  const mode: WorkspaceMemorySearchMode = input.mode ?? "hybrid";
  const limit = Math.min(
    Math.max(input.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT, 1),
    MEMORY_SEARCH_MAX_LIMIT,
  );
  const candidateLimit = mode === "hybrid" ? Math.min(limit * 4, 100) : limit;

  const baseConditions: SQL[] = [
    eq(schema.knowledgeMemories.workspaceId, workspaceId),
    inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
  ];
  if (input.kind) {
    baseConditions.push(eq(schema.knowledgeMemories.kind, input.kind));
  }

  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const scored = new Map<string, { vectorScore: number | null; keywordScore: number | null }>();

    if (mode === "vector" || mode === "hybrid") {
      try {
        if (!embedder) {
          throw new Error("no embedder configured for vector memory search");
        }
        const [vector] = await embedder.embedMany([query]);
        if (!vector || vector.length === 0) {
          throw new Error("embedder returned no query vector");
        }
        const distance = sql<number>`${schema.knowledgeMemories.embedding} <=> ${memoryVectorLiteral(vector)}::vector`;
        const rows = await scopedDb
          .select({ id: schema.knowledgeMemories.id, distance })
          .from(schema.knowledgeMemories)
          .where(
            and(
              ...baseConditions,
              eq(schema.knowledgeMemories.embeddingModel, embedder.model),
              sql`${schema.knowledgeMemories.embedding} is not null`,
            ),
          )
          .orderBy(distance)
          .limit(candidateLimit);
        for (const row of rows) {
          const vectorScore = 1 / (1 + Number(row.distance));
          scored.set(row.id, {
            vectorScore,
            keywordScore: scored.get(row.id)?.keywordScore ?? null,
          });
        }
      } catch (error) {
        if (mode === "vector") {
          throw error;
        }
        console.warn(
          "workspace memory hybrid search vector component failed; falling back to keyword",
          {
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    if (mode === "keyword" || mode === "hybrid") {
      const rank = sql<number>`ts_rank_cd(to_tsvector('simple', ${schema.knowledgeMemories.text}), plainto_tsquery('simple', ${query}))`;
      const rows = await scopedDb
        .select({ id: schema.knowledgeMemories.id, rank })
        .from(schema.knowledgeMemories)
        .where(
          and(
            ...baseConditions,
            sql`to_tsvector('simple', ${schema.knowledgeMemories.text}) @@ plainto_tsquery('simple', ${query})`,
          ),
        )
        .orderBy(desc(rank))
        .limit(candidateLimit);
      for (const row of rows) {
        const rankValue = Number(row.rank);
        const keywordScore =
          Number.isFinite(rankValue) && rankValue > 0 ? rankValue / (rankValue + 1) : 0;
        const prev = scored.get(row.id);
        scored.set(row.id, { vectorScore: prev?.vectorScore ?? null, keywordScore });
      }
    }

    const ranked = [...scored.entries()]
      .map(([id, { vectorScore, keywordScore }]) => {
        const matchType: WorkspaceMemorySearchMode =
          vectorScore !== null && keywordScore !== null
            ? "hybrid"
            : vectorScore !== null
              ? "vector"
              : "keyword";
        const vector = vectorScore ?? 0;
        const keyword = keywordScore ?? 0;
        const score =
          mode === "vector"
            ? vector
            : mode === "keyword"
              ? keyword
              : Math.min(1, 0.65 * vector + 0.35 * keyword + (matchType === "hybrid" ? 0.1 : 0));
        return { id, score: Number(score.toFixed(6)), matchType, vectorScore, keywordScore };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          (right.vectorScore ?? 0) - (left.vectorScore ?? 0) ||
          (right.keywordScore ?? 0) - (left.keywordScore ?? 0),
      )
      .slice(0, limit);

    if (ranked.length === 0) {
      return [];
    }

    // Bump usage_count/last_used_at for the returned rows (NOT updated_at — search
    // must not reshuffle the working set's recency order). Returns the fresh rows.
    const ids = ranked.map((entry) => entry.id);
    const bumped = await scopedDb
      .update(schema.knowledgeMemories)
      .set({
        usageCount: sql`${schema.knowledgeMemories.usageCount} + 1`,
        lastUsedAt: new Date(),
      })
      .where(
        and(
          eq(schema.knowledgeMemories.workspaceId, workspaceId),
          inArray(schema.knowledgeMemories.id, ids),
        ),
      )
      .returning();
    const byId = new Map(bumped.map((row) => [row.id, row] as const));

    const results: WorkspaceMemorySearchResult[] = [];
    for (const entry of ranked) {
      const row = byId.get(entry.id);
      if (!row) {
        continue;
      }
      results.push({
        memory: mapKnowledgeMemory(row),
        score: entry.score,
        matchType: entry.matchType,
        vectorScore: entry.vectorScore,
        keywordScore: entry.keywordScore,
      });
    }
    return results;
  });
}

// Render the per-turn working-set block for a workspace. Returns null when the
// workspace's memory setting is off (injection no-ops); the empty-state block
// when memory is on but there are zero visible records; otherwise the populated
// block. Pure rendering lives in memory-domain.ts.
export async function resolveWorkspaceMemoryBlock(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const [workspace] = await db
    .select({ settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!workspace || !resolveWorkspaceMemoryEnabled(workspace.settings)) {
    return null;
  }
  const records = await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb
        .select({
          id: schema.knowledgeMemories.id,
          kind: schema.knowledgeMemories.kind,
          text: schema.knowledgeMemories.text,
          pinned: schema.knowledgeMemories.pinned,
        })
        .from(schema.knowledgeMemories)
        .where(
          and(
            eq(schema.knowledgeMemories.workspaceId, workspaceId),
            inArray(schema.knowledgeMemories.status, agentVisibleMemoryStatuses),
            ne(schema.knowledgeMemories.kind, "episodic"),
          ),
        )
        .orderBy(desc(schema.knowledgeMemories.pinned), desc(schema.knowledgeMemories.updatedAt))
        .limit(MEMORY_BLOCK_RECORD_LIMIT),
  );
  if (records.length === 0) {
    return WORKSPACE_MEMORY_BLOCK_EMPTY;
  }
  const blockRecords: MemoryBlockRecord[] = records.map((row) => ({
    id: row.id,
    kind: row.kind as KnowledgeMemoryKind,
    text: row.text,
    pinned: row.pinned,
  }));
  return renderWorkspaceMemoryBlock(blockRecords) ?? WORKSPACE_MEMORY_BLOCK_EMPTY;
}

export async function createSocialConnection(
  db: Database,
  input: CreateSocialConnectionInput,
): Promise<SocialConnection> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.socialConnections)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          provider: input.provider,
          accountHandle: input.accountHandle,
          accountName: input.accountName ?? null,
          externalAccountId: input.externalAccountId ?? null,
          status: input.status,
          scopes: input.scopes ?? [],
          credentialRef: input.credentialRef ?? null,
          tokenMetadata: input.tokenMetadata ?? {},
          metadata: input.metadata ?? {},
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create social connection");
      }
      return mapSocialConnection(row);
    },
  );
}

export async function listSocialConnections(
  db: Database,
  workspaceId: string,
  limit = 100,
): Promise<SocialConnection[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.socialConnections)
      .where(eq(schema.socialConnections.workspaceId, workspaceId))
      .orderBy(desc(schema.socialConnections.createdAt))
      .limit(limit);
    return rows.map(mapSocialConnection);
  });
}

export async function getSocialConnection(
  db: Database,
  workspaceId: string,
  connectionId: string,
): Promise<SocialConnection | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.socialConnections)
      .where(
        and(
          eq(schema.socialConnections.workspaceId, workspaceId),
          eq(schema.socialConnections.id, connectionId),
        ),
      )
      .limit(1);
    return row ? mapSocialConnection(row) : null;
  });
}

export async function requireSocialConnection(
  db: Database,
  workspaceId: string,
  connectionId: string,
): Promise<SocialConnection> {
  const connection = await getSocialConnection(db, workspaceId, connectionId);
  if (!connection) {
    throw new Error(`Social connection not found: ${connectionId}`);
  }
  return connection;
}

export async function createSocialPost(
  db: Database,
  input: CreateSocialPostInput,
): Promise<SocialPost> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const connection = await requireSocialConnection(
        scopedDb,
        input.workspaceId,
        input.connectionId,
      );
      const [row] = await scopedDb
        .insert(schema.socialPosts)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          provider: connection.provider,
          externalPostId: input.externalPostId ?? null,
          url: input.url ?? null,
          authorHandle: input.authorHandle ?? connection.accountHandle,
          text: input.text,
          publishedAt: input.publishedAt,
          metrics: input.metrics ?? {},
          raw: input.raw ?? {},
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create social post");
      }
      return mapSocialPost(row);
    },
  );
}

export async function listSocialPosts(
  db: Database,
  options: {
    workspaceId: string;
    connectionIds?: string[];
    since?: Date;
    limit?: number;
  },
): Promise<SocialPost[]> {
  const conditions: SQL[] = [eq(schema.socialPosts.workspaceId, options.workspaceId)];
  if (options.connectionIds?.length) {
    conditions.push(inArray(schema.socialPosts.connectionId, options.connectionIds));
  }
  if (options.since) {
    conditions.push(gte(schema.socialPosts.publishedAt, options.since));
  }
  const limit = options.limit ?? 100;
  return await withWorkspaceRls(db, options.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.socialPosts)
      .where(and(...conditions))
      .orderBy(desc(schema.socialPosts.publishedAt))
      .limit(limit);
    return rows.map(mapSocialPost);
  });
}

export async function createScheduledTask(
  db: Database,
  input: CreateScheduledTaskInput,
): Promise<ScheduledTask> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb.insert(schema.scheduledTasks).values(input).returning();
      if (!row) {
        throw new Error("Failed to create scheduled task");
      }
      return mapScheduledTask(row);
    },
  );
}

export async function updateScheduledTask(
  db: Database,
  workspaceId: string,
  taskId: string,
  input: UpdateScheduledTaskInput,
): Promise<ScheduledTask> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.scheduledTasks)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.runMode !== undefined ? { runMode: input.runMode } : {}),
        ...(input.overlapPolicy !== undefined ? { overlapPolicy: input.overlapPolicy } : {}),
        ...(input.agentConfig !== undefined ? { agentConfig: input.agentConfig } : {}),
        ...(input.reusableSessionId !== undefined
          ? { reusableSessionId: input.reusableSessionId }
          : {}),
        ...(input.variableSetId !== undefined ? { variableSetId: input.variableSetId } : {}),
        ...(input.rigId !== undefined ? { rigId: input.rigId } : {}),
        ...(input.rigDefaultVariableSetsAuthorized !== undefined
          ? {
              rigDefaultVariableSetsAuthorized: input.rigDefaultVariableSetsAuthorized,
            }
          : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, workspaceId),
          eq(schema.scheduledTasks.id, taskId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    return mapScheduledTask(row);
  });
}

export async function getScheduledTask(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<ScheduledTask | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, workspaceId),
          eq(schema.scheduledTasks.id, taskId),
        ),
      )
      .limit(1);
    return row ? mapScheduledTask(row) : null;
  });
}

export async function requireScheduledTask(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<ScheduledTask> {
  const task = await getScheduledTask(db, workspaceId, taskId);
  if (!task) {
    throw new Error(`Scheduled task not found: ${taskId}`);
  }
  return task;
}

export async function listScheduledTasks(
  db: Database,
  workspaceId: string,
  limit = 100,
): Promise<ScheduledTask[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.workspaceId, workspaceId))
      .orderBy(desc(schema.scheduledTasks.createdAt))
      .limit(limit);
    return rows.map(mapScheduledTask);
  });
}

export async function deleteScheduledTask(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .delete(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, workspaceId),
          eq(schema.scheduledTasks.id, taskId),
        ),
      );
  });
}

export async function createScheduledTaskRun(
  db: Database,
  input: {
    workspaceId: string;
    taskId: string;
    triggerType: ScheduledTaskTriggerType;
    /** Stable Temporal workflow/activity producer identity for replay repair. */
    producerKey?: string | null;
    scheduledAt?: Date | null;
    firedAt?: Date;
  },
): Promise<ScheduledTaskRun> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [taskRow] = await scopedDb
      .select()
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, input.workspaceId),
          eq(schema.scheduledTasks.id, input.taskId),
        ),
      )
      .limit(1);
    if (!taskRow) {
      throw new Error(`Scheduled task not found: ${input.taskId}`);
    }
    const values = {
      accountId: taskRow.accountId,
      workspaceId: taskRow.workspaceId,
      taskId: input.taskId,
      triggerType: input.triggerType,
      producerKey: input.producerKey ?? null,
      scheduledAt: input.scheduledAt ?? null,
      firedAt: input.firedAt ?? new Date(),
      status: "queued" as const,
    };
    const [inserted] = input.producerKey
      ? await scopedDb
          .insert(schema.scheduledTaskRuns)
          .values(values)
          .onConflictDoNothing({
            target: [schema.scheduledTaskRuns.workspaceId, schema.scheduledTaskRuns.producerKey],
            where: sql`${schema.scheduledTaskRuns.producerKey} is not null`,
          })
          .returning()
      : await scopedDb.insert(schema.scheduledTaskRuns).values(values).returning();
    const [row] = inserted
      ? [inserted]
      : await scopedDb
          .select()
          .from(schema.scheduledTaskRuns)
          .where(
            and(
              eq(schema.scheduledTaskRuns.workspaceId, input.workspaceId),
              eq(schema.scheduledTaskRuns.producerKey, input.producerKey!),
            ),
          )
          .limit(1);
    if (!row) {
      throw new Error("Failed to create scheduled task run");
    }
    return mapScheduledTaskRun(row);
  });
}

/** Failure settlement must not rewrite a source already committed as dispatched. */
export async function markScheduledTaskRunFailedIfQueued(
  db: Database,
  workspaceId: string,
  runId: string,
  error: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.scheduledTaskRuns)
      .set({ status: "failed", error, updatedAt: new Date() })
      .where(
        and(
          eq(schema.scheduledTaskRuns.workspaceId, workspaceId),
          eq(schema.scheduledTaskRuns.id, runId),
          eq(schema.scheduledTaskRuns.status, "queued"),
        ),
      );
  });
}

export async function updateScheduledTaskRun(
  db: Database,
  workspaceId: string,
  runId: string,
  input: Partial<{
    status: ScheduledTaskRunStatus;
    sessionId: string | null;
    triggerEventId: string | null;
    error: string | null;
  }>,
): Promise<ScheduledTaskRun> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.scheduledTaskRuns)
      .set({
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.triggerEventId !== undefined ? { triggerEventId: input.triggerEventId } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.scheduledTaskRuns.workspaceId, workspaceId),
          eq(schema.scheduledTaskRuns.id, runId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Scheduled task run not found: ${runId}`);
    }
    return mapScheduledTaskRun(row);
  });
}

/** DB-only source mutation callback for durable scheduled delivery. */
export async function settleScheduledTaskRunInTransaction(
  tx: Database,
  input: {
    workspaceId: string;
    runId: string;
    sessionId: string;
    triggerEventId: string;
    status: "dispatched";
  },
): Promise<void> {
  const [row] = await tx
    .update(schema.scheduledTaskRuns)
    .set({
      status: input.status,
      sessionId: input.sessionId,
      triggerEventId: input.triggerEventId,
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.scheduledTaskRuns.workspaceId, input.workspaceId),
        eq(schema.scheduledTaskRuns.id, input.runId),
        inArray(schema.scheduledTaskRuns.status, ["queued", "dispatched"]),
      ),
    )
    .returning({ id: schema.scheduledTaskRuns.id });
  if (!row) throw new Error(`Scheduled task run not dispatchable: ${input.runId}`);
}

export async function listScheduledTaskRuns(
  db: Database,
  workspaceId: string,
  taskId: string,
  limit = 100,
): Promise<ScheduledTaskRun[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.scheduledTaskRuns)
      .where(
        and(
          eq(schema.scheduledTaskRuns.workspaceId, workspaceId),
          eq(schema.scheduledTaskRuns.taskId, taskId),
        ),
      )
      .orderBy(desc(schema.scheduledTaskRuns.createdAt))
      .limit(limit);
    return rows.map(mapScheduledTaskRun);
  });
}

export async function createVariableSet(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    description?: string | null;
    variables?: Array<{ name: string; valueEncrypted: string }>;
  },
): Promise<VariableSet> {
  // withRlsContext wraps the callback in one transaction, so the variableSet
  // row and all initial variables commit or roll back together.
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.workspaceVariableSets)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description ?? null,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create variable set");
      }
      const variables = input.variables ?? [];
      if (variables.length === 0) {
        return mapVariableSet(row, []);
      }
      const inserted = await scopedDb
        .insert(schema.workspaceVariableSetVariables)
        .values(
          variables.map((variable) => ({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            variableSetId: row.id,
            name: variable.name,
            valueEncrypted: variable.valueEncrypted,
          })),
        )
        .returning({
          name: schema.workspaceVariableSetVariables.name,
          version: schema.workspaceVariableSetVariables.version,
          createdAt: schema.workspaceVariableSetVariables.createdAt,
          updatedAt: schema.workspaceVariableSetVariables.updatedAt,
        });
      return mapVariableSet(
        row,
        inserted.map(mapVariableSetVariableMetadata).sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
  );
}

export async function listVariableSets(db: Database, workspaceId: string): Promise<VariableSet[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceVariableSets)
      .where(eq(schema.workspaceVariableSets.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceVariableSets.createdAt));
    const variableRows = await scopedDb
      .select({
        variableSetId: schema.workspaceVariableSetVariables.variableSetId,
        name: schema.workspaceVariableSetVariables.name,
        version: schema.workspaceVariableSetVariables.version,
        createdAt: schema.workspaceVariableSetVariables.createdAt,
        updatedAt: schema.workspaceVariableSetVariables.updatedAt,
      })
      .from(schema.workspaceVariableSetVariables)
      .where(eq(schema.workspaceVariableSetVariables.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceVariableSetVariables.name));
    const grouped = new Map<string, VariableSetVariableMetadata[]>();
    for (const variable of variableRows) {
      const list = grouped.get(variable.variableSetId) ?? [];
      list.push(mapVariableSetVariableMetadata(variable));
      grouped.set(variable.variableSetId, list);
    }
    return rows.map((row) => mapVariableSet(row, grouped.get(row.id) ?? []));
  });
}

export async function getVariableSet(
  db: Database,
  workspaceId: string,
  variableSetId: string,
): Promise<VariableSet | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceVariableSets)
      .where(
        and(
          eq(schema.workspaceVariableSets.workspaceId, workspaceId),
          eq(schema.workspaceVariableSets.id, variableSetId),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return mapVariableSet(
      row,
      await listVariableSetVariableMetadata(scopedDb, workspaceId, variableSetId),
    );
  });
}

export async function getVariableSetByName(
  db: Database,
  workspaceId: string,
  name: string,
): Promise<VariableSet | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceVariableSets)
      .where(
        and(
          eq(schema.workspaceVariableSets.workspaceId, workspaceId),
          eq(schema.workspaceVariableSets.name, name),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return mapVariableSet(
      row,
      await listVariableSetVariableMetadata(scopedDb, workspaceId, row.id),
    );
  });
}

export async function updateVariableSet(
  db: Database,
  workspaceId: string,
  variableSetId: string,
  input: {
    name?: string;
    description?: string | null;
  },
): Promise<VariableSet> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.workspaceVariableSets)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workspaceVariableSets.workspaceId, workspaceId),
          eq(schema.workspaceVariableSets.id, variableSetId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Variable set not found: ${variableSetId}`);
    }
    return mapVariableSet(
      row,
      await listVariableSetVariableMetadata(scopedDb, workspaceId, variableSetId),
    );
  });
}

export async function deleteVariableSet(
  db: Database,
  workspaceId: string,
  variableSetId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.workspaceVariableSets)
      .where(
        and(
          eq(schema.workspaceVariableSets.workspaceId, workspaceId),
          eq(schema.workspaceVariableSets.id, variableSetId),
        ),
      )
      .returning({ id: schema.workspaceVariableSets.id });
    return rows.length > 0;
  });
}

export async function countVariableSets(db: Database, workspaceId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(schema.workspaceVariableSets)
      .where(eq(schema.workspaceVariableSets.workspaceId, workspaceId));
    return Number(count);
  });
}

export async function countScheduledTasksUsingVariableSet(
  db: Database,
  workspaceId: string,
  variableSetId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(schema.scheduledTasks)
      .where(
        and(
          eq(schema.scheduledTasks.workspaceId, workspaceId),
          eq(schema.scheduledTasks.variableSetId, variableSetId),
        ),
      );
    return Number(count);
  });
}

export async function countActiveSessionsUsingVariableSet(
  db: Database,
  workspaceId: string,
  variableSetId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.variableSetId, variableSetId),
          inArray(schema.sessions.status, ["queued", "running", "requires_action"]),
        ),
      );
    return Number(count);
  });
}

export async function setVariableSetVariable(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    variableSetId: string;
    name: string;
    valueEncrypted: string;
  },
): Promise<VariableSetVariableMetadata> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      const [row] = await scopedDb
        .insert(schema.workspaceVariableSetVariables)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          variableSetId: input.variableSetId,
          name: input.name,
          valueEncrypted: input.valueEncrypted,
        })
        .onConflictDoUpdate({
          target: [
            schema.workspaceVariableSetVariables.workspaceId,
            schema.workspaceVariableSetVariables.variableSetId,
            schema.workspaceVariableSetVariables.name,
          ],
          set: {
            valueEncrypted: input.valueEncrypted,
            version: sql`${schema.workspaceVariableSetVariables.version} + 1`,
            updatedAt: now,
          },
        })
        .returning({
          name: schema.workspaceVariableSetVariables.name,
          version: schema.workspaceVariableSetVariables.version,
          createdAt: schema.workspaceVariableSetVariables.createdAt,
          updatedAt: schema.workspaceVariableSetVariables.updatedAt,
        });
      if (!row) {
        throw new Error("Failed to set variable set variable");
      }
      await scopedDb
        .update(schema.workspaceVariableSets)
        .set({ updatedAt: now })
        .where(
          and(
            eq(schema.workspaceVariableSets.workspaceId, input.workspaceId),
            eq(schema.workspaceVariableSets.id, input.variableSetId),
          ),
        );
      return mapVariableSetVariableMetadata(row);
    },
  );
}

export async function deleteVariableSetVariable(
  db: Database,
  workspaceId: string,
  variableSetId: string,
  name: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.workspaceVariableSetVariables)
      .where(
        and(
          eq(schema.workspaceVariableSetVariables.workspaceId, workspaceId),
          eq(schema.workspaceVariableSetVariables.variableSetId, variableSetId),
          eq(schema.workspaceVariableSetVariables.name, name),
        ),
      )
      .returning({ id: schema.workspaceVariableSetVariables.id });
    if (rows.length > 0) {
      await scopedDb
        .update(schema.workspaceVariableSets)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(schema.workspaceVariableSets.workspaceId, workspaceId),
            eq(schema.workspaceVariableSets.id, variableSetId),
          ),
        );
    }
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Rigs (migration 0047). Workspace-scoped, versioned sandbox machine definitions.
// Versions are append-only + content-immutable: NO function below ever UPDATEs a
// content column of rig_versions — only activateRigVersion flips the `active`
// boolean. Every function runs through withWorkspaceRls / withRlsContext.
// ---------------------------------------------------------------------------

// Thrown when a rig_change status transition is illegal. The domain/route layer
// maps this to a 409.
export class RigChangeTransitionError extends Error {
  constructor(
    public readonly changeId: string,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(`Rig change ${changeId} is ${fromStatus}; cannot transition to ${toStatus}`);
    this.name = "RigChangeTransitionError";
  }
}

export class RigActiveVersionChangedError extends Error {
  constructor(
    public readonly rigId: string,
    public readonly expectedVersionId: string,
    public readonly actualVersionId: string | null,
  ) {
    super(
      `Rig ${rigId} moved since verification: expected active ${expectedVersionId}, current active ${actualVersionId ?? "none"}`,
    );
    this.name = "RigActiveVersionChangedError";
  }
}

export class RigChangeAlreadyVerifyingError extends Error {
  constructor(public readonly changeId: string) {
    super(`Rig change ${changeId} is already verifying`);
    this.name = "RigChangeAlreadyVerifyingError";
  }
}

export class RigChangeIdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super("Rig change idempotency key was already used with different proposal content");
    this.name = "RigChangeIdempotencyConflictError";
  }
}

export class RigVerificationAttemptChangedError extends Error {
  constructor(
    public readonly changeId: string,
    public readonly expectedAttempt: number,
    public readonly actualAttempt: number | null,
    public readonly actualStatus: string,
  ) {
    super(
      `Rig change ${changeId} verification attempt moved: expected ${expectedAttempt}, current ${actualAttempt ?? "none"} (${actualStatus})`,
    );
    this.name = "RigVerificationAttemptChangedError";
  }
}

export type RigVersionContentInput = {
  image?: string | null;
  setupScript?: string | null;
  checks?: RigCheck[];
  credentialHooks?: string[];
  defaultVariableSetIds?: string[];
  changelog?: string | null;
  createdBy?: string | null;
};

function mapRigVersion(row: typeof schema.rigVersions.$inferSelect): RigVersion {
  return {
    id: row.id,
    rigId: row.rigId,
    version: row.version,
    image: row.image,
    setupScript: row.setupScript,
    checks: row.checks,
    credentialHooks: row.credentialHooks,
    defaultVariableSetIds: row.defaultVariableSetIds,
    changelog: row.changelog,
    createdBy: row.createdBy,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

function unknownRigHealth(activeVersion: RigVersion | null): RigVerificationHealth | null {
  return activeVersion
    ? {
        checkHealth: activeVersion.checks.length === 0 ? "not_configured" : "unknown",
        lastVerifiedAt: null,
      }
    : null;
}

function mapRig(
  row: typeof schema.rigs.$inferSelect,
  activeVersion: RigVersion | null,
  versionCount: number,
  activeVersionHealth: RigVerificationHealth | null = unknownRigHealth(activeVersion),
): Rig {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    activeVersion,
    activeVersionHealth,
    versionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRigChange(row: typeof schema.rigChanges.$inferSelect): RigChange {
  return {
    id: row.id,
    rigId: row.rigId,
    baseVersionId: row.baseVersionId,
    kind: row.kind as RigChangeKind,
    payload: RigChangeContract.shape.payload.parse(row.payload),
    status: row.status as RigChangeStatus,
    proposedBy: row.proposedBy,
    idempotencyKey: row.idempotencyKey ?? null,
    verification: (row.verification ?? null) as RigChange["verification"],
    resultVersionId: row.resultVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Load a rig's active version + total version count within an existing RLS scope.
async function loadRigActiveAndCount(
  scopedDb: Database,
  workspaceId: string,
  rigId: string,
): Promise<{ activeVersion: RigVersion | null; versionCount: number }> {
  const [activeRow] = await scopedDb
    .select()
    .from(schema.rigVersions)
    .where(
      and(
        eq(schema.rigVersions.workspaceId, workspaceId),
        eq(schema.rigVersions.rigId, rigId),
        eq(schema.rigVersions.active, true),
      ),
    )
    .limit(1);
  const [{ count } = { count: 0 }] = await scopedDb
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.rigVersions)
    .where(
      and(eq(schema.rigVersions.workspaceId, workspaceId), eq(schema.rigVersions.rigId, rigId)),
    );
  return {
    activeVersion: activeRow ? mapRigVersion(activeRow) : null,
    versionCount: Number(count),
  };
}

type RigHealthCandidate = {
  versionId: string;
  checkHealth: "passing" | "failing";
  verifiedAt: string;
};

function latestRigHealth(candidates: RigHealthCandidate[]): RigVerificationHealth {
  let latest: RigHealthCandidate | null = null;
  for (const candidate of candidates) {
    if (!latest || Date.parse(candidate.verifiedAt) >= Date.parse(latest.verifiedAt)) {
      latest = candidate;
    }
  }
  return latest
    ? { checkHealth: latest.checkHealth, lastVerifiedAt: latest.verifiedAt }
    : { checkHealth: "unknown", lastVerifiedAt: null };
}

function verificationTimestamp(
  verification: Record<string, unknown> | null | undefined,
  fallback: Date,
): string {
  return typeof verification?.finishedAt === "string"
    ? verification.finishedAt
    : fallback.toISOString();
}

async function loadRigHealthByActiveVersion(
  scopedDb: Database,
  workspaceId: string,
  activeVersions: RigVersion[],
): Promise<Map<string, RigVerificationHealth>> {
  const versionIds = activeVersions.map((version) => version.id);
  const versionById = new Map(activeVersions.map((version) => [version.id, version]));
  const healthByVersion: Map<string, RigVerificationHealth> = new Map(
    activeVersions.map((version) => [version.id, unknownRigHealth(version)!]),
  );
  if (versionIds.length === 0) {
    return healthByVersion;
  }
  const candidatesByVersion = new Map<string, RigHealthCandidate[]>();
  const pushCandidate = (candidate: RigHealthCandidate) => {
    candidatesByVersion.set(candidate.versionId, [
      ...(candidatesByVersion.get(candidate.versionId) ?? []),
      candidate,
    ]);
  };

  const changes = await scopedDb
    .select({
      resultVersionId: schema.rigChanges.resultVersionId,
      verification: schema.rigChanges.verification,
      updatedAt: schema.rigChanges.updatedAt,
    })
    .from(schema.rigChanges)
    .where(
      and(
        eq(schema.rigChanges.workspaceId, workspaceId),
        inArray(schema.rigChanges.resultVersionId, versionIds),
      ),
    );
  for (const change of changes) {
    if (!change.resultVersionId) {
      continue;
    }
    const verification = (change.verification ?? null) as Record<string, unknown> | null;
    if (verification?.passed === true) {
      pushCandidate({
        versionId: change.resultVersionId,
        checkHealth: "passing",
        verifiedAt: verificationTimestamp(verification, change.updatedAt),
      });
    } else if (verification?.passed === false) {
      pushCandidate({
        versionId: change.resultVersionId,
        checkHealth: "failing",
        verifiedAt: verificationTimestamp(verification, change.updatedAt),
      });
    }
  }

  const auditRows = await scopedDb
    .select({
      action: schema.auditEvents.action,
      metadata: schema.auditEvents.metadata,
      occurredAt: schema.auditEvents.occurredAt,
    })
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.workspaceId, workspaceId),
        eq(schema.auditEvents.targetType, "rig"),
        inArray(schema.auditEvents.action, ["rig.verification.passed", "rig.verification.failed"]),
        inArray(sql<string>`${schema.auditEvents.metadata}->>'versionId'`, versionIds),
      ),
    );
  for (const row of auditRows) {
    const metadata = row.metadata ?? {};
    const versionId = typeof metadata.versionId === "string" ? metadata.versionId : null;
    if (!versionId || !healthByVersion.has(versionId)) {
      continue;
    }
    const passed =
      typeof metadata.passed === "boolean"
        ? metadata.passed
        : row.action === "rig.verification.passed";
    pushCandidate({
      versionId,
      checkHealth: passed ? "passing" : "failing",
      verifiedAt:
        typeof metadata.finishedAt === "string"
          ? metadata.finishedAt
          : row.occurredAt.toISOString(),
    });
  }

  for (const versionId of versionIds) {
    const version = versionById.get(versionId)!;
    healthByVersion.set(
      versionId,
      version.checks.length === 0
        ? { checkHealth: "not_configured", lastVerifiedAt: null }
        : latestRigHealth(candidatesByVersion.get(versionId) ?? []),
    );
  }
  return healthByVersion;
}

// Creates the rig row AND its version 1 (active) in one transaction: a failure
// leaves nothing behind. version-1 content comes from `initialVersion`.
export async function createRig(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    name: string;
    description?: string | null;
    createdBy?: string | null;
    initialVersion?: RigVersionContentInput;
  },
): Promise<Rig> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [rigRow] = await scopedDb
        .insert(schema.rigs)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      if (!rigRow) {
        throw new Error("Failed to create rig");
      }
      const content = input.initialVersion ?? {};
      const [versionRow] = await scopedDb
        .insert(schema.rigVersions)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          rigId: rigRow.id,
          version: 1,
          image: content.image ?? null,
          setupScript: content.setupScript ?? null,
          checks: content.checks ?? [],
          credentialHooks: content.credentialHooks ?? [],
          defaultVariableSetIds: content.defaultVariableSetIds ?? [],
          changelog: content.changelog ?? null,
          createdBy: content.createdBy ?? input.createdBy ?? null,
          active: true,
        })
        .returning();
      if (!versionRow) {
        throw new Error("Failed to create initial rig version");
      }
      return mapRig(rigRow, mapRigVersion(versionRow), 1);
    },
  );
}

export async function listRigs(db: Database, workspaceId: string): Promise<Rig[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.rigs)
      .where(eq(schema.rigs.workspaceId, workspaceId))
      .orderBy(asc(schema.rigs.createdAt));
    if (rows.length === 0) {
      return [];
    }
    const activeRows = await scopedDb
      .select()
      .from(schema.rigVersions)
      .where(
        and(eq(schema.rigVersions.workspaceId, workspaceId), eq(schema.rigVersions.active, true)),
      );
    const activeByRig = new Map(activeRows.map((row) => [row.rigId, mapRigVersion(row)]));
    const healthByVersion = await loadRigHealthByActiveVersion(scopedDb, workspaceId, [
      ...activeByRig.values(),
    ]);
    const countRows = await scopedDb
      .select({
        rigId: schema.rigVersions.rigId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.rigVersions)
      .where(eq(schema.rigVersions.workspaceId, workspaceId))
      .groupBy(schema.rigVersions.rigId);
    const countByRig = new Map(countRows.map((row) => [row.rigId, Number(row.count)]));
    return rows.map((row) => {
      const activeVersion = activeByRig.get(row.id) ?? null;
      return mapRig(
        row,
        activeVersion,
        countByRig.get(row.id) ?? 0,
        activeVersion
          ? (healthByVersion.get(activeVersion.id) ?? unknownRigHealth(activeVersion))
          : null,
      );
    });
  });
}

export async function getRig(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<Rig | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .limit(1);
    if (!row) {
      return null;
    }
    const { activeVersion, versionCount } = await loadRigActiveAndCount(
      scopedDb,
      workspaceId,
      rigId,
    );
    const healthByVersion = await loadRigHealthByActiveVersion(
      scopedDb,
      workspaceId,
      activeVersion ? [activeVersion] : [],
    );
    return mapRig(
      row,
      activeVersion,
      versionCount,
      activeVersion
        ? (healthByVersion.get(activeVersion.id) ?? unknownRigHealth(activeVersion))
        : null,
    );
  });
}

export async function getRigByName(
  db: Database,
  workspaceId: string,
  name: string,
): Promise<Rig | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.name, name)))
      .limit(1);
    if (!row) {
      return null;
    }
    const { activeVersion, versionCount } = await loadRigActiveAndCount(
      scopedDb,
      workspaceId,
      row.id,
    );
    const healthByVersion = await loadRigHealthByActiveVersion(
      scopedDb,
      workspaceId,
      activeVersion ? [activeVersion] : [],
    );
    return mapRig(
      row,
      activeVersion,
      versionCount,
      activeVersion
        ? (healthByVersion.get(activeVersion.id) ?? unknownRigHealth(activeVersion))
        : null,
    );
  });
}

// name/description only — never touches versions (content immutability).
export async function updateRig(
  db: Database,
  workspaceId: string,
  rigId: string,
  input: {
    name?: string;
    description?: string | null;
  },
): Promise<Rig> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.rigs)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .returning();
    if (!row) {
      throw new Error(`Rig not found: ${rigId}`);
    }
    const { activeVersion, versionCount } = await loadRigActiveAndCount(
      scopedDb,
      workspaceId,
      rigId,
    );
    const healthByVersion = await loadRigHealthByActiveVersion(
      scopedDb,
      workspaceId,
      activeVersion ? [activeVersion] : [],
    );
    return mapRig(
      row,
      activeVersion,
      versionCount,
      activeVersion
        ? (healthByVersion.get(activeVersion.id) ?? unknownRigHealth(activeVersion))
        : null,
    );
  });
}

export async function deleteRig(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .returning({ id: schema.rigs.id });
    return rows.length > 0;
  });
}

export async function deleteRigIfNoActiveSessions(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<{ deleted: boolean; activeSessionCount: number }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [rig] = await scopedDb
      .select({ id: schema.rigs.id })
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .for("update")
      .limit(1);
    if (!rig) {
      return { deleted: false, activeSessionCount: 0 };
    }
    const [{ count } = { count: 0 }] = await scopedDb
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.rigId, rigId),
          sql`${schema.sessions.status} not in ('failed', 'cancelled')`,
        ),
      );
    const activeSessionCount = Number(count);
    if (activeSessionCount > 0) {
      return { deleted: false, activeSessionCount };
    }
    const rows = await scopedDb
      .delete(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .returning({ id: schema.rigs.id });
    return { deleted: rows.length > 0, activeSessionCount };
  });
}

export async function countRigs(db: Database, workspaceId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.rigs)
      .where(eq(schema.rigs.workspaceId, workspaceId));
    return Number(count);
  });
}

export async function countSessionsUsingRig(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.rigId, rigId)));
    return Number(count);
  });
}

// Mints the next version for a rig (promote/rollback-mint paths, M4). Row-locks
// the rig so concurrent mints get strictly-monotonic version numbers. When
// `activate` is set, atomically deactivates the current active version first.
export async function createRigVersion(
  db: Database,
  workspaceId: string,
  rigId: string,
  input: RigVersionContentInput,
  options: { activate?: boolean } = {},
): Promise<RigVersion> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [rig] = await scopedDb
      .select({ id: schema.rigs.id, accountId: schema.rigs.accountId })
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .for("update")
      .limit(1);
    if (!rig) {
      throw new Error(`Rig not found: ${rigId}`);
    }
    const [{ max } = { max: 0 }] = await scopedDb
      .select({
        max: sql<number>`coalesce(max(${schema.rigVersions.version}), 0)::int`,
      })
      .from(schema.rigVersions)
      .where(
        and(eq(schema.rigVersions.workspaceId, workspaceId), eq(schema.rigVersions.rigId, rigId)),
      );
    const nextVersion = Number(max) + 1;
    if (options.activate) {
      await scopedDb
        .update(schema.rigVersions)
        .set({ active: false })
        .where(
          and(
            eq(schema.rigVersions.workspaceId, workspaceId),
            eq(schema.rigVersions.rigId, rigId),
            eq(schema.rigVersions.active, true),
          ),
        );
    }
    const [row] = await scopedDb
      .insert(schema.rigVersions)
      .values({
        accountId: rig.accountId,
        workspaceId,
        rigId,
        version: nextVersion,
        image: input.image ?? null,
        setupScript: input.setupScript ?? null,
        checks: input.checks ?? [],
        credentialHooks: input.credentialHooks ?? [],
        defaultVariableSetIds: input.defaultVariableSetIds ?? [],
        changelog: input.changelog ?? null,
        createdBy: input.createdBy ?? null,
        active: options.activate ?? false,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create rig version");
    }
    await scopedDb
      .update(schema.rigs)
      .set({ updatedAt: new Date() })
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)));
    return mapRigVersion(row);
  });
}

export async function createRigVersionForChangePromotion(
  db: Database,
  workspaceId: string,
  rigId: string,
  changeId: string,
  input: RigVersionContentInput & {
    expectedActiveVersionId: string;
  },
): Promise<{ version: RigVersion; change: RigChange; promoted: boolean }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [rig] = await scopedDb
      .select({ id: schema.rigs.id, accountId: schema.rigs.accountId })
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .for("update")
      .limit(1);
    if (!rig) {
      throw new Error(`Rig not found: ${rigId}`);
    }
    const [currentChange] = await scopedDb
      .select()
      .from(schema.rigChanges)
      .where(
        and(
          eq(schema.rigChanges.workspaceId, workspaceId),
          eq(schema.rigChanges.rigId, rigId),
          eq(schema.rigChanges.id, changeId),
        ),
      )
      .for("update")
      .limit(1);
    if (!currentChange) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    if (currentChange.status === "merged") {
      if (!currentChange.resultVersionId) {
        throw new RigChangeTransitionError(changeId, currentChange.status, "merged");
      }
      const [existingVersion] = await scopedDb
        .select()
        .from(schema.rigVersions)
        .where(
          and(
            eq(schema.rigVersions.workspaceId, workspaceId),
            eq(schema.rigVersions.rigId, rigId),
            eq(schema.rigVersions.id, currentChange.resultVersionId),
          ),
        )
        .limit(1);
      if (!existingVersion) {
        throw new Error(`Promoted rig version not found: ${currentChange.resultVersionId}`);
      }
      return {
        version: mapRigVersion(existingVersion),
        change: mapRigChange(currentChange),
        promoted: false,
      };
    }
    if (currentChange.status === "rejected") {
      throw new RigChangeTransitionError(changeId, currentChange.status, "merged");
    }
    const verification = (currentChange.verification ?? null) as Record<string, unknown> | null;
    if (currentChange.status !== "proposed" || verification?.passed !== true) {
      throw new RigChangeTransitionError(changeId, currentChange.status, "merged");
    }
    if (currentChange.baseVersionId !== input.expectedActiveVersionId) {
      throw new RigActiveVersionChangedError(
        rigId,
        input.expectedActiveVersionId,
        currentChange.baseVersionId,
      );
    }
    const [active] = await scopedDb
      .select({ id: schema.rigVersions.id })
      .from(schema.rigVersions)
      .where(
        and(
          eq(schema.rigVersions.workspaceId, workspaceId),
          eq(schema.rigVersions.rigId, rigId),
          eq(schema.rigVersions.active, true),
        ),
      )
      .limit(1);
    if (active?.id !== input.expectedActiveVersionId) {
      throw new RigActiveVersionChangedError(
        rigId,
        input.expectedActiveVersionId,
        active?.id ?? null,
      );
    }
    const [{ max } = { max: 0 }] = await scopedDb
      .select({
        max: sql<number>`coalesce(max(${schema.rigVersions.version}), 0)::int`,
      })
      .from(schema.rigVersions)
      .where(
        and(eq(schema.rigVersions.workspaceId, workspaceId), eq(schema.rigVersions.rigId, rigId)),
      );
    const nextVersion = Number(max) + 1;
    await scopedDb
      .update(schema.rigVersions)
      .set({ active: false })
      .where(
        and(
          eq(schema.rigVersions.workspaceId, workspaceId),
          eq(schema.rigVersions.rigId, rigId),
          eq(schema.rigVersions.active, true),
        ),
      );
    const [versionRow] = await scopedDb
      .insert(schema.rigVersions)
      .values({
        accountId: rig.accountId,
        workspaceId,
        rigId,
        version: nextVersion,
        image: input.image ?? null,
        setupScript: input.setupScript ?? null,
        checks: input.checks ?? [],
        credentialHooks: input.credentialHooks ?? [],
        defaultVariableSetIds: input.defaultVariableSetIds ?? [],
        changelog: input.changelog ?? null,
        createdBy: input.createdBy ?? null,
        active: true,
      })
      .returning();
    if (!versionRow) {
      throw new Error("Failed to create rig version");
    }
    const [changeRow] = await scopedDb
      .update(schema.rigChanges)
      .set({
        status: "merged",
        resultVersionId: versionRow.id,
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .returning();
    if (!changeRow) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    await scopedDb
      .update(schema.rigs)
      .set({ updatedAt: new Date() })
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)));
    return {
      version: mapRigVersion(versionRow),
      change: mapRigChange(changeRow),
      promoted: true,
    };
  });
}

export async function listRigVersions(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<RigVersion[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.rigVersions)
      .where(
        and(eq(schema.rigVersions.workspaceId, workspaceId), eq(schema.rigVersions.rigId, rigId)),
      )
      .orderBy(desc(schema.rigVersions.version));
    return rows.map(mapRigVersion);
  });
}

export async function getRigVersion(
  db: Database,
  workspaceId: string,
  rigId: string,
  versionId: string,
): Promise<RigVersion | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.rigVersions)
      .where(
        and(
          eq(schema.rigVersions.workspaceId, workspaceId),
          eq(schema.rigVersions.rigId, rigId),
          eq(schema.rigVersions.id, versionId),
        ),
      )
      .limit(1);
    return row ? mapRigVersion(row) : null;
  });
}

export async function getRigVersionById(
  db: Database,
  workspaceId: string,
  versionId: string,
): Promise<RigVersion | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.rigVersions)
      .where(
        and(eq(schema.rigVersions.workspaceId, workspaceId), eq(schema.rigVersions.id, versionId)),
      )
      .limit(1);
    return row ? mapRigVersion(row) : null;
  });
}

// M3 runtime: the rig's display name only (for the turn's doctrine block + setup
// events/errors), without the extra active-version + count reads getRig does.
export async function getRigName(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<string | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ name: schema.rigs.name })
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .limit(1);
    return row?.name ?? null;
  });
}

// Flips which version is active (rollback / promote-activate). Row-locks the rig
// to serialize concurrent activations, deactivates the current active, activates
// the target. Only touches the `active` flag — never content.
export async function activateRigVersion(
  db: Database,
  workspaceId: string,
  rigId: string,
  versionId: string,
): Promise<RigVersion> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [rig] = await scopedDb
      .select({ id: schema.rigs.id })
      .from(schema.rigs)
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)))
      .for("update")
      .limit(1);
    if (!rig) {
      throw new Error(`Rig not found: ${rigId}`);
    }
    const [target] = await scopedDb
      .select({ id: schema.rigVersions.id })
      .from(schema.rigVersions)
      .where(
        and(
          eq(schema.rigVersions.workspaceId, workspaceId),
          eq(schema.rigVersions.rigId, rigId),
          eq(schema.rigVersions.id, versionId),
        ),
      )
      .limit(1);
    if (!target) {
      throw new Error(`Rig version not found: ${versionId}`);
    }
    await scopedDb
      .update(schema.rigVersions)
      .set({ active: false })
      .where(
        and(
          eq(schema.rigVersions.workspaceId, workspaceId),
          eq(schema.rigVersions.rigId, rigId),
          eq(schema.rigVersions.active, true),
        ),
      );
    const [row] = await scopedDb
      .update(schema.rigVersions)
      .set({ active: true })
      .where(
        and(
          eq(schema.rigVersions.workspaceId, workspaceId),
          eq(schema.rigVersions.rigId, rigId),
          eq(schema.rigVersions.id, versionId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Rig version not found: ${versionId}`);
    }
    await scopedDb
      .update(schema.rigs)
      .set({ updatedAt: new Date() })
      .where(and(eq(schema.rigs.workspaceId, workspaceId), eq(schema.rigs.id, rigId)));
    return mapRigVersion(row);
  });
}

export async function createRigChange(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    rigId: string;
    baseVersionId?: string | null;
    kind: RigChangeKind;
    payload: Record<string, unknown>;
    proposedBy?: string | null;
  },
): Promise<RigChange> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.rigChanges)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          rigId: input.rigId,
          baseVersionId: input.baseVersionId ?? null,
          kind: input.kind,
          payload: input.payload,
          status: "proposed",
          proposedBy: input.proposedBy ?? null,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create rig change");
      }
      return mapRigChange(row);
    },
  );
}

/**
 * Idempotent proposal insert. The key is unique per workspace; a retry with the
 * exact same rig/base/kind/payload/actor returns the existing row, while key
 * reuse for different content fails closed instead of silently aliasing two
 * proposals.
 */
export async function createRigChangeWithIdempotencyKey(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    rigId: string;
    baseVersionId?: string | null;
    kind: RigChangeKind;
    payload: Record<string, unknown>;
    proposedBy?: string | null;
    idempotencyKey: string;
  },
): Promise<{ change: RigChange; created: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [inserted] = await scopedDb
        .insert(schema.rigChanges)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          rigId: input.rigId,
          baseVersionId: input.baseVersionId ?? null,
          kind: input.kind,
          payload: input.payload,
          status: "proposed",
          proposedBy: input.proposedBy ?? null,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({
          target: [schema.rigChanges.workspaceId, schema.rigChanges.idempotencyKey],
          where: sql`${schema.rigChanges.idempotencyKey} is not null`,
        })
        .returning();
      if (inserted) {
        return { change: mapRigChange(inserted), created: true };
      }
      const [existing] = await scopedDb
        .select()
        .from(schema.rigChanges)
        .where(
          and(
            eq(schema.rigChanges.workspaceId, input.workspaceId),
            eq(schema.rigChanges.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error("Failed to create rig change under idempotency key");
      }
      const sameProposal =
        existing.rigId === input.rigId &&
        existing.baseVersionId === (input.baseVersionId ?? null) &&
        existing.kind === input.kind &&
        existing.proposedBy === (input.proposedBy ?? null) &&
        isDeepStrictEqual(existing.payload, input.payload);
      if (!sameProposal) {
        throw new RigChangeIdempotencyConflictError(input.idempotencyKey);
      }
      return { change: mapRigChange(existing), created: false };
    },
  );
}

export async function listRigChanges(
  db: Database,
  workspaceId: string,
  rigId: string,
  limit = 100,
): Promise<RigChange[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.rigChanges)
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.rigId, rigId)),
      )
      .orderBy(desc(schema.rigChanges.createdAt))
      .limit(limit);
    return rows.map(mapRigChange);
  });
}

export async function getRigChange(
  db: Database,
  workspaceId: string,
  changeId: string,
): Promise<RigChange | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.rigChanges)
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .limit(1);
    return row ? mapRigChange(row) : null;
  });
}

// Advances a change's lifecycle. merged/rejected are terminal (any attempted
// transition throws RigChangeTransitionError). A supplied verification payload is
// shallow-merged onto the existing one so a status bump can enrich it (M4).
export async function updateRigChangeStatus(
  db: Database,
  workspaceId: string,
  changeId: string,
  input: {
    status: RigChangeStatus;
    verification?: Record<string, unknown> | null;
    resultVersionId?: string | null;
  },
): Promise<RigChange> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [current] = await scopedDb
      .select()
      .from(schema.rigChanges)
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    const terminal = current.status === "merged" || current.status === "rejected";
    if (terminal) {
      throw new RigChangeTransitionError(changeId, current.status, input.status);
    }
    const mergedVerification = input.verification
      ? {
          ...((current.verification as Record<string, unknown> | null) ?? {}),
          ...input.verification,
        }
      : undefined;
    const [row] = await scopedDb
      .update(schema.rigChanges)
      .set({
        status: input.status,
        ...(mergedVerification !== undefined ? { verification: mergedVerification } : {}),
        ...(input.resultVersionId !== undefined ? { resultVersionId: input.resultVersionId } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .returning();
    if (!row) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    return mapRigChange(row);
  });
}

/**
 * Attempt-fenced verification settlement. A cancelled/lost workflow may race a
 * late activity completion; only the still-current `verifying` attempt may
 * write its terminal outcome, so a zombie can never overwrite recovery.
 */
export async function settleRigChangeVerificationAttempt(
  db: Database,
  workspaceId: string,
  changeId: string,
  expectedAttempt: number,
  input: {
    status: "proposed" | "rejected" | "failed";
    verification: Record<string, unknown>;
  },
): Promise<RigChange> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [current] = await scopedDb
      .select()
      .from(schema.rigChanges)
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    const currentVerification = (current.verification as Record<string, unknown> | null) ?? {};
    const actualAttempt =
      typeof currentVerification.attempt === "number" ? currentVerification.attempt : null;
    if (current.status !== "verifying" || actualAttempt !== expectedAttempt) {
      throw new RigVerificationAttemptChangedError(
        changeId,
        expectedAttempt,
        actualAttempt,
        current.status,
      );
    }
    const [row] = await scopedDb
      .update(schema.rigChanges)
      .set({
        status: input.status,
        verification: { ...currentVerification, ...input.verification },
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .returning();
    if (!row) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    return mapRigChange(row);
  });
}

export async function beginRigChangeVerificationAttempt(
  db: Database,
  workspaceId: string,
  changeId: string,
  input: {
    startedAt: string;
    allowAlreadyVerifying?: boolean;
  },
): Promise<RigChange> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [current] = await scopedDb
      .select()
      .from(schema.rigChanges)
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    const previousVerification = (current.verification as Record<string, unknown> | null) ?? {};
    const previousAttempt =
      typeof previousVerification.attempt === "number" &&
      Number.isInteger(previousVerification.attempt) &&
      previousVerification.attempt > 0
        ? previousVerification.attempt
        : 0;
    if (current.status === "verifying") {
      if (input.allowAlreadyVerifying && previousAttempt > 0) {
        return mapRigChange(current);
      }
      if (!input.allowAlreadyVerifying) {
        throw new RigChangeAlreadyVerifyingError(changeId);
      }
      // A historical/pre-attempt row may have committed `verifying` before its
      // Temporal start was lost. Adopt it under attempt 1 while holding the row
      // lock so retries converge on one deterministic workflow id.
    }
    if (current.status === "merged") {
      throw new RigChangeTransitionError(changeId, current.status, "verifying");
    }
    const [row] = await scopedDb
      .update(schema.rigChanges)
      .set({
        status: "verifying",
        verification: {
          ...previousVerification,
          attempt: previousAttempt + 1,
          startedAt: input.startedAt,
          checkResults: [],
          finishedAt: null,
          passed: null,
          error: null,
        },
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.rigChanges.workspaceId, workspaceId), eq(schema.rigChanges.id, changeId)),
      )
      .returning();
    if (!row) {
      throw new Error(`Rig change not found: ${changeId}`);
    }
    return mapRigChange(row);
  });
}

/**
 * The ONLY helper that selects value_encrypted. Used exclusively by the worker
 * activity that materializes a sandbox for a run whose session carries an
 * variableSet attachment. Do not call from API routes: values are write-only.
 */
export async function getVariableSetValuesForRun(
  db: Database,
  workspaceId: string,
  variableSetId: string,
): Promise<{
  variableSet: { id: string; name: string; description: string | null };
  values: Record<string, string>;
} | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [variableSet] = await scopedDb
      .select({
        id: schema.workspaceVariableSets.id,
        name: schema.workspaceVariableSets.name,
        description: schema.workspaceVariableSets.description,
      })
      .from(schema.workspaceVariableSets)
      .where(
        and(
          eq(schema.workspaceVariableSets.workspaceId, workspaceId),
          eq(schema.workspaceVariableSets.id, variableSetId),
        ),
      )
      .limit(1);
    if (!variableSet) {
      return null;
    }
    const rows = await scopedDb
      .select({
        name: schema.workspaceVariableSetVariables.name,
        valueEncrypted: schema.workspaceVariableSetVariables.valueEncrypted,
      })
      .from(schema.workspaceVariableSetVariables)
      .where(
        and(
          eq(schema.workspaceVariableSetVariables.workspaceId, workspaceId),
          eq(schema.workspaceVariableSetVariables.variableSetId, variableSetId),
        ),
      );
    return {
      variableSet: {
        id: variableSet.id,
        name: variableSet.name,
        description: variableSet.description,
      },
      values: Object.fromEntries(rows.map((row) => [row.name, row.valueEncrypted])),
    };
  });
}

/** @deprecated use createVariableSet */
export const createWorkspaceEnvironment = createVariableSet;
/** @deprecated use listVariableSets */
export const listWorkspaceEnvironments = listVariableSets;
/** @deprecated use getVariableSet */
export const getWorkspaceEnvironment = getVariableSet;
/** @deprecated use getVariableSetByName */
export const getWorkspaceEnvironmentByName = getVariableSetByName;
/** @deprecated use updateVariableSet */
export const updateWorkspaceEnvironment = updateVariableSet;
/** @deprecated use deleteVariableSet */
export const deleteWorkspaceEnvironment = deleteVariableSet;
/** @deprecated use countVariableSets */
export const countWorkspaceEnvironments = countVariableSets;
/** @deprecated use countScheduledTasksUsingVariableSet */
export const countScheduledTasksUsingEnvironment = countScheduledTasksUsingVariableSet;
/** @deprecated use countActiveSessionsUsingVariableSet */
export const countActiveSessionsUsingEnvironment = countActiveSessionsUsingVariableSet;
/** @deprecated use setVariableSetVariable */
export const setWorkspaceEnvironmentVariable = setVariableSetVariable;
/** @deprecated use deleteVariableSetVariable */
export const deleteWorkspaceEnvironmentVariable = deleteVariableSetVariable;
/** @deprecated use getVariableSetValuesForRun */
export const getWorkspaceEnvironmentValuesForRun = getVariableSetValuesForRun;

export type VariableSetForRun = {
  id: string;
  name: string;
  description: string | null;
  values: Record<string, string>;
};

/**
 * Load and decrypt the variable set attached to a run's session. SHARED
 * by the worker TURN path (apps/worker agent-turn) AND the API-direct ATTACH paths
 * (viewer / Channel-A / desktop / terminal) so a box first warmed by an attach is
 * created with the SAME decrypted workspace-variableSet values the turn declares —
 * the box-manifest env must match the agent-manifest env or the SDK's
 * `validateNoVariableSetDelta` throws when the agent injects its manifest into the
 * resumed non-owned box.
 *
 * `variableSetId === null` is the unattached path: zero DB work and behavior
 * byte-identical to deployments without this feature. Attached runs fail closed: a
 * missing key or a deleted variableSet throws (names/ids only in messages) instead
 * of silently running without the secrets the run expects.
 */
export async function loadVariableSetForRun(
  db: Database,
  settings: Settings,
  workspaceId: string,
  variableSetId: string | null,
): Promise<VariableSetForRun | null> {
  if (!variableSetId) {
    return null;
  }
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "variable set attached but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  const stored = await getVariableSetValuesForRun(db, workspaceId, variableSetId);
  if (!stored) {
    throw new Error(`variable set not found: ${variableSetId}`);
  }
  const values: Record<string, string> = {};
  for (const [name, encrypted] of Object.entries(stored.values)) {
    try {
      values[name] = decryptEnvironmentValue(key, encrypted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to decrypt variable set variable ${name}: ${reason}`, {
        cause: error,
      });
    }
  }
  return {
    id: stored.variableSet.id,
    name: stored.variableSet.name,
    description: stored.variableSet.description,
    values,
  };
}

/** @deprecated use loadVariableSetForRun */
export const loadWorkspaceEnvironmentForRun = loadVariableSetForRun;
/** @deprecated use VariableSetForRun */
export type WorkspaceEnvironmentForRun = VariableSetForRun;

// ---------------------------------------------------------------------------
// Codex (ChatGPT) subscription credentials
//
// One row per workspace. Secret tokens live inside `credential_encrypted` (v1
// AES-256-GCM, same envelope as workspace env vars). The caller pre-encrypts the
// JSON bundle {access_token, refresh_token, id_token} — the db layer never sees
// plaintext token JSON on the write path. `loadCodexCredentialForRun` is the
// ONLY decrypt-read accessor and must never be called from an API route;
// `getCodexCredentialStatus` returns metadata only (never the secret column).
// ---------------------------------------------------------------------------

export type CodexCredentialTokens = { accessToken: string; refreshToken: string; idToken: string };

export type CodexCredentialForRun = {
  id: string; // row id — for compare-and-set writes (P1-c)
  version: number; // optimistic-concurrency version loaded with this snapshot
  workspaceId: string;
  tokens: CodexCredentialTokens; // decrypted — never logged, never returned by a route
  chatgptAccountId: string | null;
  scopes: string | null;
  planType: string | null;
  isFedramp: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  status: string;
  lastError: string | null;
};

/**
 * Login / rotation write (multi-account P1). Caller passes the PRE-encrypted
 * credential blob. Keyed on the composite partial index (workspace, chatgpt
 * account): re-connecting the SAME ChatGPT account updates that row in place
 * (re-asserts account_id, bumps version); connecting a NEW account inserts a new
 * row. Returns the row id + whether it was newly inserted. The route — not this
 * accessor — auto-activates a brand-new first account and ensures the
 * rotation-settings row exists.
 */
export async function upsertCodexSubscriptionCredential(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    credentialEncrypted: string; // v1 envelope of JSON {access_token, refresh_token, id_token}
    chatgptAccountId: string | null;
    scopes: string | null;
    planType: string | null;
    isFedramp: boolean;
    expiresAt: Date | null;
    lastRefreshAt: Date | null;
    accountEmail?: string | null;
    label?: string | null;
  },
): Promise<{ id: string; isNew: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const now = new Date();
      const [row] = await scopedDb
        .insert(schema.codexSubscriptionCredentials)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          credentialEncrypted: input.credentialEncrypted,
          chatgptAccountId: input.chatgptAccountId,
          scopes: input.scopes,
          planType: input.planType,
          isFedramp: input.isFedramp,
          expiresAt: input.expiresAt,
          lastRefreshAt: input.lastRefreshAt,
          accountEmail: input.accountEmail ?? null,
          label: input.label ?? null,
          status: "active",
          lastError: null,
        })
        .onConflictDoUpdate({
          // The unique index is PARTIAL (WHERE chatgpt_account_id IS NOT NULL), so the
          // conflict target MUST repeat that predicate via targetWhere, else postgres
          // raises "no unique or exclusion constraint matching the ON CONFLICT".
          target: [
            schema.codexSubscriptionCredentials.workspaceId,
            schema.codexSubscriptionCredentials.chatgptAccountId,
          ],
          targetWhere: sql`chatgpt_account_id is not null`,
          set: {
            // account_id MUST be re-asserted on conflict. Omitting it leaves a stale
            // account_id on a row whose owning account changed (e.g. a reconnect
            // under a different grant), which makes the row RLS-INVISIBLE to every
            // subsequent scoped read — a permanent phantom "no active subscription".
            accountId: input.accountId,
            credentialEncrypted: input.credentialEncrypted,
            scopes: input.scopes,
            planType: input.planType,
            isFedramp: input.isFedramp,
            expiresAt: input.expiresAt,
            lastRefreshAt: input.lastRefreshAt,
            // Refresh the derived email; keep an existing user-chosen label (only seed
            // it when still null) so a re-connect never clobbers a rename.
            accountEmail: input.accountEmail ?? null,
            label: sql`coalesce(${schema.codexSubscriptionCredentials.label}, ${input.label ?? null})`,
            status: "active",
            lastError: null,
            version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
            updatedAt: now,
          },
        })
        .returning({
          id: schema.codexSubscriptionCredentials.id,
          createdAt: schema.codexSubscriptionCredentials.createdAt,
          updatedAt: schema.codexSubscriptionCredentials.updatedAt,
        });
      // The upsert always returns exactly one row (insert or update).
      if (!row) {
        throw new Error("upsertCodexSubscriptionCredential returned no row");
      }
      // A fresh INSERT leaves created_at === updated_at (both the same per-txn db
      // now()). A conflict UPDATE stamps updated_at to our JS `now` while created_at
      // keeps the original (older) value, so the two diverge. This distinguishes
      // insert from update without a second read.
      const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
      return { id: row.id, isNew };
    },
  );
}

/**
 * The ONLY decrypt-read accessor. Fails closed. Never call from an API route that
 * returns the result.
 *
 * The run's account is the resolved pin-or-active credential id, not LIMIT 1: the
 * caller (worker) resolves the effective credential id and passes it here so a
 * pinned session loads its SPECIFIC account. RLS still constrains the row to the
 * workspace; an unknown/disconnected id returns null → the caller treats it as
 * "needs relogin / re-pick".
 */
export async function loadCodexCredentialForRun(
  db: Database,
  settings: Settings,
  workspaceId: string,
  credentialId: string,
): Promise<CodexCredentialForRun | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
    );
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    let tokens: CodexCredentialTokens;
    try {
      // The stored blob uses OpenAI's snake_case token field names; map to the
      // camelCase internal shape. Callers (route + worker) write snake_case.
      const parsed = JSON.parse(decryptEnvironmentValue(key, row.credentialEncrypted)) as {
        access_token: string;
        refresh_token: string;
        id_token: string;
      };
      tokens = {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token,
        idToken: parsed.id_token,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to decrypt codex credential for workspace ${workspaceId}: ${reason}`,
        { cause: error },
      );
    }
    return {
      id: row.id,
      version: row.version,
      workspaceId,
      tokens,
      chatgptAccountId: row.chatgptAccountId,
      scopes: row.scopes,
      planType: row.planType,
      isFedramp: row.isFedramp,
      expiresAt: row.expiresAt,
      lastRefreshAt: row.lastRefreshAt,
      status: row.status,
      lastError: row.lastError,
    };
  });
}

/**
 * Persist rotated tokens after a successful refresh. Caller pre-encrypts.
 *
 * COMPARE-AND-SET (P1-c): the write is guarded by the (id, version) the resolver
 * loaded and by the row still being healthy/active. If a disconnect→reconnect
 * replaced/rotated the row, or a definitive model refusal quarantined it while
 * the provider refresh was in flight, the guard matches 0 rows. We therefore do
 * not clobber fresh tokens or reactivate a quarantined credential. Returns true
 * iff the guarded row was updated; false means "credential changed under me —
 * the rotation is moot, drop it."
 */
export async function recordCodexTokenRefresh(
  db: Database,
  input: {
    id: string;
    version: number;
    workspaceId: string;
    credentialEncrypted: string;
    expiresAt: Date | null;
    lastRefreshAt: Date;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({
        credentialEncrypted: input.credentialEncrypted,
        expiresAt: input.expiresAt,
        lastRefreshAt: input.lastRefreshAt,
        status: "active",
        lastError: null,
        version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, input.id),
          eq(schema.codexSubscriptionCredentials.version, input.version),
          eq(schema.codexSubscriptionCredentials.status, "active"),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

/**
 * Cross-process single-flight boundary for one workspace credential refresh.
 * The callback must re-read the credential after entering: a waiter normally
 * observes the winner's incremented version and skips the provider refresh.
 * Holding one DB connection over the short OAuth request is deliberate—the
 * alternative can double-spend a rotating refresh token before CAS runs.
 */
export async function withCodexCredentialRefreshLock<T>(
  db: Database,
  workspaceId: string,
  credentialId: string,
  fn: (lockedDb: Database) => Promise<T>,
): Promise<T> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`set local lock_timeout = '30s'`);
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`codex-refresh:${credentialId}`}, 0))`,
    );
    return await fn(scopedDb);
  });
}

/**
 * Surface a permanent or transient failure on a SPECIFIC credential row.
 *
 * COMPARE-AND-SET (P1-c): the status is stamped only if the row STILL matches the
 * (id, version) the resolver loaded, and only while the row remains active. This
 * stops a refresh that began before a disconnect→reconnect (or a concurrent
 * definitive model quarantine) from stamping `needs_relogin` on the brand-new or
 * already-quarantined credential — with N accounts per workspace a workspace-wide
 * write would be flat-out wrong (it would scribble on every account). Returns
 * true iff the guarded row was updated.
 */
export async function setCodexCredentialStatus(
  db: Database,
  workspaceId: string,
  status: "active" | "needs_relogin" | "error",
  lastError: string | null,
  target: { id: string; version: number },
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({ status, lastError, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, target.id),
          eq(schema.codexSubscriptionCredentials.version, target.version),
          eq(schema.codexSubscriptionCredentials.status, "active"),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

/**
 * Metadata-only runtime quarantine for a credential selected by id. The version
 * is read and written in one RLS-scoped transaction, so a reconnect that rotates
 * the credential family between those statements makes the CAS miss instead of
 * poisoning the fresh tokens. This is used after a model request still returns
 * 401 after the transport's forced-refresh retry.
 */
export async function setCodexCredentialStatusById(
  db: Database,
  workspaceId: string,
  credentialId: string,
  status: "active" | "needs_relogin" | "error",
  lastError: string | null,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ version: schema.codexSubscriptionCredentials.version })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          eq(schema.codexSubscriptionCredentials.id, credentialId),
        ),
      )
      .limit(1);
    if (!row) {
      return false;
    }
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({ status, lastError, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.version, row.version),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

/**
 * Metadata-only read for API routes, repointed to the per-workspace ACTIVE
 * credential. NEVER selects credential_encrypted.
 *
 * Reads codex_rotation_settings.active_credential_id and joins the credential by
 * id (deterministic). If the pointer is NULL but credentials exist (the
 * mid-disconnect window), it falls back to the most-recently-connected row and
 * lazily repairs the pointer so the next read is deterministic. The returned
 * `credentialId` is the active row's id (null when no credential exists at all).
 */
export type CodexCredentialStatus = {
  connected: boolean;
  credentialId: string | null;
  chatgptAccountId: string | null;
  scopes: string | null;
  planType: string | null;
  status: string;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
};

async function getCodexCredentialStatusScoped(
  scopedDb: Database,
  workspaceId: string,
): Promise<CodexCredentialStatus | null> {
  await scopedDb.execute(sql`
    select id from codex_rotation_settings
    where workspace_id = ${workspaceId}
    for update
  `);
  const cols = {
    id: schema.codexSubscriptionCredentials.id,
    chatgptAccountId: schema.codexSubscriptionCredentials.chatgptAccountId,
    scopes: schema.codexSubscriptionCredentials.scopes,
    planType: schema.codexSubscriptionCredentials.planType,
    status: schema.codexSubscriptionCredentials.status,
    expiresAt: schema.codexSubscriptionCredentials.expiresAt,
    lastRefreshAt: schema.codexSubscriptionCredentials.lastRefreshAt,
    lastError: schema.codexSubscriptionCredentials.lastError,
  } as const;
  const [settingsRow] = await scopedDb
    .select({ activeCredentialId: schema.codexRotationSettings.activeCredentialId })
    .from(schema.codexRotationSettings)
    .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
    .limit(1);

  let row:
    | {
        id: string;
        chatgptAccountId: string | null;
        scopes: string | null;
        planType: string | null;
        status: string;
        expiresAt: Date | null;
        lastRefreshAt: Date | null;
        lastError: string | null;
      }
    | undefined;
  if (settingsRow?.activeCredentialId) {
    [row] = await scopedDb
      .select(cols)
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, settingsRow.activeCredentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .limit(1);
  }
  if (!row) {
    // No active pointer (or it dangles): fall back to the most-recently-connected
    // credential and lazily repair the pointer so the active account is stable.
    [row] = await scopedDb
      .select(cols)
      .from(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
      .orderBy(desc(schema.codexSubscriptionCredentials.createdAt))
      .limit(1);
    if (row && settingsRow && settingsRow.activeCredentialId !== row.id) {
      await scopedDb
        .update(schema.codexRotationSettings)
        .set({ activeCredentialId: row.id, updatedAt: new Date() })
        .where(eq(schema.codexRotationSettings.workspaceId, workspaceId));
    }
  }
  if (!row) {
    return null;
  }
  const { id, ...rest } = row;
  return { connected: rest.status === "active", credentialId: id, ...rest };
}

export async function getCodexCredentialStatus(
  db: Database,
  workspaceId: string,
): Promise<CodexCredentialStatus | null> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) => await getCodexCredentialStatusScoped(scopedDb, workspaceId),
  );
}

/**
 * Single source of truth for "this workspace has an ACTIVE ChatGPT/Codex
 * subscription connected AND the feature is enabled for this deployment."
 *
 * This is the SAME condition `settingsWithCodexCredential` (worker) uses to
 * decide whether to inject the synthetic codex-subscription provider, so billing
 * and provider-injection cannot drift. Metadata-only read (never the secret).
 */
export async function workspaceCodexSubscriptionActive(
  db: Database,
  settings: Pick<Settings, "codexSubscriptionEnabled" | "codexCredentialLeasingEnabled">,
  workspaceId: string,
): Promise<boolean> {
  if (!settings.codexSubscriptionEnabled) {
    return false;
  }
  // Bounded re-read. A TRANSIENT read failure (a pooled-connection blip or a
  // lost RLS GUC — now thrown loud by withRlsContext's read-back guard rather
  // than silently returning zero rows) must never permanently decide a
  // genuinely-active subscription is disconnected, which would throw the
  // fail-loud CodexSubscriptionUnavailableError at model resolution and fail the
  // turn. Retry only on a THROWN error (the transient signature); a cleanly
  // returned status — a row (any status) or a confirmed absent row (null) — is
  // authoritative and resolves immediately, so the common no-subscription turn
  // pays no extra latency.
  let lastError: unknown;
  for (let attempt = 0; attempt < CODEX_ACTIVE_READ_ATTEMPTS; attempt++) {
    try {
      return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
        const [rotation] = await scopedDb
          .select({
            rotationEnabled: schema.codexRotationSettings.rotationEnabled,
            leaseRotationEnabled: schema.codexRotationSettings.leaseRotationEnabled,
          })
          .from(schema.codexRotationSettings)
          .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
          .for("update")
          .limit(1);
        const leaseCutoverEnabled = Boolean(
          settings.codexCredentialLeasingEnabled &&
          rotation?.rotationEnabled &&
          rotation.leaseRotationEnabled,
        );
        if (!leaseCutoverEnabled) {
          // Process flag alone is not a cutover. Mixed old/new workers must use
          // the exact legacy active-pointer predicate until the synchronized DB
          // bits are true; the row lock makes this admission decision atomic
          // with the admin settings write.
          const status = await getCodexCredentialStatusScoped(scopedDb, workspaceId);
          return status?.status === "active";
        }
        // After cutover the workspace-global pointer is a UI/manual cursor, not
        // the health of the pool. A broken pointer must not hide another healthy
        // account and prevent the worker from reaching the lease selector.
        const [row] = await scopedDb
          .select({ id: schema.codexSubscriptionCredentials.id })
          .from(schema.codexSubscriptionCredentials)
          .where(
            and(
              eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
              eq(schema.codexSubscriptionCredentials.status, "active"),
            ),
          )
          .limit(1);
        return Boolean(row);
      });
    } catch (error) {
      lastError = error;
      if (attempt < CODEX_ACTIVE_READ_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CODEX_ACTIVE_READ_RETRY_MS * (attempt + 1)),
        );
      }
    }
  }
  // Every attempt threw: this is a real, persistent read outage, not a one-off
  // blip. Surface the underlying error (truthful + retryable) instead of
  // silently denying an active subscription.
  console.error(
    `workspaceCodexSubscriptionActive: credential read failed for workspace ${workspaceId} after ${CODEX_ACTIVE_READ_ATTEMPTS} attempts`,
    lastError,
  );
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Bounded re-read tuning for the codex active-credential check. A handful of
// attempts with a short linear backoff rides out a transient pooler/RLS blip
// without materially delaying a genuine outage's failure.
const CODEX_ACTIVE_READ_ATTEMPTS = 3;
const CODEX_ACTIVE_READ_RETRY_MS = 50;

/**
 * CANONICAL "is this a Codex-billed turn?" predicate.
 *
 * True iff: the turn's model is a `codex/<slug>` id (`isCodexBilledModel`) AND
 * the deployment flag is on AND the workspace has an ACTIVE credential. A true
 * result means the turn is paid by the USER's ChatGPT/Codex plan and MUST consume
 * ZERO OpenGeni credits: callers skip the credit-balance / model-cost / token
 * gates and skip OpenGeni pricing + credit debit.
 *
 * The prefix ALONE never returns true: an unconnected user typing `codex/...`
 * gets the normal gates (and the worker fails the turn for a missing credential),
 * so there is no free/uncapped-run bypass.
 */
export async function isCodexBilledTurn(input: {
  db: Database;
  settings: Pick<Settings, "codexSubscriptionEnabled" | "codexCredentialLeasingEnabled">;
  workspaceId: string;
  model: string | null | undefined;
  /**
   * Precomputed `workspaceCodexSubscriptionActive` result (P2-b). When the caller
   * already resolved the active flag for provider injection, pass it here so the
   * billed-turn predicate and the routing overlay read the credential ONCE and
   * cannot disagree across a concurrent disconnect/reconnect — a drift that would
   * either wrongly debit OpenGeni credits for a ChatGPT-paid turn or the inverse.
   */
  active?: boolean;
}): Promise<boolean> {
  if (!isCodexBilledModel(input.model)) {
    return false; // cheap; no db hit on the common path
  }
  if (input.active !== undefined) {
    return input.active;
  }
  return workspaceCodexSubscriptionActive(input.db, input.settings, input.workspaceId);
}

// ---------------------------------------------------------------------------
// Multi-account (P1) metadata accessors. All metadata-only — NEVER decrypt.
// ---------------------------------------------------------------------------

export type CodexAccountStatus = {
  id: string;
  chatgptAccountId: string | null;
  label: string | null;
  accountEmail: string | null;
  planType: string | null;
  status: string; // active | needs_relogin | error
  /** New automatic allocations only; health/refresh and existing turns remain independent. */
  allocatorEnabled: boolean;
  isActive: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
  // P2 cached usage (plaintext metadata; rides along on this metadata-only read
  // with ZERO provider calls and ZERO decrypts). null until the first refresh.
  primaryUsedPercent: number | null;
  primaryResetAt: Date | null;
  secondaryUsedPercent: number | null;
  secondaryResetAt: Date | null;
  usageCheckedAt: Date | null;
  // P3 rotation cooldown: when set and in the future, this account is cooling-down
  // (rotated-off after a usage cap) and the engine skips it. null ⇒ not cooling.
  exhaustedUntil: Date | null;
  // P4 connector-aware rotation: the ORIGINAL-dotted connector namespaces this
  // account exposes via codex_apps (github/gmail/linear/…). null ⇒ never probed
  // (the ranker treats it as unknown: never credited as covering, never excluded).
  connectorNamespaces: string[] | null;
  connectorsCheckedAt: Date | null;
};

/**
 * A metadata-only scheduling candidate observed while the workspace's rotation
 * row is locked. `activeLeaseCount` counts unexpired holders from OTHER turns;
 * the selection cursor gives deterministic fairness after those holders drain.
 * None of these fields contains credential material.
 */
export type CodexLeaseAccountStatus = CodexAccountStatus & {
  activeLeaseCount: number;
  selectionCount: number;
  lastSelectedAt: Date | null;
};

/**
 * Opaque accepted-turn policy scope resolved while the durable turn is locked.
 *
 * OPE-21 deliberately does not know the shape of named pools. A downstream
 * allocator policy (OPE-32) owns its private scope type and supplies a pure
 * metadata resolver. The resolved value is handed to the selector in the same
 * workspace rotation-row transaction as lease acquisition, so future pool
 * membership filtering cannot race the accepted turn's frozen policy.
 */
export type CodexCredentialLeasePolicyScopeResolver<TPolicyScope> = (
  turnMetadata: Readonly<Record<string, unknown>>,
) => TPolicyScope | null;

export type CodexCredentialLeaseCandidateFilterResult<TUnavailableDiagnostic = never> = {
  /** Candidates from exactly one selected policy scope; never a union-ranked pool list. */
  accounts: readonly CodexLeaseAccountStatus[];
  /** Downstream-owned, secret-safe diagnostics for rejected primary/fallback scopes. */
  unavailableDiagnostics?: readonly TUnavailableDiagnostic[];
};

export type CodexCredentialLeaseCandidateFilter<
  TPolicyScope,
  TUnavailableDiagnostic = never,
> = (input: {
  accounts: readonly CodexLeaseAccountStatus[];
  policyScope: TPolicyScope | null;
}) =>
  | readonly CodexLeaseAccountStatus[]
  | CodexCredentialLeaseCandidateFilterResult<TUnavailableDiagnostic>;

export type CodexCredentialLeaseSelectionContext<
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
> = {
  accounts: CodexLeaseAccountStatus[];
  activeCredentialId: string | null;
  rotationEnabled: boolean;
  /** Workspace cutover fence. False means the additive lease table stays inert. */
  leaseRotationEnabled: boolean;
  rotationStrategy: string;
  /** A still-live idempotent lease for this SAME turn, if one exists. */
  existingCredentialId: string | null;
  /** Downstream-owned accepted-turn policy; absent until a resolver is supplied. */
  policyScope: TPolicyScope | null;
  /** Diagnostics produced while choosing one policy scope for this NEW allocation. */
  unavailableDiagnostics: readonly TUnavailableDiagnostic[];
};

export type CodexCredentialLeaseSelection<T> = {
  credentialId: string | null;
  decision: T;
  /** Optional selector veto for policy/manual homes that must not move the legacy pointer. */
  advanceActivePointer?: boolean;
};

export type CodexCredentialLeaseResult<T, TUnavailableDiagnostic = never> = {
  decision: T;
  accounts: CodexLeaseAccountStatus[];
  activeCredentialId: string | null;
  rotationEnabled: boolean;
  rotationStrategy: string;
  credentialId: string | null;
  reused: boolean;
  holderId: string | null;
  generation: number | null;
  leasedUntil: Date | null;
  unavailableDiagnostics: readonly TUnavailableDiagnostic[];
  /** Final selector decision after input policy and manual/policy pin handling. */
  advanceActivePointer: boolean;
};

/**
 * Five minutes is deliberately much longer than the one-minute heartbeat and
 * much shorter than a five-hour allowance window. A killed worker therefore
 * stops biasing selection promptly, while a transient heartbeat write failure
 * cannot duplicate a live holder immediately.
 */
export const CODEX_CREDENTIAL_LEASE_TTL_MS = 5 * 60_000;

type CodexLeaseCandidateRow = {
  id: string;
  chatgpt_account_id: string | null;
  label: string | null;
  account_email: string | null;
  plan_type: string | null;
  status: string;
  allocator_enabled: boolean;
  expires_at: Date | string | null;
  last_refresh_at: Date | string | null;
  last_error: string | null;
  primary_used_percent: number | null;
  primary_reset_at: Date | string | null;
  secondary_used_percent: number | null;
  secondary_reset_at: Date | string | null;
  usage_checked_at: Date | string | null;
  exhausted_until: Date | string | null;
  connector_namespaces: string[] | null;
  connectors_checked_at: Date | string | null;
  selection_count: number;
  last_selected_at: Date | string | null;
  active_lease_count: number;
};

function codexMetadataDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapCodexLeaseCandidate(
  row: CodexLeaseCandidateRow,
  activeCredentialId: string | null,
): CodexLeaseAccountStatus {
  return {
    id: row.id,
    chatgptAccountId: row.chatgpt_account_id,
    label: row.label,
    accountEmail: row.account_email,
    planType: row.plan_type,
    status: row.status,
    allocatorEnabled: row.allocator_enabled,
    isActive: row.id === activeCredentialId,
    expiresAt: codexMetadataDate(row.expires_at),
    lastRefreshAt: codexMetadataDate(row.last_refresh_at),
    lastError: row.last_error,
    primaryUsedPercent: row.primary_used_percent,
    primaryResetAt: codexMetadataDate(row.primary_reset_at),
    secondaryUsedPercent: row.secondary_used_percent,
    secondaryResetAt: codexMetadataDate(row.secondary_reset_at),
    usageCheckedAt: codexMetadataDate(row.usage_checked_at),
    exhaustedUntil: codexMetadataDate(row.exhausted_until),
    connectorNamespaces: row.connector_namespaces,
    connectorsCheckedAt: codexMetadataDate(row.connectors_checked_at),
    selectionCount: Number(row.selection_count),
    lastSelectedAt: codexMetadataDate(row.last_selected_at),
    activeLeaseCount: Number(row.active_lease_count),
  };
}

function filterCodexLeaseCandidatesForPolicy<TPolicyScope, TUnavailableDiagnostic>(
  accounts: CodexLeaseAccountStatus[],
  policyScope: TPolicyScope | null,
  filter: CodexCredentialLeaseCandidateFilter<TPolicyScope, TUnavailableDiagnostic> | undefined,
): {
  accounts: CodexLeaseAccountStatus[];
  unavailableDiagnostics: readonly TUnavailableDiagnostic[];
} {
  const filtered = filter?.({ accounts, policyScope });
  if (!filtered) return { accounts, unavailableDiagnostics: [] };
  const structured = Array.isArray(filtered)
    ? null
    : (filtered as CodexCredentialLeaseCandidateFilterResult<TUnavailableDiagnostic>);
  const filteredAccounts = structured?.accounts ?? (filtered as readonly CodexLeaseAccountStatus[]);
  const unavailableDiagnostics = structured?.unavailableDiagnostics ?? [];
  const workspaceIds = new Set(accounts.map((account) => account.id));
  const filteredIds = new Set<string>();
  for (const account of filteredAccounts) {
    if (!workspaceIds.has(account.id) || filteredIds.has(account.id)) {
      throw new Error("Codex lease candidate filter returned a foreign or duplicate credential");
    }
    filteredIds.add(account.id);
  }
  return { accounts: [...filteredAccounts], unavailableDiagnostics };
}

async function listCodexLeaseCandidatesInTransaction(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    activeCredentialId: string | null;
    excludeTurnId?: string | null;
  },
): Promise<CodexLeaseAccountStatus[]> {
  const rows = await tx.execute(sql<CodexLeaseCandidateRow>`
    select
      c.id,
      c.chatgpt_account_id,
      c.label,
      c.account_email,
      c.plan_type,
      c.status,
      c.allocator_enabled,
      c.expires_at,
      c.last_refresh_at,
      c.last_error,
      c.primary_used_percent,
      c.primary_reset_at,
      c.secondary_used_percent,
      c.secondary_reset_at,
      c.usage_checked_at,
      c.exhausted_until,
      c.connector_namespaces,
      c.connectors_checked_at,
      c.selection_count,
      c.last_selected_at,
      count(l.id) filter (
        where l.leased_until > now()
          and (${input.excludeTurnId ?? null}::uuid is null or l.turn_id <> ${input.excludeTurnId ?? null})
      )::int as active_lease_count
    from codex_subscription_credentials c
    left join codex_credential_leases l
      on l.workspace_id = c.workspace_id and l.credential_id = c.id
    where c.account_id = ${input.accountId} and c.workspace_id = ${input.workspaceId}
    group by c.id
    order by c.created_at asc, c.id asc
  `);
  return (rows as unknown as CodexLeaseCandidateRow[]).map((row) =>
    mapCodexLeaseCandidate(row, input.activeCredentialId),
  );
}

/**
 * Atomically choose and lease one workspace-owned Codex credential for a turn.
 *
 * The per-workspace `codex_rotation_settings` row is the serialization point:
 * every worker replica blocks on the same plain `FOR UPDATE`, observes all live
 * leases, runs the caller's pure policy, persists the chosen holder, advances
 * the fairness cursor, and only then releases the transaction. A retried
 * activity for the same turn is idempotent and exposes its existing holder to
 * the policy so worker death does not silently switch accounts.
 *
 * The callback receives metadata only. Its chosen id is revalidated against the
 * RLS-scoped candidate set before any write, closing a malicious/buggy callback
 * from naming another workspace's row.
 */
export async function acquireCodexCredentialLease<
  T,
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    turnId: string;
    /** Unique Temporal/local activity execution id used as the zombie fence. */
    holderId: string;
    /** Pins must not move the workspace-global cursor. */
    advanceActivePointer: boolean;
    /** Exact frozen credential for this same durable turn, if it is resuming. */
    continuationCredentialId?: string | null;
    /**
     * Optional downstream parser for private accepted-turn policy metadata.
     * It is pure, runs under the turn/rotation transaction, and must not query
     * pool membership itself. OPE-21 stores or interprets no pool identifiers.
     */
    resolvePolicyScope?: CodexCredentialLeasePolicyScopeResolver<TPolicyScope>;
    /**
     * Optional downstream membership policy for NEW allocations only. A live
     * lease or validated frozen credential is offered to the selector against
     * the complete workspace rows first and can never be filtered out here.
     */
    filterNewAllocationCandidates?: CodexCredentialLeaseCandidateFilter<
      TPolicyScope,
      TUnavailableDiagnostic
    >;
    leaseTtlMs?: number;
  },
  select: (
    context: CodexCredentialLeaseSelectionContext<TPolicyScope, TUnavailableDiagnostic>,
  ) => CodexCredentialLeaseSelection<T>,
): Promise<CodexCredentialLeaseResult<T, TUnavailableDiagnostic>> {
  const leaseTtlMs = input.leaseTtlMs ?? CODEX_CREDENTIAL_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new Error("Codex credential lease TTL must be positive");
  }
  if (!input.holderId.trim()) {
    throw new Error("Codex credential lease holder id is required");
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      // The singleton workspace row is the only serialization point. Never
      // SKIP LOCKED: concurrent replicas wait, then observe the winner's lease.
      await tx.execute(sql`
        insert into codex_rotation_settings
          (account_id, workspace_id, lease_rotation_enabled)
        values (${input.accountId}, ${input.workspaceId}, false)
        on conflict (workspace_id) do nothing
      `);
      const settingsRows = await tx.execute(sql<{
        active_credential_id: string | null;
        rotation_enabled: boolean;
        lease_rotation_enabled: boolean;
        rotation_strategy: string;
      }>`
        select active_credential_id, rotation_enabled,
               lease_rotation_enabled, rotation_strategy
        from codex_rotation_settings
        where account_id = ${input.accountId} and workspace_id = ${input.workspaceId}
        for update
      `);
      const settingsRow = settingsRows[0];
      if (!settingsRow) {
        throw new Error(`Codex rotation settings not visible for workspace ${input.workspaceId}`);
      }
      // Rotation row -> durable turn is the common allocator/waiter lock order.
      // Fail closed before taking a credential: the turn and allocator must be
      // inside exactly the same RLS-scoped workspace/account. A downstream
      // accepted-turn policy is parsed from this locked metadata while the
      // rotation transaction is held.
      const turns = await tx.execute(sql<{ id: string; metadata: Record<string, unknown> | null }>`
        select id, metadata from session_turns
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and id = ${input.turnId}
        for share
      `);
      if (!turns[0]) {
        throw new Error(`Session turn not found for Codex lease: ${input.turnId}`);
      }
      const policyScope = input.resolvePolicyScope?.(turns[0].metadata ?? {}) ?? null;
      const continuationRows = input.continuationCredentialId
        ? await tx.execute(
            sql<{ frozen_codex_credential_id: string | null }>`
              select frozen_codex_credential_id
              from agent_run_states
              where account_id = ${input.accountId}
                and workspace_id = ${input.workspaceId}
                and turn_id = ${input.turnId}
              order by state_version desc
              limit 1
            `,
          )
        : [];
      const validatedContinuationCredentialId =
        continuationRows[0]?.frozen_codex_credential_id === input.continuationCredentialId
          ? input.continuationCredentialId
          : null;
      const activeCredentialId = settingsRow.active_credential_id;
      const rotationEnabled = settingsRow.rotation_enabled;
      // Fail closed on a torn/manual legacy write. The user-intent bit and the
      // revision-aware cutover bit are synchronized by the supported API; both
      // must remain true before the additive allocator may touch lease state.
      const leaseRotationEnabled =
        settingsRow.rotation_enabled && settingsRow.lease_rotation_enabled;
      const rotationStrategy = settingsRow.rotation_strategy;

      // The per-workspace bit is the atomic cutover fence. Until an operator or
      // explicit settings write enables it, a migration-compatible worker keeps
      // the lease table/cursors completely inert and follows the legacy policy.
      if (leaseRotationEnabled) {
        await tx.execute(sql`
          delete from codex_credential_leases
          where workspace_id = ${input.workspaceId} and leased_until <= now()
        `);
      }
      const existingRows = leaseRotationEnabled
        ? await tx.execute(
            sql<{ credential_id: string; holder_id: string; generation: number }>`
              select credential_id, holder_id, generation from codex_credential_leases
              where workspace_id = ${input.workspaceId}
                and turn_id = ${input.turnId}
                and leased_until > now()
              limit 1
            `,
          )
        : [];
      const existingCredentialId = existingRows[0]?.credential_id ?? null;

      const allAccounts = await listCodexLeaseCandidatesInTransaction(tx as unknown as Database, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        activeCredentialId,
        excludeTurnId: input.turnId,
      });
      const sameTurnCredentialId = existingCredentialId ?? validatedContinuationCredentialId;
      const selectionContext = (
        accounts: CodexLeaseAccountStatus[],
        unavailableDiagnostics: readonly TUnavailableDiagnostic[],
      ) => ({
        accounts,
        activeCredentialId,
        rotationEnabled,
        leaseRotationEnabled,
        rotationStrategy,
        existingCredentialId,
        policyScope,
        unavailableDiagnostics,
      });
      let accounts = allAccounts;
      let unavailableDiagnostics: readonly TUnavailableDiagnostic[] = [];
      let selected: CodexCredentialLeaseSelection<T> | undefined;
      if (sameTurnCredentialId !== null) {
        const sameTurnSelection = select(selectionContext(allAccounts, []));
        if (sameTurnSelection.credentialId === sameTurnCredentialId) {
          selected = sameTurnSelection;
        }
      }

      // Exact-turn continuity is resolved before any future pool membership
      // filter. The normal selector still owns health validation: a quarantined
      // live/frozen row falls through to scoped new acquisition rather than
      // being reused blindly.
      if (!selected) {
        const filtered = filterCodexLeaseCandidatesForPolicy(
          allAccounts,
          policyScope,
          input.filterNewAllocationCandidates,
        );
        accounts = filtered.accounts;
        unavailableDiagnostics = filtered.unavailableDiagnostics;
        selected = select(selectionContext(accounts, unavailableDiagnostics));
      }
      if (selected.credentialId === null) {
        if (leaseRotationEnabled && existingCredentialId !== null) {
          await tx.execute(sql`
            delete from codex_credential_leases
            where workspace_id = ${input.workspaceId} and turn_id = ${input.turnId}
          `);
        }
        return {
          decision: selected.decision,
          accounts,
          activeCredentialId,
          rotationEnabled,
          rotationStrategy,
          credentialId: null,
          reused: false,
          holderId: null,
          generation: null,
          leasedUntil: null,
          unavailableDiagnostics,
          advanceActivePointer: false,
        };
      }
      const selectedAccount = accounts.find((account) => account.id === selected.credentialId);
      if (!selectedAccount) {
        throw new Error("Codex lease selector returned a credential outside the workspace pool");
      }
      if (
        !selectedAccount.allocatorEnabled &&
        selectedAccount.id !== existingCredentialId &&
        selectedAccount.id !== validatedContinuationCredentialId
      ) {
        throw new Error("Codex lease selector returned a credential disabled for new allocations");
      }

      const advanceActivePointer =
        input.advanceActivePointer && selected.advanceActivePointer !== false;

      // Compatible-but-not-cut-over workers may still run the legacy rotation
      // policy under this same workspace-row lock. They can advance the active
      // pointer, but never create a lease or mutate fairness cursors.
      if (!leaseRotationEnabled) {
        if (advanceActivePointer && activeCredentialId !== selected.credentialId) {
          await tx.execute(sql`
            update codex_rotation_settings
            set active_credential_id = ${selected.credentialId}, updated_at = now()
            where account_id = ${input.accountId} and workspace_id = ${input.workspaceId}
          `);
        }
        return {
          decision: selected.decision,
          accounts,
          activeCredentialId,
          rotationEnabled,
          rotationStrategy,
          credentialId: selected.credentialId,
          reused: false,
          holderId: null,
          generation: null,
          leasedUntil: null,
          unavailableDiagnostics,
          advanceActivePointer,
        };
      }

      const reused = existingCredentialId === selected.credentialId;
      const leaseRows = await tx.execute(
        sql<{ holder_id: string; generation: number; leased_until: Date | string }>`
        insert into codex_credential_leases
          (account_id, workspace_id, credential_id, turn_id, holder_id, generation, leased_until)
        values
          (${input.accountId}, ${input.workspaceId}, ${selected.credentialId}, ${input.turnId}, ${input.holderId}, 1, now() + (${leaseTtlMs} * interval '1 millisecond'))
        on conflict (workspace_id, turn_id) do update set
          credential_id = excluded.credential_id,
          holder_id = excluded.holder_id,
          generation = case
            when codex_credential_leases.holder_id = excluded.holder_id
              then codex_credential_leases.generation
            else codex_credential_leases.generation + 1
          end,
          leased_until = excluded.leased_until,
          updated_at = now()
        returning holder_id, generation, leased_until
      `,
      );
      const leasedUntil = codexMetadataDate(leaseRows[0]?.leased_until);
      if (!leasedUntil) {
        throw new Error("Codex credential lease insert returned no expiry");
      }
      if (!reused) {
        await tx.execute(sql`
          update codex_subscription_credentials
          set selection_count = selection_count + 1,
              last_selected_at = now()
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and id = ${selected.credentialId}
        `);
      }
      if (advanceActivePointer && activeCredentialId !== selected.credentialId) {
        await tx.execute(sql`
          update codex_rotation_settings
          set active_credential_id = ${selected.credentialId}, updated_at = now()
          where account_id = ${input.accountId} and workspace_id = ${input.workspaceId}
        `);
      }
      return {
        decision: selected.decision,
        accounts,
        activeCredentialId,
        rotationEnabled,
        rotationStrategy,
        credentialId: selected.credentialId,
        reused,
        holderId: leaseRows[0]?.holder_id ?? input.holderId,
        generation: Number(leaseRows[0]?.generation),
        leasedUntil,
        unavailableDiagnostics,
        advanceActivePointer,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// OPE-21 durable zero-capacity wait / wake state machine.
// ---------------------------------------------------------------------------

export type CodexCapacityWaitStatus = "waiting" | "resumed" | "superseded";
export type CodexCapacityResetKind = "authoritative" | "bounded_refresh";

export type CodexCapacityWait = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  goalId: string;
  blockedTurnId: string;
  workflowId: string;
  generation: number;
  status: CodexCapacityWaitStatus;
  goalVersion: number;
  policyHash: string | null;
  earliestResetAt: Date | null;
  nextCheckAt: Date;
  resetKind: CodexCapacityResetKind;
  refreshAttempt: number;
  wakeRevision: number;
  observedWakeRevision: number;
  lastWakeReason: string;
  resumedUpdateId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CodexCapacityWakeTarget = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  workflowId: string;
  waiterId: string;
  generation: number;
  wakeRevision: number;
  workflowWakeRevision: number;
};

export type CodexCapacityMutationResult<T> = {
  result: T;
  wakeTargets: CodexCapacityWakeTarget[];
};

export type CodexCapacityAvailabilityDecision =
  | { kind: "available"; credentialId: string; diagnostic?: Record<string, unknown> }
  | {
      kind: "unavailable";
      earliestResetAt: Date | null;
      resetKind: CodexCapacityResetKind;
      diagnostic?: Record<string, unknown>;
    };

export type CodexCapacitySelectionContext<
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
> = CodexCredentialLeaseSelectionContext<TPolicyScope, TUnavailableDiagnostic> & {
  sessionId: string;
  sessionPinnedCredentialId: string | null;
  sessionPinSource: CodexPinSource | null;
  sessionLastCredentialId: string | null;
  policyHash: string | null;
};

export type ArmCodexCapacityWaitResult =
  | { action: "waiting"; waiter: CodexCapacityWait; events: SessionEvent[] }
  | { action: "stale"; waiter: CodexCapacityWait | null; events: SessionEvent[] };

export type ReconcileCodexCapacityWaitResult =
  | { action: "waiting"; waiter: CodexCapacityWait; events: SessionEvent[] }
  | {
      action: "resumed";
      waiter: CodexCapacityWait;
      update: SessionSystemUpdate;
      events: SessionEvent[];
    }
  | { action: "superseded"; waiter: CodexCapacityWait; events: SessionEvent[] }
  | { action: "stale"; waiter: CodexCapacityWait | null; events: SessionEvent[] };

export const CODEX_CAPACITY_REFRESH_MIN_MS = 60_000;
export const CODEX_CAPACITY_REFRESH_MAX_MS = 15 * 60_000;

/**
 * Unknown/stale reset data uses bounded control-plane refresh backoff. This is
 * never a model turn and never consumes an entitlement. The value is pure so
 * crash/timer tests can pin the exact progression.
 */
export function codexCapacityRefreshBackoffMs(attempt: number): number {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return Math.min(CODEX_CAPACITY_REFRESH_MIN_MS * 2 ** safeAttempt, CODEX_CAPACITY_REFRESH_MAX_MS);
}

function mapCodexCapacityWaiter(
  row: typeof schema.codexCapacityWaiters.$inferSelect,
): CodexCapacityWait {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    goalId: row.goalId,
    blockedTurnId: row.blockedTurnId,
    workflowId: row.workflowId,
    generation: row.generation,
    status: row.status as CodexCapacityWaitStatus,
    goalVersion: row.goalVersion,
    policyHash: row.policyHash,
    earliestResetAt: row.earliestResetAt,
    nextCheckAt: row.nextCheckAt,
    resetKind: row.resetKind as CodexCapacityResetKind,
    refreshAttempt: row.refreshAttempt,
    wakeRevision: row.wakeRevision,
    observedWakeRevision: row.observedWakeRevision,
    lastWakeReason: row.lastWakeReason,
    resumedUpdateId: row.resumedUpdateId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function codexCapacityPolicyHashFromTurnMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.codexCredentialPolicyHash;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function lockExistingCodexRotationSettingsForCapacity(
  tx: Database,
  workspaceId: string,
): Promise<{
  accountId: string;
  activeCredentialId: string | null;
  rotationEnabled: boolean;
  leaseRotationEnabled: boolean;
  rotationStrategy: string;
} | null> {
  const rows = await tx.execute(sql<{
    account_id: string;
    active_credential_id: string | null;
    rotation_enabled: boolean;
    lease_rotation_enabled: boolean;
    rotation_strategy: string;
  }>`
    select account_id, active_credential_id, rotation_enabled,
           lease_rotation_enabled, rotation_strategy
    from codex_rotation_settings
    where workspace_id = ${workspaceId}
    for update
  `);
  const row = rows[0];
  return row
    ? {
        accountId: row.account_id,
        activeCredentialId: row.active_credential_id,
        rotationEnabled: row.rotation_enabled,
        leaseRotationEnabled: row.rotation_enabled && row.lease_rotation_enabled,
        rotationStrategy: row.rotation_strategy,
      }
    : null;
}

function nextCodexCapacityCheckAt(
  earliestResetAt: Date | null,
  resetKind: CodexCapacityResetKind,
  refreshAttempt: number,
  now: Date,
): Date {
  if (
    resetKind === "authoritative" &&
    earliestResetAt !== null &&
    earliestResetAt.getTime() > now.getTime()
  ) {
    return earliestResetAt;
  }
  return new Date(now.getTime() + codexCapacityRefreshBackoffMs(refreshAttempt));
}

/**
 * Atomically settle one all-unavailable turn and arm exactly one durable wait.
 * Lock order is allocator rotation row -> session -> goal -> blocked turn ->
 * live lease (when a reactive failure owns one) -> waiter. The failed turn,
 * idle/capacity-paused session, durable events, lease release, and waiter
 * generation commit together; a crash cannot leave only half of the boundary
 * visible.
 */
export async function armCodexCapacityWait(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    workflowId: string;
    goalId: string;
    goalVersion: number;
    policyHash?: string | null;
    earliestResetAt: Date | null;
    resetKind: CodexCapacityResetKind;
    failurePayload: Record<string, unknown>;
    /** Required on reactive failures that already own a credential lease. */
    leaseFence?: { holderId: string; generation: number };
    /** Worker-death dispatch generation observed before model execution. */
    expectedRedispatches?: number;
    now?: Date;
  },
): Promise<ArmCodexCapacityWaitResult> {
  const now = input.now ?? new Date();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const rotation = await lockExistingCodexRotationSettingsForCapacity(tx, input.workspaceId);
        if (!rotation || rotation.accountId !== input.accountId) {
          return { action: "stale", waiter: null, events: [] } as const;
        }
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.accountId, input.accountId),
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [goal] = await tx
          .select()
          .from(schema.sessionGoals)
          .where(
            and(
              eq(schema.sessionGoals.workspaceId, input.workspaceId),
              eq(schema.sessionGoals.id, input.goalId),
              eq(schema.sessionGoals.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [turn] = await tx
          .select()
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const leaseRows = input.leaseFence
          ? await tx.execute(sql<{ holder_id: string; generation: number }>`
              select holder_id, generation
              from codex_credential_leases
              where account_id = ${input.accountId}
                and workspace_id = ${input.workspaceId}
                and turn_id = ${input.turnId}
                and leased_until > now()
              for update
            `)
          : [];
        const [existing] = await tx
          .select()
          .from(schema.codexCapacityWaiters)
          .where(
            and(
              eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
              eq(schema.codexCapacityWaiters.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);

        if (
          existing?.status === "waiting" &&
          existing.blockedTurnId === input.turnId &&
          turn?.status === "failed"
        ) {
          return {
            action: "waiting",
            waiter: mapCodexCapacityWaiter(existing),
            events: [],
          } as const;
        }
        const policyHash =
          input.policyHash ?? codexCapacityPolicyHashFromTurnMetadata(turn?.metadata);
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        const lease = leaseRows[0];
        const leaseFenceValid =
          !input.leaseFence ||
          (lease?.holder_id === input.leaseFence.holderId &&
            Number(lease.generation) === input.leaseFence.generation &&
            currentRedispatches === (input.expectedRedispatches ?? currentRedispatches));
        if (
          !session ||
          !goal ||
          !turn ||
          session.activeTurnId !== input.turnId ||
          session.status !== "running" ||
          goal.status !== "active" ||
          goal.version !== input.goalVersion ||
          turn.status !== "running" ||
          turn.activeAttemptId !== input.attemptId ||
          !leaseFenceValid ||
          codexCapacityPolicyHashFromTurnMetadata(turn.metadata) !== policyHash
        ) {
          return {
            action: "stale",
            waiter: existing ? mapCodexCapacityWaiter(existing) : null,
            events: [],
          } as const;
        }

        await closeSessionTurnAttemptInTransaction(tx, {
          id: input.attemptId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: "failed",
          closedAt: now,
        });

        const generation = (existing?.generation ?? 0) + 1;
        const nextCheckAt = nextCodexCapacityCheckAt(
          input.earliestResetAt,
          input.resetKind,
          0,
          now,
        );
        const wakeRevision = (existing?.wakeRevision ?? 0) + 1;
        const waiterValues = {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          goalId: input.goalId,
          blockedTurnId: input.turnId,
          workflowId: input.workflowId,
          generation,
          status: "waiting",
          goalVersion: input.goalVersion,
          policyHash,
          earliestResetAt: input.earliestResetAt,
          nextCheckAt,
          resetKind: input.resetKind,
          refreshAttempt: 0,
          // Arming follows an allocator evaluation in this same transaction,
          // so this generation has already observed its own initial revision.
          // Only a later capacity mutation creates pending outbox work.
          wakeRevision,
          observedWakeRevision: wakeRevision,
          lastWakeReason: "capacity_wait_armed",
          resumedUpdateId: null,
          updatedAt: now,
        } as const;
        const [waiterRow] = existing
          ? await tx
              .update(schema.codexCapacityWaiters)
              .set(waiterValues)
              .where(eq(schema.codexCapacityWaiters.id, existing.id))
              .returning()
          : await tx.insert(schema.codexCapacityWaiters).values(waiterValues).returning();
        if (!waiterRow) {
          throw new Error("Codex capacity wait arm returned no waiter row");
        }

        let sequence = session.lastSequence;
        const closedTools = await closePendingSessionToolCallsInTransaction(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: "codex_capacity_wait",
          sequence,
          now,
        });
        sequence = closedTools.sequence;
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values([
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "turn.failed",
              payload: sanitizeEventPayload({
                ...input.failurePayload,
                recovery: "codex_capacity",
                retryable: false,
                rotated: true,
                capacityWaiterId: waiterRow.id,
                capacityWaitGeneration: waiterRow.generation,
              }),
              turnId: input.turnId,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              occurredAt: now,
            },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "codex.capacity.waiting",
              payload: sanitizeEventPayload({
                waiterId: waiterRow.id,
                generation: waiterRow.generation,
                goalId: input.goalId,
                goalVersion: input.goalVersion,
                policyHash,
                resetKind: input.resetKind,
                earliestResetAt: input.earliestResetAt?.toISOString() ?? null,
                nextCheckAt: nextCheckAt.toISOString(),
              }),
              turnId: input.turnId,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              occurredAt: now,
            },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "session.status.changed",
              payload: { status: "idle", reason: "codex_capacity" },
              turnId: input.turnId,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              occurredAt: now,
            },
          ])
          .returning();
        await tx
          .update(schema.sessionTurns)
          .set({
            status: "failed",
            activeAttemptId: null,
            version: turn.version + 1,
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.status, "running"),
            ),
          );
        await tx
          .update(schema.sessions)
          .set({
            status: "idle",
            activeTurnId: null,
            lastSequence: sequence,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.activeTurnId, input.turnId),
            ),
          );
        await tx.execute(sql`
          delete from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
        `);
        return {
          action: "waiting",
          waiter: mapCodexCapacityWaiter(waiterRow),
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        } as const;
      }),
  );
}

export async function getCodexCapacityWaitForSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<CodexCapacityWait | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.codexCapacityWaiters)
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
          eq(schema.codexCapacityWaiters.sessionId, sessionId),
          eq(schema.codexCapacityWaiters.status, "waiting"),
        ),
      )
      .limit(1);
    return row ? mapCodexCapacityWaiter(row) : null;
  });
}

/**
 * Same-transaction capacity-mutation/outbox seam for OPE-24 eligibility and
 * OPE-32 membership/default changes. The allocator rotation row is always the
 * first lock. Mutations report whether capacity truth changed; only then are
 * matching waiter wake revisions advanced and returned for best-effort signal.
 */
export async function withCodexCapacityMutation<T>(
  db: Database,
  input: {
    workspaceId: string;
    reason: string;
    policyHash?: string | null;
  },
  mutate: (tx: Database) => Promise<{ result: T; changed: boolean }>,
): Promise<CodexCapacityMutationResult<T>> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        await lockExistingCodexRotationSettingsForCapacity(tx, input.workspaceId);
        const mutation = await mutate(tx);
        if (!mutation.changed) {
          return { result: mutation.result, wakeTargets: [] };
        }
        const rows = await tx
          .update(schema.codexCapacityWaiters)
          .set({
            wakeRevision: sql`${schema.codexCapacityWaiters.wakeRevision} + 1`,
            lastWakeReason: input.reason,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
              eq(schema.codexCapacityWaiters.status, "waiting"),
              ...(input.policyHash !== undefined
                ? [
                    input.policyHash === null
                      ? isNull(schema.codexCapacityWaiters.policyHash)
                      : eq(schema.codexCapacityWaiters.policyHash, input.policyHash),
                  ]
                : []),
            ),
          )
          .returning();
        const wakeTargets: CodexCapacityWakeTarget[] = [];
        for (const row of rows) {
          const workflowWakeRevision = await enqueueSessionWorkflowWakeInTransaction(tx, {
            accountId: row.accountId,
            workspaceId: row.workspaceId,
            sessionId: row.sessionId,
            temporalWorkflowId: row.workflowId,
            reason: "codex_capacity",
          });
          wakeTargets.push({
            accountId: row.accountId,
            workspaceId: row.workspaceId,
            sessionId: row.sessionId,
            workflowId: row.workflowId,
            waiterId: row.id,
            generation: row.generation,
            wakeRevision: row.wakeRevision,
            workflowWakeRevision,
          });
        }
        return {
          result: mutation.result,
          wakeTargets,
        };
      }),
  );
}

export async function listPendingCodexCapacityWakeTargets(
  db: Database,
  workspaceId: string,
): Promise<CodexCapacityWakeTarget[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        waiter: schema.codexCapacityWaiters,
        workflowWakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision,
      })
      .from(schema.codexCapacityWaiters)
      .innerJoin(
        schema.sessionWorkflowWakeOutbox,
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, schema.codexCapacityWaiters.workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, schema.codexCapacityWaiters.sessionId),
        ),
      )
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
          eq(schema.codexCapacityWaiters.status, "waiting"),
          sql`${schema.codexCapacityWaiters.wakeRevision} > ${schema.codexCapacityWaiters.observedWakeRevision}`,
        ),
      );
    return rows.map(({ waiter: row, workflowWakeRevision }) => ({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      workflowId: row.workflowId,
      waiterId: row.id,
      generation: row.generation,
      wakeRevision: row.wakeRevision,
      workflowWakeRevision,
    }));
  });
}

async function supersedeCodexCapacityWaitInTransaction(
  tx: Database,
  input: {
    session: typeof schema.sessions.$inferSelect;
    waiter: typeof schema.codexCapacityWaiters.$inferSelect;
    reason: string;
    now: Date;
  },
): Promise<{ waiter: CodexCapacityWait; events: SessionEvent[] }> {
  const [updated] = await tx
    .update(schema.codexCapacityWaiters)
    .set({
      status: "superseded",
      observedWakeRevision: input.waiter.wakeRevision,
      lastWakeReason: input.reason,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(schema.codexCapacityWaiters.id, input.waiter.id),
        eq(schema.codexCapacityWaiters.status, "waiting"),
      ),
    )
    .returning();
  if (!updated) {
    return { waiter: mapCodexCapacityWaiter(input.waiter), events: [] };
  }
  const inserted = await tx
    .insert(schema.sessionEvents)
    .values({
      accountId: input.session.accountId,
      workspaceId: input.session.workspaceId,
      sessionId: input.session.id,
      sequence: input.session.lastSequence + 1,
      type: "codex.capacity.superseded",
      payload: sanitizeEventPayload({
        waiterId: updated.id,
        generation: updated.generation,
        reason: input.reason,
      }),
      turnId: updated.blockedTurnId,
      occurredAt: input.now,
    })
    .returning();
  await tx
    .update(schema.sessions)
    .set({ lastSequence: input.session.lastSequence + 1, updatedAt: input.now })
    .where(
      and(
        eq(schema.sessions.workspaceId, input.session.workspaceId),
        eq(schema.sessions.id, input.session.id),
      ),
    );
  return { waiter: mapCodexCapacityWaiter(updated), events: inserted.map(mapEvent) };
}

/**
 * Row-lock and re-evaluate one waiter. Availability is decided by a pure
 * caller supplied policy over the same rotation-row transaction as normal
 * acquisition. If available, one system goal-continuation event and one turn
 * are committed; duplicate timers/signals observe status=resumed and do no
 * work. If any goal/control/policy/turn/queue fence changed, the waiter is
 * superseded without inference.
 */
export async function reconcileCodexCapacityWait<
  TPolicyScope = never,
  TUnavailableDiagnostic = never,
>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    waiterId: string;
    generation: number;
    now?: Date;
  },
  decide: (
    context: CodexCapacitySelectionContext<TPolicyScope, TUnavailableDiagnostic>,
  ) => CodexCapacityAvailabilityDecision,
  policy?: {
    resolvePolicyScope?: CodexCredentialLeasePolicyScopeResolver<TPolicyScope>;
    filterNewAllocationCandidates?: CodexCredentialLeaseCandidateFilter<
      TPolicyScope,
      TUnavailableDiagnostic
    >;
  },
): Promise<ReconcileCodexCapacityWaitResult> {
  const now = input.now ?? new Date();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const rotation = await lockExistingCodexRotationSettingsForCapacity(tx, input.workspaceId);
        if (!rotation || rotation.accountId !== input.accountId) {
          return { action: "stale", waiter: null, events: [] } as const;
        }
        const [waiterRead] = await tx
          .select()
          .from(schema.codexCapacityWaiters)
          .where(
            and(
              eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
              eq(schema.codexCapacityWaiters.id, input.waiterId),
              eq(schema.codexCapacityWaiters.sessionId, input.sessionId),
            ),
          )
          .limit(1);
        if (!waiterRead || waiterRead.generation !== input.generation) {
          return {
            action: "stale",
            waiter: waiterRead ? mapCodexCapacityWaiter(waiterRead) : null,
            events: [],
          } as const;
        }
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.accountId, input.accountId),
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [goal] = await tx
          .select()
          .from(schema.sessionGoals)
          .where(
            and(
              eq(schema.sessionGoals.workspaceId, input.workspaceId),
              eq(schema.sessionGoals.id, waiterRead.goalId),
              eq(schema.sessionGoals.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [blockedTurn] = await tx
          .select()
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, waiterRead.blockedTurnId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [waiter] = await tx
          .select()
          .from(schema.codexCapacityWaiters)
          .where(eq(schema.codexCapacityWaiters.id, input.waiterId))
          .for("update")
          .limit(1);
        if (
          !session ||
          !goal ||
          !blockedTurn ||
          !waiter ||
          waiter.generation !== input.generation ||
          waiter.status !== "waiting"
        ) {
          return {
            action: "stale",
            waiter: waiter ? mapCodexCapacityWaiter(waiter) : null,
            events: [],
          } as const;
        }

        const [pending] = await tx
          .select({ id: schema.sessionTurns.id })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              inArray(schema.sessionTurns.status, ["queued", "running", "requires_action"]),
            ),
          )
          .limit(1);
        const [laterTurn] = await tx
          .select({ id: schema.sessionTurns.id })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              gt(schema.sessionTurns.position, blockedTurn.position),
            ),
          )
          .limit(1);
        const currentPolicyHash = codexCapacityPolicyHashFromTurnMetadata(blockedTurn.metadata);
        let supersedeReason: string | null = null;
        if (goal.status !== "active" || goal.version !== waiter.goalVersion) {
          supersedeReason = "goal_changed";
        } else if (currentPolicyHash !== waiter.policyHash) {
          supersedeReason = "credential_policy_changed";
        } else if (session.status !== "idle" || session.activeTurnId !== null) {
          supersedeReason = "session_not_capacity_idle";
        } else if (blockedTurn.status !== "failed") {
          supersedeReason = "blocked_turn_changed";
        } else if (pending) {
          supersedeReason = "pending_work_exists";
        } else if (laterTurn) {
          supersedeReason = "newer_turn_exists";
        }
        if (supersedeReason) {
          const superseded = await supersedeCodexCapacityWaitInTransaction(tx, {
            session,
            waiter,
            reason: supersedeReason,
            now,
          });
          return { action: "superseded", ...superseded } as const;
        }

        const allAccounts = await listCodexLeaseCandidatesInTransaction(tx, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          activeCredentialId: rotation.activeCredentialId,
          excludeTurnId: waiter.blockedTurnId,
        });
        const policyScope = policy?.resolvePolicyScope?.(blockedTurn.metadata ?? {}) ?? null;
        const filtered = filterCodexLeaseCandidatesForPolicy(
          allAccounts,
          policyScope,
          policy?.filterNewAllocationCandidates,
        );
        const decision = decide({
          accounts: filtered.accounts,
          activeCredentialId: rotation.activeCredentialId,
          rotationEnabled: rotation.rotationEnabled,
          leaseRotationEnabled: rotation.leaseRotationEnabled,
          rotationStrategy: rotation.rotationStrategy,
          existingCredentialId: null,
          policyScope,
          unavailableDiagnostics: filtered.unavailableDiagnostics,
          sessionId: session.id,
          sessionPinnedCredentialId: session.codexPinnedCredentialId,
          sessionPinSource: (session.codexPinSource as CodexPinSource | null) ?? null,
          sessionLastCredentialId: session.codexLastCredentialId,
          policyHash: waiter.policyHash,
        });
        if (decision.kind === "unavailable") {
          const refreshAttempt =
            decision.resetKind === "bounded_refresh" ? waiter.refreshAttempt + 1 : 0;
          const nextCheckAt = nextCodexCapacityCheckAt(
            decision.earliestResetAt,
            decision.resetKind,
            refreshAttempt,
            now,
          );
          const [updated] = await tx
            .update(schema.codexCapacityWaiters)
            .set({
              earliestResetAt: decision.earliestResetAt,
              nextCheckAt,
              resetKind: decision.resetKind,
              refreshAttempt,
              observedWakeRevision: waiter.wakeRevision,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.codexCapacityWaiters.id, waiter.id),
                eq(schema.codexCapacityWaiters.status, "waiting"),
                eq(schema.codexCapacityWaiters.generation, waiter.generation),
              ),
            )
            .returning();
          if (!updated) {
            return { action: "stale", waiter: null, events: [] } as const;
          }
          return {
            action: "waiting",
            waiter: mapCodexCapacityWaiter(updated),
            events: [],
          } as const;
        }

        const prompt = [
          "[CODEX CAPACITY RESUME] Codex subscription capacity is available again.",
          `Continue the existing active goal from durable conversation history: ${goal.text}`,
          `Success criteria: ${goal.successCriteria ?? "none specified"}.`,
          "Do not replay completed tool side effects; verify any ambiguous in-flight effect before repeating it.",
          "If the goal is complete, call opengeni__goal_complete. If blocked for another reason, call opengeni__goal_pause.",
        ].join("\n");
        const [update] = await tx
          .insert(schema.sessionSystemUpdates)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            kind: "goal_continuation",
            classification: "info",
            sourceId: goal.id,
            dedupeKey: `codex-capacity-resume:${waiter.id}:${waiter.generation}`,
            summary: prompt,
            payload: {
              type: "goal_continuation",
              goalId: goal.id,
              goalVersion: goal.version,
              prompt,
              reason: "codex_capacity",
              capacityWaiterId: waiter.id,
              capacityWaitGeneration: waiter.generation,
              policy: {
                model: blockedTurn.model,
                reasoningEffort: blockedTurn.reasoningEffort,
                tools: blockedTurn.tools,
                sandboxBackend: blockedTurn.sandboxBackend,
              },
            },
            lineage: {
              goalId: goal.id,
              blockedTurnId: blockedTurn.id,
              capacityWaiterId: waiter.id,
            },
            state: "pending",
          })
          .returning();
        if (!update) {
          throw new Error("Codex capacity resume did not create an internal update");
        }
        await tx
          .insert(schema.usageEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            eventType: "agent_run.created",
            quantity: 1,
            unit: "run",
            sourceResourceType: "session_system_update",
            sourceResourceId: update.id,
            idempotencyKey: `agent_run.created:codex-capacity:${input.workspaceId}:${update.id}`,
            occurredAt: now,
          })
          .onConflictDoNothing({ target: schema.usageEvents.idempotencyKey });
        const events = await tx
          .insert(schema.sessionEvents)
          .values([
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: session.lastSequence + 1,
              type: "system.update.pending",
              payload: sanitizeEventPayload({
                updateId: update.id,
                kind: update.kind,
                classification: update.classification,
                sourceId: update.sourceId,
                summary: update.summary,
              }),
              occurredAt: now,
            },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: session.lastSequence + 2,
              type: "codex.capacity.resumed",
              payload: sanitizeEventPayload({
                waiterId: waiter.id,
                generation: waiter.generation,
                wakeRevision: waiter.wakeRevision,
                goalId: goal.id,
                goalVersion: goal.version,
                policyHash: waiter.policyHash,
                diagnostic: decision.diagnostic ?? null,
                updateId: update.id,
              }),
              turnId: blockedTurn.id,
              occurredAt: now,
            },
          ])
          .returning();
        const [updatedWaiter] = await tx
          .update(schema.codexCapacityWaiters)
          .set({
            status: "resumed",
            resumedUpdateId: update.id,
            observedWakeRevision: waiter.wakeRevision,
            lastWakeReason: "capacity_available",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.codexCapacityWaiters.id, waiter.id),
              eq(schema.codexCapacityWaiters.status, "waiting"),
              eq(schema.codexCapacityWaiters.generation, waiter.generation),
            ),
          )
          .returning();
        if (!updatedWaiter) {
          throw new Error("Codex capacity waiter changed during atomic resume");
        }
        await tx
          .update(schema.sessions)
          .set({
            status: "queued",
            activeTurnId: null,
            lastSequence: session.lastSequence + 2,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              isNull(schema.sessions.activeTurnId),
            ),
          );
        return {
          action: "resumed",
          waiter: mapCodexCapacityWaiter(updatedWaiter),
          update: mapSessionSystemUpdate(update),
          events: events.map(mapEvent),
        } as const;
      }),
  );
}

/**
 * Extend a live holder and return the database-confirmed expiry. A
 * missing/expired/released row returns null. A successful result lets the worker
 * derive a conservative monotonic deadline from the request start and configured
 * TTL, without comparing the Postgres and worker wall clocks.
 */
export async function heartbeatCodexCredentialLeaseUntil(
  db: Database,
  accountId: string,
  workspaceId: string,
  turnId: string,
  holderId: string,
  generation: number,
  leaseTtlMs: number = CODEX_CREDENTIAL_LEASE_TTL_MS,
): Promise<Date | null> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb.execute(sql<{ leased_until: Date | string }>`
      update codex_credential_leases
      set leased_until = now() + (${leaseTtlMs} * interval '1 millisecond'),
          updated_at = now()
      where account_id = ${accountId}
        and workspace_id = ${workspaceId}
        and turn_id = ${turnId}
        and holder_id = ${holderId}
        and generation = ${generation}
        and leased_until > now()
      returning leased_until
    `);
    return codexMetadataDate(rows[0]?.leased_until);
  });
}

/** Extend a live holder. Compatibility wrapper for boolean-only callers. */
export async function heartbeatCodexCredentialLease(
  db: Database,
  accountId: string,
  workspaceId: string,
  turnId: string,
  holderId: string,
  generation: number,
  leaseTtlMs: number = CODEX_CREDENTIAL_LEASE_TTL_MS,
): Promise<boolean> {
  return (
    (await heartbeatCodexCredentialLeaseUntil(
      db,
      accountId,
      workspaceId,
      turnId,
      holderId,
      generation,
      leaseTtlMs,
    )) !== null
  );
}

/** Idempotent turn-end release. */
export async function releaseCodexCredentialLease(
  db: Database,
  accountId: string,
  workspaceId: string,
  turnId: string,
  holderId: string,
  generation: number,
): Promise<boolean> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.codexCredentialLeases)
      .where(
        and(
          eq(schema.codexCredentialLeases.workspaceId, workspaceId),
          eq(schema.codexCredentialLeases.turnId, turnId),
          eq(schema.codexCredentialLeases.holderId, holderId),
          eq(schema.codexCredentialLeases.generation, generation),
        ),
      )
      .returning({ id: schema.codexCredentialLeases.id });
    return rows.length > 0;
  });
}

export type CodexCredentialLeaseQuarantine =
  | {
      kind: "status";
      status: "needs_relogin" | "error";
      lastError: string;
    }
  | { kind: "cooldown"; until: Date };

/**
 * Quarantine the credential served by one exact live holder. The lease row is
 * locked and checked before the credential write, so a superseded/expired
 * activity cannot poison status or cooldown after a successor owns the turn.
 */
export async function quarantineCodexCredentialForLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    turnId: string;
    credentialId: string;
    holderId: string;
    generation: number;
    quarantine: CodexCredentialLeaseQuarantine;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const leaseRows = await tx.execute(sql<{ id: string }>`
          select id from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and credential_id = ${input.credentialId}
            and holder_id = ${input.holderId}
            and generation = ${input.generation}
            and leased_until > now()
          for update
        `);
        if (!leaseRows[0]) {
          return false;
        }
        const updated = await tx
          .update(schema.codexSubscriptionCredentials)
          .set(
            input.quarantine.kind === "status"
              ? {
                  status: input.quarantine.status,
                  lastError: input.quarantine.lastError,
                  updatedAt: new Date(),
                }
              : { exhaustedUntil: input.quarantine.until },
          )
          .where(
            and(
              eq(schema.codexSubscriptionCredentials.accountId, input.accountId),
              eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId),
              eq(schema.codexSubscriptionCredentials.id, input.credentialId),
            ),
          )
          .returning({ id: schema.codexSubscriptionCredentials.id });
        return updated.length > 0;
      }),
  );
}

/**
 * Metadata-only list of every connected Codex account in the workspace, for the
 * accounts UI + the worker's selection resolver. NEVER decrypts. `isActive` marks
 * the workspace active pointer. Ordered by created_at ASC (stable list order).
 */
export async function listCodexAccountStatuses(
  db: Database,
  workspaceId: string,
): Promise<CodexAccountStatus[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [settingsRow] = await scopedDb
      .select({ activeCredentialId: schema.codexRotationSettings.activeCredentialId })
      .from(schema.codexRotationSettings)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .limit(1);
    const activeId = settingsRow?.activeCredentialId ?? null;
    const rows = await scopedDb
      .select({
        id: schema.codexSubscriptionCredentials.id,
        chatgptAccountId: schema.codexSubscriptionCredentials.chatgptAccountId,
        label: schema.codexSubscriptionCredentials.label,
        accountEmail: schema.codexSubscriptionCredentials.accountEmail,
        planType: schema.codexSubscriptionCredentials.planType,
        status: schema.codexSubscriptionCredentials.status,
        allocatorEnabled: schema.codexSubscriptionCredentials.allocatorEnabled,
        expiresAt: schema.codexSubscriptionCredentials.expiresAt,
        lastRefreshAt: schema.codexSubscriptionCredentials.lastRefreshAt,
        lastError: schema.codexSubscriptionCredentials.lastError,
        // P2/P3 cached capacity metadata is strictly workspace-local.
        primaryUsedPercent: schema.codexSubscriptionCredentials.primaryUsedPercent,
        primaryResetAt: schema.codexSubscriptionCredentials.primaryResetAt,
        secondaryUsedPercent: schema.codexSubscriptionCredentials.secondaryUsedPercent,
        secondaryResetAt: schema.codexSubscriptionCredentials.secondaryResetAt,
        usageCheckedAt: schema.codexSubscriptionCredentials.usageCheckedAt,
        exhaustedUntil: schema.codexSubscriptionCredentials.exhaustedUntil,
        // P4 connector-set cache — metadata-only, rides along on this read.
        connectorNamespaces: schema.codexSubscriptionCredentials.connectorNamespaces,
        connectorsCheckedAt: schema.codexSubscriptionCredentials.connectorsCheckedAt,
      })
      .from(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
      .orderBy(
        asc(schema.codexSubscriptionCredentials.createdAt),
        asc(schema.codexSubscriptionCredentials.id),
      );
    return rows.map((row) => ({
      ...row,
      expiresAt: codexMetadataDate(row.expiresAt),
      lastRefreshAt: codexMetadataDate(row.lastRefreshAt),
      primaryResetAt: codexMetadataDate(row.primaryResetAt),
      secondaryResetAt: codexMetadataDate(row.secondaryResetAt),
      usageCheckedAt: codexMetadataDate(row.usageCheckedAt),
      exhaustedUntil: codexMetadataDate(row.exhaustedUntil),
      connectorsCheckedAt: codexMetadataDate(row.connectorsCheckedAt),
      isActive: row.id === activeId,
    }));
  });
}

/** The P2 usage-cache snapshot written by the refreshing usage wrapper. */
export type CodexAccountUsageSnapshot = {
  primaryUsedPercent: number | null;
  primaryResetAt: Date | null;
  secondaryUsedPercent: number | null;
  secondaryResetAt: Date | null;
  checkedAt: Date;
};

/**
 * Cache-write for P2 quota bars: persist the five plaintext usage columns on a
 * SPECIFIC credential row. NEVER touches credential_encrypted. RLS-scoped, guarded
 * by (id, workspace_id) so it can only write a row the workspace owns. Returns true
 * iff a row was updated (false ⇒ the credential was disconnected under us — the
 * snapshot is moot, drop it). This is the only writer of the usage_checked_at TTL
 * clock that `listCodexAccountStatuses` reads back.
 */
export async function recordCodexAccountUsage(
  db: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
): Promise<boolean> {
  return (await recordCodexAccountUsageWithWakeTargets(db, workspaceId, credentialId, snapshot))
    .result;
}

/** Usage-cache mutation plus its committed durable capacity-wake outbox. */
export async function recordCodexAccountUsageWithWakeTargets(
  db: Database,
  workspaceId: string,
  credentialId: string,
  snapshot: CodexAccountUsageSnapshot,
): Promise<CodexCapacityMutationResult<boolean>> {
  return await withCodexCapacityMutation(
    db,
    { workspaceId, reason: "codex_usage_refreshed" },
    async (tx) => {
      const updated = await tx
        .update(schema.codexSubscriptionCredentials)
        .set({
          primaryUsedPercent: snapshot.primaryUsedPercent,
          primaryResetAt: snapshot.primaryResetAt,
          secondaryUsedPercent: snapshot.secondaryUsedPercent,
          secondaryResetAt: snapshot.secondaryResetAt,
          usageCheckedAt: snapshot.checkedAt,
          // NB: no `version` bump and no `updatedAt` touch — usage is non-credential
          // metadata and must NOT race the (id, version) refresh CAS in
          // recordCodexTokenRefresh / setCodexCredentialStatus.
        })
        .where(
          and(
            eq(schema.codexSubscriptionCredentials.id, credentialId),
            eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          ),
        )
        .returning({ id: schema.codexSubscriptionCredentials.id });
      const changed = updated.length > 0;
      return { result: changed, changed };
    },
  );
}

export type CodexRotationSettings = {
  activeCredentialId: string | null;
  /** Legacy selector bit; old binaries only understand this field. */
  rotationEnabled: boolean;
  /** New allocator cutover bit; ignored safely by old binaries. */
  leaseRotationEnabled: boolean;
  rotationStrategy: string; // P1: 'most_remaining' (unused)
};

/**
 * Per-workspace model/provider availability policy. NULL fields = unrestricted
 * (identical to no row — the default for every workspace). Non-null
 * allowedProviders is a strict allowlist over resolved provider identities;
 * non-null allowedModels an additional exact model-id allowlist. Consumers:
 * the API model choke points (fail 422) and the worker's post-resolution gate
 * (a blocked provider never reaches a model call and never silently remaps).
 */
export type WorkspaceModelPolicy = {
  allowedProviders: string[] | null;
  allowedModels: string[] | null;
};

/** The per-workspace model policy row (null when none exists = unrestricted). */
export async function getWorkspaceModelPolicy(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceModelPolicy | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        allowedProviders: schema.workspaceModelPolicies.allowedProviders,
        allowedModels: schema.workspaceModelPolicies.allowedModels,
      })
      .from(schema.workspaceModelPolicies)
      .where(eq(schema.workspaceModelPolicies.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Create or replace the workspace's model policy. Passing null for a field
 * clears that restriction; a policy of {null, null} is kept as an explicit
 * "unrestricted" row (delete is not needed for correctness — it reads the same
 * as no row).
 */
export async function upsertWorkspaceModelPolicy(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    allowedProviders: string[] | null;
    allowedModels: string[] | null;
  },
): Promise<WorkspaceModelPolicy> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.workspaceModelPolicies)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          allowedProviders: input.allowedProviders,
          allowedModels: input.allowedModels,
        })
        .onConflictDoUpdate({
          target: [schema.workspaceModelPolicies.workspaceId],
          set: {
            allowedProviders: input.allowedProviders,
            allowedModels: input.allowedModels,
            updatedAt: new Date(),
          },
        })
        .returning({
          allowedProviders: schema.workspaceModelPolicies.allowedProviders,
          allowedModels: schema.workspaceModelPolicies.allowedModels,
        });
      return row!;
    },
  );
}

/** The per-workspace rotation/active-pointer row (null when none exists yet). */
export async function getCodexRotationSettings(
  db: Database,
  workspaceId: string,
): Promise<CodexRotationSettings | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        activeCredentialId: schema.codexRotationSettings.activeCredentialId,
        rotationEnabled: schema.codexRotationSettings.rotationEnabled,
        leaseRotationEnabled: schema.codexRotationSettings.leaseRotationEnabled,
        rotationStrategy: schema.codexRotationSettings.rotationStrategy,
      })
      .from(schema.codexRotationSettings)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  });
}

/** Idempotently ensure the per-workspace rotation-settings row exists. */
export async function ensureCodexRotationSettings(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<void> {
  await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) => {
    await scopedDb
      .insert(schema.codexRotationSettings)
      .values({
        accountId,
        workspaceId,
        leaseRotationEnabled: false,
      })
      .onConflictDoNothing({ target: [schema.codexRotationSettings.workspaceId] });
  });
}

/**
 * THE manual-switch primitive (workspace scope). Validates the credential id
 * belongs to the workspace, then one-cell UPDATEs active_credential_id. Returns
 * false if the id is unknown (so the route can 404).
 */
export async function setActiveCodexCredential(
  db: Database,
  workspaceId: string,
  credentialId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`
      select id from codex_rotation_settings
      where workspace_id = ${workspaceId}
      for update
    `);
    const [cred] = await scopedDb
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!cred) {
      return false;
    }
    const updated = await scopedDb
      .update(schema.codexRotationSettings)
      .set({ activeCredentialId: credentialId, updatedAt: new Date() })
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .returning({ id: schema.codexRotationSettings.id });
    return updated.length > 0;
  });
}

/** First-connect activation that never overwrites a concurrent manual choice. */
export async function setInitialActiveCodexCredential(
  db: Database,
  workspaceId: string,
  credentialId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`
      select id from codex_rotation_settings
      where workspace_id = ${workspaceId}
      for update
    `);
    const [cred] = await scopedDb
      .select({ id: schema.codexSubscriptionCredentials.id })
      .from(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          eq(schema.codexSubscriptionCredentials.id, credentialId),
        ),
      )
      .limit(1);
    if (!cred) return false;
    const rows = await scopedDb
      .update(schema.codexRotationSettings)
      .set({ activeCredentialId: credentialId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexRotationSettings.workspaceId, workspaceId),
          isNull(schema.codexRotationSettings.activeCredentialId),
        ),
      )
      .returning({ id: schema.codexRotationSettings.id });
    return rows.length > 0;
  });
}

/**
 * P3 rotation cooldown writer: stamp `exhausted_until` on a SPECIFIC credential row so the
 * rotation engine treats it as cooling-down (capped) until `until`. Pass `until = null` to
 * clear the cooldown. Modeled EXACTLY on recordCodexAccountUsage: RLS-scoped, guarded by
 * (id, workspace_id), and — critically — NO `version` bump and NO `updatedAt` touch, so it can
 * never race the (id, version) token-refresh CAS in recordCodexTokenRefresh / setCodexCredentialStatus.
 * Returns true iff a row was updated (false ⇒ the credential was disconnected under us).
 */
export async function setCodexCredentialExhausted(
  db: Database,
  workspaceId: string,
  credentialId: string,
  until: Date | null,
): Promise<boolean> {
  return (await setCodexCredentialExhaustedWithWakeTargets(db, workspaceId, credentialId, until))
    .result;
}

/** Cooldown mutation plus its committed durable capacity-wake outbox. */
export async function setCodexCredentialExhaustedWithWakeTargets(
  db: Database,
  workspaceId: string,
  credentialId: string,
  until: Date | null,
): Promise<CodexCapacityMutationResult<boolean>> {
  return await withCodexCapacityMutation(
    db,
    { workspaceId, reason: until === null ? "codex_cooldown_cleared" : "codex_cooldown_changed" },
    async (tx) => {
      const updated = await tx
        .update(schema.codexSubscriptionCredentials)
        .set({ exhaustedUntil: until })
        .where(
          and(
            eq(schema.codexSubscriptionCredentials.id, credentialId),
            eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          ),
        )
        .returning({ id: schema.codexSubscriptionCredentials.id });
      const changed = updated.length > 0;
      return { result: changed, changed };
    },
  );
}

/**
 * P3 reactive-rotation boundedness (Finding 1b): the number of CONSECUTIVE rotated
 * 429-failover turns since the session last had a SUCCESSFUL turn. Counts
 * `turn.failed` events carrying the `rotated` marker that occurred AFTER the most
 * recent `turn.completed` event (the natural reset anchor — any successful turn
 * moves the anchor past every prior failover, so the streak resets to 0). The
 * reactive 429 catch consults this to bound its otherwise-0-delay re-dispatch:
 * once the streak exceeds ~(connected accounts + margin) the path degrades to a
 * fixed positive idle instead of another hot re-dispatch (invariant 4: NO THRASH),
 * covering the double-fault where a cooldown write did not persist AND the 429
 * carried no usage headers. Derived from persisted events so it is correct across
 * the Temporal re-dispatch (each failover is a NEW turn, but its event survives).
 */
export async function countConsecutiveReactiveRotations(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [lastOk] = await scopedDb
      .select({ sequence: schema.sessionEvents.sequence })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.sessionId, sessionId),
          eq(schema.sessionEvents.type, "turn.completed"),
        ),
      )
      .orderBy(desc(schema.sessionEvents.sequence))
      .limit(1);
    const conditions = [
      eq(schema.sessionEvents.workspaceId, workspaceId),
      eq(schema.sessionEvents.sessionId, sessionId),
      eq(schema.sessionEvents.type, "turn.failed"),
      sql`${schema.sessionEvents.payload} ->> 'rotated' = 'true'`,
    ];
    if (lastOk) {
      conditions.push(sql`${schema.sessionEvents.sequence} > ${lastOk.sequence}`);
    }
    const [{ rotated } = { rotated: 0 }] = await scopedDb
      .select({
        rotated: sql<number>`count(*)::int`,
      })
      .from(schema.sessionEvents)
      .where(and(...conditions));
    return Number(rotated);
  });
}

/**
 * P4 connector-set cache writer: persist the set of ORIGINAL-dotted connector
 * namespaces a SPECIFIC credential exposes via codex_apps (+ the freshness clock).
 * Modeled byte-for-byte on recordCodexAccountUsage / setCodexCredentialExhausted:
 * RLS-scoped, guarded by (id, workspace_id), and — critically — NO `version` bump and
 * NO `updatedAt` touch, so it can never race the (id, version) token-refresh CAS.
 *
 * The CALLER must only invoke this with a NON-EMPTY set: codex_apps connects
 * best-effort (a transient failure yields an empty tools/list), and overwriting a
 * known non-empty set with [] would falsely "drop" coverage on a flaky turn. A
 * genuinely connector-less account stays null (the ranker treats null as unknown).
 * Returns true iff a row was updated (false ⇒ the credential was disconnected under us).
 */
export async function recordCodexAccountConnectors(
  db: Database,
  workspaceId: string,
  credentialId: string,
  namespaces: string[],
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({
        connectorNamespaces: namespaces,
        connectorsCheckedAt: new Date(),
        // NB: no `version` bump and no `updatedAt` touch — connector set is non-credential
        // metadata and must NOT race the (id, version) refresh CAS (same discipline as
        // recordCodexAccountUsage / setCodexCredentialExhausted).
      })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

/** The supported rotation strategies (P3). */
export const CODEX_ROTATION_STRATEGIES = [
  "most_remaining",
  "round_robin",
  "drain_then_next",
  // Session-sharded account affinity: each session gets a deterministic HOME
  // account (hash(sessionId) % healthy-accounts), written as a 'policy' pin at its
  // first codex turn and re-sharded only when that account caps. Spreads load ~1/N
  // across the pool while keeping a session on one warm account for prompt-cache
  // stability. Selectable exactly like the others via updateCodexRotationSettings.
  "sharded",
] as const;
export type CodexRotationStrategy = (typeof CODEX_ROTATION_STRATEGIES)[number];

/**
 * P3 rotation-settings write path: one-cell UPDATE of `rotation_enabled` and/or
 * `rotation_strategy` on the per-workspace row. Validates the strategy enum (rejects unknown).
 * Guarded by workspaceId; ensureCodexRotationSettings guarantees the row exists. Returns the
 * effective settings after the patch (null when no row exists yet — caller should ensure first).
 */
export async function updateCodexRotationSettings(
  db: Database,
  workspaceId: string,
  patch: { rotationEnabled?: boolean; rotationStrategy?: CodexRotationStrategy },
): Promise<CodexRotationSettings | null> {
  if (
    patch.rotationStrategy !== undefined &&
    !CODEX_ROTATION_STRATEGIES.includes(patch.rotationStrategy)
  ) {
    throw new Error(`invalid codex rotation strategy: ${patch.rotationStrategy}`);
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.rotationEnabled !== undefined) {
      set.rotationEnabled = patch.rotationEnabled;
      // A manual toggle owns both generations. Turning rotation off must also
      // disable the allocator-only default; turning it on keeps current and old
      // binaries consistent with explicit user intent.
      set.leaseRotationEnabled = patch.rotationEnabled;
    }
    if (patch.rotationStrategy !== undefined) {
      set.rotationStrategy = patch.rotationStrategy;
    }
    const [row] = await scopedDb
      .update(schema.codexRotationSettings)
      .set(set)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .returning({
        activeCredentialId: schema.codexRotationSettings.activeCredentialId,
        rotationEnabled: schema.codexRotationSettings.rotationEnabled,
        leaseRotationEnabled: schema.codexRotationSettings.leaseRotationEnabled,
        rotationStrategy: schema.codexRotationSettings.rotationStrategy,
      });
    return row ?? null;
  });
}

/** P1 rename (label only); P3 widens to rotation fields. */
export async function renameCodexAccount(
  db: Database,
  workspaceId: string,
  credentialId: string,
  label: string | null,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const updated = await scopedDb
      .update(schema.codexSubscriptionCredentials)
      .set({ label, updatedAt: new Date() })
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return updated.length > 0;
  });
}

/** The two sources of a per-session codex pin (AM-2). See sessions.codex_pin_source. */
export type CodexPinSource = "manual" | "policy";

export type SessionCodexState = {
  pinnedCredentialId: string | null;
  lastCredentialId: string | null;
  // The pin's SOURCE (AM-2): 'manual' (user switcher, sacred) or 'policy' (sharded
  // home assignment, re-shardable). NULL iff pinnedCredentialId is NULL.
  pinSource: CodexPinSource | null;
};

export type SetSessionCodexPinOptions = {
  /** Policy writers must not overwrite a pin committed after their read. */
  expected?: Pick<SessionCodexState, "pinnedCredentialId" | "pinSource">;
};

/** The session's pin (+ source) + last-ran-on Codex account (drives the worker resolver + indicator). */
export async function getSessionCodexState(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionCodexState | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        pinnedCredentialId: schema.sessions.codexPinnedCredentialId,
        lastCredentialId: schema.sessions.codexLastCredentialId,
        pinSource: schema.sessions.codexPinSource,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      pinnedCredentialId: row.pinnedCredentialId,
      lastCredentialId: row.lastCredentialId,
      pinSource: (row.pinSource as CodexPinSource | null) ?? null,
    };
  });
}

/**
 * Per-session pin. pinnedCredentialId === null clears the pin (follow the workspace
 * active) and clears the source. A non-null pin records `source` — 'manual' (the
 * default; the user's in-session switcher, which no policy path ever moves) or
 * 'policy' (the sharded strategy's deterministic home, re-shardable on cap).
 * Validates the id belongs to the workspace when non-null. Returns false if the
 * session is unknown or the id is invalid.
 */
export async function setSessionCodexPin(
  db: Database,
  workspaceId: string,
  sessionId: string,
  pinnedCredentialId: string | null,
  source: CodexPinSource = "manual",
  options: SetSessionCodexPinOptions = {},
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    if (pinnedCredentialId !== null) {
      const [cred] = await scopedDb
        .select({ id: schema.codexSubscriptionCredentials.id })
        .from(schema.codexSubscriptionCredentials)
        .where(
          and(
            eq(schema.codexSubscriptionCredentials.id, pinnedCredentialId),
            eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!cred) {
        return false;
      }
    }
    const conditions = [
      eq(schema.sessions.workspaceId, workspaceId),
      eq(schema.sessions.id, sessionId),
    ];
    if (options.expected) {
      conditions.push(
        options.expected.pinnedCredentialId === null
          ? isNull(schema.sessions.codexPinnedCredentialId)
          : eq(schema.sessions.codexPinnedCredentialId, options.expected.pinnedCredentialId),
        options.expected.pinSource === null
          ? isNull(schema.sessions.codexPinSource)
          : eq(schema.sessions.codexPinSource, options.expected.pinSource),
      );
    }
    const updated = await scopedDb
      .update(schema.sessions)
      .set({
        codexPinnedCredentialId: pinnedCredentialId,
        // Source travels with the pin: a cleared pin (null) clears the source too.
        codexPinSource: pinnedCredentialId === null ? null : source,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning({ id: schema.sessions.id });
    return updated.length > 0;
  });
}

/** Written by the worker at the turn boundary; drives the in-session indicator. */
export async function recordSessionActiveCodexCredential(
  db: Database,
  workspaceId: string,
  sessionId: string,
  credentialId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.sessions)
      .set({ codexLastCredentialId: credentialId, updatedAt: new Date() })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

/**
 * Disconnect ONE account. DELETE WHERE id = credentialId AND workspace_id. If it
 * was the active pointer, the FK ON DELETE SET NULL clears it; this fn then
 * re-picks the most-recently-connected remaining account as active, atomically in
 * the same RLS txn. Returns whether a row was removed + the new active id.
 */
export async function disconnectCodexAccount(
  db: Database,
  workspaceId: string,
  credentialId: string,
): Promise<{ removed: boolean; newActiveCredentialId: string | null }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(sql`
      select id from codex_rotation_settings
      where workspace_id = ${workspaceId}
      for update
    `);
    const removedRows = await scopedDb
      .delete(schema.codexSubscriptionCredentials)
      .where(
        and(
          eq(schema.codexSubscriptionCredentials.id, credentialId),
          eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId),
        ),
      )
      .returning({ id: schema.codexSubscriptionCredentials.id });
    // The FK SET NULL already cleared the pointer if we deleted the active row.
    const [settingsRow] = await scopedDb
      .select({ activeCredentialId: schema.codexRotationSettings.activeCredentialId })
      .from(schema.codexRotationSettings)
      .where(eq(schema.codexRotationSettings.workspaceId, workspaceId))
      .limit(1);
    if (removedRows.length === 0) {
      return { removed: false, newActiveCredentialId: settingsRow?.activeCredentialId ?? null };
    }
    let newActive = settingsRow?.activeCredentialId ?? null;
    if (newActive === null) {
      const [next] = await scopedDb
        .select({ id: schema.codexSubscriptionCredentials.id })
        .from(schema.codexSubscriptionCredentials)
        .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
        .orderBy(desc(schema.codexSubscriptionCredentials.createdAt))
        .limit(1);
      newActive = next?.id ?? null;
      if (settingsRow) {
        await scopedDb
          .update(schema.codexRotationSettings)
          .set({ activeCredentialId: newActive, updatedAt: new Date() })
          .where(eq(schema.codexRotationSettings.workspaceId, workspaceId));
      }
    }
    return { removed: true, newActiveCredentialId: newActive };
  });
}

/** Legacy "disconnect all" (old workspace-wide behavior). Returns rows removed. */
export async function disconnectAllCodexAccounts(
  db: Database,
  workspaceId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .delete(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return rows.length;
  });
}

export async function recordAuditEvent(
  db: Database,
  input: {
    accountId: string;
    workspaceId?: string | null;
    subjectId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  // audit_events has a FORCED RLS policy keyed on the account/workspace GUCs,
  // so the insert must run inside an RLS context.
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId ?? null },
    async (scopedDb) => {
      await scopedDb.insert(schema.auditEvents).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId ?? null,
        subjectId: input.subjectId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
      });
    },
  );
}

async function listVariableSetVariableMetadata(
  db: Database,
  workspaceId: string,
  variableSetId: string,
): Promise<VariableSetVariableMetadata[]> {
  const rows = await db
    .select({
      name: schema.workspaceVariableSetVariables.name,
      version: schema.workspaceVariableSetVariables.version,
      createdAt: schema.workspaceVariableSetVariables.createdAt,
      updatedAt: schema.workspaceVariableSetVariables.updatedAt,
    })
    .from(schema.workspaceVariableSetVariables)
    .where(
      and(
        eq(schema.workspaceVariableSetVariables.workspaceId, workspaceId),
        eq(schema.workspaceVariableSetVariables.variableSetId, variableSetId),
      ),
    )
    .orderBy(asc(schema.workspaceVariableSetVariables.name));
  return rows.map(mapVariableSetVariableMetadata);
}

function mapVariableSet(
  row: typeof schema.workspaceVariableSets.$inferSelect,
  variables: VariableSetVariableMetadata[],
): VariableSet {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    variables,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapVariableSetVariableMetadata(row: {
  name: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): VariableSetVariableMetadata {
  return {
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSessionMcpServerMetadata(
  row: typeof schema.sessionMcpServers.$inferSelect,
): SessionMcpServerMetadata {
  return {
    id: row.serverId,
    name: row.name ?? null,
    url: row.url,
    headerNames: Object.keys(row.headersEncrypted ?? {}).sort(),
    credentialVersion: Number(row.credentialVersion),
  };
}

async function sessionMcpServerMetadataForSessions(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<Map<string, SessionMcpServerMetadata[]>> {
  const grouped = new Map<string, SessionMcpServerMetadata[]>();
  if (sessionIds.length === 0) {
    return grouped;
  }
  const rows = await db
    .select()
    .from(schema.sessionMcpServers)
    .where(
      and(
        eq(schema.sessionMcpServers.workspaceId, workspaceId),
        inArray(schema.sessionMcpServers.sessionId, sessionIds),
      ),
    )
    .orderBy(asc(schema.sessionMcpServers.createdAt), asc(schema.sessionMcpServers.serverId));
  for (const row of rows) {
    const list = grouped.get(row.sessionId) ?? [];
    list.push(mapSessionMcpServerMetadata(row));
    grouped.set(row.sessionId, list);
  }
  return grouped;
}

async function insertSessionMcpServers(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    servers: CreateSessionMcpServerInput[];
  },
): Promise<SessionMcpServerMetadata[]> {
  if (input.servers.length === 0) {
    return [];
  }
  const rows = await db
    .insert(schema.sessionMcpServers)
    .values(
      input.servers.map((server) => ({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        serverId: server.id,
        name: server.name ?? null,
        url: server.url,
        allowedTools: server.allowedTools ?? null,
        timeoutMs: server.timeoutMs ?? null,
        cacheToolsList: server.cacheToolsList ?? false,
        requireApproval: server.requireApproval ?? null,
        headersEncrypted: server.headersEncrypted ?? {},
      })),
    )
    .returning();
  return rows.map(mapSessionMcpServerMetadata);
}

export async function createSessionMcpServers(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    servers: CreateSessionMcpServerInput[];
  },
): Promise<SessionMcpServerMetadata[]> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await insertSessionMcpServers(scopedDb, input),
  );
}

export async function listSessionMcpServerMetadata(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionMcpServerMetadata[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const grouped = await sessionMcpServerMetadataForSessions(scopedDb, workspaceId, [sessionId]);
    return grouped.get(sessionId) ?? [];
  });
}

export async function updateSessionMcpServerCredentials(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    updates: UpdateSessionMcpServerCredentialsInput[];
  },
): Promise<UpdateSessionMcpServerCredentialsResult> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(
        async (tx) => await updateSessionMcpServerCredentialsInTransaction(tx, input),
      ),
  );
}

async function updateSessionMcpServerCredentialsInTransaction(
  tx: Pick<Database, "update">,
  input: {
    workspaceId: string;
    sessionId: string;
    updates: UpdateSessionMcpServerCredentialsInput[];
  },
): Promise<UpdateSessionMcpServerCredentialsResult> {
  const servers: SessionMcpServerMetadata[] = [];
  const missingIds: string[] = [];
  for (const update of input.updates) {
    const [row] = await tx
      .update(schema.sessionMcpServers)
      .set({
        headersEncrypted: update.headersEncrypted,
        credentialVersion: sql`${schema.sessionMcpServers.credentialVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessionMcpServers.workspaceId, input.workspaceId),
          eq(schema.sessionMcpServers.sessionId, input.sessionId),
          eq(schema.sessionMcpServers.serverId, update.id),
        ),
      )
      .returning();
    if (!row) {
      missingIds.push(update.id);
    } else {
      servers.push(mapSessionMcpServerMetadata(row));
    }
  }
  return { servers, missingIds };
}

export async function listSessionMcpServersForRun(
  db: Database,
  workspaceId: string,
  sessionId: string,
  encryptionKey: Uint8Array,
): Promise<SessionMcpServerForRun[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sessionMcpServers)
      .where(
        and(
          eq(schema.sessionMcpServers.workspaceId, workspaceId),
          eq(schema.sessionMcpServers.sessionId, sessionId),
        ),
      )
      .orderBy(asc(schema.sessionMcpServers.createdAt), asc(schema.sessionMcpServers.serverId));
    return rows.map((row) => {
      let headers: Record<string, string>;
      try {
        headers = Object.fromEntries(
          Object.entries(row.headersEncrypted ?? {}).map(([name, stored]) => [
            name,
            decryptEnvironmentValue(encryptionKey, stored),
          ]),
        );
      } catch {
        throw new Error("session MCP server credential decryption failed");
      }
      return {
        ...mapSessionMcpServerMetadata(row),
        ...(row.allowedTools ? { allowedTools: row.allowedTools } : {}),
        ...(row.timeoutMs ? { timeoutMs: row.timeoutMs } : {}),
        ...(row.cacheToolsList ? { cacheToolsList: row.cacheToolsList } : {}),
        ...(row.requireApproval != null ? { requireApproval: row.requireApproval } : {}),
        headers,
      };
    });
  });
}

async function lockWorkspaceForSessionCreate(tx: Database, workspaceId: string): Promise<void> {
  await lockWorkspaceInferenceControl(tx, workspaceId, "share");
  const [workspace] = await tx
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
}

export async function createSession(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    initialMessage: string;
    resources: ResourceRef[];
    tools?: ToolRef[];
    metadata: Record<string, unknown>;
    model: string;
    sandboxBackend: SandboxBackend;
    variableSetId?: string | null;
    // The rig + frozen active rig version resolved at create (M3). Both omitted/null
    // ⇒ a rig-less session (byte-for-byte today's behavior).
    rigId?: string | null;
    rigVersionId?: string | null;
    rigDefaultVariableSetsAuthorized?: boolean;
    firstPartyMcpPermissions?: Permission[] | null;
    // Per-session agent persona/system instructions (org-visible, not a secret).
    // Null/omitted ⇒ the session carries none (composed instructions unchanged).
    instructions?: string | null;
    parentSessionId?: string | null;
    createIdempotencyKey?: string | null;
    // The shared-sandbox group to join. Omit (or null) for a singleton group:
    // the new row's own id is used (group === session), today's 1:1 behavior. A
    // shared spawn passes the parent's sandboxGroupId so both run in ONE box.
    sandboxGroupId?: string | null;
    sandboxOs?: SandboxOs;
    mcpServers?: CreateSessionMcpServerInput[];
  },
): Promise<Session> {
  // Generate the id up front so the same uuid can seed sandbox_group_id for a
  // singleton group (sandbox_group_id cannot SQL-default to id).
  const id = crypto.randomUUID();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockWorkspaceForSessionCreate(tx as unknown as Database, input.workspaceId);
        const [row] = await tx
          .insert(schema.sessions)
          .values({
            id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            initialMessage: input.initialMessage,
            resources: input.resources,
            tools: input.tools ?? [],
            metadata: input.metadata,
            model: input.model,
            sandboxBackend: input.sandboxBackend,
            sandboxOs: input.sandboxOs ?? "linux",
            sandboxGroupId: input.sandboxGroupId ?? id,
            variableSetId: input.variableSetId ?? null,
            rigId: input.rigId ?? null,
            rigVersionId: input.rigVersionId ?? null,
            rigDefaultVariableSetsAuthorized: input.rigDefaultVariableSetsAuthorized ?? false,
            firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
            instructions: input.instructions ?? null,
            parentSessionId: input.parentSessionId ?? null,
            createIdempotencyKey: input.createIdempotencyKey ?? null,
            status: "queued",
          })
          .returning();
        if (!row) {
          throw new Error("Failed to create session");
        }
        const mcpServers = await insertSessionMcpServers(tx as unknown as Database, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: row.id,
          servers: input.mcpServers ?? [],
        });
        return await mapSessionWithControl(tx as unknown as Database, row, mcpServers);
      }),
  );
}

/**
 * Inserts a session under a workspace-scoped CREATE idempotency key, collapsing
 * a concurrent race on the same key to a single row. On the unique-violation
 * the conflicting insert does nothing (`onConflictDoNothing` on the partial
 * unique index) and the now-existing winning row is fetched and returned, so
 * two near-simultaneous creates with the same key yield ONE session and both
 * callers see the same id. `created` distinguishes the winner (true: this call
 * inserted and must run the rest of the start flow) from the loser/dup (false:
 * the row already existed and must be returned as-is).
 */
export async function createSessionWithIdempotencyKey(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    initialMessage: string;
    resources: ResourceRef[];
    tools?: ToolRef[];
    metadata: Record<string, unknown>;
    model: string;
    sandboxBackend: SandboxBackend;
    variableSetId?: string | null;
    // The rig + frozen active rig version resolved at create (M3). Both omitted/null
    // ⇒ a rig-less session (byte-for-byte today's behavior).
    rigId?: string | null;
    rigVersionId?: string | null;
    rigDefaultVariableSetsAuthorized?: boolean;
    firstPartyMcpPermissions?: Permission[] | null;
    // Per-session agent persona/system instructions (org-visible, not a secret).
    instructions?: string | null;
    parentSessionId?: string | null;
    createIdempotencyKey: string;
    // The shared-sandbox group to join. Omit (or null) for a singleton group
    // (group === the new row's own id); a shared spawn passes the parent's group.
    sandboxGroupId?: string | null;
    sandboxOs?: SandboxOs;
    mcpServers?: CreateSessionMcpServerInput[];
  },
): Promise<{ session: Session; created: boolean }> {
  // Generate the id up front so the same uuid can seed sandbox_group_id for a
  // singleton group (sandbox_group_id cannot SQL-default to id).
  const id = crypto.randomUUID();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockWorkspaceForSessionCreate(tx as unknown as Database, input.workspaceId);
        const [inserted] = await tx
          .insert(schema.sessions)
          .values({
            id,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            initialMessage: input.initialMessage,
            resources: input.resources,
            tools: input.tools ?? [],
            metadata: input.metadata,
            model: input.model,
            sandboxBackend: input.sandboxBackend,
            sandboxOs: input.sandboxOs ?? "linux",
            sandboxGroupId: input.sandboxGroupId ?? id,
            variableSetId: input.variableSetId ?? null,
            rigId: input.rigId ?? null,
            rigVersionId: input.rigVersionId ?? null,
            rigDefaultVariableSetsAuthorized: input.rigDefaultVariableSetsAuthorized ?? false,
            firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
            instructions: input.instructions ?? null,
            parentSessionId: input.parentSessionId ?? null,
            createIdempotencyKey: input.createIdempotencyKey,
            status: "queued",
          })
          .onConflictDoNothing({
            target: [schema.sessions.workspaceId, schema.sessions.createIdempotencyKey],
            where: sql`${schema.sessions.createIdempotencyKey} is not null`,
          })
          .returning();
        if (inserted) {
          const mcpServers = await insertSessionMcpServers(tx as unknown as Database, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: inserted.id,
            servers: input.mcpServers ?? [],
          });
          return {
            session: await mapSessionWithControl(tx as unknown as Database, inserted, mcpServers),
            created: true,
          };
        }
        const [existing] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.createIdempotencyKey, input.createIdempotencyKey),
            ),
          )
          .limit(1);
        if (!existing) {
          // No row inserted and none found: the conflict target did not actually
          // collide (should never happen for a present key) — surface it rather
          // than silently returning a phantom.
          throw new Error("Failed to create session under idempotency key");
        }
        const grouped = await sessionMcpServerMetadataForSessions(
          tx as unknown as Database,
          input.workspaceId,
          [existing.id],
        );
        return {
          session: await mapSessionWithControl(
            tx as unknown as Database,
            existing,
            grouped.get(existing.id) ?? [],
          ),
          created: false,
        };
      }),
  );
}

export async function getSessionByCreateIdempotencyKey(
  db: Database,
  workspaceId: string,
  createIdempotencyKey: string,
): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.createIdempotencyKey, createIdempotencyKey),
        ),
      )
      .limit(1);
    if (!row) return null;
    const grouped = await sessionMcpServerMetadataForSessions(scopedDb, workspaceId, [row.id]);
    return await mapSessionWithControl(scopedDb, row, grouped.get(row.id) ?? []);
  });
}

export async function getSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) return null;
    const grouped = await sessionMcpServerMetadataForSessions(scopedDb, workspaceId, [row.id]);
    return await mapSessionWithControl(scopedDb, row, grouped.get(row.id) ?? []);
  });
}

/**
 * Resolve ANY session that belongs to a shared-sandbox group (addendum 05 §D.3,
 * stress (e)). Used by the create-session `sandbox:{groupId}` join path to (1)
 * prove the group exists and (2) inherit its box's (backend, os).
 *
 * `workspaceId` is a MANDATORY access boundary, NOT optional: the group uuid is
 * caller-supplied, so the workspace filter (inside RLS) is what forbids a
 * cross-workspace join — a foreign group returns null → the caller 404s. The
 * group uuid itself is never an authorization boundary. Returns the first member
 * session (any one suffices to read the shared box's backend/os); null when the
 * group has no session in this workspace.
 */
export async function getAnySessionInGroup(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.sandboxGroupId, sandboxGroupId),
        ),
      )
      .limit(1);
    return row ? await mapSessionWithControl(scopedDb, row) : null;
  });
}

/**
 * The DISTINCT variableSetIds across a group's member sessions (workspace-
 * scoped; null = no variableSet attached). The env-aware create check compares
 * a joiner against EVERY member — an arbitrary single member (getAnySessionInGroup)
 * makes the compatibility verdict nondeterministic for legacy env-blind groups
 * whose members carry mixed variableSetIds.
 */
export async function listDistinctVariableSetIdsInGroup(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
): Promise<Array<string | null>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .selectDistinct({ variableSetId: schema.sessions.variableSetId })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.sandboxGroupId, sandboxGroupId),
        ),
      );
    return rows.map((r) => r.variableSetId ?? null);
  });
}

// M3 rig sharing gate: the distinct frozen rig_version_ids across a group's
// sessions. Mirrors listDistinctVariableSetIdsInGroup — the box's rig-baked
// setup is fixed at cold-create, so a session joining a group must carry the
// SAME rig_version_id (or the join is a genuine shared-state conflict). A null
// entry means a rig-less member (compatible only with another rig-less join).
export async function listDistinctRigVersionIdsInGroup(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
): Promise<Array<string | null>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .selectDistinct({ rigVersionId: schema.sessions.rigVersionId })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.sandboxGroupId, sandboxGroupId),
        ),
      );
    return rows.map((r) => r.rigVersionId ?? null);
  });
}

// M3 default-rig fallback: the workspace's default rig id (workspaces.default_rig_id),
// read WITHOUT surfacing it through the Workspace contract (a workspace-settings
// UI concern deferred to M5). A create with no explicit rigId falls back to this.
// Not RLS-scoped for the same reason getWorkspace is not: the workspace row is
// addressed by its primary key and the caller already holds the workspace grant.
export async function getWorkspaceDefaultRigId(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ defaultRigId: schema.workspaces.defaultRigId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return row?.defaultRigId ?? null;
}

export type ListSessionsOptions = {
  limit?: number;
  parentSessionId?: string | null;
};

export type SessionListCursor = {
  snapshotId: string;
  offset: number;
  parentSessionFilter: string;
  search: string | null;
};

export type ListSessionsForSubjectOptions = ListSessionsOptions & {
  subjectId: string;
  cursor?: SessionListCursor | undefined;
  search?: string | undefined;
};

export class SessionPinVersionConflictError extends Error {
  constructor(readonly current: Pick<Session, "pinned" | "pinnedAt" | "pinVersion">) {
    super("session pin version conflict");
    this.name = "SessionPinVersionConflictError";
  }
}

export class SessionListCursorError extends Error {
  constructor(message = "session list cursor is invalid or expired") {
    super(message);
    this.name = "SessionListCursorError";
  }
}

export class SessionListAccessError extends Error {
  constructor(message = "workspace access denied") {
    super(message);
    this.name = "SessionListAccessError";
  }
}

export class SessionPinAccessError extends Error {
  constructor(message = "workspace access denied") {
    super(message);
    this.name = "SessionPinAccessError";
  }
}

function isPostgresSerializationFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate: unknown = error;
  while (typeof candidate === "object" && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    if ("code" in candidate && (candidate as { code?: unknown }).code === "40001") {
      return true;
    }
    candidate = "cause" in candidate ? (candidate as { cause?: unknown }).cause : undefined;
  }
  return false;
}

type SessionPinRow = Pick<
  typeof schema.sessionPins.$inferSelect,
  "pinned" | "pinnedAt" | "version"
>;

function mapSessionPin(
  row: SessionPinRow | null | undefined,
): Pick<Session, "pinned" | "pinnedAt" | "pinVersion"> {
  return row
    ? {
        pinned: row.pinned,
        pinnedAt: row.pinnedAt?.toISOString() ?? null,
        pinVersion: Number(row.version),
      }
    : { pinned: false, pinnedAt: null, pinVersion: 0 };
}

type SessionTreeStats = NonNullable<Session["treeStats"]>;

type SessionTreeStatsRow = {
  rootId: string;
  directChildren: number | string;
  totalDescendants: number | string;
  runningDescendants: number | string;
  queuedDescendants: number | string;
  attentionDescendants: number | string;
  pausedDescendants: number | string;
  failedDescendants: number | string;
};

/**
 * Return complete descendant aggregates for the bounded set of rows being
 * painted in the session rail. Parent links are immutable, so one recursive
 * read inside the list transaction gives the client stable, authoritative
 * expand affordances without loading the workspace's entire session table.
 */
async function sessionTreeStatsForSessions(
  db: Database,
  workspaceId: string,
  rootIds: string[],
): Promise<Map<string, SessionTreeStats>> {
  if (rootIds.length === 0) return new Map();
  const rows = await rawRows<SessionTreeStatsRow>(
    db,
    sql`
      with recursive descendants(root_id, id, status, depth, path) as (
        select
          root.id,
          root.id,
          root.status,
          0,
          array[root.id]
        from ${schema.sessions} root
        where root.workspace_id = ${workspaceId}
          and ${inArray(sql`root.id`, rootIds)}

        union all

        select
          descendants.root_id,
          child.id,
          child.status,
          descendants.depth + 1,
          descendants.path || child.id
        from ${schema.sessions} child
        join descendants on child.parent_session_id = descendants.id
        where child.workspace_id = ${workspaceId}
          and not child.id = any(descendants.path)
      )
      select
        root_id as "rootId",
        count(*) filter (where depth = 1)::int as "directChildren",
        count(*) filter (where depth > 0)::int as "totalDescendants",
        count(*) filter (
          where depth > 0 and status in ('running', 'recovering')
        )::int as "runningDescendants",
        count(*) filter (
          where depth > 0 and status in ('queued', 'waiting_capacity')
        )::int as "queuedDescendants",
        count(*) filter (
          where depth > 0 and status = 'requires_action'
        )::int as "attentionDescendants",
        count(*) filter (
          where depth > 0 and status = 'paused'
        )::int as "pausedDescendants",
        count(*) filter (
          where depth > 0 and status = 'failed'
        )::int as "failedDescendants"
      from descendants
      group by root_id
    `,
  );
  return new Map(
    rows.map((row) => [
      row.rootId,
      {
        directChildren: Number(row.directChildren),
        totalDescendants: Number(row.totalDescendants),
        runningDescendants: Number(row.runningDescendants),
        queuedDescendants: Number(row.queuedDescendants),
        attentionDescendants: Number(row.attentionDescendants),
        pausedDescendants: Number(row.pausedDescendants),
        failedDescendants: Number(row.failedDescendants),
      },
    ]),
  );
}

function sessionFilters(
  options: Pick<ListSessionsForSubjectOptions, "parentSessionId" | "search">,
): SQL[] {
  const filters: SQL[] = [];
  if (Object.prototype.hasOwnProperty.call(options, "parentSessionId")) {
    const parentSessionId = options.parentSessionId;
    if (parentSessionId === null) {
      filters.push(isNull(schema.sessions.parentSessionId));
    } else if (parentSessionId !== undefined) {
      filters.push(eq(schema.sessions.parentSessionId, parentSessionId));
    }
  }
  const search = options.search?.trim();
  if (search) {
    // PostgreSQL LIKE uses backslash as its default escape. Escape it first so
    // a literal trailing slash cannot consume our surrounding wildcard; then
    // escape the two wildcard metacharacters. The resulting search is literal,
    // case-insensitive substring matching rather than user-authored SQL globbing.
    const pattern = `%${search
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_")}%`;
    filters.push(
      or(ilike(schema.sessions.title, pattern), ilike(schema.sessions.initialMessage, pattern))!,
    );
  }
  return filters;
}

const SESSION_LIST_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionParentFilter(parentSessionId: string | null | undefined): string {
  return parentSessionId === undefined
    ? "all"
    : parentSessionId === null
      ? "null"
      : parentSessionId;
}

function sessionSearchFilter(search: string | undefined): string | null {
  const trimmed = search?.trim();
  return trimmed ? trimmed : null;
}

/** Opaque, URL-safe cursor encoding for a server-owned activity snapshot. */
export function encodeSessionListCursor(cursor: SessionListCursor): string {
  return Buffer.from(
    JSON.stringify({
      snapshotId: cursor.snapshotId,
      offset: cursor.offset,
      parentSessionFilter: cursor.parentSessionFilter,
      search: cursor.search,
    }),
  ).toString("base64url");
}

/** Decode and validate a cursor before it reaches any SQL predicate. */
export function decodeSessionListCursor(value: string): SessionListCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      snapshotId?: unknown;
      offset?: unknown;
      parentSessionFilter?: unknown;
      search?: unknown;
    };
    const parentSessionFilter = parsed.parentSessionFilter;
    const search = parsed.search;
    const offset = parsed.offset;
    if (
      typeof parsed.snapshotId !== "string" ||
      !UUID_PATTERN.test(parsed.snapshotId) ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (parentSessionFilter !== "all" &&
        parentSessionFilter !== "null" &&
        (typeof parentSessionFilter !== "string" || !UUID_PATTERN.test(parentSessionFilter))) ||
      (search !== null && (typeof search !== "string" || search.length > 200))
    ) {
      return null;
    }
    return {
      snapshotId: parsed.snapshotId,
      offset,
      parentSessionFilter: parentSessionFilter as string,
      search: search as string | null,
    };
  } catch {
    return null;
  }
}

/** Bounded global TTL cleanup, isolated from serializable member list reads. */
export async function reapExpiredSessionListSnapshots(db: Database, limit = 500): Promise<number> {
  const rows = await rawRows<{ deleted_count: number | string }>(
    db,
    sql`select opengeni_private.reap_expired_session_list_snapshots(${limit}) as deleted_count`,
  );
  return Number(rows[0]?.deleted_count ?? 0);
}

/**
 * Server-authoritative member-specific page. Pinned rows are returned separately
 * and omitted from ordinary pages, so list pagination cannot duplicate a
 * session. The first page materializes the complete ordinary activity order in
 * a short-lived, subject-scoped snapshot; continuation cursors carry only that
 * snapshot id and offset, while the page joins live session rows for current
 * lifecycle/title data.
 */
export async function listSessionsForSubject(
  db: Database,
  workspaceId: string,
  options: ListSessionsForSubjectOptions,
): Promise<SessionListResponse> {
  const limit = Math.max(1, options.limit ?? 50);
  let membershipCheckSerializationFailure = false;
  const listInTransaction = async (): Promise<SessionListResponse> => {
    membershipCheckSerializationFailure = false;
    return await withWorkspaceSubjectRls(
      db,
      workspaceId,
      options.subjectId,
      async (tx) => {
        // Authorization is resolved before this helper by the API, but that
        // grant can be stale by the time this transaction starts. Lock the live
        // membership before touching snapshots so removal and listing serialize:
        // listing first lets removal clean its committed snapshot, while removal
        // first makes listing observe the missing membership and do no writes.
        let membership: { id: string } | undefined;
        try {
          [membership] = await tx
            .select({ id: schema.workspaceMemberships.id })
            .from(schema.workspaceMemberships)
            .where(
              and(
                eq(schema.workspaceMemberships.workspaceId, workspaceId),
                eq(schema.workspaceMemberships.subjectId, options.subjectId),
              ),
            )
            .for("update")
            .limit(1);
        } catch (error) {
          membershipCheckSerializationFailure = isPostgresSerializationFailure(error);
          throw error;
        }
        // A missing membership only means "denied" for user subjects — people
        // are authorized exclusively through memberships, so absence here is a
        // removal that the route-level grant hasn't observed yet. Non-user
        // principals (workspace-scoped `api_key:*`, delegated service subjects)
        // are authorized by requireAccessGrant from their own credential row and
        // may legitimately have no membership; they list without the removal
        // serialization. That is sound: member-removal cleanup already purges a
        // removed subject's pins and snapshots, and any snapshot a never-member
        // subject writes is bounded by TTL expiry.
        if (!membership && options.subjectId.startsWith("user:")) {
          throw new SessionListAccessError();
        }

        const filters = [eq(schema.sessions.workspaceId, workspaceId), ...sessionFilters(options)];
        const parentFilter = sessionParentFilter(options.parentSessionId);
        const searchFilter = sessionSearchFilter(options.search);
        const now = new Date();

        let pageIds: string[];
        let nextCursor: string | null = null;
        if (options.cursor) {
          const cursor = options.cursor;
          if (cursor.parentSessionFilter !== parentFilter || cursor.search !== searchFilter) {
            throw new SessionListCursorError("session list cursor does not match its filters");
          }
          const [snapshot] = await tx
            .select()
            .from(schema.sessionListSnapshots)
            .where(
              and(
                eq(schema.sessionListSnapshots.id, cursor.snapshotId),
                eq(schema.sessionListSnapshots.workspaceId, workspaceId),
                eq(schema.sessionListSnapshots.subjectId, options.subjectId),
              ),
            )
            .limit(1);
          if (!snapshot || snapshot.expiresAt.getTime() <= now.getTime()) {
            throw new SessionListCursorError();
          }
          if (
            snapshot.parentSessionFilter !== parentFilter ||
            (snapshot.search ?? null) !== searchFilter ||
            cursor.offset > snapshot.ordinarySessionIds.length
          ) {
            throw new SessionListCursorError();
          }
          pageIds = snapshot.ordinarySessionIds.slice(cursor.offset, cursor.offset + limit);
          const nextOffset = cursor.offset + pageIds.length;
          if (nextOffset < snapshot.ordinarySessionIds.length) {
            nextCursor = encodeSessionListCursor({
              snapshotId: snapshot.id,
              offset: nextOffset,
              parentSessionFilter: snapshot.parentSessionFilter,
              search: snapshot.search ?? null,
            });
          }
        } else {
          const ordinaryIdRows = await tx
            .select({ id: schema.sessions.id })
            .from(schema.sessions)
            .leftJoin(
              schema.sessionPins,
              and(
                eq(schema.sessionPins.workspaceId, workspaceId),
                eq(schema.sessionPins.subjectId, options.subjectId),
                eq(schema.sessionPins.sessionId, schema.sessions.id),
              ),
            )
            .where(
              and(
                ...filters,
                or(isNull(schema.sessionPins.id), eq(schema.sessionPins.pinned, false)),
              ),
            )
            .orderBy(desc(schema.sessions.updatedAt), desc(schema.sessions.id));
          const ordinaryIds = ordinaryIdRows.map((row) => row.id);
          pageIds = ordinaryIds.slice(0, limit);
          if (ordinaryIds.length > limit) {
            const [workspace] = await tx
              .select({ accountId: schema.workspaces.accountId })
              .from(schema.workspaces)
              .where(eq(schema.workspaces.id, workspaceId))
              .limit(1);
            if (!workspace) {
              throw new SessionListCursorError();
            }
            const [snapshot] = await tx
              .insert(schema.sessionListSnapshots)
              .values({
                accountId: workspace.accountId,
                workspaceId,
                subjectId: options.subjectId,
                parentSessionFilter: parentFilter,
                search: searchFilter,
                ordinarySessionIds: ordinaryIds,
                expiresAt: new Date(now.getTime() + SESSION_LIST_SNAPSHOT_TTL_MS),
              })
              .returning();
            if (!snapshot) {
              throw new SessionListCursorError();
            }
            nextCursor = encodeSessionListCursor({
              snapshotId: snapshot.id,
              offset: limit,
              parentSessionFilter: parentFilter,
              search: searchFilter,
            });
          }
        }
        const pinnedRows = await tx
          .select({ session: schema.sessions, pin: schema.sessionPins })
          .from(schema.sessionPins)
          .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionPins.sessionId))
          .where(
            and(
              eq(schema.sessionPins.workspaceId, workspaceId),
              eq(schema.sessionPins.subjectId, options.subjectId),
              eq(schema.sessionPins.pinned, true),
              ...filters,
            ),
          )
          .orderBy(desc(schema.sessionPins.pinnedAt), desc(schema.sessions.id));
        const ordinaryRows =
          pageIds.length === 0
            ? []
            : await tx
                .select({ session: schema.sessions, pin: schema.sessionPins })
                .from(schema.sessions)
                .leftJoin(
                  schema.sessionPins,
                  and(
                    eq(schema.sessionPins.workspaceId, workspaceId),
                    eq(schema.sessionPins.subjectId, options.subjectId),
                    eq(schema.sessionPins.sessionId, schema.sessions.id),
                  ),
                )
                .where(
                  and(
                    eq(schema.sessions.workspaceId, workspaceId),
                    inArray(schema.sessions.id, pageIds),
                    or(isNull(schema.sessionPins.id), eq(schema.sessionPins.pinned, false)),
                  ),
                );
        const ordinaryById = new Map(ordinaryRows.map((row) => [row.session.id, row]));
        const pageRows = pageIds.flatMap((id) => {
          const row = ordinaryById.get(id);
          return row ? [row] : [];
        });
        const ids = [
          ...pinnedRows.map((row) => row.session.id),
          ...pageRows.map((row) => row.session.id),
        ];
        const mcpServers = await sessionMcpServerMetadataForSessions(tx, workspaceId, ids);
        const treeStats = await sessionTreeStatsForSessions(tx, workspaceId, ids);
        const controls = await sessionControlProjections(tx, workspaceId, ids);
        const mapListSession = (
          row: (typeof pinnedRows)[number] | (typeof pageRows)[number],
        ): Session => {
          const control = controls.get(row.session.id);
          if (!control) throw new Error(`Effective control missing for session ${row.session.id}`);
          return {
            ...mapSession(
              row.session,
              control,
              mcpServers.get(row.session.id) ?? [],
              mapSessionPin(row.pin),
            ),
            treeStats: treeStats.get(row.session.id) ?? {
              directChildren: 0,
              totalDescendants: 0,
              runningDescendants: 0,
              queuedDescendants: 0,
              attentionDescendants: 0,
              pausedDescendants: 0,
              failedDescendants: 0,
            },
          };
        };
        return {
          pinned: pinnedRows.map(mapListSession),
          sessions: pageRows.map(mapListSession),
          nextCursor,
        };
      },
      { isolationLevel: "repeatable read" },
    );
  };

  try {
    return await listInTransaction();
  } catch (error) {
    if (!membershipCheckSerializationFailure || !isPostgresSerializationFailure(error)) {
      throw error;
    }
    // PostgreSQL has already aborted and rolled back the first transaction.
    // Retry exactly once so the fresh snapshot can observe a membership that
    // removal committed while the listing was waiting on its row lock.
    return await listInTransaction();
  }
}

/** Read a session with the caller subject's personal pin projection. */
export async function getSessionForSubject(
  db: Database,
  workspaceId: string,
  sessionId: string,
  subjectId: string,
): Promise<Session | null> {
  return await withWorkspaceSubjectRls(db, workspaceId, subjectId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ session: schema.sessions, pin: schema.sessionPins })
      .from(schema.sessions)
      .leftJoin(
        schema.sessionPins,
        and(
          eq(schema.sessionPins.workspaceId, workspaceId),
          eq(schema.sessionPins.subjectId, subjectId),
          eq(schema.sessionPins.sessionId, schema.sessions.id),
        ),
      )
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) return null;
    const mcpServers = await sessionMcpServerMetadataForSessions(scopedDb, workspaceId, [
      sessionId,
    ]);
    return await mapSessionWithControl(
      scopedDb,
      row.session,
      mcpServers.get(sessionId) ?? [],
      mapSessionPin(row.pin),
    );
  });
}

/**
 * Idempotently set a member's pin without mutating the session's lifecycle or
 * activity timestamps. A transaction advisory lock serializes same-subject,
 * same-session actions across API replicas; expectedVersion rejects stale tabs.
 */
export async function setSessionPin(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    sessionId: string;
    pinned: boolean;
    expectedVersion?: number | undefined;
  },
): Promise<Session | null> {
  return await withWorkspaceSubjectRls(
    db,
    input.workspaceId,
    input.subjectId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        // Serialize with removeWorkspaceMember(), which locks this row before
        // cleaning personal state and deleting the membership. A stale API
        // grant must not be able to recreate a pin after removal commits.
        const [membership] = await tx
          .select({ id: schema.workspaceMemberships.id })
          .from(schema.workspaceMemberships)
          .where(
            and(
              eq(schema.workspaceMemberships.workspaceId, input.workspaceId),
              eq(schema.workspaceMemberships.subjectId, input.subjectId),
            ),
          )
          .for("update")
          .limit(1);
        if (!membership) {
          throw new SessionPinAccessError();
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`session-pin:${input.workspaceId}:${input.subjectId}:${input.sessionId}`}, 0))`,
        );
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .limit(1);
        if (!session) return null;
        const [existing] = await tx
          .select()
          .from(schema.sessionPins)
          .where(
            and(
              eq(schema.sessionPins.workspaceId, input.workspaceId),
              eq(schema.sessionPins.subjectId, input.subjectId),
              eq(schema.sessionPins.sessionId, input.sessionId),
            ),
          )
          .limit(1);
        const current = mapSessionPin(existing);
        // Desired-state retries are idempotent even when their OCC revision is
        // stale. This is essential for a client that timed out after the server
        // committed: retrying the same pin/unpin must observe success, not a
        // conflict. OCC only protects a request that would CHANGE current state.
        if (current.pinned === input.pinned) {
          const mcpServers = await sessionMcpServerMetadataForSessions(tx, input.workspaceId, [
            session.id,
          ]);
          return await mapSessionWithControl(
            tx as unknown as Database,
            session,
            mcpServers.get(session.id) ?? [],
            mapSessionPin(existing),
          );
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.pinVersion) {
          throw new SessionPinVersionConflictError(current);
        }
        let pin = existing ?? null;
        if (!existing) {
          const [inserted] = await tx
            .insert(schema.sessionPins)
            .values({
              accountId: session.accountId,
              workspaceId: input.workspaceId,
              subjectId: input.subjectId,
              sessionId: input.sessionId,
              // The equal-state return above means an absent row can only
              // transition false -> true here; initial unpin stays row-free at
              // version zero instead of manufacturing an OCC revision.
              pinned: true,
              pinnedAt: new Date(),
            })
            .returning();
          pin = inserted ?? null;
        } else if (existing.pinned !== input.pinned) {
          const [updated] = await tx
            .update(schema.sessionPins)
            .set({
              pinned: input.pinned,
              pinnedAt: input.pinned ? new Date() : null,
              version: sql`${schema.sessionPins.version} + 1`,
            })
            .where(
              and(
                eq(schema.sessionPins.workspaceId, input.workspaceId),
                eq(schema.sessionPins.subjectId, input.subjectId),
                eq(schema.sessionPins.sessionId, input.sessionId),
              ),
            )
            .returning();
          pin = updated ?? null;
        }
        const mcpServers = await sessionMcpServerMetadataForSessions(tx, input.workspaceId, [
          session.id,
        ]);
        return await mapSessionWithControl(
          tx as unknown as Database,
          session,
          mcpServers.get(session.id) ?? [],
          mapSessionPin(pin),
        );
      }),
  );
}

export async function listSessions(
  db: Database,
  workspaceId: string,
  limit?: number,
): Promise<Session[]>;
export async function listSessions(
  db: Database,
  workspaceId: string,
  options?: ListSessionsOptions,
): Promise<Session[]>;
export async function listSessions(
  db: Database,
  workspaceId: string,
  limitOrOptions: number | ListSessionsOptions = 50,
): Promise<Session[]> {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const limit = options.limit ?? 50;
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const filters: SQL[] = [eq(schema.sessions.workspaceId, workspaceId)];
    if (Object.prototype.hasOwnProperty.call(options, "parentSessionId")) {
      const parentSessionId = options.parentSessionId;
      if (parentSessionId === null) {
        filters.push(isNull(schema.sessions.parentSessionId));
      } else if (parentSessionId !== undefined) {
        filters.push(eq(schema.sessions.parentSessionId, parentSessionId));
      }
    }
    const rows = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(...filters))
      .orderBy(desc(schema.sessions.createdAt), desc(schema.sessions.id))
      .limit(limit);
    const grouped = await sessionMcpServerMetadataForSessions(
      scopedDb,
      workspaceId,
      rows.map((row) => row.id),
    );
    const controls = await sessionControlProjections(
      scopedDb,
      workspaceId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => {
      const control = controls.get(row.id);
      if (!control) throw new Error(`Effective control missing for session ${row.id}`);
      return mapSession(row, control, grouped.get(row.id) ?? []);
    });
  });
}

export type SessionDiscoveryCursor = { createdAt: Date; id: string };
export type SessionDiscoverySummary = {
  id: string;
  title: string | null;
  parentSessionId: string | null;
  status: SessionStatus;
  effectiveControl: Session["effectiveControl"];
  goal: { status: SessionGoalStatus; text: string } | null;
  queuedPromptCount: number;
  treeStats: NonNullable<Session["treeStats"]>;
  latestMessage: { type: SessionEventType; preview: string | null } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Compact-by-construction discovery projection for the first-party
 * `sessions_list` MCP tool. It never selects instructions, resources, tools,
 * MCP metadata, repositories, settings, or full event/history bodies.
 */
export async function listSessionDiscoverySummaries(
  db: Database,
  workspaceId: string,
  options: {
    limit: number;
    cursor?: SessionDiscoveryCursor;
    includeLastMessage?: boolean;
  },
): Promise<{
  sessions: SessionDiscoverySummary[];
  hasMore: boolean;
  nextCursor: SessionDiscoveryCursor | null;
  total: number;
}> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const cursorPredicate = options.cursor
      ? or(
          lt(schema.sessions.createdAt, options.cursor.createdAt),
          and(
            eq(schema.sessions.createdAt, options.cursor.createdAt),
            lt(schema.sessions.id, options.cursor.id),
          ),
        )
      : undefined;
    const rows = await scopedDb
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        parentSessionId: schema.sessions.parentSessionId,
        status: schema.sessions.status,
        createdAt: schema.sessions.createdAt,
        updatedAt: schema.sessions.updatedAt,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), cursorPredicate))
      .orderBy(desc(schema.sessions.createdAt), desc(schema.sessions.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);
    const [{ total } = { total: 0 }] = await scopedDb
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, workspaceId));
    if (ids.length === 0) {
      return { sessions: [], hasMore: false, nextCursor: null, total: Number(total) };
    }

    const controls = await sessionControlProjections(scopedDb, workspaceId, ids);
    const treeStats = await sessionTreeStatsForSessions(scopedDb, workspaceId, ids);
    const goals = await scopedDb
      .select({
        sessionId: schema.sessionGoals.sessionId,
        status: schema.sessionGoals.status,
        text: schema.sessionGoals.text,
      })
      .from(schema.sessionGoals)
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          inArray(schema.sessionGoals.sessionId, ids),
        ),
      );
    const goalsBySession = new Map(goals.map((goal) => [goal.sessionId, goal]));
    const queueCounts = await scopedDb
      .select({
        sessionId: schema.sessionTurns.sessionId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          inArray(schema.sessionTurns.sessionId, ids),
          eq(schema.sessionTurns.status, "queued"),
          inArray(schema.sessionTurns.source, ["user", "api"]),
        ),
      )
      .groupBy(schema.sessionTurns.sessionId);
    const queueBySession = new Map(
      queueCounts.map((entry) => [entry.sessionId, Number(entry.count)]),
    );
    const latestMessages = options.includeLastMessage
      ? await scopedDb
          .selectDistinctOn([schema.sessionEvents.sessionId], {
            sessionId: schema.sessionEvents.sessionId,
            type: schema.sessionEvents.type,
            // Extract only the bounded textual preview in PostgreSQL. Selecting
            // the JSON payload here would re-materialize the exact multi-MB
            // event bodies this compact discovery path exists to avoid.
            preview: sql<string | null>`left(coalesce(
              ${schema.sessionEvents.payload}->>'text',
              ${schema.sessionEvents.payload}->>'message',
              ${schema.sessionEvents.payload}->>'content'
            ), 1200)`,
          })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, workspaceId),
              inArray(schema.sessionEvents.sessionId, ids),
              inArray(schema.sessionEvents.type, ["user.message", "agent.message.completed"]),
            ),
          )
          .orderBy(schema.sessionEvents.sessionId, desc(schema.sessionEvents.sequence))
      : [];
    const latestBySession = new Map(latestMessages.map((entry) => [entry.sessionId, entry]));
    const sessions = page.map((row): SessionDiscoverySummary => {
      const control = controls.get(row.id);
      if (!control) throw new Error(`Effective control missing for session ${row.id}`);
      const goal = goalsBySession.get(row.id);
      const latest = latestBySession.get(row.id);
      return {
        id: row.id,
        title: row.title,
        parentSessionId: row.parentSessionId,
        status: row.status as SessionStatus,
        effectiveControl: control,
        goal: goal ? { status: goal.status as SessionGoalStatus, text: goal.text } : null,
        queuedPromptCount: queueBySession.get(row.id) ?? 0,
        treeStats: treeStats.get(row.id) ?? {
          directChildren: 0,
          totalDescendants: 0,
          runningDescendants: 0,
          queuedDescendants: 0,
          attentionDescendants: 0,
          pausedDescendants: 0,
          failedDescendants: 0,
        },
        latestMessage: latest
          ? { type: latest.type as SessionEventType, preview: latest.preview }
          : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
    const last = page.at(-1);
    return {
      sessions,
      hasMore,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
      total: Number(total),
    };
  });
}

export type SessionLineage = {
  ancestors: Session[];
  children: LineageNode[];
  truncated: boolean;
};

type LineageIdRow = {
  id: string;
  parentSessionId: string | null;
  depth: number;
  path: string[];
};

/**
 * Read the full lineage slice around a session. Every recursive step carries
 * workspace_id as a hard predicate; a foreign parent/child id is invisible even
 * before RLS is considered. Ancestors are capped at 10 and returned root-first.
 * Descendants are capped at depth 5 and 200 total rows, returned as a nested tree.
 */
export async function getSessionLineage(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionLineage | null> {
  const descendantLimit = 200;
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    // Existence check on the ALREADY-SCOPED connection — never a nested
    // withWorkspaceRls (getSession opens its own scoped transaction, which
    // acquires a SECOND pooled connection while this one is held; under load
    // that is a classic pool-starvation deadlock).
    const rootRows = await scopedDb.execute<{ id: string }>(sql`
      select id from ${schema.sessions}
      where ${schema.sessions.workspaceId} = ${workspaceId} and ${schema.sessions.id} = ${sessionId}
      limit 1
    `);
    if (rootRows.length === 0) {
      return null;
    }

    const ancestorRows = (await scopedDb.execute(sql<LineageIdRow>`
      with recursive ancestors(id, parent_session_id, depth, path) as (
        select ${schema.sessions.id}, ${schema.sessions.parentSessionId}, 0, array[${schema.sessions.id}]
        from ${schema.sessions}
        where ${schema.sessions.workspaceId} = ${workspaceId}
          and ${schema.sessions.id} = ${sessionId}
        union all
        select parent.id, parent.parent_session_id, ancestors.depth + 1, ancestors.path || parent.id
        from ${schema.sessions} parent
        join ancestors on ancestors.parent_session_id = parent.id
        where parent.workspace_id = ${workspaceId}
          and ancestors.depth < 10
          and not parent.id = any(ancestors.path)
      )
      select id, parent_session_id as "parentSessionId", depth, path
      from ancestors
      where depth > 0
      order by depth desc
    `)) as LineageIdRow[];

    const childRows = (await scopedDb.execute(sql<LineageIdRow>`
      with recursive descendants(id, parent_session_id, depth, path) as (
        select child.id, child.parent_session_id, 1, array[${sessionId}, child.id]
        from ${schema.sessions} child
        where child.workspace_id = ${workspaceId}
          and child.parent_session_id = ${sessionId}
        union all
        select child.id, child.parent_session_id, descendants.depth + 1, descendants.path || child.id
        from ${schema.sessions} child
        join descendants on child.parent_session_id = descendants.id
        where child.workspace_id = ${workspaceId}
          and descendants.depth < 5
          and not child.id = any(descendants.path)
      )
      select id, parent_session_id as "parentSessionId", depth, path
      from descendants
      order by path
      limit ${descendantLimit + 1}
    `)) as LineageIdRow[];
    const truncated = childRows.length > descendantLimit;
    const descendantRows = truncated ? childRows.slice(0, descendantLimit) : childRows;

    const lineageRows = [...ancestorRows, ...descendantRows];
    const ids = [...new Set(lineageRows.map((row) => row.id))];
    if (ids.length === 0) {
      return { ancestors: [], children: [], truncated: false };
    }
    const rows = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), inArray(schema.sessions.id, ids)));
    const grouped = await sessionMcpServerMetadataForSessions(
      scopedDb,
      workspaceId,
      rows.map((row) => row.id),
    );
    const controls = await sessionControlProjections(scopedDb, workspaceId, ids);
    const sessionsById = new Map(
      rows.map((row) => {
        const control = controls.get(row.id);
        if (!control) throw new Error(`Effective control missing for session ${row.id}`);
        return [row.id, mapSession(row, control, grouped.get(row.id) ?? [])] as const;
      }),
    );

    const ancestors = ancestorRows
      .map((row) => sessionsById.get(row.id))
      .filter((session): session is Session => Boolean(session));

    const nodesById = new Map<string, LineageNode>();
    for (const row of descendantRows) {
      const session = sessionsById.get(row.id);
      if (session) {
        nodesById.set(row.id, { session, children: [] });
      }
    }
    const children: LineageNode[] = [];
    for (const row of descendantRows) {
      const node = nodesById.get(row.id);
      if (!node) continue;
      if (row.parentSessionId === sessionId) {
        children.push(node);
      } else {
        nodesById.get(row.parentSessionId ?? "")?.children.push(node);
      }
    }
    return { ancestors, children, truncated };
  });
}

/**
 * Count sessions still attached to a live Temporal workflow: queued, running,
 * or awaiting an approval (requires_action). idle has no running execution and
 * failed/cancelled are terminal, so neither blocks a workspace delete. The
 * delete path uses this to refuse (409) while a session could still be running
 * in Temporal, since there is no clean session-terminate to call first.
 */
export async function countActiveSessionsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          inArray(schema.sessions.status, ["queued", "running", "requires_action"]),
        ),
      );
    return Number(count);
  });
}

export async function requireSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<Session> {
  const session = await getSession(db, workspaceId, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

export type ListSessionEventsOptions = {
  after?: number;
  before?: number;
  limit?: number;
};

const POSTGRES_INT_MAX = 2_147_483_647;

export async function listSessionEvents(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionEvent[]>;
export async function listSessionEvents(
  db: Database,
  workspaceId: string,
  sessionId: string,
  after: number,
  limit?: number,
): Promise<SessionEvent[]>;
export async function listSessionEvents(
  db: Database,
  workspaceId: string,
  sessionId: string,
  options: ListSessionEventsOptions,
): Promise<SessionEvent[]>;
export async function listSessionEvents(
  db: Database,
  workspaceId: string,
  sessionId: string,
  afterOrOptions: number | ListSessionEventsOptions = 0,
  legacyLimit = 500,
): Promise<SessionEvent[]> {
  const options =
    typeof afterOrOptions === "number"
      ? { after: afterOrOptions, limit: legacyLimit }
      : afterOrOptions;
  const after = normalizeEventSequence(options.after, 0);
  const limit = normalizeEventLimit(options.limit, 500);
  const hasBefore = options.before !== undefined && Number.isFinite(options.before);
  const before = hasBefore ? Math.floor(options.before as number) : undefined;

  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const filters: SQL[] = [
      eq(schema.sessionEvents.workspaceId, workspaceId),
      eq(schema.sessionEvents.sessionId, sessionId),
      gt(schema.sessionEvents.sequence, after),
    ];
    if (before !== undefined && before <= POSTGRES_INT_MAX) {
      filters.push(lt(schema.sessionEvents.sequence, before));
    }
    const rows = await scopedDb
      .select()
      .from(schema.sessionEvents)
      .where(and(...filters))
      .orderBy(hasBefore ? desc(schema.sessionEvents.sequence) : asc(schema.sessionEvents.sequence))
      .limit(limit);
    return (hasBefore ? rows.reverse() : rows).map(mapEvent);
  });
}

export type ToolspaceCallReservation = { reserved: true; count: number } | { reserved: false };

/**
 * Atomically reserve one toolspace call against a turn's per-turn budget.
 *
 * A single conditional UPDATE increments `toolspace_call_count` only while it is
 * below `limit` and returns the post-increment value. Concurrent reservations
 * for the same turn serialize on the row lock, so exactly `limit` of N
 * simultaneous callers observe `reserved: true` — closing the read-then-append
 * TOCTOU the event-count approach had. `reserved: false` means the turn is at or
 * over budget (or the turn row no longer exists).
 */
export async function reserveToolspaceCallForTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  limit: number,
): Promise<ToolspaceCallReservation> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.sessionTurns)
      .set({ toolspaceCallCount: sql`${schema.sessionTurns.toolspaceCallCount} + 1` })
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.id, turnId),
          sql`${schema.sessionTurns.toolspaceCallCount} < ${limit}`,
        ),
      )
      .returning({ count: schema.sessionTurns.toolspaceCallCount });
    return row ? { reserved: true, count: Number(row.count) } : { reserved: false };
  });
}

function normalizeEventSequence(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeEventLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

export async function getSessionEvent(
  db: Database,
  workspaceId: string,
  eventId: string,
): Promise<SessionEvent | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.id, eventId),
        ),
      )
      .limit(1);
    return row ? mapEvent(row) : null;
  });
}

function mapWorkspaceControlEvent(
  row: typeof schema.workspaceControlEvents.$inferSelect,
): WorkspaceControlEvent {
  const revision = Number(row.revision);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sequence: revision,
    revision,
    type: "workspace.control.changed",
    scope: row.scope as WorkspaceControlEvent["scope"],
    rootSessionId: row.rootSessionId,
    action: row.action as WorkspaceControlEvent["action"],
    automatic: row.automatic,
    reason: row.reason,
    actor: row.actor,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export async function listWorkspaceControlEvents(
  db: Database,
  workspaceId: string,
  after = 0,
  limit = 500,
): Promise<WorkspaceControlEvent[]> {
  const cursor = normalizeEventSequence(after, 0);
  const boundedLimit = Math.min(1000, normalizeEventLimit(limit, 500));
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceControlEvents)
      .where(
        and(
          eq(schema.workspaceControlEvents.workspaceId, workspaceId),
          gt(schema.workspaceControlEvents.revision, cursor),
        ),
      )
      .orderBy(asc(schema.workspaceControlEvents.revision))
      .limit(boundedLimit);
    return rows.map(mapWorkspaceControlEvent);
  });
}

export async function getWorkspaceControlEvent(
  db: Database,
  workspaceId: string,
  eventId: string,
): Promise<WorkspaceControlEvent | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceControlEvents)
      .where(
        and(
          eq(schema.workspaceControlEvents.workspaceId, workspaceId),
          eq(schema.workspaceControlEvents.id, eventId),
        ),
      )
      .limit(1);
    return row ? mapWorkspaceControlEvent(row) : null;
  });
}

/**
 * Resolve a client-idempotent event inside one exact workspace/session scope.
 * The three predicates are deliberate: a client event id is unique only within
 * a session, while the workspace predicate remains the tenancy boundary.
 */
export async function getSessionEventByClientEventId(
  db: Database,
  workspaceId: string,
  sessionId: string,
  clientEventId: string,
): Promise<SessionEvent | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.sessionId, sessionId),
          eq(schema.sessionEvents.clientEventId, clientEventId),
        ),
      )
      .limit(1);
    return row ? mapEvent(row) : null;
  });
}

export async function getLatestRunState(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{
  id: string;
  turnId: string | null;
  serializedRunState: string;
  pendingApprovals: unknown[];
  // The codex account that froze this state (pin > workspace-active), or null
  // when frozen on the non-codex path / before the column existed. The replay
  // path compares it to the resuming turn's codex account to decide whether the
  // blob's account-bound reasoning must be neutralized before being replayed.
  frozenCodexCredentialId: string | null;
} | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.agentRunStates)
      .where(
        and(
          eq(schema.agentRunStates.workspaceId, workspaceId),
          eq(schema.agentRunStates.sessionId, sessionId),
        ),
      )
      .orderBy(desc(schema.agentRunStates.createdAt))
      .limit(1);
    return row
      ? {
          id: row.id,
          turnId: row.turnId ?? null,
          serializedRunState: row.serializedRunState,
          pendingApprovals: row.pendingApprovals,
          frozenCodexCredentialId: row.frozenCodexCredentialId ?? null,
        }
      : null;
  });
}

export type TurnAttemptFenceRejectReason =
  | "workspace_paused"
  | "session_paused"
  | "pending_control"
  | "active_turn_changed"
  | "generation_changed"
  | "attempt_changed"
  | "turn_terminal"
  | "not_found";

type TurnAttemptFenceResult =
  | {
      allowed: true;
      workspace: typeof schema.workspaces.$inferSelect;
      session: typeof schema.sessions.$inferSelect;
      turn: typeof schema.sessionTurns.$inferSelect;
    }
  | {
      allowed: false;
      reason: TurnAttemptFenceRejectReason;
      workspace: typeof schema.workspaces.$inferSelect | null;
      session: typeof schema.sessions.$inferSelect | null;
      turn: typeof schema.sessionTurns.$inferSelect | null;
    };

/**
 * Lock order for every activity write fence: workspace -> session -> turn.
 *
 * Activity writes only need a shared workspace admission lock: concurrent
 * sessions may write independently, while an exclusive workspace Pause/Resume
 * still waits for every admitted write and prevents later writes from crossing
 * the control boundary. Using FOR UPDATE here serialized every active session in
 * one workspace behind a single row and turned streaming into a workspace-wide
 * lock queue.
 */
async function lockTurnAttemptWriteFenceTx(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
  },
): Promise<TurnAttemptFenceResult> {
  const effectiveControl = await evaluateSessionControl(tx, input.workspaceId, input.sessionId, {
    lock: "share",
  });
  const [workspace] = await tx
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, input.workspaceId))
    .limit(1);
  const [session] = await tx
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.workspaceId, input.workspaceId),
        eq(schema.sessions.id, input.sessionId),
      ),
    )
    .for("update")
    .limit(1);
  const [turn] = await tx
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        eq(schema.sessionTurns.id, input.turnId),
      ),
    )
    .for("update")
    .limit(1);
  const base = { workspace: workspace ?? null, session: session ?? null, turn: turn ?? null };
  if (!workspace || !session || !turn) return { allowed: false, reason: "not_found", ...base };
  if (effectiveControl.state === "paused") {
    return {
      allowed: false,
      reason:
        effectiveControl.primaryBlocker?.kind === "workspace"
          ? "workspace_paused"
          : "session_paused",
      ...base,
    };
  }
  if (session.activeTurnId !== input.turnId) {
    return { allowed: false, reason: "active_turn_changed", ...base };
  }
  if (turn.executionGeneration !== input.executionGeneration) {
    return { allowed: false, reason: "generation_changed", ...base };
  }
  if (turn.activeAttemptId !== input.attemptId) {
    return { allowed: false, reason: "attempt_changed", ...base };
  }
  const [interruption] = await tx
    .select({ id: schema.sessionAttemptInterruptions.id })
    .from(schema.sessionAttemptInterruptions)
    .where(
      and(
        eq(schema.sessionAttemptInterruptions.workspaceId, input.workspaceId),
        eq(schema.sessionAttemptInterruptions.sessionId, input.sessionId),
        eq(schema.sessionAttemptInterruptions.attemptId, input.attemptId),
        inArray(schema.sessionAttemptInterruptions.state, ["pending", "delivered", "acknowledged"]),
      ),
    )
    .limit(1);
  if (interruption) {
    return { allowed: false, reason: "pending_control", ...base };
  }
  if (!["running", "requires_action"].includes(turn.status)) {
    return { allowed: false, reason: "turn_terminal", ...base };
  }
  return { allowed: true, workspace, session, turn };
}

/**
 * Append conversation items (verbatim SDK AgentInputItems) to the session's
 * history. Idempotent on (workspace, session, position): concurrent or
 * repeated writers (streaming writes + turn-end reconciliation) converge
 * instead of duplicating.
 */
export async function appendSessionHistoryItems(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedExecutionGeneration: number;
    expectedAttemptId: string;
    // The codex account that produced these items (the turn's resolved credential
    // id), or null/undefined on the non-codex path. Stored verbatim so the read
    // path can strip cross-account reasoning.encrypted_content blobs per turn.
    producerCodexCredentialId?: string | null;
    modelToolOutputTruncationTokens?: number;
    items: Array<{ position: number; item: Record<string, unknown> }>;
  },
): Promise<boolean> {
  if (input.items.length === 0) {
    return true;
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await scopedDb.transaction(async (tx) => {
        const allowed = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.expectedExecutionGeneration,
          attemptId: input.expectedAttemptId,
        });
        if (!allowed.allowed) return false;
        await tx
          .insert(schema.sessionHistoryItems)
          .values(
            input.items.map((entry) => ({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
              producerCodexCredentialId: input.producerCodexCredentialId ?? null,
              position: entry.position,
              // This is the canonical model-memory boundary. The pending-call
              // ledger and audit event may retain their separate raw/preview
              // forms, but conversation truth is always the bounded Codex form.
              item: sanitizeModelPayload(
                boundModelToolOutputItem(entry.item, input.modelToolOutputTruncationTokens),
              ),
            })),
          )
          .onConflictDoNothing({
            target: [
              schema.sessionHistoryItems.workspaceId,
              schema.sessionHistoryItems.sessionId,
              schema.sessionHistoryItems.position,
            ],
          });
        return true;
      });
    },
  );
}

export type PendingSessionToolCallInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
  callId: string;
  callType: string;
  callItem: Record<string, unknown>;
};

/**
 * Durably capture the raw SDK call item at the exact attempt boundary. This is
 * model-facing truth, deliberately separate from the redacted session-event
 * projection. The receipt belongs to the logical turn so an approval resume can
 * settle it from a newer attempt. Duplicate SDK delivery converges on the
 * unique (turn, call) identity.
 */
export async function registerPendingSessionToolCall(
  db: Database,
  input: PendingSessionToolCallInput,
): Promise<{ accepted: boolean; registered: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.executionGeneration,
          attemptId: input.attemptId,
        });
        if (!fence.allowed) return { accepted: false, registered: false };
        const inserted = await tx
          .insert(schema.sessionPendingToolCalls)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            executionGeneration: input.executionGeneration,
            attemptId: input.attemptId,
            callId: input.callId,
            callType: input.callType,
            callItem: sanitizeModelPayload(input.callItem),
          })
          .onConflictDoNothing({
            target: [
              schema.sessionPendingToolCalls.workspaceId,
              schema.sessionPendingToolCalls.turnId,
              schema.sessionPendingToolCalls.callId,
            ],
          })
          .returning({ id: schema.sessionPendingToolCalls.id });
        return { accepted: true, registered: inserted.length === 1 };
      }),
  );
}

/** Record the raw SDK result without dropping the call receipt. */
export async function recordPendingSessionToolCallResult(
  db: Database,
  input: Omit<PendingSessionToolCallInput, "callType" | "callItem"> & {
    resultItem: Record<string, unknown>;
  },
): Promise<{ accepted: boolean; recorded: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.executionGeneration,
          attemptId: input.attemptId,
        });
        if (!fence.allowed) {
          return { accepted: false, recorded: false };
        }
        const [pending] = await tx
          .select()
          .from(schema.sessionPendingToolCalls)
          .where(
            and(
              eq(schema.sessionPendingToolCalls.workspaceId, input.workspaceId),
              eq(schema.sessionPendingToolCalls.sessionId, input.sessionId),
              eq(schema.sessionPendingToolCalls.turnId, input.turnId),
              eq(schema.sessionPendingToolCalls.callId, input.callId),
            ),
          )
          .limit(1);
        if (!pending) return { accepted: true, recorded: false };
        const resultType = TOOL_RESULT_TYPE_BY_CALL_TYPE[pending.callType];
        if (
          !resultType ||
          historyItemType(input.resultItem) !== resultType ||
          historyCallId(input.resultItem) !== input.callId
        ) {
          throw new Error(`SDK tool result does not settle ${pending.callType}:${input.callId}`);
        }
        const recorded = await tx
          .update(schema.sessionPendingToolCalls)
          .set({
            resultItem: sanitizeModelPayload(input.resultItem),
            resultRecordedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessionPendingToolCalls.id, pending.id),
              sql`${schema.sessionPendingToolCalls.resultItem} is null`,
            ),
          )
          .returning({ id: schema.sessionPendingToolCalls.id });
        return {
          accepted: true,
          recorded: recorded.length === 1,
        };
      }),
  );
}

/**
 * Remove completed receipts only after the full SDK call/result batch is
 * durable. Until then every raw result remains available to an attempt-ending
 * transaction, including reverse-completing parallel calls.
 */
export async function clearDurablePendingSessionToolCalls(
  db: Database,
  input: Omit<PendingSessionToolCallInput, "callId" | "callType" | "callItem"> & {
    callIds: string[];
  },
): Promise<{ accepted: boolean; cleared: number }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.executionGeneration,
          attemptId: input.attemptId,
        });
        if (!fence.allowed) return { accepted: false, cleared: 0 };
        if (input.callIds.length === 0) return { accepted: true, cleared: 0 };
        const pending = await tx
          .select()
          .from(schema.sessionPendingToolCalls)
          .where(
            and(
              eq(schema.sessionPendingToolCalls.workspaceId, input.workspaceId),
              eq(schema.sessionPendingToolCalls.sessionId, input.sessionId),
              eq(schema.sessionPendingToolCalls.turnId, input.turnId),
              inArray(schema.sessionPendingToolCalls.callId, input.callIds),
              sql`${schema.sessionPendingToolCalls.resultItem} is not null`,
            ),
          )
          .for("update");
        if (pending.length === 0) return { accepted: true, cleared: 0 };
        const history = await tx
          .select({
            position: schema.sessionHistoryItems.position,
            item: schema.sessionHistoryItems.item,
          })
          .from(schema.sessionHistoryItems)
          .where(
            and(
              eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
              eq(schema.sessionHistoryItems.sessionId, input.sessionId),
              eq(schema.sessionHistoryItems.turnId, input.turnId),
            ),
          );
        const durableIds = pending
          .filter((call) => {
            const resultType = TOOL_RESULT_TYPE_BY_CALL_TYPE[call.callType];
            if (!resultType) return false;
            const durableCall = history.find(
              ({ item }) =>
                historyItemType(item) === call.callType && historyCallId(item) === call.callId,
            );
            return Boolean(
              durableCall &&
              history.some(
                ({ item, position }) =>
                  position > durableCall.position &&
                  historyItemType(item) === resultType &&
                  historyCallId(item) === call.callId,
              ),
            );
          })
          .map((call) => call.id);
        if (durableIds.length > 0) {
          await tx
            .delete(schema.sessionPendingToolCalls)
            .where(inArray(schema.sessionPendingToolCalls.id, durableIds));
        }
        return { accepted: true, cleared: durableIds.length };
      }),
  );
}

export async function getSessionHistoryItems(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<Array<{ position: number; item: Record<string, unknown> }>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        position: schema.sessionHistoryItems.position,
        item: schema.sessionHistoryItems.item,
      })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, workspaceId),
          eq(schema.sessionHistoryItems.sessionId, sessionId),
        ),
      )
      .orderBy(schema.sessionHistoryItems.position);
    return rows;
  });
}

/**
 * The LIVE conversation-truth read path: only active rows, position-ordered.
 * After a client-side context compaction this returns [retained user messages,
 * active summary]; with no compaction yet it equals
 * getSessionHistoryItems. The model-facing read path uses this so superseded
 * (summarized-away) prefix rows are excluded while the full transcript stays in
 * the table as an audit trail.
 */
export async function getActiveSessionHistoryItems(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<
  Array<{
    position: number;
    item: Record<string, unknown>;
    producerCodexCredentialId: string | null;
  }>
> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        position: schema.sessionHistoryItems.position,
        item: schema.sessionHistoryItems.item,
        producerCodexCredentialId: schema.sessionHistoryItems.producerCodexCredentialId,
      })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, workspaceId),
          eq(schema.sessionHistoryItems.sessionId, sessionId),
          eq(schema.sessionHistoryItems.active, true),
        ),
      )
      .orderBy(schema.sessionHistoryItems.position);
    return rows;
  });
}

/**
 * Count of ACTIVE (live, model-facing) history rows for a session. This is the
 * length of the history the next turn is seeded from — the dual-write slice
 * index — which after a compaction is far smaller than the total persisted-row
 * count (countSessionHistoryItems still includes the superseded prefix).
 */
export async function countActiveSessionHistoryItems(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        count: sql<number>`count(*)`,
      })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, workspaceId),
          eq(schema.sessionHistoryItems.sessionId, sessionId),
          eq(schema.sessionHistoryItems.active, true),
        ),
      );
    return Number(row?.count ?? 0);
  });
}

/**
 * Result-item types and the CALL type that settles each. Kept byte-for-byte in
 * sync with the runtime sanitizer's RESULT_TYPE_BY_CALL_TYPE and the repair
 * migration (0014). The repair, the read-path sanitizer, and this spec all share
 * one definition of a tool-call pair.
 */
const REPAIR_CALL_TYPE_BY_RESULT_TYPE: Record<string, string> = {
  function_call_result: "function_call",
  computer_call_result: "computer_call",
  shell_call_output: "shell_call",
  apply_patch_call_output: "apply_patch_call",
};

function repairCallIdOf(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as { callId?: unknown; call_id?: unknown };
  if (typeof record.callId === "string") {
    return record.callId;
  }
  if (typeof record.call_id === "string") {
    return record.call_id;
  }
  return undefined;
}

function repairItemType(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Pure TypeScript SPEC for the one-time orphan repair (migration 0014),
 * mirroring its SQL WHERE clause so the deletion rule is unit-testable without a
 * database. Given the ACTIVE history rows of a single session in position order,
 * returns the indices of the orphaned tool-call RESULT rows the repair deletes.
 *
 * An orphan is a result-type row (function_call_result / computer_call_result /
 * shell_call_output / apply_patch_call_output) with no matching CALL of the
 * paired type, same correlation id (camelCase `callId` OR snake_case `call_id`),
 * at a STRICTLY EARLIER position in the same session. This is exactly the
 * session-bricking row the Responses API 400s on ("No tool call found for
 * function call output").
 *
 * DANGLING CALLS (a call with no result yet) are intentionally NOT returned: a
 * call awaiting a not-yet-settled result is valid, not corruption. Only unpaired
 * results are removed.
 *
 * EXISTENCE, not consumption: like the migration's `NOT EXISTS (... earlier
 * call ...)`, a result is kept whenever ANY earlier matching call exists. A
 * second result that re-uses a call_id already settled earlier is therefore NOT
 * flagged here (a matching call still exists before it) — this conservative
 * choice matches the SQL exactly and never deletes a row whose call is present;
 * the read-path sanitizer (which consumes calls one-for-one) still drops such a
 * rare duplicate in-memory, so the model request stays valid regardless.
 *
 * Callers pass rows already ordered by position. The earlier-position test is
 * by array order (the SQL orders by the numeric position column, which the read
 * path also orders by), so identical inputs yield identical decisions.
 */
export function orphanedResultRowIndicesForRepair(
  activeRowsInPositionOrder: ReadonlyArray<{ item: Record<string, unknown> }>,
): number[] {
  // call_ids of CALLs seen so far, per matching result type. A result is an
  // orphan unless a call of its paired type with the same id appeared earlier.
  const seenCallIdsByResultType = new Map<string, Set<string>>();
  // Pre-index every call type to the result type(s) it can settle.
  const resultTypeByCallType: Record<string, string> = {};
  for (const [resultType, callType] of Object.entries(REPAIR_CALL_TYPE_BY_RESULT_TYPE)) {
    resultTypeByCallType[callType] = resultType;
  }
  const orphanIndices: number[] = [];
  activeRowsInPositionOrder.forEach((row, index) => {
    const type = repairItemType(row.item);
    const callId = repairCallIdOf(row.item);
    if (!type || !callId) {
      return;
    }
    const settlesResultType = resultTypeByCallType[type];
    if (settlesResultType) {
      // This row is a CALL: record its id so a later matching result is paired.
      const seen = seenCallIdsByResultType.get(settlesResultType) ?? new Set<string>();
      seen.add(callId);
      seenCallIdsByResultType.set(settlesResultType, seen);
      return;
    }
    if (REPAIR_CALL_TYPE_BY_RESULT_TYPE[type]) {
      // This row is a RESULT: orphan unless an earlier matching call was seen.
      const seen = seenCallIdsByResultType.get(type);
      if (!seen || !seen.has(callId)) {
        orphanIndices.push(index);
      }
    }
  });
  return orphanIndices;
}

export type ApplyContextCompactionResult =
  | {
      applied: true;
      supersededFrom: number;
      summaryPosition: number;
      events: SessionEvent[];
    }
  | { applied: false; reason: TurnAttemptFenceRejectReason };

/**
 * Atomically install the Codex-style replacement history for one exact turn
 * attempt. The old active rows remain as inactive audit evidence; the retained
 * user messages and summary receive fresh whole-number positions after every
 * existing row. A paused, replaced, recovered, or terminal attempt cannot
 * mutate conversation truth.
 */
export async function applyContextCompaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedExecutionGeneration: number;
    expectedAttemptId: string;
    replacementItems: Array<Record<string, unknown>>;
    summaryItem: Record<string, unknown>;
    replacementInputTokens: number;
    clearRequestedCompaction?: boolean;
    eventPayload?: Record<string, unknown>;
  },
): Promise<ApplyContextCompactionResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await scopedDb.transaction(async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.expectedExecutionGeneration,
          attemptId: input.expectedAttemptId,
        });
        if (!fence.allowed) {
          return { applied: false as const, reason: fence.reason };
        }
        const [{ maxPosition } = { maxPosition: -1 }] = await tx
          .select({
            maxPosition: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1)`,
          })
          .from(schema.sessionHistoryItems)
          .where(
            and(
              eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
              eq(schema.sessionHistoryItems.sessionId, input.sessionId),
            ),
          );
        const supersededFrom = Math.floor(Number(maxPosition)) + 1;
        await tx
          .update(schema.sessionHistoryItems)
          .set({ active: false })
          .where(
            and(
              eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
              eq(schema.sessionHistoryItems.sessionId, input.sessionId),
              eq(schema.sessionHistoryItems.active, true),
            ),
          );
        if (input.replacementItems.length > 0) {
          await tx.insert(schema.sessionHistoryItems).values(
            input.replacementItems.map((item, index) => ({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId: null,
              position: supersededFrom + index,
              item: sanitizeModelPayload(item),
              active: true,
            })),
          );
        }
        const summaryPosition = supersededFrom + input.replacementItems.length;
        await tx.insert(schema.sessionHistoryItems).values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          position: summaryPosition,
          item: sanitizeModelPayload(input.summaryItem),
          active: true,
        });
        const insertedEvents = input.eventPayload
          ? await tx
              .insert(schema.sessionEvents)
              .values({
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                turnGeneration: input.expectedExecutionGeneration,
                turnAttemptId: input.expectedAttemptId,
                turnAssociation: "current",
                sequence: fence.session.lastSequence + 1,
                type: "session.context.compacted",
                payload: sanitizeEventPayload({
                  ...input.eventPayload,
                  summaryPosition,
                }),
                occurredAt: new Date(),
              })
              .returning()
          : [];
        await tx
          .update(schema.sessions)
          .set({
            lastInputTokens: Math.max(0, Math.floor(input.replacementInputTokens)),
            ...(input.clearRequestedCompaction ? { compactRequested: false } : {}),
            ...(insertedEvents.length > 0
              ? { lastSequence: fence.session.lastSequence + insertedEvents.length }
              : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );
        return {
          applied: true as const,
          supersededFrom,
          summaryPosition,
          events: insertedEvents.map(mapEvent),
        };
      });
    },
  );
}

/**
 * Atomically record that an operator compaction request needed no replacement
 * and consume it. The exact running attempt owns both the visible event and
 * the clear, just like a successful replacement; a paused, recovered, or
 * superseded attempt can do neither and leaves the request pending.
 */
export async function recordSkippedContextCompaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedExecutionGeneration: number;
    expectedAttemptId: string;
    reason:
      | "no_history"
      | "replacement_not_smaller"
      | "replacement_unchanged"
      | "summarization_failed";
  },
): Promise<
  | { recorded: true; events: SessionEvent[] }
  | { recorded: false; reason: TurnAttemptFenceRejectReason | "request_not_pending" }
> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const fence = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.expectedExecutionGeneration,
          attemptId: input.expectedAttemptId,
        });
        if (!fence.allowed) return { recorded: false as const, reason: fence.reason };
        if (!fence.session.compactRequested) {
          return { recorded: false as const, reason: "request_not_pending" as const };
        }
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            turnGeneration: input.expectedExecutionGeneration,
            turnAttemptId: input.expectedAttemptId,
            turnAssociation: "current",
            sequence: fence.session.lastSequence + 1,
            type: "session.context.compaction.skipped",
            payload: sanitizeEventPayload({ reason: input.reason }),
            occurredAt: new Date(),
          })
          .returning();
        await tx
          .update(schema.sessions)
          .set({
            compactRequested: false,
            lastSequence: fence.session.lastSequence + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.compactRequested, true),
            ),
          );
        return { recorded: true as const, events: inserted.map(mapEvent) };
      }),
  );
}

/**
 * The next free WHOLE-NUMBER history position for a session: one past the
 * largest existing position (active or superseded), floored so the synthetic
 * summary's fractional half-step never shifts the count. The dual-write
 * watermark uses this to append new rows at fresh absolute positions, decoupled
 * from the in-memory history length (which, after a compaction, is far shorter
 * than the total persisted-row count and so cannot serve as the next position).
 */
export async function nextSessionHistoryPosition(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        maxPosition: sql<number | null>`max(${schema.sessionHistoryItems.position})`,
      })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, workspaceId),
          eq(schema.sessionHistoryItems.sessionId, sessionId),
        ),
      );
    const max = row?.maxPosition;
    return max === null || max === undefined ? 0 : Math.floor(Number(max)) + 1;
  });
}

/**
 * Record the actual input-token count of the most recent turn's final model
 * call, for the next turn's pre-read compaction trigger.
 */
export async function setSessionLastInputTokensForTurnAttempt(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedExecutionGeneration: number;
    expectedAttemptId: string;
    lastInputTokens: number;
  },
): Promise<boolean> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const fence = await lockTurnAttemptWriteFenceTx(tx, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionGeneration: input.expectedExecutionGeneration,
        attemptId: input.expectedAttemptId,
      });
      if (!fence.allowed) return false;
      await tx
        .update(schema.sessions)
        .set({ lastInputTokens: input.lastInputTokens, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      return true;
    });
  });
}

/** The neutral boundary left as the sole active history row after a clear. */
export function clearedContextMarkerItem(): Record<string, unknown> {
  return { type: "message", role: "user", content: "[context cleared]" };
}

export type ClearSessionContextResult = {
  /** Active history rows superseded (active=true -> false). */
  supersededItems: number;
  /** Position of the inserted neutral boundary marker. */
  markerPosition: number;
};

export class SessionContextBusyError extends Error {
  constructor(public readonly status: string) {
    super(`session is ${status}; Pause must settle before context can be cleared`);
    this.name = "SessionContextBusyError";
  }
}

/**
 * Clear a session's conversation context in ONE transaction, audit-preserving
 * and idempotent:
 *
 *  (a) supersede every active session_history_items row (active=true -> false).
 *      Nothing is deleted — the full transcript stays as an audit trail, same
 *      pattern as applyContextCompaction.
 *  (b) insert ONE active neutral boundary marker at max(position)+1. Ordinary
 *      inference reads only this canonical history store; SDK RunState remains
 *      reserved for an approval that paused mid-turn, and the API forbids a
 *      clear while such an approval or active turn exists.
 *
 * Also resets last_input_tokens to 0 so the next turn's compaction trigger
 * starts fresh against the now-short context.
 *
 * Idempotent: a re-run supersedes the (now sole, already-marker) active row,
 * inserts another marker at the next position. The post-condition (one active
 * marker row) holds.
 */
export async function clearSessionContext(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
  },
): Promise<ClearSessionContextResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await scopedDb.transaction(async (tx) => {
        const [workspace] = await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        if (!workspace) throw new Error(`Workspace not found: ${input.workspaceId}`);
        const [session] = await tx
          .select({
            status: schema.sessions.status,
            activeTurnId: schema.sessions.activeTurnId,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!session) throw new Error(`Session not found: ${input.sessionId}`);
        if (
          session.activeTurnId !== null ||
          !["idle", "failed", "cancelled"].includes(session.status)
        ) {
          throw new SessionContextBusyError(session.status);
        }
        const supersededRows = await tx
          .update(schema.sessionHistoryItems)
          .set({ active: false })
          .where(
            and(
              eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
              eq(schema.sessionHistoryItems.sessionId, input.sessionId),
              eq(schema.sessionHistoryItems.active, true),
            ),
          )
          .returning({ id: schema.sessionHistoryItems.id });

        const [{ maxPosition } = { maxPosition: -1 }] = await tx
          .select({
            maxPosition: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1)`,
          })
          .from(schema.sessionHistoryItems)
          .where(
            and(
              eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
              eq(schema.sessionHistoryItems.sessionId, input.sessionId),
            ),
          );
        const markerPosition = Number(maxPosition) + 1;
        await tx
          .insert(schema.sessionHistoryItems)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: null,
            position: markerPosition,
            item: sanitizeModelPayload(clearedContextMarkerItem()),
            active: true,
          })
          .onConflictDoNothing({
            target: [
              schema.sessionHistoryItems.workspaceId,
              schema.sessionHistoryItems.sessionId,
              schema.sessionHistoryItems.position,
            ],
          });

        await tx
          .update(schema.sessions)
          .set({ lastInputTokens: 0, updatedAt: new Date() })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );

        return { supersededItems: supersededRows.length, markerPosition };
      });
    },
  );
}

export async function countSessionHistoryItems(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        count: sql<number>`count(*)`,
      })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, workspaceId),
          eq(schema.sessionHistoryItems.sessionId, sessionId),
        ),
      );
    return Number(row?.count ?? 0);
  });
}

/**
 * Set the operator /compact request flag. The worker honors it before the next
 * turn (forced portable compaction) and clears it. Idempotent: repeated
 * requests collapse to one pending compaction.
 */
export async function requestSessionCompaction(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{ wakeRevision: number; temporalWorkflowId: string }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [session] = await scopedDb
      .select({
        accountId: schema.sessions.accountId,
        temporalWorkflowId: schema.sessions.temporalWorkflowId,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .for("update")
      .limit(1);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await scopedDb
      .update(schema.sessions)
      .set({ compactRequested: true, updatedAt: new Date() })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
    const temporalWorkflowId = session.temporalWorkflowId ?? `session-${sessionId}`;
    const wakeRevision = await enqueueSessionWorkflowWakeInTransaction(scopedDb, {
      accountId: session.accountId,
      workspaceId,
      sessionId,
      temporalWorkflowId,
      reason: "compaction_requested",
    });
    return { wakeRevision, temporalWorkflowId };
  });
}

/** Read the durable /compact request without consuming it. The exact current
 * turn attempt clears the flag in the same transaction that installs the new
 * active history, so a failed or superseded summarizer cannot lose the request.
 */
export async function isSessionCompactionRequested(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [session] = await scopedDb
      .select({ compactRequested: schema.sessions.compactRequested })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    return session?.compactRequested === true;
  });
}

/**
 * Persist the session's sandbox recovery descriptor (the small versioned
 * envelope used to reattach / snapshot-restore / rebuild the sandbox),
 * decoupled from the RunState blob.
 */
export async function upsertSandboxSessionEnvelope(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    envelope: Record<string, unknown>;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .insert(schema.sandboxSessionEnvelopes)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          envelope: input.envelope,
        })
        .onConflictDoUpdate({
          target: [
            schema.sandboxSessionEnvelopes.workspaceId,
            schema.sandboxSessionEnvelopes.sessionId,
          ],
          set: { envelope: input.envelope, updatedAt: new Date() },
        });
    },
  );
}

export async function getSandboxSessionEnvelope(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ envelope: schema.sandboxSessionEnvelopes.envelope })
      .from(schema.sandboxSessionEnvelopes)
      .where(
        and(
          eq(schema.sandboxSessionEnvelopes.workspaceId, workspaceId),
          eq(schema.sandboxSessionEnvelopes.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row?.envelope ?? null;
  });
}

export type SandboxGitCredentialBindingSource =
  (typeof schema.sandboxGitCredentialBindingSourceValues)[number];
export type SandboxGitCredentialBindingStatus =
  (typeof schema.sandboxGitCredentialBindingStatusValues)[number];
export type SandboxGitCredentialBinding = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  provider: GitCredentialProvider;
  source: SandboxGitCredentialBindingSource;
  status: SandboxGitCredentialBindingStatus;
  repositoryRefs: GitCredentialRepositoryRef[];
  generation: number;
  reasonCode: string | null;
  lastValidatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function normalizedGitCredentialRepositoryRefs(
  refs: readonly GitCredentialRepositoryRef[],
): GitCredentialRepositoryRef[] {
  return [...GitCredentialRepositoryRefContract.array().min(1).parse(refs)].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function checkedGitCredentialBindingReason(reasonCode: string | null | undefined): string | null {
  if (reasonCode === null || reasonCode === undefined) return null;
  if (!/^[a-z0-9_]{1,64}$/.test(reasonCode)) {
    throw new Error("Git credential binding reasonCode must match [a-z0-9_]{1,64}");
  }
  return reasonCode;
}

function mapSandboxGitCredentialBinding(
  row: typeof schema.sandboxGitCredentialBindings.$inferSelect,
): SandboxGitCredentialBinding {
  return {
    ...row,
    provider: row.provider as GitCredentialProvider,
    repositoryRefs: normalizedGitCredentialRepositoryRefs(row.repositoryRefs),
  };
}

export async function listSandboxGitCredentialBindings(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SandboxGitCredentialBinding[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sandboxGitCredentialBindings)
      .where(
        and(
          eq(schema.sandboxGitCredentialBindings.workspaceId, workspaceId),
          eq(schema.sandboxGitCredentialBindings.sessionId, sessionId),
        ),
      )
      .orderBy(asc(schema.sandboxGitCredentialBindings.provider));
    return rows.map(mapSandboxGitCredentialBinding);
  });
}

/**
 * Validate or replace one secret-free binding under its row lock. Identical
 * validation updates the timestamp without rotating the generation; any
 * authorization identity/source/status change advances the fence exactly once.
 */
export async function upsertSandboxGitCredentialBinding(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    provider: GitCredentialProvider;
    source: SandboxGitCredentialBindingSource;
    repositoryRefs: readonly GitCredentialRepositoryRef[];
    status?: SandboxGitCredentialBindingStatus;
    reasonCode?: string | null;
    validatedAt?: Date;
  },
): Promise<SandboxGitCredentialBinding> {
  const repositoryRefs = normalizedGitCredentialRepositoryRefs(input.repositoryRefs);
  const status = input.status ?? "active";
  const reasonCode = checkedGitCredentialBindingReason(input.reasonCode);
  const validatedAt = input.validatedAt ?? new Date();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .insert(schema.sandboxGitCredentialBindings)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          provider: input.provider,
          source: input.source,
          status,
          repositoryRefs,
          generation: 1,
          reasonCode,
          lastValidatedAt: validatedAt,
        })
        .onConflictDoNothing({
          target: [
            schema.sandboxGitCredentialBindings.workspaceId,
            schema.sandboxGitCredentialBindings.sessionId,
            schema.sandboxGitCredentialBindings.provider,
          ],
        });
      const [current] = await scopedDb
        .select()
        .from(schema.sandboxGitCredentialBindings)
        .where(
          and(
            eq(schema.sandboxGitCredentialBindings.workspaceId, input.workspaceId),
            eq(schema.sandboxGitCredentialBindings.sessionId, input.sessionId),
            eq(schema.sandboxGitCredentialBindings.provider, input.provider),
          ),
        )
        .for("update")
        .limit(1);
      if (!current) throw new Error("Failed to lock sandbox Git credential binding");
      const changed =
        current.source !== input.source ||
        current.status !== status ||
        current.reasonCode !== reasonCode ||
        !isDeepStrictEqual(
          normalizedGitCredentialRepositoryRefs(current.repositoryRefs),
          repositoryRefs,
        );
      const [row] = await scopedDb
        .update(schema.sandboxGitCredentialBindings)
        .set({
          source: input.source,
          status,
          repositoryRefs,
          reasonCode,
          lastValidatedAt: validatedAt,
          generation: changed ? current.generation + 1 : current.generation,
          updatedAt: new Date(),
        })
        .where(eq(schema.sandboxGitCredentialBindings.id, current.id))
        .returning();
      if (!row) throw new Error("Failed to update sandbox Git credential binding");
      return mapSandboxGitCredentialBinding(row);
    },
  );
}

export async function markSandboxGitCredentialBindingStatus(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    provider: GitCredentialProvider;
    status: Exclude<SandboxGitCredentialBindingStatus, "active">;
    reasonCode: string;
    /** Optional sandbox invalidation performed while the binding row is locked. */
    mutateSandbox?: () => Promise<void>;
  },
): Promise<SandboxGitCredentialBinding | null> {
  const [row] = await markSandboxGitCredentialBindingsStatus(db, {
    ...input,
    providers: [input.provider],
  });
  return row ?? null;
}

/**
 * Revoke or deactivate a provider set under one deterministic lock set. The
 * sandbox mutation runs while every matching row is locked, so a concurrent
 * final write either completes first and is then invalidated, or observes the
 * committed replacement generation/status and cannot write.
 */
export async function markSandboxGitCredentialBindingsStatus(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    providers: readonly GitCredentialProvider[];
    status: Exclude<SandboxGitCredentialBindingStatus, "active">;
    reasonCode: string;
    /** Optional exact active-generation fence for controller-owned deactivation. */
    expectedGenerations?: Readonly<Partial<Record<GitCredentialProvider, number>>>;
    /** Optional one-shot sandbox invalidation while all provider rows are locked. */
    mutateSandbox?: () => Promise<void>;
  },
): Promise<SandboxGitCredentialBinding[]> {
  const providers = [...new Set(input.providers)].sort();
  if (providers.length === 0) return [];
  const reasonCode = checkedGitCredentialBindingReason(input.reasonCode);
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const current = await scopedDb
        .select()
        .from(schema.sandboxGitCredentialBindings)
        .where(
          and(
            eq(schema.sandboxGitCredentialBindings.workspaceId, input.workspaceId),
            eq(schema.sandboxGitCredentialBindings.sessionId, input.sessionId),
            inArray(schema.sandboxGitCredentialBindings.provider, providers),
          ),
        )
        .orderBy(asc(schema.sandboxGitCredentialBindings.provider))
        .for("update");
      if (current.length === 0) return [];
      if (
        input.expectedGenerations &&
        ((Object.keys(input.expectedGenerations) as GitCredentialProvider[]).sort().join("\0") !==
          providers.join("\0") ||
          current.length !== providers.length ||
          current.some(
            (binding) =>
              binding.status !== "active" ||
              binding.generation !== input.expectedGenerations?.[binding.provider],
          ))
      ) {
        return [];
      }
      await input.mutateSandbox?.();
      const rows: SandboxGitCredentialBinding[] = [];
      for (const binding of current) {
        const changed = binding.status !== input.status || binding.reasonCode !== reasonCode;
        const [row] = await scopedDb
          .update(schema.sandboxGitCredentialBindings)
          .set({
            status: input.status,
            reasonCode,
            generation: changed ? binding.generation + 1 : binding.generation,
            updatedAt: new Date(),
          })
          .where(eq(schema.sandboxGitCredentialBindings.id, binding.id))
          .returning();
        if (!row) throw new Error("Failed to update sandbox Git credential binding status");
        rows.push(mapSandboxGitCredentialBinding(row));
      }
      return rows;
    },
  );
}

export type SandboxGitCredentialMutationResult =
  | { applied: true }
  | { applied: false; reason: "missing" | "not_active" | "stale_generation" };

/**
 * Final sandbox mutation fence. Token minting may happen before this call, but
 * no file write can occur unless every provider row is still active at the
 * exact generation while all rows are locked in deterministic provider order.
 */
export async function withActiveSandboxGitCredentialBindings(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    expectedGenerations: Readonly<Partial<Record<GitCredentialProvider, number>>>;
  },
  mutateSandbox: () => Promise<void>,
): Promise<SandboxGitCredentialMutationResult> {
  const providers = (Object.keys(input.expectedGenerations) as GitCredentialProvider[]).sort();
  if (providers.length === 0) return { applied: false, reason: "missing" };
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.sandboxGitCredentialBindings)
        .where(
          and(
            eq(schema.sandboxGitCredentialBindings.workspaceId, input.workspaceId),
            eq(schema.sandboxGitCredentialBindings.sessionId, input.sessionId),
            inArray(schema.sandboxGitCredentialBindings.provider, providers),
          ),
        )
        .orderBy(asc(schema.sandboxGitCredentialBindings.provider))
        .for("update");
      if (rows.length !== providers.length) return { applied: false, reason: "missing" };
      if (rows.some((row) => row.status !== "active")) {
        return { applied: false, reason: "not_active" };
      }
      if (rows.some((row) => row.generation !== input.expectedGenerations[row.provider])) {
        return { applied: false, reason: "stale_generation" };
      }
      await mutateSandbox();
      return { applied: true };
    },
  );
}

// ============================================================================
// Session recordings — the durable index for the "agent films itself proving
// the fix" loop (P4.3). One row per recording; insert at start, update at
// finalize (available with the storage_key) or failure. Read-side feeds the
// list route + the signed-URL replay route (storage_key is the source of truth).
// ============================================================================

export type SessionRecordingState = (typeof schema.sessionRecordingStateValues)[number];
export type SessionRecordingMode = (typeof schema.sessionRecordingModeValues)[number];
export type SessionRecordingCodec = (typeof schema.sessionRecordingCodecValues)[number];

export type SessionRecordingRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string | null;
  state: SessionRecordingState;
  mode: SessionRecordingMode;
  codec: SessionRecordingCodec;
  storageKey: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number;
  height: number;
  reason: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};

function mapRecording(row: typeof schema.sessionRecordings.$inferSelect): SessionRecordingRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    state: row.state,
    mode: row.mode,
    codec: row.codec,
    storageKey: row.storageKey,
    sizeBytes: row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
    durationSeconds:
      row.durationSeconds === null || row.durationSeconds === undefined
        ? null
        : Number(row.durationSeconds),
    width: row.width,
    height: row.height,
    reason: row.reason,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
  };
}

export async function insertRecording(
  db: Database,
  input: {
    id: string;
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId?: string | null;
    mode: SessionRecordingMode;
    codec: SessionRecordingCodec;
    width: number;
    height: number;
    reason?: string | null;
  },
): Promise<SessionRecordingRow> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.sessionRecordings)
        .values({
          id: input.id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId ?? null,
          state: "recording",
          mode: input.mode,
          codec: input.codec,
          width: input.width,
          height: input.height,
          reason: input.reason ?? null,
        })
        .returning();
      return mapRecording(row!);
    },
  );
}

export async function updateRecording(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    recordingId: string;
    state: SessionRecordingState;
    storageKey?: string | null;
    sizeBytes?: number | null;
    durationSeconds?: number | null;
    reason?: string | null;
    finalized?: boolean;
  },
): Promise<SessionRecordingRow | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const set: Partial<typeof schema.sessionRecordings.$inferInsert> = { state: input.state };
      if (input.storageKey !== undefined) set.storageKey = input.storageKey;
      if (input.sizeBytes !== undefined) set.sizeBytes = input.sizeBytes;
      if (input.durationSeconds !== undefined) set.durationSeconds = input.durationSeconds;
      if (input.reason !== undefined) set.reason = input.reason;
      if (input.finalized || input.state === "available" || input.state === "failed") {
        set.finalizedAt = new Date();
      }
      const [row] = await scopedDb
        .update(schema.sessionRecordings)
        .set(set)
        .where(
          and(
            eq(schema.sessionRecordings.workspaceId, input.workspaceId),
            eq(schema.sessionRecordings.id, input.recordingId),
          ),
        )
        .returning();
      return row ? mapRecording(row) : null;
    },
  );
}

/**
 * Hard-delete a recording row. Used to DISCARD an on-turn recording that captured
 * NO computer-use activity (a plain text turn): the row was inserted at
 * `beginRecording` (state "recording") but the turn never drove the desktop, so it
 * is removed entirely rather than surfaced as a phantom recording or a failure. No
 * other table FK-references session_recordings, so the delete is self-contained.
 */
export async function deleteRecording(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    recordingId: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .delete(schema.sessionRecordings)
        .where(
          and(
            eq(schema.sessionRecordings.workspaceId, input.workspaceId),
            eq(schema.sessionRecordings.id, input.recordingId),
          ),
        );
    },
  );
}

/**
 * Close an attempt-owned recording that could not reach the atomic turn
 * settlement. The accepted recording.started event is the durable ownership
 * receipt: cleanup is allowed only for the exact turn generation and attempt
 * that created this recording id. No timeline event is emitted from this
 * hygiene path.
 */
export async function abandonRecordingForTurnAttempt(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    executionGeneration: number;
    attemptId: string;
    recordingId: string;
    disposition: "failed" | "discard";
    reason: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [recording] = await tx
          .select({ id: schema.sessionRecordings.id })
          .from(schema.sessionRecordings)
          .where(
            and(
              eq(schema.sessionRecordings.accountId, input.accountId),
              eq(schema.sessionRecordings.workspaceId, input.workspaceId),
              eq(schema.sessionRecordings.sessionId, input.sessionId),
              eq(schema.sessionRecordings.turnId, input.turnId),
              eq(schema.sessionRecordings.id, input.recordingId),
              eq(schema.sessionRecordings.mode, "on-turn"),
              inArray(schema.sessionRecordings.state, ["recording", "finalizing"]),
            ),
          )
          .for("update")
          .limit(1);
        if (!recording) return false;
        const [started] = await tx
          .select({ id: schema.sessionEvents.id })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, input.workspaceId),
              eq(schema.sessionEvents.sessionId, input.sessionId),
              eq(schema.sessionEvents.turnId, input.turnId),
              eq(schema.sessionEvents.turnGeneration, input.executionGeneration),
              eq(schema.sessionEvents.turnAttemptId, input.attemptId),
              eq(schema.sessionEvents.turnAssociation, "current"),
              eq(schema.sessionEvents.type, "recording.started"),
              eq(sql<string>`${schema.sessionEvents.payload} ->> 'recordingId'`, input.recordingId),
            ),
          )
          .limit(1);
        if (!started) return false;
        if (input.disposition === "discard") {
          await tx
            .delete(schema.sessionRecordings)
            .where(eq(schema.sessionRecordings.id, recording.id));
        } else {
          await tx
            .update(schema.sessionRecordings)
            .set({
              state: "failed",
              reason: input.reason.slice(0, 2_000),
              finalizedAt: new Date(),
            })
            .where(eq(schema.sessionRecordings.id, recording.id));
        }
        return true;
      }),
  );
}

export async function getRecording(
  db: Database,
  workspaceId: string,
  recordingId: string,
): Promise<SessionRecordingRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessionRecordings)
      .where(
        and(
          eq(schema.sessionRecordings.workspaceId, workspaceId),
          eq(schema.sessionRecordings.id, recordingId),
        ),
      )
      .limit(1);
    return row ? mapRecording(row) : null;
  });
}

export async function listRecordings(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionRecordingRow[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sessionRecordings)
      .where(
        and(
          eq(schema.sessionRecordings.workspaceId, workspaceId),
          eq(schema.sessionRecordings.sessionId, sessionId),
        ),
      )
      .orderBy(desc(schema.sessionRecordings.createdAt));
    return rows.map(mapRecording);
  });
}

// ============================================================================
// Channel-A interactive PTY sessions (P4.4) — the ptyId <-> exec-session-id map.
// The ONLY new persistent state Channel A needs; FS/Git reads persist nothing.
// ============================================================================

export type SandboxPtySessionRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  execSessionId: number | null;
  leaseEpoch: number;
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
  status: "open" | "closed";
  openedBy: string;
  lastInputAt: string;
  createdAt: string;
  closedAt: string | null;
};

function mapPtySession(row: typeof schema.sandboxPtySessions.$inferSelect): SandboxPtySessionRow {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    execSessionId: row.execSessionId ?? null,
    leaseEpoch: row.leaseEpoch,
    cols: row.cols,
    rows: row.rows,
    shell: row.shell,
    cwd: row.cwd,
    status: row.status as "open" | "closed",
    openedBy: row.openedBy,
    lastInputAt: row.lastInputAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

export async function insertPtySession(
  db: Database,
  input: {
    id: string;
    accountId: string;
    workspaceId: string;
    sessionId: string;
    execSessionId?: number | null;
    leaseEpoch: number;
    cols: number;
    rows: number;
    shell: string;
    cwd: string;
    openedBy: string;
  },
): Promise<SandboxPtySessionRow> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.sandboxPtySessions)
        .values({
          id: input.id,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          execSessionId: input.execSessionId ?? null,
          leaseEpoch: input.leaseEpoch,
          cols: input.cols,
          rows: input.rows,
          shell: input.shell,
          cwd: input.cwd,
          status: "open",
          openedBy: input.openedBy,
        })
        .returning();
      return mapPtySession(row!);
    },
  );
}

/** Read an OPEN PTY row by ptyId. Returns null when absent or already closed. */
export async function getOpenPtySession(
  db: Database,
  workspaceId: string,
  ptyId: string,
): Promise<SandboxPtySessionRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sandboxPtySessions)
      .where(
        and(
          eq(schema.sandboxPtySessions.workspaceId, workspaceId),
          eq(schema.sandboxPtySessions.id, ptyId),
          eq(schema.sandboxPtySessions.status, "open"),
        ),
      )
      .limit(1);
    return row ? mapPtySession(row) : null;
  });
}

/** Stamp the SDK exec-session id (known only after the open exec yields a still-
 *  running process) + refresh the input-activity TTL. */
export async function updatePtySessionActivity(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    ptyId: string;
    execSessionId?: number | null;
    cols?: number;
    rows?: number;
  },
): Promise<SandboxPtySessionRow | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const set: Partial<typeof schema.sandboxPtySessions.$inferInsert> = {
        lastInputAt: new Date(),
      };
      if (input.execSessionId !== undefined) set.execSessionId = input.execSessionId;
      if (input.cols !== undefined) set.cols = input.cols;
      if (input.rows !== undefined) set.rows = input.rows;
      const [row] = await scopedDb
        .update(schema.sandboxPtySessions)
        .set(set)
        .where(
          and(
            eq(schema.sandboxPtySessions.workspaceId, input.workspaceId),
            eq(schema.sandboxPtySessions.id, input.ptyId),
            eq(schema.sandboxPtySessions.status, "open"),
          ),
        )
        .returning();
      return row ? mapPtySession(row) : null;
    },
  );
}

/** Mark a PTY closed (idempotent — a double close on a closed row is a no-op). */
export async function closePtySession(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    ptyId: string;
  },
): Promise<SandboxPtySessionRow | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .update(schema.sandboxPtySessions)
        .set({ status: "closed", closedAt: new Date() })
        .where(
          and(
            eq(schema.sandboxPtySessions.workspaceId, input.workspaceId),
            eq(schema.sandboxPtySessions.id, input.ptyId),
          ),
        )
        .returning();
      return row ? mapPtySession(row) : null;
    },
  );
}

/** List a session's OPEN PTYs (reattach + reap). */
export async function listOpenPtySessions(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SandboxPtySessionRow[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sandboxPtySessions)
      .where(
        and(
          eq(schema.sandboxPtySessions.workspaceId, workspaceId),
          eq(schema.sandboxPtySessions.sessionId, sessionId),
          eq(schema.sandboxPtySessions.status, "open"),
        ),
      )
      .orderBy(desc(schema.sandboxPtySessions.createdAt));
    return rows.map(mapPtySession);
  });
}

// ============================================================================
// Sandbox singleton lease — the SOLE enforcer of one-box-per-group (P1.1).
//
// Group-keyed (workspace_id, sandbox_group_id) from the start. The sole
// double-spawn guard is the UNIQUE (workspace_id, sandbox_group_id) index +
// plain SELECT … FOR UPDATE (block, NOT skip-locked) + the cold->warming CAS
// inside that row lock. lease_epoch is integer (returns a JS number) but every
// read is Number()-coerced defensively. Mirrors the atomic turn-admission
// withWorkspaceRls/withRlsContext -> scopedDb.transaction -> tx.execute(sql<T>``)
// pattern (the row type goes on the sql tag, not on .execute).
// ============================================================================

export type SandboxLeaseLiveness = "cold" | "warming" | "warm" | "draining";
export type LeaseHolderKind = "turn" | "viewer";

// The snake_case raw shape returned by the raw sql`` lease queries. lease_epoch
// comes back as a number for an integer column, but we type it number|string
// and Number()-coerce so the same code is correct regardless of column type.
// Typed with an index signature so it satisfies db.execute<TRow extends
// Record<string, unknown>>.
type LeaseRow = {
  id: string;
  account_id: string;
  workspace_id: string;
  sandbox_group_id: string;
  liveness: SandboxLeaseLiveness;
  refcount: number;
  turn_holders: number;
  viewer_holders: number;
  instance_id: string | null;
  backend: string;
  os: string;
  image: string | null;
  rig_version_id: string | null;
  data_plane_url: string | null;
  terminal_data_plane_url: string | null;
  lease_epoch: number | string;
  resume_backend_id: string | null;
  resume_state: Record<string, unknown> | null;
  last_meter_at: Date | string | null;
  last_meter_tick: number;
  expires_at: Date | string;
} & Record<string, unknown>;

export interface LeaseSnapshot {
  id: string;
  sandboxGroupId: string;
  liveness: SandboxLeaseLiveness;
  refcount: number;
  turnHolders: number;
  viewerHolders: number;
  instanceId: string | null;
  backend: string;
  os: string;
  // The container image the group box runs (Modal image ref / docker image). Null
  // for a legacy/cold row (image unknown). Shared state: all the box's sessions run
  // this image; a resume resolving a different image conflicts (B3).
  image: string | null;
  // The frozen rig version the group box was created under (M3). Like `image`,
  // shared state: a resume resolving a DIFFERENT rig_version_id conflicts (solo
  // recreates, N-holders throw SandboxRigConflictError). Null = rig unknown
  // (legacy/cold row or a rig-less session), which never conflicts.
  rigVersionId: string | null;
  dataPlaneUrl: string | null;
  // The cached ttyd pty-ws tunnel URL (7681), separate from dataPlaneUrl (the
  // 6080 desktop tunnel). Null until mintTerminalStream resolves + records it.
  terminalDataPlaneUrl: string | null;
  leaseEpoch: number;
  resumeBackendId: string | null;
  resumeState: Record<string, unknown> | null;
  expiresAt: Date;
}

export interface LiveModalSandboxLeaseAttribution {
  leaseId: string;
  workspaceId: string;
  sandboxGroupId: string;
  instanceId: string | null;
  liveness: SandboxLeaseLiveness;
}

export interface AcquireLeaseInput {
  accountId: string;
  workspaceId: string;
  // The group's identity (sessions.sandbox_group_id; == session id for a
  // singleton group). The lease is per-group, not per-session.
  sandboxGroupId: string;
  kind: LeaseHolderKind;
  // Globally unique durable turn-attempt id (turn) | viewer connection id
  // (viewer). A workflow-local activity id is not a valid turn holder id.
  holderId: string;
  subjectId?: string | null; // the attributing session within the group
  backend: string; // sessions.sandbox_backend
  os?: string; // default 'linux'
  // The container image this run resolves (Modal image ref / docker image). Stamped on
  // the cold-create + folded onto a warming/CAS; a warm/draining/warming box already
  // running a DIFFERENT image is a shared-state conflict (B3): a SOLO holder forces the
  // box to recreate on this image, N-holders throw SandboxImageConflictError. Omitted
  // (null/undefined) -> image is not enforced (legacy/cold rows, selfhosted).
  image?: string | null;
  // The frozen rig version this run rides (M3). Stamped on the cold-create + CAS
  // and conflicted exactly like `image`: a live multi-holder box under a DIFFERENT
  // rig version throws SandboxRigConflictError; a solo holder recreates the box cold
  // on the new rig. Omitted (null/undefined) -> rig is not enforced (rig-less
  // sessions never stamp or conflict; legacy/cold rows read null = compatible).
  rigVersionId?: string | null;
  leaseTtlMs: number; // refresh window for expires_at (turn-heartbeat cadence)
  // Expiry stamped only while a cold->warming spawner is allowed to create the
  // provider box before any instance_id exists. Warm/draining/attached refreshes
  // must continue using leaseTtlMs.
  warmingLeaseTtlMs?: number;
  // Optional epoch fence for a re-establishing turn holder: when set, the
  // turn-arrival increment is gated on lease_epoch == expectedEpoch (split-brain).
  expectedEpoch?: number;
}

export type AcquireLeaseResult =
  // Caller WON the cold->warming CAS: it is the spawner (any pool worker). Must
  // resume-by-id from resume_state, expose the stream port, then call
  // commitWarmingToWarm. No owner process is started.
  | { role: "spawner"; lease: LeaseSnapshot }
  // Box live or being built by someone else: attach (and, for warming, wait).
  | { role: "attached"; lease: LeaseSnapshot }
  // Re-armed a draining lease back to warm (box never torn down).
  | { role: "rearmed"; lease: LeaseSnapshot }
  // Epoch fence rejected the turn-arrival increment: a newer epoch exists (a
  // later turn re-established the box). Caller must back off and re-read; NEVER
  // create().
  | { role: "fenced"; lease: LeaseSnapshot };

// Thrown by callers that treat a fenced/superseded epoch as an error path.
export class SandboxLeaseSupersededError extends Error {
  constructor(
    public readonly sandboxGroupId: string,
    public readonly leaseEpoch: number,
  ) {
    super(`Sandbox lease superseded for group ${sandboxGroupId} (epoch ${leaseEpoch})`);
    this.name = "SandboxLeaseSupersededError";
  }
}

// IMAGE IS SHARED STATE (B3): thrown when a resume resolves an image DIFFERENT from
// the one the live shared box was created with AND other holders are still on the box.
// A shared box is ONE filesystem; recreating it on a new image would yank the running
// filesystem out from under the OTHER sessions, so we refuse. The turn activity surfaces
// this as an actionable error: spawn with sandbox:'new' or align the pack image. A SOLO
// holder never hits this — acquireLease recreates the box on the new image instead.
export class SandboxImageConflictError extends Error {
  constructor(
    public readonly sandboxGroupId: string,
    public readonly currentImage: string,
    public readonly requestedImage: string,
  ) {
    super(
      `Sandbox group ${sandboxGroupId} runs image ${currentImage}; this run resolves image ${requestedImage}. ` +
        `A shared box requires one image — spawn with sandbox:'new' for an isolated box or align the pack image.`,
    );
    this.name = "SandboxImageConflictError";
  }
}

// RIG IS SHARED STATE (M3): thrown when a resume resolves a rig version DIFFERENT from
// the one the live shared box was set up under AND other holders are still on the box.
// A rig bakes setup/tooling into the ONE shared filesystem; recreating it on a different
// rig would yank that filesystem out from under the other sessions, so we refuse. The
// turn activity surfaces this as an actionable error. A SOLO holder never hits this —
// acquireLease recreates the box cold on the new rig instead. Mirrors SandboxImageConflictError.
export class SandboxRigConflictError extends Error {
  constructor(
    public readonly sandboxGroupId: string,
    public readonly currentRigVersionId: string,
    public readonly requestedRigVersionId: string,
  ) {
    super(
      `Sandbox group ${sandboxGroupId} was set up for rig version ${currentRigVersionId}; this run resolves rig version ${requestedRigVersionId}. ` +
        `A shared box requires one rig — spawn with sandbox:'new' for an isolated box or bind the group's rig.`,
    );
    this.name = "SandboxRigConflictError";
  }
}

function mapLeaseRow(row: LeaseRow): LeaseSnapshot {
  return {
    id: row.id,
    sandboxGroupId: row.sandbox_group_id,
    liveness: row.liveness,
    refcount: Number(row.refcount),
    turnHolders: Number(row.turn_holders),
    viewerHolders: Number(row.viewer_holders),
    instanceId: row.instance_id,
    backend: row.backend,
    os: row.os,
    image: row.image ?? null,
    rigVersionId: row.rig_version_id ?? null,
    dataPlaneUrl: row.data_plane_url,
    terminalDataPlaneUrl: row.terminal_data_plane_url ?? null,
    // Defensive coercion: integer returns a number, but coerce regardless so the
    // fence comparison stays exact even if the column type ever drifts to int8.
    leaseEpoch: Number(row.lease_epoch),
    resumeBackendId: row.resume_backend_id,
    resumeState: row.resume_state,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

// Recompute refcount/split-counts from the holder rows (holders are the source
// of truth), refresh expires_at, optionally set liveness. Returns the updated row.
async function recomputeAndStampLease(
  tx: Database,
  leaseId: string,
  leaseTtlMs: number,
  setLiveness: SandboxLeaseLiveness | null,
): Promise<LeaseRow> {
  const counts = await tx.execute<{ total: number; turns: number; viewers: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where kind = 'turn')::int   as turns,
           count(*) filter (where kind = 'viewer')::int as viewers
    from sandbox_lease_holders where lease_id = ${leaseId}
  `);
  const c = counts[0]!;
  const updated = await tx.execute<LeaseRow>(sql`
    update sandbox_leases set
      refcount       = ${c.total},
      turn_holders   = ${c.turns},
      viewer_holders = ${c.viewers},
      expires_at     = now() + (${String(leaseTtlMs)} || ' milliseconds')::interval,
      ${setLiveness ? sql`liveness = ${setLiveness},` : sql``}
      updated_at     = now()
    where id = ${leaseId}
    returning *
  `);
  return updated[0]!;
}

// Idempotent acquire: the unique (lease, kind, holder) index makes a retried or
// duplicate acquire a no-op heartbeat refresh, never a double-count.
async function upsertLeaseHolder(
  tx: Database,
  leaseId: string,
  accountId: string,
  workspaceId: string,
  kind: LeaseHolderKind,
  holderId: string,
  subjectId: string | null,
): Promise<void> {
  await tx.execute(sql`
    insert into sandbox_lease_holders
      (account_id, workspace_id, lease_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${accountId}, ${workspaceId}, ${leaseId}, ${kind}, ${holderId}, ${subjectId}, now())
    on conflict (lease_id, kind, holder_id)
      do update set last_heartbeat_at = now()
  `);
}

// §4.1 — the get-or-create critical section. ONE transaction:
// insert-or-nothing -> SELECT … FOR UPDATE (block, not skip) -> branch -> bump.
// The single most load-bearing function: the sole double-spawn guard.
export async function acquireLease(
  db: Database,
  input: AcquireLeaseInput,
): Promise<AcquireLeaseResult> {
  const { accountId, workspaceId, sandboxGroupId, kind, holderId, backend } = input;
  const os = input.os ?? "linux";
  const subjectId = input.subjectId ?? null;
  const warmingLeaseTtlMs = input.warmingLeaseTtlMs ?? input.leaseTtlMs;
  return await withRlsContext(
    db,
    { accountId, workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const image = input.image ?? null;
        const rigVersionId = input.rigVersionId ?? null;
        // (1) Materialize the singleton row if absent. ON CONFLICT DO NOTHING + the
        // unique index = idempotent under a race; concurrent inserts collapse to
        // one row. expires_at seeded so a never-warmed cold row has a valid TTL. The
        // image (B3) + rig version (M3) are stamped on the cold-create so a fresh box
        // records what it will be built on; a conflict on an EXISTING live box is
        // handled below.
        await tx.execute(sql`
        insert into sandbox_leases
          (account_id, workspace_id, sandbox_group_id, liveness, backend, os, image, rig_version_id, expires_at)
        values
          (${accountId}, ${workspaceId}, ${sandboxGroupId}, 'cold', ${backend}, ${os}, ${image}, ${rigVersionId},
           now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval)
        on conflict (workspace_id, sandbox_group_id) do nothing
      `);

        // (2) Serialize ALL concurrent arrivals on this group's row. Plain FOR
        // UPDATE (block, do NOT skip) — unlike concurrent enrollment scans,
        // because we WANT the loser to block then attach, not skip and lose.
        const rows = await tx.execute<LeaseRow>(sql`
        select * from sandbox_leases
        where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}
        for update
      `);
        const row = rows[0];
        if (!row) throw new Error(`Lease row vanished post-insert: ${sandboxGroupId}`);

        let liveness = row.liveness;

        // -- SHARED STATE CONFLICT (B3 image + M3 rig): a LIVE box (warm/draining/warming)
        // was created under a specific image AND rig version. If this run resolves a
        // DIFFERENT image OR a DIFFERENT rig version (each checked only when both sides are
        // known), the one shared filesystem cannot serve both. Under the held row lock we
        // count the OTHER holders (not this exact (kind, holderId) — an idempotent retry of
        // our own holder is not a rival):
        //   - SOLO (no other holders): RECREATE. Reset the box to cold and re-stamp the NEW
        //     image + rig version, then fall through to the cold branch below, which CASes us
        //     in as the spawner. The spawner cold-creates a fresh box (the archive replay in
        //     establishSandboxSessionFromEnvelope hydrates /workspace) — for the RIG case the
        //     new box then re-runs the new rig's setup hook (fresh marker).
        //   - OTHER holders present: REFUSE. Throw — recreating would yank the running
        //     filesystem out from under the other sessions. Image conflict is reported first
        //     so its (pre-rig) error is unchanged for the image-only case.
        // Each axis is enforced only when BOTH sides are known; a cold row / a legacy null /
        // an unset input never conflicts (the selfhosted path passes neither; a rig-less run
        // passes no rigVersionId, so it never stamps or conflicts on rig).
        const imageConflict = image !== null && row.image !== null && row.image !== image;
        const rigConflict =
          rigVersionId !== null &&
          row.rig_version_id !== null &&
          row.rig_version_id !== rigVersionId;
        if (liveness !== "cold" && (imageConflict || rigConflict)) {
          const others = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from sandbox_lease_holders
          where lease_id = ${row.id} and not (kind = ${kind} and holder_id = ${holderId})
        `);
          const otherHolders = Number(others[0]?.n ?? 0);
          if (otherHolders > 0) {
            if (imageConflict) {
              throw new SandboxImageConflictError(
                sandboxGroupId,
                row.image as string,
                image as string,
              );
            }
            throw new SandboxRigConflictError(
              sandboxGroupId,
              row.rig_version_id as string,
              rigVersionId as string,
            );
          }
          // SOLO recreate: reset to cold + re-stamp whichever axis this run carries (each
          // conditional so a rig-only change does not null out a still-valid image and vice
          // versa). Clear the live-box fields so no stale instance/tunnel survives the roll
          // (symmetric with failWarmingToCold). resume_state is nulled — a solo image/rig
          // change is an intentional fresh box (a divergent image/rig cannot replay the old
          // box's live state); the session envelope/archive still drives /workspace
          // hydration on the cold re-create. Fall through to the cold branch (CAS spawner).
          await tx.execute(sql`
          update sandbox_leases set
            liveness = 'cold',
            ${image !== null ? sql`image = ${image},` : sql``}
            ${rigVersionId !== null ? sql`rig_version_id = ${rigVersionId},` : sql``}
            instance_id = null,
            data_plane_url = null, terminal_data_plane_url = null,
            resume_backend_id = null, resume_state = null, updated_at = now()
          where id = ${row.id}
        `);
          liveness = "cold";
        }

        // -- draining: late arrival re-arms (D1). Box still alive (grace open).
        if (liveness === "draining") {
          await upsertLeaseHolder(tx, row.id, accountId, workspaceId, kind, holderId, subjectId);
          const updated = await recomputeAndStampLease(tx, row.id, input.leaseTtlMs, "warm");
          return { role: "rearmed" as const, lease: mapLeaseRow(updated) };
        }

        // -- cold: WIN the cold->warming CAS (C1). Exactly one winner under the
        // held row lock; concurrent arrivals serialize behind us and see warming.
        // The image (B3) is (re-)stamped on the CAS so the box the spawner cold-creates
        // records the image it runs — for a fresh cold row or a solo-recreate above.
        if (liveness === "cold") {
          const casRows = await tx.execute<{ id: string }>(sql`
          update sandbox_leases set
            liveness = 'warming',
            ${image !== null ? sql`image = ${image},` : sql``}
            ${rigVersionId !== null ? sql`rig_version_id = ${rigVersionId},` : sql``}
            updated_at = now()
          where id = ${row.id} and liveness = 'cold'
          returning id
        `);
          await upsertLeaseHolder(tx, row.id, accountId, workspaceId, kind, holderId, subjectId);
          const updated = await recomputeAndStampLease(tx, row.id, warmingLeaseTtlMs, null);
          // casRows.length === 0 cannot happen under the held row lock (defensive):
          // a lost CAS means a sibling flipped it first, so we attach.
          const role = casRows.length === 0 ? ("attached" as const) : ("spawner" as const);
          return { role, lease: mapLeaseRow(updated) };
        }

        // -- warm: epoch fence for re-establishing turn holders (split-brain). A
        // turn arriving with expectedEpoch must match the live row epoch; a stale
        // re-dispatched turn is fenced out -> back off, NEVER create(). Number()-
        // coerced so an int8 drift cannot make the compare always-true.
        if (
          liveness === "warm" &&
          kind === "turn" &&
          input.expectedEpoch !== undefined &&
          Number(row.lease_epoch) !== input.expectedEpoch
        ) {
          return { role: "fenced" as const, lease: mapLeaseRow(row) };
        }

        // -- warm / warming: attach (A2 / A1). refcount++ ONLY; never touch
        // liveness. The spawner exclusively owns warming->warm.
        // TTL: a WARMING attach must keep the warming budget — re-stamping the
        // plain (90s) TTL while a spawner's create() is still in flight would
        // collapse expires_at and let the warming-death reaper reset/drain the
        // lease before instance_id is recorded (F1). A WARM attach uses the plain
        // TTL as before.
        await upsertLeaseHolder(tx, row.id, accountId, workspaceId, kind, holderId, subjectId);
        const attachTtlMs = liveness === "warming" ? warmingLeaseTtlMs : input.leaseTtlMs;
        const updated = await recomputeAndStampLease(tx, row.id, attachTtlMs, null);
        return { role: "attached" as const, lease: mapLeaseRow(updated) };
      }),
  );
}

// §4.2 — the ONLY lease_epoch++ site. CAS on (warming AND lease_epoch=expected).
// Folds the group box-envelope (resume_backend_id/resume_state) onto the lease.
export async function commitWarmingToWarm(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number; // the epoch the spawner observed at cold->warming
    instanceId: string;
    dataPlaneUrl?: string | null; // event-driven resolveExposedPort result, any worker
    resumeBackendId?: string | null;
    resumeState?: Record<string, unknown> | null;
    leaseTtlMs: number;
  },
): Promise<{ committed: boolean; lease: LeaseSnapshot | null }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // resume_state is jsonb: the raw postgres driver does NOT auto-stringify a
      // plain object bound for a jsonb column, so serialize to a JSON string and
      // cast ::jsonb (null stays a real SQL null). Binding the object directly
      // throws "string argument must be of type string" on the wire.
      const resumeStateJson = input.resumeState == null ? null : JSON.stringify(input.resumeState);
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          liveness          = 'warm',
          instance_id       = ${input.instanceId},
          data_plane_url    = ${input.dataPlaneUrl ?? null},
          -- A box re-key (epoch++) invalidates the prior epoch's ttyd tunnel; the
          -- terminal URL is re-resolved + re-recorded lazily by mintTerminalStream
          -- on the next attach. Clear it here so a stale URL never survives a roll.
          terminal_data_plane_url = null,
          resume_backend_id = ${input.resumeBackendId ?? null},
          resume_state      = ${resumeStateJson}::jsonb,
          lease_epoch       = lease_epoch + 1,
          expires_at        = now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval,
          updated_at        = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
        returning *
      `);
      // CAS miss = a reaper already reset this warming row to cold (the spawner
      // was too slow), or another spawner re-established and bumped the epoch.
      // The spawner MUST drop its in-memory handle and re-acquire — NEVER force
      // warm, NEVER provider-delete the box (it rides the provider idle-timeout).
      if (rows.length === 0) return { committed: false, lease: null };
      return { committed: true, lease: mapLeaseRow(rows[0]!) };
    },
  );
}

// §4.2a — leak-proof create attribution. The spawner calls this immediately
// after the provider create returns, before display/readiness/setup work. It
// intentionally does NOT bump lease_epoch or mark the lease warm; it only makes
// the just-created provider id durable while the row is still warming so a
// failure/reaper/provider-side sweep can identify and stop it.
export async function recordWarmingSandboxCreated(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    instanceId: string;
    resumeBackendId?: string | null;
    resumeState?: Record<string, unknown> | null;
    leaseTtlMs: number;
    /** The still-WARMING lease must keep the warming budget after create() returns:
     *  provider manifest hydration and commitWarmingToWarm can exceed the 90s turn
     *  TTL and trip the warming-death (c2) drain now that instance_id is set.
     *  Desktop/display work is not part of warming; it is initialized lazily by
     *  viewer attach or actual computer-use. Defaults to leaseTtlMs for callers. */
    warmingLeaseTtlMs?: number;
  },
): Promise<{ recorded: boolean; lease: LeaseSnapshot | null }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const resumeStateJson = input.resumeState == null ? null : JSON.stringify(input.resumeState);
      const warmingTtlMs = input.warmingLeaseTtlMs ?? input.leaseTtlMs;
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          instance_id       = ${input.instanceId},
          resume_backend_id = ${input.resumeBackendId ?? null},
          resume_state      = ${resumeStateJson}::jsonb,
          expires_at        = now() + (${String(warmingTtlMs)} || ' milliseconds')::interval,
          updated_at        = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
        returning *
      `);
      if (rows.length === 0) return { recorded: false, lease: null };
      return { recorded: true, lease: mapLeaseRow(rows[0]!) };
    },
  );
}

export type MarkWarmLeaseInstanceLostResult =
  | { status: "marked"; lease: LeaseSnapshot }
  | { status: "stale"; lease: LeaseSnapshot | null };

/**
 * Atomically retire one exact warm provider instance after a resume-only caller
 * receives a provider NotFound. The epoch + instance predicates are the
 * ownership fence: concurrent attached callers may all observe the same missing
 * box, but only the first one transitions the lease to cold and advances its
 * epoch. The next ordinary acquire elects one cold->warming spawner.
 *
 * Holders remain intact because their logical work/viewer interest still exists.
 * Only live provider identity is cleared. A persisted workspace archive is
 * reduced to the same minimal cold envelope used by the drain/failure paths, so
 * the elected replacement can hydrate it without carrying the dead box id.
 */
export async function markWarmLeaseInstanceLost(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    expectedInstanceId: string;
  },
): Promise<MarkWarmLeaseInstanceLostResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const currentRows = await tx.execute<LeaseRow>(sql`
          select * from sandbox_leases
          where workspace_id = ${input.workspaceId}
            and sandbox_group_id = ${input.sandboxGroupId}
          for update
        `);
        const current = currentRows[0];
        if (
          !current ||
          current.liveness !== "warm" ||
          Number(current.lease_epoch) !== input.expectedEpoch ||
          current.instance_id !== input.expectedInstanceId
        ) {
          return {
            status: "stale" as const,
            lease: current ? mapLeaseRow(current) : null,
          };
        }

        const updatedRows = await tx.execute<LeaseRow>(sql`
          update sandbox_leases set
            liveness = 'cold',
            instance_id = null,
            data_plane_url = null,
            terminal_data_plane_url = null,
            lease_epoch = lease_epoch + 1,
            resume_state = case
              when (resume_state #>> '{sessionState,workspaceArchive}') is not null
                then jsonb_build_object(
                  'backendId', coalesce(resume_state ->> 'backendId', to_jsonb(resume_backend_id) #>> '{}'),
                  'sessionState', jsonb_strip_nulls(jsonb_build_object(
                    'workspaceArchive', resume_state #> '{sessionState,workspaceArchive}',
                    'workspaceArchivePrev', resume_state #> '{sessionState,workspaceArchivePrev}',
                    'workspaceArchiveAt', resume_state #> '{sessionState,workspaceArchiveAt}')))
              else null
            end,
            resume_backend_id = case
              when (resume_state #>> '{sessionState,workspaceArchive}') is not null
                then resume_backend_id
              else null
            end,
            updated_at = now()
          where id = ${current.id}
          returning *
        `);
        const updated = updatedRows[0];
        if (!updated) {
          throw new Error(`Warm sandbox lease vanished while retiring instance ${current.id}`);
        }
        return { status: "marked" as const, lease: mapLeaseRow(updated) };
      }),
  );
}

// §4.3 — caught spawn failure: warming -> cold (W3). Holders are intentionally
// left intact — the arrival that triggered the spawn still wants a box, so the
// next acquireLease re-CAS cold->warming.
//
// ARCHIVE PRESERVATION (sandbox-file-persistence): when the cold lease that was
// selected for re-warm carried a persisted /workspace archive on its resume_state
// (an archive-only envelope `{ backendId, sessionState: { workspaceArchive } }`
// placed there by a prior drain), the spawn failed BEFORE commitWarmingToWarm,
// so the LIVE box envelope was never folded onto resume_state. The warming row
// still holds the ORIGINAL archive-only envelope. Nulling resume_state here would
// destroy the snapshot the NEXT re-warm must replay — the same file-persistence
// bug confirmDrainCold guards against. So we PRESERVE a minimal archive-only
// envelope across this failure rollback (same shape confirmDrainCold keeps) and
// retain resume_backend_id. No archive on the warming row (a never-persisted cold
// start) -> resume_state is nulled as before.
export async function failWarmingToCold(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.execute(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          data_plane_url = null, terminal_data_plane_url = null, updated_at = now(),
          resume_state = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then jsonb_build_object(
                'backendId', coalesce(resume_state ->> 'backendId', to_jsonb(resume_backend_id) #>> '{}'),
                -- Carry BOTH archives (+ the capture time) into the minimal cold
                -- envelope: the mid-session fallback (workspaceArchivePrev) was
                -- retained and never GC'd, so dropping it here would strand the
                -- provider snapshot AND lose the restore fallback across a
                -- drain/warming-death. strip_nulls omits prev/at when absent.
                'sessionState', jsonb_strip_nulls(jsonb_build_object(
                  'workspaceArchive', resume_state #> '{sessionState,workspaceArchive}',
                  'workspaceArchivePrev', resume_state #> '{sessionState,workspaceArchivePrev}',
                  'workspaceArchiveAt', resume_state #> '{sessionState,workspaceArchiveAt}')))
            else null
          end,
          resume_backend_id = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then resume_backend_id
            else null
          end
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
      `);
    },
  );
}

// §4.4 — idempotent delete-my-row (+ opportunistic warm->draining guarded
// refcount=0 AND turn_holders=0, so a paying turn is never drained).
export async function releaseLeaseHolder(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    kind: LeaseHolderKind;
    holderId: string;
    idleGraceMs: number;
  },
): Promise<{ liveness: SandboxLeaseLiveness; refcount: number } | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const rows = await tx.execute<LeaseRow>(sql`
        select * from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
        for update
      `);
        const row = rows[0];
        if (!row) return null; // already cold-and-reaped; release is an idempotent no-op

        // Idempotent: deleting an already-gone holder affects 0 rows, fine.
        await tx.execute(sql`
        delete from sandbox_lease_holders
        where lease_id = ${row.id} and kind = ${input.kind} and holder_id = ${input.holderId}
      `);

        const counts = await tx.execute<{ total: number; turns: number; viewers: number }>(sql`
        select count(*)::int as total,
               count(*) filter (where kind = 'turn')::int   as turns,
               count(*) filter (where kind = 'viewer')::int as viewers
        from sandbox_lease_holders where lease_id = ${row.id}
      `);
        const c = counts[0]!;

        // warm + dropped to 0 (AND no turn holders) -> draining, stamp grace deadline.
        // Release during warming decrements only, NEVER touches liveness (the
        // spawner owns warming->warm and re-checks refcount after committing).
        const enterDraining = row.liveness === "warm" && c.total === 0 && c.turns === 0;
        const updated = await tx.execute<LeaseRow>(sql`
        update sandbox_leases set
          refcount = ${c.total}, turn_holders = ${c.turns}, viewer_holders = ${c.viewers},
          ${
            enterDraining
              ? sql`liveness = 'draining', expires_at = now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval,`
              : sql``
          }
          updated_at = now()
        where id = ${row.id}
        returning *
      `);
        return { liveness: updated[0]!.liveness, refcount: Number(c.total) };
      }),
  );
}

// §4.5 — heartbeat. EPOCH-FENCED (the C1b fix — the real split-brain bug, on the
// HEARTBEAT path): a stale (superseded) owner's lease refresh is rejected so it
// self-evicts. Also liveness-guarded to warm/warming (C2) so a heartbeat can't
// wedge a draining lease forever by pushing its grace deadline.
export async function heartbeatLeaseHolder(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    kind: LeaseHolderKind;
    holderId: string;
    leaseTtlMs: number;
    expectedEpoch: number;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const updated = await tx.execute<{ id: string }>(sql`
        update sandbox_lease_holders set last_heartbeat_at = now()
        where lease_id = (select id from sandbox_leases
                          where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId})
          and kind = ${input.kind} and holder_id = ${input.holderId}
        returning id
      `);
        if (updated.length === 0) return false; // holder was reaped — caller re-acquires
        // Epoch-fenced, liveness-guarded lease TTL refresh: only a live-epoch
        // warm/warming lease is refreshed. A stale-epoch (split-brain) or draining
        // lease returns 0 rows -> false -> the stale holder drops its handle.
        const leaseRows = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          expires_at = now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval,
          updated_at = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and lease_epoch = ${input.expectedEpoch}
          and liveness in ('warm','warming')
        returning id
      `);
        return leaseRows.length > 0;
      }),
  );
}

/**
 * HOLDER-LIVENESS touch: refresh ONLY this holder's last_heartbeat_at. The
 * warmup phase of a turn (acquire -> waitForWarm -> establish/cold-restore ->
 * display stack) can legitimately run for many minutes BEFORE the full turn
 * heartbeat (heartbeatLeaseHolder) starts, and the dead-worker turn-holder
 * reap judges liveness by this timestamp. Touching our own holder row needs no
 * epoch fence — supersession is handled by the fenced acquire/establish paths;
 * a reaped/released row returns false (row gone).
 */
export async function touchLeaseHolder(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    kind: LeaseHolderKind;
    holderId: string;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const updated = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_lease_holders set last_heartbeat_at = now()
        where lease_id = (select id from sandbox_leases
                          where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId})
          and kind = ${input.kind} and holder_id = ${input.holderId}
        returning id
      `);
      return updated.length > 0;
    },
  );
}

// §4.6 — the reaper. DB-SIDE ONLY (no provider call — the provider stop() is
// P1.3's runtime concern). Three actions in one pass: TTL-reap stale viewer
// holders, recompute refcounts + warm->draining, reset warming-death to cold;
// returns the drainable (workspaceId, sandboxGroupId) rows the caller terminates.
//
// This is the PER-WORKSPACE entry point (RLS-scoped). The cross-workspace global
// sweep is the SECURITY-DEFINER opengeni_private.reap_sandbox_leases() fn —
// reapStaleLeaseHoldersGlobal below.
export interface ReapDrainable {
  workspaceId: string;
  sandboxGroupId: string;
  instanceId: string | null;
  leaseEpoch: number;
}

let loggedLegacyReapFunctionFallback = false;

export async function reapStaleLeaseHolders(
  db: Database,
  input: {
    workspaceId: string;
    viewerHolderTtlMs: number; // delete viewer rows older than this
    /** Delete TURN rows whose heartbeat is older than this (the lease TTL: >> the
     *  10s turn heartbeat, so only a DEAD worker's holder ever crosses it). 0/absent
     *  = legacy never-reap. */
    turnHolderTtlMs?: number;
    idleGraceMs: number; // drain-grace horizon (matches releaseLeaseHolder)
  },
): Promise<{
  reapedViewers: number;
  reapedTurns: number;
  warmingReset: number;
  drained: ReapDrainable[];
}> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        // (a) Reap stale VIEWER holders.
        const reaped = await tx.execute<{ lease_id: string }>(sql`
        delete from sandbox_lease_holders
        where workspace_id = ${input.workspaceId} and kind = 'viewer'
          and last_heartbeat_at < now() - (${String(input.viewerHolderTtlMs)} || ' milliseconds')::interval
        returning lease_id
      `);
        // (a2) Reap DEAD-WORKER turn holders. A live holder is touched every 10s
        // from registration (the resumeBoxForTurn holder-liveness loop covers the
        // warmup; the turn heartbeat covers the run — legit multi-day turns
        // included), so the caller's horizon is generous defense-in-depth, never
        // a bound a live path can reach. A holder staler than it belongs to a
        // worker that died without cleanup (SIGKILL/OOM/deploy churn); left in
        // place it pins refcount >= 1 FOREVER, so the lease never drains, the
        // reaper never persists /workspace, and the box rides the provider
        // hard-timeout to an UNPERSISTED death (the 2026-07-06 staging deploy
        // churn left holders frozen for hours). The redispatched turn re-acquires
        // under a NEW holder id, so deleting the corpse never touches a live
        // execution.
        const reapedTurnRows =
          input.turnHolderTtlMs && input.turnHolderTtlMs > 0
            ? await tx.execute<{ lease_id: string }>(sql`
          delete from sandbox_lease_holders
          where workspace_id = ${input.workspaceId} and kind = 'turn'
            and last_heartbeat_at < now() - (${String(input.turnHolderTtlMs)} || ' milliseconds')::interval
          returning lease_id
        `)
            : [];

        // (b) Recompute refcounts for every lease in the workspace; warm leases
        // that hit 0 (AND turn_holders=0) enter draining with a fresh grace
        // deadline (idleGraceMs — the SAME horizon releaseLeaseHolder stamps).
        await tx.execute(sql`
        update sandbox_leases L set
          refcount       = c.total,
          turn_holders   = c.turns,
          viewer_holders = c.viewers,
          liveness = case when L.liveness = 'warm' and c.total = 0 and c.turns = 0
                          then 'draining' else L.liveness end,
          expires_at = case when L.liveness = 'warm' and c.total = 0 and c.turns = 0
                          then now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval
                          else L.expires_at end,
          updated_at = now()
        from (
          select L2.id,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id)::int                       as total,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id and h.kind = 'turn')::int   as turns,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id and h.kind = 'viewer')::int as viewers
          from sandbox_leases L2 where L2.workspace_id = ${input.workspaceId}
        ) c
        where L.id = c.id and L.workspace_id = ${input.workspaceId}
      `);

        // (c1) WARMING-death before provider create returned: no instance_id was
        // ever persisted, so there is no provider box to stop. Reset to cold so a
        // queued turn can re-acquire and re-spawn.
        const warmingReset = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          resume_backend_id = null, resume_state = null,
          data_plane_url = null, terminal_data_plane_url = null, updated_at = now()
        where workspace_id = ${input.workspaceId}
          and liveness = 'warming' and expires_at < now() and instance_id is null
        returning id
      `);

        // (c2) WARMING-death after provider create returned: instance_id is known,
        // so do NOT drop it. Convert to immediately-drainable so the caller's
        // provider terminate path stops the box before the lease goes cold.
        const warmingDrain = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'draining',
          refcount = 0,
          turn_holders = 0,
          viewer_holders = 0,
          data_plane_url = null,
          terminal_data_plane_url = null,
          expires_at = now() - interval '1 millisecond',
          updated_at = now()
        where workspace_id = ${input.workspaceId}
          and liveness = 'warming' and expires_at < now() and instance_id is not null
        returning id
      `);

        // (d) DRAINING-grace elapsed: surface leases whose grace is up AND still
        // idle, with instance_id + epoch, so the caller can issue the provider
        // stop() then confirmDrainCold. DB-only: no provider call here.
        const drainable = await rawRows<{
          sandbox_group_id: string;
          instance_id: string | null;
          lease_epoch: number | string;
        }>(
          tx,
          sql`
        select sandbox_group_id, instance_id, lease_epoch from sandbox_leases
        where workspace_id = ${input.workspaceId}
          and liveness = 'draining' and expires_at < now() and refcount = 0
      `,
        );

        return {
          reapedViewers: reaped.length,
          reapedTurns: reapedTurnRows.length,
          warmingReset: warmingReset.length + warmingDrain.length,
          drained: drainable.map((r) => ({
            workspaceId: input.workspaceId,
            sandboxGroupId: r.sandbox_group_id,
            instanceId: r.instance_id,
            leaseEpoch: Number(r.lease_epoch),
          })),
        };
      }),
  );
}

// §4.6 (global) — the cross-workspace reaper sweep (OD-3). Calls the
// SECURITY-DEFINER opengeni_private.reap_sandbox_leases() fn so the global
// reaper Temporal Schedule (P1.3) sees stale rows across ALL workspaces in ONE
// pass, bypassing per-workspace FORCE RLS. DB-only — returns the drainable rows;
// the provider stop() is the caller's concern. No RLS GUC is set (the DEFINER fn
// is the sanctioned cross-workspace read).
export async function reapStaleLeaseHoldersGlobal(
  db: Database,
  input: {
    viewerHolderTtlMs: number;
    /** Reap DEAD-WORKER turn holders staler than this (the lease TTL; see
     *  reapStaleLeaseHolders). 0/absent = never (legacy). */
    turnHolderTtlMs?: number;
    idleGraceMs: number;
  },
): Promise<ReapDrainable[]> {
  let rows: Array<{
    workspace_id: string;
    sandbox_group_id: string;
    instance_id: string | null;
    lease_epoch: number | string;
  }>;
  try {
    rows = await rawRows<{
      workspace_id: string;
      sandbox_group_id: string;
      instance_id: string | null;
      lease_epoch: number | string;
    }>(
      db,
      sql`
      select workspace_id, sandbox_group_id, instance_id, lease_epoch
      from opengeni_private.reap_sandbox_leases(${input.viewerHolderTtlMs}, ${input.turnHolderTtlMs ?? 0}, ${input.idleGraceMs})
    `,
    );
  } catch (error) {
    // Deploy normally runs migrations before rollout, but a newly-started worker
    // may briefly hit a DB that only has the legacy 2-arg SECURITY DEFINER
    // function. Fall back for that sweep only: viewer/warming/drain reaping stays
    // active, dead-turn-holder reaping is skipped until migration 0044 lands.
    if ((error as { code?: unknown })?.code !== "42883") {
      throw error;
    }
    if (!loggedLegacyReapFunctionFallback) {
      loggedLegacyReapFunctionFallback = true;
      console.warn(
        "sandbox lease global reaper: 3-arg reap_sandbox_leases missing; falling back to legacy 2-arg sweep",
      );
    }
    rows = await rawRows<{
      workspace_id: string;
      sandbox_group_id: string;
      instance_id: string | null;
      lease_epoch: number | string;
    }>(
      db,
      sql`
      select workspace_id, sandbox_group_id, instance_id, lease_epoch
      from opengeni_private.reap_sandbox_leases(${input.viewerHolderTtlMs}, ${input.idleGraceMs})
    `,
    );
  }
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    sandboxGroupId: r.sandbox_group_id,
    instanceId: r.instance_id,
    leaseEpoch: Number(r.lease_epoch),
  }));
}

// §2.2 (global) — the warm-meter read for the REAPER tick (P2.1). Returns one row
// per WARM viewer-only group (turn-held boxes are metered by the turn heartbeat,
// so they are EXCLUDED here — no double-meter). Cross-workspace via the
// SECURITY-DEFINER list fn (FORCE RLS would hide other workspaces from the scoped
// connection). DB-only read; the worker accrues per row via accrueWarmSeconds.
export interface MeterableWarmLease {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  leaseEpoch: number;
  backend: string;
}

export async function listMeterableWarmLeases(db: Database): Promise<MeterableWarmLease[]> {
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    sandbox_group_id: string;
    lease_epoch: number | string;
    backend: string;
  }>(
    db,
    sql`
    select account_id, workspace_id, sandbox_group_id, lease_epoch, backend
    from opengeni_private.list_meterable_warm_leases()
  `,
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    workspaceId: r.workspace_id,
    sandboxGroupId: r.sandbox_group_id,
    leaseEpoch: Number(r.lease_epoch),
    backend: r.backend,
  }));
}

export async function countQueuedTurns(db: Database): Promise<number> {
  const rows = await rawRows<{ count: number | string }>(
    db,
    sql`
    select opengeni_private.count_queued_turns() as count
  `,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function countSandboxLeasesByLiveness(
  db: Database,
): Promise<Record<SandboxLeaseLiveness, number>> {
  const counts: Record<SandboxLeaseLiveness, number> = {
    cold: 0,
    warming: 0,
    warm: 0,
    draining: 0,
  };
  const rows = await rawRows<{ liveness: SandboxLeaseLiveness; count: number | string }>(
    db,
    sql`
    select liveness, count
    from opengeni_private.count_sandbox_leases_by_liveness()
  `,
  );
  for (const row of rows) {
    if (row.liveness in counts) {
      counts[row.liveness] = Number(row.count);
    }
  }
  return counts;
}

export type CreditBalanceByAccount = {
  accountId: string;
  balanceMicros: number;
};

export async function listCreditBalancesByAccount(db: Database): Promise<CreditBalanceByAccount[]> {
  const rows = await rawRows<{ account_id: string; balance_micros: number | string }>(
    db,
    sql`
    select account_id, balance_micros
    from opengeni_private.credit_balance_by_account()
  `,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    balanceMicros: Number(row.balance_micros),
  }));
}

// Cross-workspace live Modal lease read for the provider-side orphan sweep. The
// SECURITY DEFINER function is the sanctioned RLS bypass; see migration 0036.
export async function listLiveModalSandboxLeaseAttributions(
  db: Database,
): Promise<LiveModalSandboxLeaseAttribution[]> {
  const rows = await rawRows<{
    lease_id: string;
    workspace_id: string;
    sandbox_group_id: string;
    instance_id: string | null;
    liveness: SandboxLeaseLiveness;
  }>(
    db,
    sql`
    select lease_id, workspace_id, sandbox_group_id, instance_id, liveness
    from opengeni_private.list_live_modal_sandbox_leases()
  `,
  );
  return rows.map((r) => ({
    leaseId: r.lease_id,
    workspaceId: r.workspace_id,
    sandboxGroupId: r.sandbox_group_id,
    instanceId: r.instance_id,
    liveness: r.liveness,
  }));
}

// §4.7 — explicit re-arm seam (D1). acquireLease already re-arms a draining
// lease inline; this is the standalone version for callers that learn a holder
// is wanted during the grace window without going through acquireLease first.
export async function reArmDrainingLease(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    leaseTtlMs: number;
  },
): Promise<{ rearmed: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'warm',
          expires_at = now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval,
          updated_at = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining'
        returning id
      `);
      return { rearmed: rows.length > 0 };
    },
  );
}

// §4.8 — the reaper's final teardown commit (D3). Called AFTER the caller issued
// the provider stop() on instance_id. CAS-guarded (draining AND refcount=0 AND
// lease_epoch=expected) so a late re-arm (D1) or a newer epoch that snuck in
// during teardown wins — wentCold:false means the box is still wanted and must
// NOT have been stopped (the caller checks this CAS before stop(), or re-reads).
export async function confirmDrainCold(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
  },
): Promise<{ wentCold: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // draining->cold: the box is terminated, so EVERY live-box field is cleared
      // (instance_id / data-plane URLs). resume_state, however, is NOT blindly
      // nulled — if the reaper PERSISTED a /workspace snapshot onto it
      // (persistDrainSnapshot folds the archive at resume_state.sessionState.
      // workspaceArchive BEFORE this CAS, in the SAME sweep), nulling it here would
      // immediately destroy the snapshot the next cold-restore must replay — the
      // file-persistence bug. So we PRESERVE a MINIMAL archive-only envelope
      // `{ backendId, sessionState: { workspaceArchive } }` (dropping the dead box's
      // providerState/sandboxId — the box is gone, resume-by-id would only fail) and
      // KEEP resume_backend_id so cold-restore knows which client to hydrate with.
      // No archive (a non-persisted drain, or a 'none'/tar config that stored none)
      // -> resume_state is nulled as before. The archive then rides the COLD lease's
      // resume_state until the next spawner reads + hydrates it; it is re-superseded
      // (GC'd) on the next drain and finally cleared on workspace teardown.
      const rows = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          data_plane_url = null, terminal_data_plane_url = null, updated_at = now(),
          resume_state = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then jsonb_build_object(
                'backendId', coalesce(resume_state ->> 'backendId', to_jsonb(resume_backend_id) #>> '{}'),
                -- Carry BOTH archives (+ the capture time) into the minimal cold
                -- envelope: the mid-session fallback (workspaceArchivePrev) was
                -- retained and never GC'd, so dropping it here would strand the
                -- provider snapshot AND lose the restore fallback across a
                -- drain/warming-death. strip_nulls omits prev/at when absent.
                'sessionState', jsonb_strip_nulls(jsonb_build_object(
                  'workspaceArchive', resume_state #> '{sessionState,workspaceArchive}',
                  'workspaceArchivePrev', resume_state #> '{sessionState,workspaceArchivePrev}',
                  'workspaceArchiveAt', resume_state #> '{sessionState,workspaceArchiveAt}')))
            else null
          end,
          resume_backend_id = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then resume_backend_id
            else null
          end
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining' and refcount = 0 and lease_epoch = ${input.expectedEpoch}
        returning id
      `);
      return { wentCold: rows.length > 0 };
    },
  );
}

// §4.8b — persist the /workspace snapshot archive onto the lease BEFORE the
// reaper terminates a drained box (sandbox-file-persistence). The reaper, after
// resuming the live box and capturing `session.persistWorkspace()` (a base64
// snapshot-ref / tar archive), CAS-folds it onto the lease's resume_state under
// the SAME epoch fence confirmDrainCold uses (draining AND refcount=0 AND
// lease_epoch=expected). Folding it into resume_state.sessionState.workspaceArchive
// means a later cold-restore (establishSandboxSessionFromEnvelope) reads it back
// off the same envelope it already deserializes, and confirmDrainCold's
// `resume_state = null` clears it on teardown for free (delete-on-teardown).
//
// When workspaceArchive is null this function acts as a PURE CAS-GATE: it checks
// (draining AND refcount=0 AND epoch=expected) under a FOR UPDATE lock and returns
// wrote:true/false WITHOUT writing anything. This allows the reaper to guard a
// terminate that produced no archive (a backend with no persistWorkspace) against
// the re-arm race: a re-arm during the snapshot window sets refcount>0 / liveness!=
// draining, so wrote:false → the reaper MUST NOT delete the box.
//
// Returns `{ wrote, priorArchive }`:
//   - wrote:false  -> the CAS missed (re-armed / newer epoch / vanished); the
//                     caller must NOT terminate (the box is wanted again). No GC.
//   - priorArchive -> the archive THIS lease carried before (if any), so the
//                     caller can best-effort delete the superseded provider
//                     snapshot (keep-latest-per-lease GC). null on the first
//                     persist for this box or when workspaceArchive is null.
// The fence is the split-brain guard: a stale-epoch reaper writes ZERO rows and
// is told not to terminate.
export async function persistDrainSnapshot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    /** base64 of the provider snapshot-ref / tar archive from persistWorkspace().
     *  Pass null to CAS-check without writing (for backends with no persistWorkspace). */
    workspaceArchive: string | null;
  },
): Promise<{ wrote: boolean; priorArchive: string | null; priorArchivePrev: string | null }> {
  // withRlsContext already runs `fn` inside ONE transaction with the RLS GUCs set,
  // so the SELECT...FOR UPDATE + UPDATE below are atomic (one snapshot, one lock)
  // WITHOUT an extra nested savepoint — nesting a second transaction here under
  // the RLS-scoped connection wedges the postgres-js client ("Failed query").
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // (1) Lock + read the PRIOR archive under the CAS guard (draining AND
      // refcount=0 AND lease_epoch=expected). A miss (re-armed / newer epoch /
      // vanished) returns no row → wrote:false, the caller must NOT terminate.
      const guard = await scopedDb.execute<{
        prior_archive: string | null;
        prior_archive_prev: string | null;
      }>(sql`
        select
          resume_state #>> '{sessionState,workspaceArchive}' as prior_archive,
          resume_state #>> '{sessionState,workspaceArchivePrev}' as prior_archive_prev
        from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining' and refcount = 0 and lease_epoch = ${input.expectedEpoch}
        for update
      `);
      if (guard.length === 0) {
        return { wrote: false, priorArchive: null, priorArchivePrev: null };
      }
      const priorArchive = guard[0]!.prior_archive ?? null;
      const priorArchivePrev = guard[0]!.prior_archive_prev ?? null;
      // null workspaceArchive = pure CAS-check (re-arm guard for no-archive backends).
      // The FOR UPDATE lock above is the only synchronization needed; no write.
      if (input.workspaceArchive === null) {
        return { wrote: true, priorArchive: null, priorArchivePrev: null };
      }
      await foldWorkspaceArchiveOntoLease(scopedDb, {
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        expectedEpoch: input.expectedEpoch,
        workspaceArchive: input.workspaceArchive,
        livenessGuard: "draining",
        clearPreviousArchive: true,
      });
      return { wrote: true, priorArchive, priorArchivePrev };
    },
  );
}

/**
 * The ONE archive-fold write, shared by the drain seam (persistDrainSnapshot)
 * and the mid-session seam (persistWarmSnapshot) — the two differ only in
 * their CAS guard (draining@refcount0 vs warm) and their read-side semantics.
 *
 * Merges the NEW archive (+ its workspaceArchiveAt timestamp, the throttle
 * baseline for mid-session snapshots) into resume_state.sessionState.
 * jsonb_set's create_missing does NOT create intermediate objects, so a direct
 * set of '{sessionState,workspaceArchive}' is a silent no-op when
 * `sessionState` is absent (a null resume_state, or a legacy flat envelope).
 * Instead: rebuild `sessionState` as (existing sessionState OR '{}') merged
 * (||) with the fold — this CREATES sessionState if absent AND preserves its
 * existing siblings (providerState/manifest/exposedPorts). The archive is
 * bound as a jsonb string scalar (to_jsonb(text)). Re-asserting the caller's
 * CAS guard keeps the write atomic with its FOR UPDATE lock.
 */
async function foldWorkspaceArchiveOntoLease(
  scopedDb: Database,
  input: {
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    workspaceArchive: string;
    livenessGuard: "draining" | "warm";
    priorCurrentArchive?: string | null;
    clearPreviousArchive?: boolean;
    /** The wall-clock (ISO) this archive's capture STARTED. Stamped as
     *  workspaceArchiveAt so warm-snapshot ordering is by capture-initiation, not
     *  land time — a late, older capture is superseded (persistWarmSnapshot's
     *  monotonic guard). Absent (drain) → now(). */
    archiveAtIso?: string;
  },
): Promise<void> {
  const livenessGuard =
    input.livenessGuard === "draining"
      ? sql`liveness = 'draining' and refcount = 0`
      : sql`liveness = 'warm'`;
  const archiveAt = input.archiveAtIso
    ? sql`to_jsonb(${input.archiveAtIso}::text)`
    : sql`to_jsonb(now()::timestamptz::text)`;
  await scopedDb.execute(sql`
    update sandbox_leases set
      resume_state = jsonb_set(
        -- Defensive: only treat resume_state / its sessionState as an object
        -- when it actually IS one; a null/scalar (legacy or malformed envelope)
        -- starts from '{}' so jsonb_set never throws "cannot set path in scalar".
        case when jsonb_typeof(resume_state) = 'object' then resume_state else '{}'::jsonb end,
        '{sessionState}',
        jsonb_strip_nulls(
          (case when jsonb_typeof(resume_state -> 'sessionState') = 'object'
                then resume_state -> 'sessionState' else '{}'::jsonb end)
            || jsonb_build_object(
              'workspaceArchive', to_jsonb(${input.workspaceArchive}::text),
              'workspaceArchiveAt', ${archiveAt},
              'workspaceArchivePrev', case
                when ${input.clearPreviousArchive ? "yes" : "no"}::text = 'yes' then null::jsonb
                when ${input.priorCurrentArchive ?? null}::text is null then null::jsonb
                else to_jsonb(${input.priorCurrentArchive ?? null}::text)
              end
            )
        ),
        true
      ),
      updated_at = now()
    where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
      and ${livenessGuard} and lease_epoch = ${input.expectedEpoch}
  `);
}

/**
 * MID-SESSION /workspace snapshot fold (sandbox-file-persistence). The WARM
 * sibling of persistDrainSnapshot: a turn that HOLDS the live box folds a fresh
 * snapshot onto its own lease without draining anything. Guarded by
 * `liveness='warm' AND lease_epoch=expected` — a drain/re-create that raced in
 * (different liveness or newer epoch) writes ZERO rows → wrote:false, and the
 * caller simply skips (the snapshot belonged to a box the lease no longer
 * tracks). `workspaceArchiveAt` rides the same sessionState merge so the
 * throttle re-check here is ATOMIC with the write — two concurrent holders
 * cannot double-snapshot inside one interval.
 */
export async function persistWarmSnapshot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    /** base64 of the provider snapshot-ref / tar archive from persistWorkspace(). */
    workspaceArchive: string;
    /** Snapshots newer than this many ms are kept (throttle); 0 = always write. */
    minIntervalMs: number;
    /** Wall-clock (ms) this capture STARTED. Ordering is by capture-initiation,
     *  NOT land time: a capture that started at or before the archive already on
     *  the lease is SUPERSEDED (a stale heartbeat capture that timed out its wait
     *  and landed late must never overwrite a fresher turn-end snapshot or refresh
     *  the throttle clock). Defaults to Date.now() for legacy callers/tests. */
    capturedAtMs?: number;
  },
): Promise<{
  wrote: boolean;
  throttled: boolean;
  superseded: boolean;
  priorArchiveForGc: string | null;
}> {
  const capturedAtMs = input.capturedAtMs ?? Date.now();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // Serialize with control acceptance before touching resume state. Either
      // this exact attempt snapshot commits first, or Pause/Steer commits its
      // interruption first and the late snapshot becomes a no-op. An in-process
      // AbortSignal cannot close this database race.
      await lockWorkspaceInferenceControl(scopedDb, input.workspaceId, "share");
      const [attempt] = await scopedDb
        .select({
          accountId: schema.sessionTurnAttempts.accountId,
          state: schema.sessionTurnAttempts.state,
          outcome: schema.sessionTurnAttempts.outcome,
        })
        .from(schema.sessionTurnAttempts)
        .where(
          and(
            eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
            eq(schema.sessionTurnAttempts.sessionId, input.sessionId),
            eq(schema.sessionTurnAttempts.turnId, input.turnId),
            eq(schema.sessionTurnAttempts.id, input.attemptId),
          ),
        )
        .limit(1);
      const [interruption] = attempt
        ? await scopedDb
            .select({ id: schema.sessionAttemptInterruptions.id })
            .from(schema.sessionAttemptInterruptions)
            .where(
              and(
                eq(schema.sessionAttemptInterruptions.workspaceId, input.workspaceId),
                eq(schema.sessionAttemptInterruptions.sessionId, input.sessionId),
                eq(schema.sessionAttemptInterruptions.attemptId, input.attemptId),
              ),
            )
            .limit(1)
        : [];
      const attemptMayPersistWorkspace =
        attempt !== undefined &&
        (attempt.state === "claimed" || attempt.state === "running"
          ? attempt.outcome === null
          : attempt.state === "closed" &&
            (attempt.outcome === "completed" ||
              attempt.outcome === "failed" ||
              attempt.outcome === "requires_action"));
      if (
        !attempt ||
        attempt.accountId !== input.accountId ||
        interruption ||
        !attemptMayPersistWorkspace
      ) {
        return { wrote: false, throttled: false, superseded: true, priorArchiveForGc: null };
      }
      const guard = await scopedDb.execute<{
        prior_archive: string | null;
        prior_archive_prev: string | null;
        prior_archive_at: string | null;
      }>(sql`
        select
          resume_state #>> '{sessionState,workspaceArchive}' as prior_archive,
          resume_state #>> '{sessionState,workspaceArchivePrev}' as prior_archive_prev,
          resume_state #>> '{sessionState,workspaceArchiveAt}' as prior_archive_at
        from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warm' and lease_epoch = ${input.expectedEpoch}
        for update
      `);
      if (guard.length === 0) {
        return { wrote: false, throttled: false, superseded: false, priorArchiveForGc: null };
      }
      const priorArchive = guard[0]!.prior_archive ?? null;
      const priorArchivePrev = guard[0]!.prior_archive_prev ?? null;
      const priorAtMs = guard[0]!.prior_archive_at
        ? Date.parse(guard[0]!.prior_archive_at)
        : Number.NaN;
      // MONOTONIC guard: a capture whose start is at/before the stored archive's
      // capture is stale (a slower-but-earlier heartbeat capture landing after a
      // fresher turn-end one). No-op — do NOT overwrite and do NOT advance the
      // throttle clock. This is what makes the bounded snapshot wait safe.
      if (Number.isFinite(priorAtMs) && capturedAtMs <= priorAtMs) {
        return { wrote: false, throttled: false, superseded: true, priorArchiveForGc: null };
      }
      if (
        input.minIntervalMs > 0 &&
        Number.isFinite(priorAtMs) &&
        capturedAtMs - priorAtMs < input.minIntervalMs
      ) {
        return { wrote: false, throttled: true, superseded: false, priorArchiveForGc: null };
      }
      await foldWorkspaceArchiveOntoLease(scopedDb, {
        workspaceId: input.workspaceId,
        sandboxGroupId: input.sandboxGroupId,
        expectedEpoch: input.expectedEpoch,
        workspaceArchive: input.workspaceArchive,
        livenessGuard: "warm",
        priorCurrentArchive: priorArchive,
        archiveAtIso: new Date(capturedAtMs).toISOString(),
      });
      return {
        wrote: true,
        throttled: false,
        superseded: false,
        priorArchiveForGc: priorArchivePrev,
      };
    },
  );
}

export async function getMaterializedSandboxFileResources(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    instanceId: string;
  },
): Promise<Set<string>> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{ file_ids: unknown }>(sql`
        select coalesce(
          jsonb_path_query_array(
            resume_state,
            '$.opengeniFileMaterialization[*] ? (@.instanceId == $instanceId).fileIds[*]',
            jsonb_build_object('instanceId', to_jsonb(${input.instanceId}::text))
          ),
          '[]'::jsonb
        ) as file_ids
        from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warm' and lease_epoch = ${input.expectedEpoch}
          and instance_id = ${input.instanceId}
        limit 1
      `);
      const raw = rows[0]?.file_ids;
      const values = Array.isArray(raw) ? raw : [];
      return new Set(values.filter((value): value is string => typeof value === "string"));
    },
  );
}

export async function markSandboxFileResourcesMaterialized(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    instanceId: string;
    fileIds: string[];
  },
): Promise<{ wrote: boolean }> {
  const fileIds = [...new Set(input.fileIds.filter((fileId) => fileId.length > 0))];
  if (fileIds.length === 0) {
    return { wrote: false };
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_leases set
          resume_state = jsonb_set(
            case when jsonb_typeof(resume_state) = 'object' then resume_state else '{}'::jsonb end,
            '{opengeniFileMaterialization}',
            (
              select jsonb_agg(entry order by entry ->> 'instanceId')
              from (
                select jsonb_build_object(
                  'instanceId', ${input.instanceId}::text,
                  'fileIds', (
                    select jsonb_agg(distinct value order by value)
                    from jsonb_array_elements_text(
                      coalesce(
                        (
                          select existing -> 'fileIds'
                          from jsonb_array_elements(coalesce(resume_state -> 'opengeniFileMaterialization', '[]'::jsonb)) existing
                          where existing ->> 'instanceId' = ${input.instanceId}
                          limit 1
                        ),
                        '[]'::jsonb
                      )
                      || ${JSON.stringify(fileIds)}::jsonb
                    ) as merged(value)
                  )
                ) as entry
                union all
                select existing as entry
                from jsonb_array_elements(coalesce(resume_state -> 'opengeniFileMaterialization', '[]'::jsonb)) existing
                where existing ->> 'instanceId' <> ${input.instanceId}
              ) entries
            ),
            true
          ),
          updated_at = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warm' and lease_epoch = ${input.expectedEpoch}
          and instance_id = ${input.instanceId}
        returning id
      `);
      return { wrote: rows.length > 0 };
    },
  );
}

// ═══════════════ Workbench v2 turn-end workspace capture (dossier §10.2) ═══════
// The durable index for turn-end workspace captures. `insertWorkspaceCapture`
// mirrors persistWarmSnapshot's epoch-CAS discipline and also requires the exact
// closed, uninterrupted turn attempt. A cancelled attempt or superseded lease
// writes ZERO rows. `revision` is explicit and unique on (session_id, revision).

export type WorkspaceCaptureRow = {
  id: string;
  sessionId: string;
  turnId: string | null;
  revision: number;
  leaseEpoch: number;
  state: string;
  manifestKey: string | null;
  treeIndexKey: string | null;
  blobKeys: string[];
  sizeBytes: number | null;
  stats: Record<string, unknown>;
  capturedAt: string;
};

export type WorkspaceCaptureCommitResult = {
  revision: number;
  events: SessionEvent[];
};

const WORKSPACE_CAPTURE_COLUMNS = sql`
  id, session_id, turn_id, revision, lease_epoch, state,
  manifest_key, tree_index_key, blob_keys, size_bytes, stats, captured_at
`;

function mapWorkspaceCaptureRow(row: {
  id: string;
  session_id: string;
  turn_id: string | null;
  revision: number | string;
  lease_epoch: number | string;
  state: string;
  manifest_key: string | null;
  tree_index_key: string | null;
  blob_keys: unknown;
  size_bytes: number | string | null;
  stats: unknown;
  captured_at: string | Date;
}): WorkspaceCaptureRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    revision: Number(row.revision),
    leaseEpoch: Number(row.lease_epoch),
    state: row.state,
    manifestKey: row.manifest_key,
    treeIndexKey: row.tree_index_key,
    blobKeys: Array.isArray(row.blob_keys) ? (row.blob_keys as string[]) : [],
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    stats: (row.stats && typeof row.stats === "object" ? row.stats : {}) as Record<string, unknown>,
    // postgres-js decodes `timestamptz` as a Date. Keep the public DB contract
    // canonical and driver-independent: capture manifests embed ISO strings and
    // the API compares this identity before it serves any blob.
    capturedAt:
      row.captured_at instanceof Date
        ? row.captured_at.toISOString()
        : new Date(row.captured_at).toISOString(),
  };
}

type CommitWorkspaceCaptureRevisionInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  sandboxGroupId: string;
  expectedEpoch: number;
  revision: number;
  state: "available" | "failed";
  manifestKey: string | null;
  treeIndexKey: string | null;
  blobKeys: string[];
  sizeBytes: number;
  stats: Record<string, unknown>;
  capturedAt?: Date;
};

/**
 * Commit the attempt/control/epoch-fenced capture index and its session-scoped
 * announcement as one durable transition. The announcement is metadata rather
 * than model output, so it has no current-turn association, but it still carries
 * the exact attempt/generation that produced the filesystem state.
 */
async function commitWorkspaceCaptureRevision(
  db: Database,
  input: CommitWorkspaceCaptureRevisionInput,
): Promise<WorkspaceCaptureCommitResult | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        // Match the canonical control/lifecycle lock order. A shared inference-
        // control lock makes acceptance of Pause/Steer and this commit mutually
        // ordered: either this revision commits first, or the control transaction
        // commits its exact attempt interruption first and the checks below reject
        // the late capture. Never rely on an in-process AbortSignal for that race.
        const [workspaceControl] = await tx
          .select({ workspaceId: schema.workspaceInferenceControls.workspaceId })
          .from(schema.workspaceInferenceControls)
          .where(eq(schema.workspaceInferenceControls.workspaceId, input.workspaceId))
          .for("share")
          .limit(1);
        if (!workspaceControl) {
          throw new Error(`Workspace control not found: ${input.workspaceId}`);
        }
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!session) throw new Error(`Session not found: ${input.sessionId}`);

        const [turn] = await tx
          .select({
            accountId: schema.sessionTurns.accountId,
            executionGeneration: schema.sessionTurns.executionGeneration,
            status: schema.sessionTurns.status,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          )
          .for("update")
          .limit(1);
        const [attempt] = turn
          ? await tx
              .select()
              .from(schema.sessionTurnAttempts)
              .where(
                and(
                  eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
                  eq(schema.sessionTurnAttempts.sessionId, input.sessionId),
                  eq(schema.sessionTurnAttempts.turnId, input.turnId),
                  eq(schema.sessionTurnAttempts.id, input.attemptId),
                ),
              )
              .for("update")
              .limit(1)
          : [];
        const [interruption] = attempt
          ? await tx
              .select({ id: schema.sessionAttemptInterruptions.id })
              .from(schema.sessionAttemptInterruptions)
              .where(
                and(
                  eq(schema.sessionAttemptInterruptions.workspaceId, input.workspaceId),
                  eq(schema.sessionAttemptInterruptions.sessionId, input.sessionId),
                  eq(schema.sessionAttemptInterruptions.attemptId, input.attemptId),
                ),
              )
              .limit(1)
          : [];
        if (
          !turn ||
          !attempt ||
          turn.accountId !== input.accountId ||
          attempt.accountId !== input.accountId ||
          attempt.executionGeneration !== turn.executionGeneration ||
          attempt.state !== "closed" ||
          (attempt.outcome !== "completed" &&
            attempt.outcome !== "failed" &&
            attempt.outcome !== "requires_action") ||
          interruption ||
          (turn.status !== "completed" &&
            turn.status !== "failed" &&
            turn.status !== "requires_action")
        ) {
          return null;
        }

        const capturedAt = input.capturedAt ?? new Date();
        const rows = await tx.execute<{ revision: number | string }>(sql`
          insert into workspace_captures
            (account_id, workspace_id, session_id, turn_id, revision, lease_epoch, state,
             manifest_key, tree_index_key, blob_keys, size_bytes, stats, captured_at)
          select
            ${input.accountId}, ${input.workspaceId}, ${input.sessionId}, ${input.turnId},
            ${input.revision}, ${input.expectedEpoch}, ${input.state},
            ${input.manifestKey}, ${input.treeIndexKey},
            ${JSON.stringify(input.blobKeys)}::jsonb, ${input.sizeBytes},
            ${JSON.stringify(input.stats)}::jsonb, ${capturedAt.toISOString()}::timestamptz
          where exists (
            select 1 from sandbox_leases
            where workspace_id = ${input.workspaceId}
              and sandbox_group_id = ${input.sandboxGroupId}
              and lease_epoch = ${input.expectedEpoch}
          )
          returning revision
        `);
        const [capture] = rows;
        if (!capture) return null;

        const revision = Number(capture.revision);
        const type: SessionEventType =
          input.state === "available"
            ? "workspace.revision.captured"
            : "workspace.revision.degraded";
        const payload =
          input.state === "available"
            ? {
                revision,
                turnId: input.turnId,
                capturedAt: capturedAt.toISOString(),
                leaseEpoch: input.expectedEpoch,
                stats: input.stats,
              }
            : {
                revision,
                turnId: input.turnId,
                capturedAt: capturedAt.toISOString(),
                leaseEpoch: input.expectedEpoch,
                reason:
                  typeof input.stats.degradedReason === "string"
                    ? input.stats.degradedReason
                    : "repository_discovery_command_failed",
              };
        const [event] = await tx
          .insert(schema.sessionEvents)
          .values({
            accountId: session.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            sequence: session.lastSequence + 1,
            type,
            payload: sanitizeEventPayload(payload),
            clientEventId: `opengeni:workspace-capture:${revision}`,
            turnId: input.turnId,
            turnGeneration: attempt.executionGeneration,
            turnAttemptId: attempt.id,
            turnAssociation: null,
            duplicateOfEventId: null,
            duplicateReason: null,
            producerId: "workspace-capture",
            producerSeq: revision,
            occurredAt: capturedAt,
          })
          .returning();
        if (!event) throw new Error("Workspace capture announcement was not inserted");
        await tx
          .update(schema.sessions)
          .set({ lastSequence: event.sequence, updatedAt: new Date() })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );
        return { revision, events: [mapEvent(event)] };
      }),
  );
}

/**
 * Fenced insert of a capture revision at an EXPLICIT revision (the caller
 * assigns it as prevRevision+1 so the manifest blob — written before this insert
 * — can embed the same number). Writes ONLY when a warm lease with the expected
 * epoch still exists for the sandbox group (the same supersession guard
 * persistWarmSnapshot uses, expressed as an EXISTS on sandbox_leases). Returns
 * the assigned revision, or null when the fence rejected the write (interrupted
 * attempt, cancelled/superseded turn, or released/superseded lease). Captures for
 * one session are serialized (one turn at a time), so the explicit revision never
 * races the unique (session_id, revision) index.
 */
export async function insertWorkspaceCapture(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    revision: number;
    manifestKey: string;
    treeIndexKey: string;
    blobKeys: string[];
    sizeBytes: number;
    stats: Record<string, unknown>;
    capturedAt?: Date;
  },
): Promise<WorkspaceCaptureCommitResult | null> {
  return await commitWorkspaceCaptureRevision(db, {
    ...input,
    state: "available",
  });
}

/**
 * Persist an epoch-fenced degraded capture marker.
 *
 * Repository discovery is part of the capture's authority boundary: if the
 * platform cannot prove discovery completed, it must not publish an
 * authoritative-looking `available` capture with zero repositories. The
 * marker deliberately has no manifest/blob keys, so readers fall back to the
 * live box while still receiving an explicit degraded reason.
 */
export async function insertFailedWorkspaceCapture(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    revision: number;
    stats: Record<string, unknown>;
    capturedAt?: Date;
  },
): Promise<WorkspaceCaptureCommitResult | null> {
  return await commitWorkspaceCaptureRevision(db, {
    ...input,
    state: "failed",
    manifestKey: null,
    treeIndexKey: null,
    blobKeys: [],
    sizeBytes: 0,
  });
}

/** The newest capture for a session (highest revision), or null if none. */
export async function latestWorkspaceCapture(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<WorkspaceCaptureRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<Parameters<typeof mapWorkspaceCaptureRow>[0]>(sql`
      select ${WORKSPACE_CAPTURE_COLUMNS} from workspace_captures
      where session_id = ${sessionId}
      order by revision desc
      limit 1
    `);
    return rows.length ? mapWorkspaceCaptureRow(rows[0]!) : null;
  });
}

/** A specific capture revision for a session (the M2 file route with an explicit
 *  `?revision=`), or null if that revision was never captured / already GC'd. */
export async function workspaceCaptureAtRevision(
  db: Database,
  workspaceId: string,
  sessionId: string,
  revision: number,
): Promise<WorkspaceCaptureRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<Parameters<typeof mapWorkspaceCaptureRow>[0]>(sql`
      select ${WORKSPACE_CAPTURE_COLUMNS} from workspace_captures
      where session_id = ${sessionId} and revision = ${revision}
      limit 1
    `);
    return rows.length ? mapWorkspaceCaptureRow(rows[0]!) : null;
  });
}

/**
 * Plan the keep-latest-N GC for a session. Pure read + set-difference (no
 * mutation): returns the evicted rows' ids, the per-revision manifest/tree blob
 * keys (unshared — always deletable), and the after-image blob keys owned ONLY
 * by evicted revisions (union(evicted) minus union(surviving) — a content-
 * addressed blob shared with a surviving revision is NEVER deleted). The caller
 * deletes storage first (idempotent), then deletes the rows (F9 ordering — the
 * new revision is already committed by the time GC runs).
 */
export type WorkspaceCaptureGcRow = {
  id: string;
  manifestKey: string | null;
  treeIndexKey: string | null;
  blobKeys: string[];
};
export type WorkspaceCaptureGcPlan = {
  evictedRowIds: string[];
  deleteBlobKeys: string[];
  deletePerRevisionKeys: string[];
};

/**
 * Pure keep-latest-N set-difference (extracted for direct unit testing). `rows`
 * MUST be ordered newest-revision-first. The first keepN survive; the rest are
 * evicted. A content-addressed after-image blob key owned by an evicted revision
 * is deleted ONLY when NO surviving revision also references it (shared blobs are
 * never deleted); per-revision manifest/tree keys are unshared → always deleted.
 */
export function computeWorkspaceCaptureGcPlan(
  rows: WorkspaceCaptureGcRow[],
  keepN: number,
): WorkspaceCaptureGcPlan {
  const survivors = rows.slice(0, Math.max(0, keepN));
  const evicted = rows.slice(Math.max(0, keepN));
  const survivingBlobKeys = new Set<string>();
  for (const r of survivors) for (const k of r.blobKeys) survivingBlobKeys.add(k);
  const deleteBlobKeys = new Set<string>();
  const deletePerRevisionKeys: string[] = [];
  const evictedRowIds: string[] = [];
  for (const r of evicted) {
    evictedRowIds.push(r.id);
    if (r.manifestKey) deletePerRevisionKeys.push(r.manifestKey);
    if (r.treeIndexKey) deletePerRevisionKeys.push(r.treeIndexKey);
    for (const k of r.blobKeys) if (!survivingBlobKeys.has(k)) deleteBlobKeys.add(k);
  }
  return { evictedRowIds, deleteBlobKeys: [...deleteBlobKeys], deletePerRevisionKeys };
}

export async function planWorkspaceCaptureGc(
  db: Database,
  input: { workspaceId: string; sessionId: string; keepN: number },
): Promise<WorkspaceCaptureGcPlan> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<{
      id: string;
      revision: number | string;
      manifest_key: string | null;
      tree_index_key: string | null;
      blob_keys: unknown;
    }>(sql`
      select id, revision, manifest_key, tree_index_key, blob_keys
      from workspace_captures
      where session_id = ${input.sessionId}
      order by revision desc
    `);
    return computeWorkspaceCaptureGcPlan(
      rows.map(
        (r: {
          id: string;
          manifest_key: string | null;
          tree_index_key: string | null;
          blob_keys: unknown;
        }) => ({
          id: r.id,
          manifestKey: r.manifest_key,
          treeIndexKey: r.tree_index_key,
          blobKeys: Array.isArray(r.blob_keys) ? (r.blob_keys as string[]) : [],
        }),
      ),
      input.keepN,
    );
  });
}

/** Delete evicted capture rows by id (call AFTER their storage blobs are gone). */
export async function deleteWorkspaceCaptureRows(
  db: Database,
  input: { workspaceId: string; rowIds: string[] },
): Promise<number> {
  if (input.rowIds.length === 0) return 0;
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const result = await scopedDb.execute<{ id: string }>(sql`
      delete from workspace_captures
      where id in (${sql.join(
        input.rowIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      returning id
    `);
    return result.length;
  });
}

// §4.9 — non-locking snapshot for the API handshake & health.
export async function readLease(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
): Promise<LeaseSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<LeaseRow>(sql`
      select * from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}
      limit 1
    `);
    return rows[0] ? mapLeaseRow(rows[0]) : null;
  });
}

// P4.2 — record the (re-)resolved desktop data-plane URL on an ALREADY-WARM
// lease, EPOCH-FENCED. commitWarmingToWarm records the URL at cold→warming→warm
// (the spawn path); this is the WARM-path counterpart used when a viewer mints
// the URL against a box that some other holder already brought up, and on
// rollover-rotation (re-resolve under the current epoch). The fence is the
// split-brain guard: a stale-epoch writer (a box re-established under a newer
// epoch) updates ZERO rows and the caller backs off. Returns the updated
// snapshot, or null on a fence miss (epoch advanced / lease vanished).
export async function recordLeaseDataPlaneUrl(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    dataPlaneUrl: string | null;
  },
): Promise<LeaseSnapshot | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          data_plane_url = ${input.dataPlaneUrl ?? null},
          updated_at     = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and lease_epoch = ${input.expectedEpoch}
          and liveness in ('warm', 'draining')
        returning *
      `);
      return rows[0] ? mapLeaseRow(rows[0]) : null;
    },
  );
}

// P5.t — record the (re-)resolved ttyd terminal data-plane URL (7681) on an
// ALREADY-WARM lease, EPOCH-FENCED. The exact terminal twin of
// recordLeaseDataPlaneUrl: the REAL PTY rides a SEPARATE provider tunnel from the
// desktop noVNC, so its URL is cached in its own column. mintTerminalStream calls
// this after resolving the 7681 tunnel; the fast-path then re-mints only a fresh
// token against the cached URL. The fence is the split-brain guard (a stale-epoch
// writer updates ZERO rows). Returns the updated snapshot, or null on a fence
// miss (epoch advanced / lease vanished).
export async function recordLeaseTerminalDataPlaneUrl(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    expectedEpoch: number;
    terminalDataPlaneUrl: string | null;
  },
): Promise<LeaseSnapshot | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          terminal_data_plane_url = ${input.terminalDataPlaneUrl ?? null},
          updated_at              = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and lease_epoch = ${input.expectedEpoch}
          and liveness in ('warm', 'draining')
        returning *
      `);
      return rows[0] ? mapLeaseRow(rows[0]) : null;
    },
  );
}

// ============================================================================
// Bring-your-own-compute (M2): first-class swappable sandboxes + enrollment +
// per-machine metrics + the per-session epoch-fenced active-sandbox pointer
// (migration 0024 / dossier §10.3 + §10.7 + §23). All workspace-scoped behind
// the same RLS the lease DAOs use.
// ============================================================================

export type SandboxKind = (typeof schema.sandboxKindValues)[number];
export type EnrollmentExposure = (typeof schema.enrollmentExposureValues)[number];
export type EnrollmentStatus = (typeof schema.enrollmentStatusValues)[number];
export type EnrollmentOs = (typeof schema.enrollmentOsValues)[number];

export type EnrollmentRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  pubkey: string;
  exposure: EnrollmentExposure;
  hasDisplay: boolean;
  opStream: boolean;
  /** Set when a display exists but capture is not permitted (macOS Screen Recording
   *  not granted); null when capture is permitted or the machine is headless. */
  desktopUnavailableReason: string | null;
  allowScreenControl: boolean;
  status: EnrollmentStatus;
  credentialGeneration: number;
  os: EnrollmentOs;
  arch: string;
  lastSeenAt: string | null;
  /** When the machine announced a clean GoingOffline; the liveness derivation reads
   *  an un-cleared marker as offline immediately. NULL ⇒ no goodbye pending. */
  wentOfflineAt: string | null;
  /** The typed reason string of the pending clean going-offline (e.g.
   *  GOING_OFFLINE_REASON_UPDATE); NULL when there is no un-cleared marker. */
  wentOfflineReason: string | null;
  createdAt: string;
  revokedAt: string | null;
  updatedAt: string;
};

function mapEnrollment(row: typeof schema.enrollments.$inferSelect): EnrollmentRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    pubkey: row.pubkey,
    exposure: row.exposure as EnrollmentExposure,
    hasDisplay: row.hasDisplay,
    opStream: row.opStream,
    desktopUnavailableReason: row.desktopUnavailableReason ?? null,
    allowScreenControl: row.allowScreenControl,
    status: row.status as EnrollmentStatus,
    credentialGeneration: Number(row.credentialGeneration),
    os: row.os as EnrollmentOs,
    arch: row.arch,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    wentOfflineAt: row.wentOfflineAt ? row.wentOfflineAt.toISOString() : null,
    wentOfflineReason: row.wentOfflineReason ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type SandboxRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  kind: SandboxKind;
  name: string;
  enrollmentId: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapSandbox(row: typeof schema.sandboxes.$inferSelect): SandboxRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    kind: row.kind as SandboxKind,
    name: row.name,
    enrollmentId: row.enrollmentId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- enrollments ----------------------------------------------------------

// Register (or idempotently re-register) a machine. A re-enroll of the SAME
// (workspace, pubkey) is an UPSERT — it refreshes the consent/OS fields and, if
// the machine was previously revoked, re-activates it (status->active, revoked_at
// cleared) — never a duplicate machine row. Every conflict is a fresh
// re-enrollment and atomically advances credential_generation, invalidating every
// older bearer. The agent's ed25519 pubkey is the machine identity; the unique
// (workspace, pubkey) index is the conflict target.
export async function createEnrollment(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    pubkey: string;
    exposure?: EnrollmentExposure;
    hasDisplay?: boolean;
    allowScreenControl?: boolean;
    os?: EnrollmentOs;
    arch?: string;
  },
): Promise<EnrollmentRecord> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.enrollments)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          pubkey: input.pubkey,
          exposure: input.exposure ?? "whole-machine",
          hasDisplay: input.hasDisplay ?? false,
          allowScreenControl: input.allowScreenControl ?? false,
          os: input.os ?? "linux",
          arch: input.arch ?? "x86_64",
          status: "active",
        })
        .onConflictDoUpdate({
          target: [schema.enrollments.workspaceId, schema.enrollments.pubkey],
          set: {
            exposure: input.exposure ?? "whole-machine",
            hasDisplay: input.hasDisplay ?? false,
            allowScreenControl: input.allowScreenControl ?? false,
            os: input.os ?? "linux",
            arch: input.arch ?? "x86_64",
            // A re-enroll re-activates a previously revoked machine.
            status: "active",
            revokedAt: null,
            credentialGeneration: sql`${schema.enrollments.credentialGeneration} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create enrollment");
      }
      return mapEnrollment(row);
    },
  );
}

export async function getEnrollment(
  db: Database,
  workspaceId: string,
  enrollmentId: string,
): Promise<EnrollmentRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.workspaceId, workspaceId),
          eq(schema.enrollments.id, enrollmentId),
        ),
      )
      .limit(1);
    return row ? mapEnrollment(row) : null;
  });
}

/**
 * Runs a short credential-mint callback while holding a shared row lock on one
 * exact active enrollment generation. Revocation and re-enrollment both update
 * this row, so they must either commit before the guarded read (the callback is
 * skipped) or wait until the callback has minted and the transaction commits.
 * This gives self-refresh a real linearization point instead of allowing a
 * stateless relay token to be minted after a concurrent revoke committed.
 */
export async function withActiveEnrollmentGeneration<T>(
  db: Database,
  input: {
    workspaceId: string;
    enrollmentId: string;
    credentialGeneration: number;
  },
  fn: (enrollment: EnrollmentRecord) => Promise<T>,
): Promise<{ matched: false } | { matched: true; value: T }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.workspaceId, input.workspaceId),
          eq(schema.enrollments.id, input.enrollmentId),
          eq(schema.enrollments.status, "active"),
          eq(schema.enrollments.credentialGeneration, input.credentialGeneration),
        ),
      )
      .for("share")
      .limit(1);
    if (!row) {
      return { matched: false };
    }
    return { matched: true, value: await fn(mapEnrollment(row)) };
  });
}

// List a workspace's enrollments, newest first. `status` filters the lifecycle
// (omit for all; 'active' for the Machines dashboard's live list).
export async function listEnrollments(
  db: Database,
  workspaceId: string,
  options: { status?: EnrollmentStatus } = {},
): Promise<EnrollmentRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const where = options.status
      ? and(
          eq(schema.enrollments.workspaceId, workspaceId),
          eq(schema.enrollments.status, options.status),
        )
      : eq(schema.enrollments.workspaceId, workspaceId);
    const rows = await scopedDb
      .select()
      .from(schema.enrollments)
      .where(where)
      .orderBy(desc(schema.enrollments.createdAt));
    return rows.map(mapEnrollment);
  });
}

// Revoke a machine (uninstall --purge / dashboard revoke). Idempotent: an already
// -revoked row is a no-op (revoked:false). status->revoked, revoked_at stamped.
// The same transaction clears every session pointer targeting this enrollment and
// advances its epoch, so no agent-facing route can keep treating a revoked machine
// as active after the revoke commits.
export async function revokeEnrollment(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
  },
): Promise<{ revoked: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.enrollments)
        .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.id, input.enrollmentId),
            eq(schema.enrollments.status, "active"),
          ),
        )
        .returning({ id: schema.enrollments.id });
      if (rows.length > 0) {
        await invalidateEnrollmentSessionPointers(scopedDb, {
          workspaceId: input.workspaceId,
          enrollmentId: input.enrollmentId,
        });
      }
      return { revoked: rows.length > 0 };
    },
  );
}

// Self-revoke is credential-family scoped, unlike the administrator revoke above.
// The row is locked before checking generation/status so a concurrent re-enroll
// cannot slip between validation and mutation. A revoked row is an idempotent
// success only for the SAME generation (lost-response retry); an old bearer after
// re-enrollment returns matched:false and cannot revoke the new credential family.
export async function revokeEnrollmentByGeneration(
  db: Database,
  input: {
    workspaceId: string;
    enrollmentId: string;
    credentialGeneration: number;
  },
): Promise<{ matched: boolean; revoked: boolean }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        status: schema.enrollments.status,
        credentialGeneration: schema.enrollments.credentialGeneration,
      })
      .from(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.workspaceId, input.workspaceId),
          eq(schema.enrollments.id, input.enrollmentId),
        ),
      )
      .for("update")
      .limit(1);
    if (!row || Number(row.credentialGeneration) !== input.credentialGeneration) {
      return { matched: false, revoked: false };
    }
    if (row.status === "revoked") {
      return { matched: true, revoked: false };
    }
    if (row.status !== "active") {
      return { matched: false, revoked: false };
    }
    const updated = await scopedDb
      .update(schema.enrollments)
      .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.enrollments.workspaceId, input.workspaceId),
          eq(schema.enrollments.id, input.enrollmentId),
          eq(schema.enrollments.status, "active"),
          eq(schema.enrollments.credentialGeneration, input.credentialGeneration),
        ),
      )
      .returning({ id: schema.enrollments.id });
    if (updated.length !== 1) {
      throw new Error("Enrollment generation changed while row lock was held");
    }
    await invalidateEnrollmentSessionPointers(scopedDb, {
      workspaceId: input.workspaceId,
      enrollmentId: input.enrollmentId,
    });
    return { matched: true, revoked: true };
  });
}

async function invalidateEnrollmentSessionPointers(
  scopedDb: Pick<Database, "execute">,
  input: { workspaceId: string; enrollmentId: string },
): Promise<void> {
  await scopedDb.execute(sql`
    update sessions
       set active_sandbox_id = null,
           active_epoch = active_epoch + 1,
           updated_at = now()
     where workspace_id = ${input.workspaceId}
       and active_sandbox_id in (
         select id
           from sandboxes
          where workspace_id = ${input.workspaceId}
            and enrollment_id = ${input.enrollmentId}
       )
  `);
}

// Heartbeat liveness cursor: the agent reports it is alive. last_seen_at is read
// by the online/reconnecting/offline derivation in the Machines surface.
//
// A fresh heartbeat is also the definitive "the machine is alive NOW" signal, so
// it CLEARS any pending clean going-offline marker in the SAME update: a machine
// that said goodbye but is heartbeating again is not offline. went_offline_at /
// went_offline_reason go back to NULL alongside the last_seen bump (unconditional —
// this update always fires on a heartbeat, so a set marker never outlives the next
// heartbeat).
export async function touchEnrollmentLastSeen(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .update(schema.enrollments)
        .set({
          lastSeenAt: new Date(),
          wentOfflineAt: null,
          wentOfflineReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.id, input.enrollmentId),
          ),
        );
    },
  );
}

// Record a CLEAN going-offline: the machine announced a typed GoingOffline
// (user-stop / self-update / host-shutdown). Stamps went_offline_at = now() +
// the typed reason so the liveness derivation reads the machine OFFLINE
// immediately (an un-cleared marker beats last_seen aging), for the dashboard AND
// for anything deciding whether to route work at it. Deliberately does NOT touch
// last_seen — a shutdown must not look "more recently alive". An unknown enrollment
// is a no-op (no row → no write).
export async function setEnrollmentWentOffline(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    reason: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .update(schema.enrollments)
        .set({
          wentOfflineAt: new Date(),
          wentOfflineReason: input.reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.id, input.enrollmentId),
          ),
        );
    },
  );
}

// Clear a pending clean going-offline marker: a reconnect Hello re-announced the
// machine, so the goodbye no longer holds. CHANGE-GUARDED (`went_offline_at IS NOT
// NULL`) so a steady-state Hello — the overwhelmingly common case — issues NO
// write and never churns; `cleared` reports whether a marker was actually present,
// which the ingestion path uses to decide whether a link.restored is warranted (a
// restored only pairs a prior lost).
export async function clearEnrollmentWentOffline(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
  },
): Promise<{ cleared: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.enrollments)
        .set({ wentOfflineAt: null, wentOfflineReason: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.id, input.enrollmentId),
            isNotNull(schema.enrollments.wentOfflineAt),
          ),
        )
        .returning({ id: schema.enrollments.id });
      return { cleared: rows.length > 0 };
    },
  );
}

// Live display cursor: the agent's connect Hello reports whether a display is
// present RIGHT NOW (a desktop framebuffer probes). Unlike `has_display` set once
// at enroll time from the enroll-offer snapshot, this tracks REALITY across the
// machine's life — a Mac that later grants Screen Recording, or a Linux box whose
// Xvfb starts after enrollment, flips false→true on its next Hello (and a display
// that goes away flips true→false).
//
// `desktopUnavailableReason` rides alongside: a machine can have a display it
// cannot CAPTURE (macOS Screen Recording / TCC not granted). In that case
// has_display is false BUT the reason is a human, actionable string, so the
// Machines dashboard can show "display: capture not granted" instead of a bare
// "headless". null means capture is permitted OR the machine is genuinely headless.
//
// CHANGE-GUARDED at the SQL layer: the write fires only when EITHER field differs
// from what the row already holds (`hasDisplay` via `ne`, the nullable reason via
// `IS DISTINCT FROM`), so a steady-state Hello updates zero rows and never churns.
// Returns whether a row was actually changed. Best-effort — the caller swallows
// failures so a display refresh never breaks the agent's connect.
export async function setEnrollmentDisplayState(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    hasDisplay: boolean;
    desktopUnavailableReason: string | null;
  },
): Promise<{ updated: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.enrollments)
        .set({
          hasDisplay: input.hasDisplay,
          desktopUnavailableReason: input.desktopUnavailableReason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.id, input.enrollmentId),
            // Only write on a CHANGE to EITHER field — an unchanged display state must
            // not churn a write on every reconnect Hello. `IS DISTINCT FROM` is the
            // null-safe inequality (a plain `ne` skips NULL rows).
            or(
              ne(schema.enrollments.hasDisplay, input.hasDisplay),
              sql`${schema.enrollments.desktopUnavailableReason} IS DISTINCT FROM ${input.desktopUnavailableReason}`,
            ),
          ),
        )
        .returning({ id: schema.enrollments.id });
      return { updated: rows.length > 0 };
    },
  );
}

// Live op-stream cursor: the agent's connect Hello advertises whether it supports
// the streaming exec transport. This is deliberately persisted separately from the
// server rollout flag so routing can require BOTH server enablement and the live
// runner capability; agents predating the op-stream engine remain false and keep
// using legacy request/reply exec.
//
// CHANGE-GUARDED at the SQL layer: the write fires only when `op_stream` differs
// from what the row already holds, so a steady-state Hello updates zero rows and
// never churns. Returns whether a row was actually changed. Best-effort — the
// caller swallows failures so capability refresh never breaks the agent's connect.
export async function setEnrollmentOpStreamState(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    opStream: boolean;
  },
): Promise<{ updated: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.enrollments)
        .set({
          opStream: input.opStream,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.enrollments.workspaceId, input.workspaceId),
            eq(schema.enrollments.id, input.enrollmentId),
            ne(schema.enrollments.opStream, input.opStream),
          ),
        )
        .returning({ id: schema.enrollments.id });
      return { updated: rows.length > 0 };
    },
  );
}

// ---- device-flow enrollment requests (M5, migration 0025) -----------------
//
// The OAuth 2.0 device-authorization (RFC 8628) PENDING request: one short-TTL,
// single-use row per in-flight enrollment. The agent starts a flow (gets a
// device_code + user_code), the user approves it (LOUD consent capture +
// createEnrollment + createSandbox), and the agent polls the device_code for the
// resulting EnrollmentCredentials. Dossier §10.2 + §18.

export type DeviceEnrollmentStatus = (typeof schema.deviceEnrollmentStatusValues)[number];

export type DeviceEnrollmentRequestRecord = {
  id: string;
  deviceCode: string;
  userCode: string;
  accountId: string;
  workspaceId: string;
  pubkey: string;
  os: EnrollmentOs;
  arch: string;
  machineName: string | null;
  requestedExposure: EnrollmentExposure;
  canOfferDisplay: boolean;
  requestsScreenControl: boolean;
  status: DeviceEnrollmentStatus;
  approvedBySubjectId: string | null;
  approvedBySubjectLabel: string | null;
  allowScreenControl: boolean;
  approvedAt: string | null;
  enrollmentId: string | null;
  sandboxId: string | null;
  credentialGeneration: number | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapDeviceEnrollmentRequest(
  row: typeof schema.deviceEnrollmentRequests.$inferSelect,
): DeviceEnrollmentRequestRecord {
  return {
    id: row.id,
    deviceCode: row.deviceCode,
    userCode: row.userCode,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    pubkey: row.pubkey,
    os: row.os as EnrollmentOs,
    arch: row.arch,
    machineName: row.machineName ?? null,
    requestedExposure: row.requestedExposure as EnrollmentExposure,
    canOfferDisplay: row.canOfferDisplay,
    requestsScreenControl: row.requestsScreenControl,
    status: row.status as DeviceEnrollmentStatus,
    approvedBySubjectId: row.approvedBySubjectId ?? null,
    approvedBySubjectLabel: row.approvedBySubjectLabel ?? null,
    allowScreenControl: row.allowScreenControl,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    enrollmentId: row.enrollmentId ?? null,
    sandboxId: row.sandboxId ?? null,
    credentialGeneration:
      row.credentialGeneration == null ? null : Number(row.credentialGeneration),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Persist a fresh PENDING device-auth request (the agent's POST /start). The
// caller supplies the unguessable device_code + user_code (minted with a CSPRNG)
// and the short TTL. RLS-scoped to the workspace the flow binds to.
export async function createDeviceEnrollmentRequest(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    deviceCode: string;
    userCode: string;
    pubkey: string;
    os?: EnrollmentOs;
    arch?: string;
    machineName?: string | null;
    requestedExposure?: EnrollmentExposure;
    canOfferDisplay?: boolean;
    requestsScreenControl?: boolean;
    expiresAt: Date;
  },
): Promise<DeviceEnrollmentRequestRecord> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.deviceEnrollmentRequests)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          deviceCode: input.deviceCode,
          userCode: input.userCode,
          pubkey: input.pubkey,
          os: input.os ?? "linux",
          arch: input.arch ?? "x86_64",
          machineName: input.machineName ?? null,
          requestedExposure: input.requestedExposure ?? "whole-machine",
          canOfferDisplay: input.canOfferDisplay ?? false,
          requestsScreenControl: input.requestsScreenControl ?? false,
          status: "pending",
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create device enrollment request");
      }
      return mapDeviceEnrollmentRequest(row);
    },
  );
}

// Look up a request by its opaque device_code (the agent's poll key). The
// device_code IS the capability (unguessable + unique) and the agent has NO
// workspace context yet, so resolve (account_id, workspace_id) via the SECURITY
// DEFINER resolver (mirrors the global reaper's cross-workspace read), then re-read
// the FULL row under that workspace's RLS scope. Returns null when unknown.
export async function getDeviceEnrollmentRequestByDeviceCode(
  db: Database,
  deviceCode: string,
): Promise<DeviceEnrollmentRequestRecord | null> {
  const resolved = await db.execute<{ account_id: string; workspace_id: string }>(sql`
    select account_id, workspace_id from opengeni_private.resolve_device_enrollment_request(${deviceCode})
  `);
  const ctx = resolved[0];
  if (!ctx) {
    return null;
  }
  return await withRlsContext(
    db,
    { accountId: ctx.account_id, workspaceId: ctx.workspace_id },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.deviceEnrollmentRequests)
        .where(eq(schema.deviceEnrollmentRequests.deviceCode, deviceCode))
        .limit(1);
      return row ? mapDeviceEnrollmentRequest(row) : null;
    },
  );
}

// Look up the PENDING request for a user_code within a workspace (the approve
// lookup). Workspace-scoped: a user can only approve a request bound to a
// workspace they hold a grant in. Returns null when no LIVE pending row matches.
export async function getPendingDeviceEnrollmentRequestByUserCode(
  db: Database,
  workspaceId: string,
  userCode: string,
): Promise<DeviceEnrollmentRequestRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.deviceEnrollmentRequests)
      .where(
        and(
          eq(schema.deviceEnrollmentRequests.workspaceId, workspaceId),
          eq(schema.deviceEnrollmentRequests.userCode, userCode),
          eq(schema.deviceEnrollmentRequests.status, "pending"),
        ),
      )
      .limit(1);
    return row ? mapDeviceEnrollmentRequest(row) : null;
  });
}

// Look up the PENDING request for a user_code GLOBALLY (no workspace context) —
// the click-Grant approve page lookup (design 11 §B.1). The user_code is globally
// unique among LIVE (pending) rows, so — exactly like getDeviceEnrollmentRequestByDeviceCode
// resolves a device_code — this resolves (account_id, workspace_id) via the 0026
// SECURITY DEFINER resolver, then re-reads the FULL pending row under that
// workspace's RLS scope. The ROUTE then re-checks the caller holds a grant in the
// resolved workspace before returning anything. Returns null when no live pending
// row matches (an unknown / terminal / expired code).
export async function getPendingDeviceEnrollmentRequestByUserCodeGlobal(
  db: Database,
  userCode: string,
): Promise<DeviceEnrollmentRequestRecord | null> {
  const resolved = await db.execute<{ account_id: string; workspace_id: string }>(sql`
    select account_id, workspace_id from opengeni_private.resolve_pending_device_enrollment_by_user_code(${userCode})
  `);
  const ctx = resolved[0];
  if (!ctx) {
    return null;
  }
  return await withRlsContext(
    db,
    { accountId: ctx.account_id, workspaceId: ctx.workspace_id },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.deviceEnrollmentRequests)
        .where(
          and(
            eq(schema.deviceEnrollmentRequests.userCode, userCode),
            eq(schema.deviceEnrollmentRequests.status, "pending"),
          ),
        )
        .limit(1);
      return row ? mapDeviceEnrollmentRequest(row) : null;
    },
  );
}

// The SHARED finalize core (design 11 §A2.3 "reuse, don't fork"): "upsert the
// enrollment (idempotent on (workspace_id, pubkey)) + ensure a kind='selfhosted'
// sandbox row" — the exact end state BOTH the device approve and the headless
// token exchange must produce. Takes an ALREADY-RLS-SCOPED `scopedDb` so the
// caller controls the transaction boundary:
//   * approveDeviceEnrollmentRequest calls it INSIDE its FOR-UPDATE txn (so the
//     re-read fence + the request stamp stay in ONE txn — semantics unchanged), and
//   * finalizeEnrollmentByToken calls it inside its OWN txn (no pending row exists
//     for a stateless token).
// A fresh finalize for the same (workspace, pubkey) re-activates the existing
// enrollment, atomically increments its credential generation, and REUSES its
// selfhosted sandbox — never a duplicate. Device-approval retries are intercepted
// before this helper so replaying one already-approved request does not rotate.
async function finalizeEnrollmentInScope(
  scopedDb: Database,
  input: {
    accountId: string;
    workspaceId: string;
    pubkey: string;
    hasDisplay: boolean;
    allowScreenControl: boolean;
    os: EnrollmentOs;
    arch: string;
    sandboxName: string;
    now: Date;
  },
): Promise<{ enrollment: EnrollmentRecord; sandbox: SandboxRecord }> {
  // createEnrollment (idempotent upsert) — whole-machine is mandatory; display +
  // screen-control come from the agent's offer + the consenting decision. We inline
  // the insert here (rather than calling createEnrollment, which opens its OWN
  // scope) so it shares the caller's transaction.
  const [enrollmentRow] = await scopedDb
    .insert(schema.enrollments)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      pubkey: input.pubkey,
      exposure: "whole-machine",
      hasDisplay: input.hasDisplay,
      allowScreenControl: input.allowScreenControl,
      os: input.os,
      arch: input.arch,
      status: "active",
    })
    .onConflictDoUpdate({
      target: [schema.enrollments.workspaceId, schema.enrollments.pubkey],
      set: {
        exposure: "whole-machine",
        hasDisplay: input.hasDisplay,
        allowScreenControl: input.allowScreenControl,
        os: input.os,
        arch: input.arch,
        status: "active",
        revokedAt: null,
        credentialGeneration: sql`${schema.enrollments.credentialGeneration} + 1`,
        updatedAt: input.now,
      },
    })
    .returning();
  if (!enrollmentRow) {
    throw new Error("Failed to create enrollment during finalize");
  }
  const enrollment = mapEnrollment(enrollmentRow);

  // Ensure a selfhosted sandbox for this enrollment. A re-finalize of the SAME
  // machine reuses the existing sandbox rather than creating a duplicate.
  const [existingSandbox] = await scopedDb
    .select()
    .from(schema.sandboxes)
    .where(
      and(
        eq(schema.sandboxes.workspaceId, input.workspaceId),
        eq(schema.sandboxes.enrollmentId, enrollment.id),
      ),
    )
    .limit(1);
  let sandbox: SandboxRecord;
  if (existingSandbox) {
    sandbox = mapSandbox(existingSandbox);
  } else {
    const [sandboxRow] = await scopedDb
      .insert(schema.sandboxes)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        kind: "selfhosted",
        name: input.sandboxName,
        enrollmentId: enrollment.id,
      })
      .returning();
    if (!sandboxRow) {
      throw new Error("Failed to create sandbox during finalize");
    }
    sandbox = mapSandbox(sandboxRow);
  }
  return { enrollment, sandbox };
}

// FINALIZE a headless enroll-token exchange (design 11 §A2.3). Produces the SAME
// end state as approveDeviceEnrollmentRequest — an enrollments row + a selfhosted
// sandbox row — but WITHOUT a pending device-flow request (a stateless `oget_`
// token carries the grant). Idempotent via the shared finalize core's upsert.
export async function finalizeEnrollmentByToken(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    pubkey: string;
    hasDisplay: boolean;
    allowScreenControl: boolean;
    os: EnrollmentOs;
    arch: string;
    sandboxName: string;
    now?: Date;
  },
): Promise<{ enrollment: EnrollmentRecord; sandbox: SandboxRecord }> {
  const now = input.now ?? new Date();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await finalizeEnrollmentInScope(scopedDb, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        pubkey: input.pubkey,
        hasDisplay: input.hasDisplay,
        allowScreenControl: input.allowScreenControl,
        os: input.os,
        arch: input.arch,
        sandboxName: input.sandboxName,
        now,
      });
    },
  );
}

// THE LOUD-CONSENT APPROVE (the user's POST /approve). In ONE transaction:
//   1. re-read the pending row FOR UPDATE (fence against a double-approve / a
//      concurrent expiry),
//   2. createEnrollment (idempotent upsert: pubkey, whole-machine exposure,
//      has_display from can_offer_display, allow_screen_control per the user's
//      decision, os/arch) → an enrollments row,
//   3. createSandbox (kind selfhosted, enrollment_id, a generated name) → a
//      sandboxes row (acceptance #2),
//   4. stamp the request approved + the consent record (WHO approved WHEN to WHAT)
//      + the resulting enrollment_id / sandbox_id.
// IDEMPOTENT: a re-approve of an ALREADY-approved row (same user_code re-submitted)
// returns the existing enrollment/sandbox WITHOUT re-running the enrollment upsert,
// so a lost approval response cannot rotate the credential generation. A genuinely
// fresh request for the same pubkey does run the upsert and rotates. An expired /
// denied / consumed row is a no-op (approved:false).
export async function approveDeviceEnrollmentRequest(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    requestId: string;
    allowScreenControl: boolean;
    approvedBySubjectId: string;
    approvedBySubjectLabel?: string | null;
    // A name for the generated sandbox (machine name or a fallback).
    sandboxName: string;
    now?: Date;
  },
): Promise<{
  approved: boolean;
  enrollment: EnrollmentRecord | null;
  sandbox: SandboxRecord | null;
}> {
  const now = input.now ?? new Date();
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // Re-read FOR UPDATE under the txn so a concurrent approve / expiry can't race.
      const [pending] = await scopedDb
        .select()
        .from(schema.deviceEnrollmentRequests)
        .where(
          and(
            eq(schema.deviceEnrollmentRequests.workspaceId, input.workspaceId),
            eq(schema.deviceEnrollmentRequests.id, input.requestId),
          ),
        )
        .for("update")
        .limit(1);
      if (!pending) {
        return { approved: false, enrollment: null, sandbox: null };
      }
      const expired = pending.expiresAt.getTime() <= now.getTime();
      if (expired) {
        return { approved: false, enrollment: null, sandbox: null };
      }
      // Already approved → idempotent return of the exact existing rows. Do not run
      // the finalize upsert again: that operation is the credential-generation
      // rotation boundary for a genuinely new enrollment request. Generationless
      // migration-era rows and any identity/generation drift fail closed.
      if (pending.status === "approved") {
        if (!pending.enrollmentId || !pending.sandboxId || !pending.credentialGeneration) {
          return { approved: false, enrollment: null, sandbox: null };
        }
        const [existingEnrollment] = await scopedDb
          .select()
          .from(schema.enrollments)
          .where(
            and(
              eq(schema.enrollments.workspaceId, input.workspaceId),
              eq(schema.enrollments.id, pending.enrollmentId),
            ),
          )
          .limit(1);
        const [existingSandbox] = await scopedDb
          .select()
          .from(schema.sandboxes)
          .where(
            and(
              eq(schema.sandboxes.workspaceId, input.workspaceId),
              eq(schema.sandboxes.id, pending.sandboxId),
              eq(schema.sandboxes.enrollmentId, pending.enrollmentId),
            ),
          )
          .limit(1);
        if (
          !existingEnrollment ||
          !existingSandbox ||
          existingEnrollment.pubkey !== pending.pubkey ||
          Number(existingEnrollment.credentialGeneration) !== pending.credentialGeneration
        ) {
          return { approved: false, enrollment: null, sandbox: null };
        }
        return {
          approved: true,
          enrollment: mapEnrollment(existingEnrollment),
          sandbox: mapSandbox(existingSandbox),
        };
      }
      if (pending.status === "denied" || pending.status === "consumed") {
        return { approved: false, enrollment: null, sandbox: null };
      }

      // The SHARED finalize core: upsert the enrollment (idempotent) + ensure a
      // selfhosted sandbox. RLS is already set on scopedDb's session and this call
      // runs INSIDE this FOR-UPDATE txn, so the re-read fence + the stamp below + the
      // enrollment/sandbox writes all commit atomically (semantics unchanged from the
      // pre-refactor inline block — acceptance #2 stays one machine). The headless
      // token exchange (finalizeEnrollmentByToken) calls the SAME core.
      const { enrollment, sandbox } = await finalizeEnrollmentInScope(scopedDb, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        pubkey: pending.pubkey,
        hasDisplay: pending.canOfferDisplay,
        allowScreenControl: input.allowScreenControl,
        os: pending.os as EnrollmentOs,
        arch: pending.arch,
        sandboxName: input.sandboxName,
        now,
      });

      // Stamp the request approved + the LOUD CONSENT record (who/when/what).
      await scopedDb
        .update(schema.deviceEnrollmentRequests)
        .set({
          status: "approved",
          allowScreenControl: input.allowScreenControl,
          approvedBySubjectId: input.approvedBySubjectId,
          approvedBySubjectLabel: input.approvedBySubjectLabel ?? null,
          approvedAt: now,
          enrollmentId: enrollment.id,
          sandboxId: sandbox.id,
          credentialGeneration: enrollment.credentialGeneration,
          updatedAt: now,
        })
        .where(eq(schema.deviceEnrollmentRequests.id, pending.id));

      return { approved: true, enrollment, sandbox };
    },
  );
}

// Mark a pending request DENIED (an explicit user "no" at the approve page).
// Idempotent: a non-pending row is a no-op (denied:false).
export async function denyDeviceEnrollmentRequest(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    requestId: string;
  },
): Promise<{ denied: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.deviceEnrollmentRequests)
        .set({ status: "denied", updatedAt: new Date() })
        .where(
          and(
            eq(schema.deviceEnrollmentRequests.workspaceId, input.workspaceId),
            eq(schema.deviceEnrollmentRequests.id, input.requestId),
            eq(schema.deviceEnrollmentRequests.status, "pending"),
          ),
        )
        .returning({ id: schema.deviceEnrollmentRequests.id });
      return { denied: rows.length > 0 };
    },
  );
}

// Flip an APPROVED request to CONSUMED once the agent has polled its credentials
// (single-use). Fenced on status='approved' so a double-poll consumes exactly once;
// a second poll then re-reads the consumed row and still returns credentials (the
// agent may legitimately retry the same poll) — the route decides. Returns whether
// THIS call performed the consume transition.
export async function consumeDeviceEnrollmentRequest(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    requestId: string;
  },
): Promise<{ consumed: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb
        .update(schema.deviceEnrollmentRequests)
        .set({ status: "consumed", updatedAt: new Date() })
        .where(
          and(
            eq(schema.deviceEnrollmentRequests.workspaceId, input.workspaceId),
            eq(schema.deviceEnrollmentRequests.id, input.requestId),
            eq(schema.deviceEnrollmentRequests.status, "approved"),
          ),
        )
        .returning({ id: schema.deviceEnrollmentRequests.id });
      return { consumed: rows.length > 0 };
    },
  );
}

// ---- sandboxes ------------------------------------------------------------

// Create a first-class named sandbox (the pointer target a session swaps to). The
// DB CHECK pins selfhosted<->enrollment_id: a selfhosted sandbox MUST carry an
// enrollment; a modal sandbox MUST NOT. We surface that as a typed pre-check so
// the caller gets a clear error rather than a raw constraint violation.
export async function createSandbox(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    kind: SandboxKind;
    name: string;
    enrollmentId?: string | null;
  },
): Promise<SandboxRecord> {
  const enrollmentId = input.enrollmentId ?? null;
  if (input.kind === "selfhosted" && !enrollmentId) {
    throw new Error("A selfhosted sandbox requires an enrollmentId.");
  }
  if (input.kind !== "selfhosted" && enrollmentId) {
    throw new Error(`A ${input.kind} sandbox must not carry an enrollmentId.`);
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.sandboxes)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          kind: input.kind,
          name: input.name,
          enrollmentId,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create sandbox");
      }
      return mapSandbox(row);
    },
  );
}

export async function getSandbox(
  db: Database,
  workspaceId: string,
  sandboxId: string,
): Promise<SandboxRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sandboxes)
      .where(and(eq(schema.sandboxes.workspaceId, workspaceId), eq(schema.sandboxes.id, sandboxId)))
      .limit(1);
    return row ? mapSandbox(row) : null;
  });
}

// List a workspace's sandboxes, newest first (the sandboxes_list tool surface).
export async function listSandboxes(db: Database, workspaceId: string): Promise<SandboxRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.workspaceId, workspaceId))
      .orderBy(desc(schema.sandboxes.createdAt));
    return rows.map(mapSandbox);
  });
}

// ---- the per-session active-sandbox pointer (epoch-fenced swap) -----------

export type ActiveSandboxPointer = {
  activeSandboxId: string | null;
  activeEpoch: number;
  // The session's working directory (the path/cwd base for a selfhosted backend),
  // surfaced alongside the pointer. NULL ⇒ the default workspace_root behavior.
  workingDir: string | null;
};

// The INVERSE of readActiveSandbox: every session in a workspace whose ACTIVE
// SANDBOX resolves to enrollment X AND that has a RUNNING TURN — i.e. "sessions
// with an active op on machine X". This is the fan-out target set for the
// machine-link session events (a machine's control link changing only concerns the
// sessions actively using it; an idle-machine blip must never spam historical
// sessions). ONE indexed lookup: the query drives from `sandboxes` via the partial
// `sandboxes_enrollment_idx` (enrollment_id WHERE NOT NULL), joins `sessions` on
// the active-sandbox pointer, and keeps only rows with a non-null active_turn_id (a
// running turn). Deliberately a v1 OVER-APPROXIMATION — no per-op tracking table.
export async function sessionsWithActiveOpOnEnrollment(
  db: Database,
  input: { workspaceId: string; enrollmentId: string },
): Promise<Array<{ sessionId: string; activeTurnId: string }>> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        sessionId: schema.sessions.id,
        activeTurnId: schema.sessions.activeTurnId,
      })
      .from(schema.sandboxes)
      .innerJoin(schema.sessions, eq(schema.sessions.activeSandboxId, schema.sandboxes.id))
      .where(
        and(
          eq(schema.sandboxes.workspaceId, input.workspaceId),
          eq(schema.sandboxes.kind, "selfhosted"),
          eq(schema.sandboxes.enrollmentId, input.enrollmentId),
          isNotNull(schema.sessions.activeTurnId),
        ),
      )
      // Stable fan-out order (oldest session first): makes the emission
      // deterministic + replayable, so a per-session emission failure is isolated
      // predictably rather than depending on the planner's row order.
      .orderBy(asc(schema.sessions.createdAt), asc(schema.sessions.id));
    // active_turn_id is non-null by the WHERE guard; the map narrows the type.
    return rows.flatMap((row) =>
      row.activeTurnId ? [{ sessionId: row.sessionId, activeTurnId: row.activeTurnId }] : [],
    );
  });
}

// Read the session's current pointer (the routing proxy re-reads this PER TOOL
// CALL). NULL active_sandbox_id == "use the session's own group sandbox".
export async function readActiveSandbox(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<ActiveSandboxPointer | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        activeSandboxId: schema.sessions.activeSandboxId,
        activeEpoch: schema.sessions.activeEpoch,
        workingDir: schema.sessions.workingDir,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      activeSandboxId: row.activeSandboxId ?? null,
      activeEpoch: Number(row.activeEpoch),
      workingDir: row.workingDir ?? null,
    };
  });
}

// THE SWAP. Repoint a session at `targetSandboxId` (NULL == back to the group
// sandbox) and BUMP active_epoch under a fence: the write is gated on the
// session's current active_epoch == expectedEpoch, so a concurrent double-swap
// (two callers both reading epoch N) lets exactly ONE win — the loser sees
// swapped:false and re-reads. The bumped epoch fences any in-flight op cached
// against the old pointer, which then retries against the new active sandbox.
// integer epoch returns a JS number; Number()-coerced defensively (lease lesson).
export async function setActiveSandbox(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    targetSandboxId: string | null;
    expectedEpoch: number;
    // The session's working directory to write alongside the pointer. OMITTED
    // (undefined) ⇒ the column is left UNCHANGED (a plain swap/attach never touches
    // it); a string sets it; null clears it back to the default. Per-session
    // working dir is seeded create-time through this CAS, not the row INSERT.
    workingDir?: string | null;
  },
): Promise<{ swapped: boolean; pointer: ActiveSandboxPointer | null }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{
        active_sandbox_id: string | null;
        active_epoch: number | string;
        working_dir: string | null;
      }>(sql`
      update sessions set
        active_sandbox_id = ${input.targetSandboxId},
        active_epoch      = active_epoch + 1,
        working_dir       = ${input.workingDir === undefined ? sql`working_dir` : input.workingDir},
        updated_at        = now()
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
        and active_epoch = ${input.expectedEpoch}
      returning active_sandbox_id, active_epoch, working_dir
    `);
      const row = rows[0];
      if (!row) {
        return { swapped: false, pointer: null };
      }
      return {
        swapped: true,
        pointer: {
          activeSandboxId: row.active_sandbox_id ?? null,
          activeEpoch: Number(row.active_epoch),
          workingDir: row.working_dir ?? null,
        },
      };
    },
  );
}

// ---- per-machine metrics (§10.7) ------------------------------------------

// The sampled signal set the agent piggybacks on the heartbeat. Every field is
// optional (a platform/sample may not provide it — no GPU, headless, etc.).
export type MachineMetricsSample = {
  cpuPercent?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  diskTotalBytes?: number | null;
  gpuUtilPercent?: number | null;
  gpuMemUsedBytes?: number | null;
  gpuMemTotalBytes?: number | null;
  contention?: number | null;
  sampledAt: Date;
};

function metricColumns(sample: MachineMetricsSample) {
  return {
    cpuPercent: sample.cpuPercent ?? null,
    load1: sample.load1 ?? null,
    load5: sample.load5 ?? null,
    load15: sample.load15 ?? null,
    memUsedBytes: sample.memUsedBytes ?? null,
    memTotalBytes: sample.memTotalBytes ?? null,
    diskUsedBytes: sample.diskUsedBytes ?? null,
    diskTotalBytes: sample.diskTotalBytes ?? null,
    gpuUtilPercent: sample.gpuUtilPercent ?? null,
    gpuMemUsedBytes: sample.gpuMemUsedBytes ?? null,
    gpuMemTotalBytes: sample.gpuMemTotalBytes ?? null,
    contention: sample.contention ?? null,
    sampledAt: sample.sampledAt,
  };
}

// Last-sample UPSERT: one row per enrollment, overwritten every sample (PK on
// enrollment_id is the conflict target). The Machines dashboard's "now" read.
export async function upsertMachineMetricsLatest(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    sample: MachineMetricsSample;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const cols = metricColumns(input.sample);
      await scopedDb
        .insert(schema.machineMetricsLatest)
        .values({
          enrollmentId: input.enrollmentId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          ...cols,
        })
        .onConflictDoUpdate({
          target: schema.machineMetricsLatest.enrollmentId,
          set: { ...cols, updatedAt: new Date() },
        });
    },
  );
}

// Append a downsampled (~1/min) series row (the history the dashboard time-range
// reads + the later retention sweep prune).
export async function insertMachineMetricsSeries(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    sample: MachineMetricsSample;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.insert(schema.machineMetricsSeries).values({
        enrollmentId: input.enrollmentId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        ...metricColumns(input.sample),
      });
    },
  );
}

// The target spacing between series rows: the agent heartbeats ~every 5s, but we
// downsample the long-term history to ~1/min (dossier §10.7). A new series row is
// appended only when >= this much time has elapsed since the last one.
export const MACHINE_METRICS_SERIES_INTERVAL_MS = 60_000;

/**
 * Ingest ONE sampled metrics point for an enrollment (the M10 ingestion seam):
 *   1. UPSERT machine_metrics_latest (the "now" row, one per enrollment) — always.
 *   2. APPEND a machine_metrics_series row only when >= ~1/min has elapsed since
 *      the last series row (downsample) — so the 5s heartbeat cadence does not
 *      flood the history table.
 * Both happen under the same RLS context. Returns whether a series row was
 * appended (the downsample decision) so the caller / tests can assert the ~1/min
 * spacing. A null/absent `sampledAt` on the prior row treats it as "no prior" →
 * append.
 */
export async function ingestMachineMetricsSample(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    enrollmentId: string;
    sample: MachineMetricsSample;
    /** Override the downsample interval (tests). Defaults to ~1/min. */
    seriesIntervalMs?: number;
  },
): Promise<{ latestUpserted: true; seriesAppended: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const cols = metricColumns(input.sample);
      // 1. Latest upsert — always.
      await scopedDb
        .insert(schema.machineMetricsLatest)
        .values({
          enrollmentId: input.enrollmentId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          ...cols,
        })
        .onConflictDoUpdate({
          target: schema.machineMetricsLatest.enrollmentId,
          set: { ...cols, updatedAt: new Date() },
        });

      // 2. Series append — downsampled. Read the most recent series sampled_at and
      // only append when the new sample is >= the interval newer (or there is no
      // prior row). Done in-context so RLS scopes the read to this workspace.
      const intervalMs = input.seriesIntervalMs ?? MACHINE_METRICS_SERIES_INTERVAL_MS;
      const [prior] = await scopedDb
        .select({ sampledAt: schema.machineMetricsSeries.sampledAt })
        .from(schema.machineMetricsSeries)
        .where(eq(schema.machineMetricsSeries.enrollmentId, input.enrollmentId))
        .orderBy(desc(schema.machineMetricsSeries.sampledAt))
        .limit(1);
      const priorMs = prior?.sampledAt ? prior.sampledAt.getTime() : null;
      const sampleMs = input.sample.sampledAt.getTime();
      const seriesAppended = priorMs === null || sampleMs - priorMs >= intervalMs;
      if (seriesAppended) {
        await scopedDb.insert(schema.machineMetricsSeries).values({
          enrollmentId: input.enrollmentId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          ...cols,
        });
      }
      return { latestUpserted: true, seriesAppended };
    },
  );
}

// The mapped read shape of a stored metrics sample (latest or a series point).
// numeric columns come back as strings from postgres-js; map them to numbers (or
// null when never reported). The byte columns are bigint(mode:"number").
export type MachineMetricsRow = {
  enrollmentId: string;
  cpuPercent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  gpuUtilPercent: number | null;
  gpuMemUsedBytes: number | null;
  gpuMemTotalBytes: number | null;
  contention: number | null;
  sampledAt: string;
};

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapMetricsRow(row: {
  enrollmentId: string;
  cpuPercent: number | string | null;
  load1: number | string | null;
  load5: number | string | null;
  load15: number | string | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  gpuUtilPercent: number | string | null;
  gpuMemUsedBytes: number | null;
  gpuMemTotalBytes: number | null;
  contention: number | string | null;
  sampledAt: Date;
}): MachineMetricsRow {
  return {
    enrollmentId: row.enrollmentId,
    cpuPercent: numericOrNull(row.cpuPercent),
    load1: numericOrNull(row.load1),
    load5: numericOrNull(row.load5),
    load15: numericOrNull(row.load15),
    memUsedBytes: row.memUsedBytes ?? null,
    memTotalBytes: row.memTotalBytes ?? null,
    diskUsedBytes: row.diskUsedBytes ?? null,
    diskTotalBytes: row.diskTotalBytes ?? null,
    gpuUtilPercent: numericOrNull(row.gpuUtilPercent),
    gpuMemUsedBytes: row.gpuMemUsedBytes ?? null,
    gpuMemTotalBytes: row.gpuMemTotalBytes ?? null,
    contention: numericOrNull(row.contention),
    sampledAt: row.sampledAt.toISOString(),
  };
}

// Read the latest sample for ONE enrollment (the dashboard "now" read), or null
// when none has landed (never seen / offline before a first heartbeat).
export async function readMachineMetricsLatest(
  db: Database,
  workspaceId: string,
  enrollmentId: string,
): Promise<MachineMetricsRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.machineMetricsLatest)
      .where(
        and(
          eq(schema.machineMetricsLatest.workspaceId, workspaceId),
          eq(schema.machineMetricsLatest.enrollmentId, enrollmentId),
        ),
      )
      .limit(1);
    return row ? mapMetricsRow(row) : null;
  });
}

// Read the latest sample for EVERY enrollment in a workspace, keyed by
// enrollmentId — the Machines list joins this onto the fleet entries with ONE
// query rather than N per-machine reads.
export async function readMachineMetricsLatestForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<Map<string, MachineMetricsRow>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.machineMetricsLatest)
      .where(eq(schema.machineMetricsLatest.workspaceId, workspaceId));
    const byEnrollment = new Map<string, MachineMetricsRow>();
    for (const row of rows) {
      byEnrollment.set(row.enrollmentId, mapMetricsRow(row));
    }
    return byEnrollment;
  });
}

// Read the downsampled series for ONE enrollment over a time window (the
// dashboard time-range read). `sinceMs` bounds the window (e.g. now - 1h);
// ordered oldest-first for a left-to-right chart. `limit` caps the row count
// (defensive against an unbounded window).
export async function readMachineMetricsSeries(
  db: Database,
  input: {
    workspaceId: string;
    enrollmentId: string;
    since: Date;
    limit?: number;
  },
): Promise<MachineMetricsRow[]> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.machineMetricsSeries)
      .where(
        and(
          eq(schema.machineMetricsSeries.workspaceId, input.workspaceId),
          eq(schema.machineMetricsSeries.enrollmentId, input.enrollmentId),
          gte(schema.machineMetricsSeries.sampledAt, input.since),
        ),
      )
      .orderBy(asc(schema.machineMetricsSeries.sampledAt))
      .limit(input.limit ?? 5_000);
    return rows.map(mapMetricsRow);
  });
}

// ============================================================================
// P3.2 — the un-redacted-pixel consent gate + viewer revocation.
//
// The desktop-stream path is gated behind an explicit acknowledgment that the
// pixel plane is un-redacted (it can show cloud creds the agent cat's into a
// terminal — strictly broader than the redacted Channel-A event log). For a
// SHARED box (the group has >1 session) the principal must additionally consent
// to the shared-exposure disclosure: watching A's desktop also shows B's agent
// on the one :0 framebuffer (addendum E.1 / stress g). Consent is per-PRINCIPAL
// and per-GROUP (one :0 per group), recorded in session_stream_acknowledgments
// (0019). Reuses the acknowledgment machinery — no new permission beyond
// stream:acknowledge.
// ============================================================================

export interface StreamAcknowledgment {
  acknowledgedUnredacted: boolean;
  acknowledgedShared: boolean;
}

// Record (or upsert) a principal's acknowledgment of the group's un-redacted
// pixel plane (and, when shared, the shared-exposure disclosure). Keyed on
// (workspace, group, subject); a re-ack (e.g. a solo→shared upgrade adding the
// shared consent) is ON CONFLICT DO UPDATE, never a duplicate row.
export async function recordStreamAcknowledgment(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    subjectId: string;
    acknowledgeUnredacted: boolean;
    acknowledgeShared: boolean;
  },
): Promise<StreamAcknowledgment> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{
        acknowledged_unredacted: boolean;
        acknowledged_shared: boolean;
      }>(sql`
        insert into session_stream_acknowledgments
          (account_id, workspace_id, sandbox_group_id, subject_id,
           acknowledged_unredacted, acknowledged_shared, acknowledged_at, updated_at)
        values
          (${input.accountId}, ${input.workspaceId}, ${input.sandboxGroupId}, ${input.subjectId},
           ${input.acknowledgeUnredacted}, ${input.acknowledgeShared}, now(), now())
        on conflict (workspace_id, sandbox_group_id, subject_id) do update set
          -- Acknowledgment is monotonic: a later ack can ADD the shared consent
          -- but never silently withdraw a prior one (OR the bits in).
          acknowledged_unredacted = session_stream_acknowledgments.acknowledged_unredacted or excluded.acknowledged_unredacted,
          acknowledged_shared     = session_stream_acknowledgments.acknowledged_shared     or excluded.acknowledged_shared,
          acknowledged_at         = now(),
          updated_at              = now()
        returning acknowledged_unredacted, acknowledged_shared
      `);
      const row = rows[0]!;
      return {
        acknowledgedUnredacted: row.acknowledged_unredacted,
        acknowledgedShared: row.acknowledged_shared,
      };
    },
  );
}

// Read a principal's recorded acknowledgment for a group, or null if they have
// never acknowledged the un-redacted pixel plane. The negotiation read + the
// desktop-stream gate both consult this.
export async function getStreamAcknowledgment(
  db: Database,
  input: {
    workspaceId: string;
    sandboxGroupId: string;
    subjectId: string;
  },
): Promise<StreamAcknowledgment | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<{
      acknowledged_unredacted: boolean;
      acknowledged_shared: boolean;
    }>(sql`
      select acknowledged_unredacted, acknowledged_shared
      from session_stream_acknowledgments
      where workspace_id = ${input.workspaceId}
        and sandbox_group_id = ${input.sandboxGroupId}
        and subject_id = ${input.subjectId}
      limit 1
    `);
    if (!rows[0]) return null;
    return {
      acknowledgedUnredacted: rows[0].acknowledged_unredacted,
      acknowledgedShared: rows[0].acknowledged_shared,
    };
  });
}

// Enumerate the session ids in a group (workspace-scoped). The shared-exposure
// disclosure surfaces the OTHER sessions' ids ONLY — never their goal/metadata/
// conversation. The query selects ONLY the id column (id is the disclosure
// boundary; stress g). RLS-scoped: a foreign-workspace group returns no rows.
export async function listSessionIdsInGroup(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
): Promise<string[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await rawRows<{ id: string }>(
      scopedDb,
      sql`
      select id from sessions
      where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}
      order by created_at asc
    `,
    );
    return rows.map((r) => r.id);
  });
}

// OD-6 v1 — revoke a viewer: DROP that viewer's holder from the GROUP lease so
// refcount recomputes (the box drains iff nothing else holds it — a turn-held or
// other-viewer-held box survives), AND block its reconnect by recording the
// revoked subject so a re-attach with the same viewerId is refused. The
// live-RFB force-disconnect of an already-open socket is a P4 follow-up; the
// holder-drop (so the box can drain) is here.
//
// Returns the post-drop lease liveness/refcount (null if the lease was already
// cold-and-reaped — a revoke is then an idempotent no-op). A revoked viewer who
// independently holds a holder on a SIBLING session may still watch via that
// session (correct — authorized there); this drops ONLY the named viewerId's
// holder.
export async function revokeViewer(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    viewerId: string;
    idleGraceMs: number;
  },
): Promise<{ liveness: SandboxLeaseLiveness; refcount: number } | null> {
  // The drop is exactly releaseLeaseHolder's idempotent delete-my-row +
  // recompute (refcount recomputes; warm→draining is guarded refcount=0 AND
  // turn_holders=0, so a turn-held box never drains on a viewer revoke). The
  // reconnect-block is a P4 concern (the holder-drop is the v1 deliverable —
  // the box can now drain); a re-attach mints a fresh viewerId regardless.
  return await releaseLeaseHolder(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    kind: "viewer",
    holderId: input.viewerId,
    idleGraceMs: input.idleGraceMs,
  });
}

// ============================================================================
// Warm-time metering (P2.1) — the COST hole the lease design opens.
//
// A box held warm by a viewer with no agent turn running emits ZERO model usage
// today; the provider bills by wall-clock and OpenGeni meters nothing. Warm-time
// accrues on TWO stateless ticks: (a) the turn's existing activity heartbeat
// (while a turn runs); (b) the reaper sweep (for viewer-only boxes between turns).
//
// The meter is GROUP-KEYED + epoch-keyed + tick-keyed:
//   idempotencyKey = usage:sandbox.warm_seconds:<group>:<epoch>:<tick>
// so a SHARED box (N sessions on one group) is metered EXACTLY ONCE per tick
// (N sessions != N x bill — a session-keyed meter would N x-over-bill), and a
// re-dispatched/overlapping tick at the same (group,epoch,tick) can never
// double-charge (recordUsageEvent is onConflictDoNothing on idempotencyKey).
//
// Cursor advance + usage insert are ATOMIC: both run inside ONE FOR UPDATE txn on
// the lease row (the M3 cross-statement-atomicity fix). The insert uses ON
// CONFLICT DO NOTHING on idempotency_key (matching recordUsageEvent), and the
// cursor (last_meter_at/last_meter_tick) is advanced in the SAME txn — so the tick
// index and the metered seconds can never desync, and a partial-failure rollback
// leaves BOTH the cursor and the event untouched.
// ============================================================================

export interface AccrueWarmSecondsResult {
  /** false when nothing was accrued (epoch fenced / not warm / no elapsed / the
   *  first tick that only seeds the cursor). */
  accrued: boolean;
  /** Whole seconds metered this tick (0 when accrued:false). */
  seconds: number;
  /** The monotonic tick index this accrual was recorded under. */
  tick: number;
  /** usd_micros charged for this tick (0 when rate is 0). */
  costMicros: number;
}

/**
 * Accrue warm-seconds for the elapsed wall-clock since the lease's last meter
 * cursor, idempotent on (sandbox_group_id, lease_epoch, tick). EPOCH-FENCED +
 * liveness-guarded (warm only): a stale-epoch tick or a draining/cold lease is a
 * no-op, so a superseded writer that re-fires cannot mis-meter. The FIRST tick on
 * a never-metered lease (last_meter_at IS NULL) only SEEDS the cursor — it
 * accrues nothing (there is no prior cursor to diff against), matching the
 * "delta since last tick" contract. warmRateMicrosPerSecond > 0 also records a
 * sandbox.warm_cost event (cost = seconds x rate) AND debits the same micros from
 * the credit balance via applyCreditDebitUpToBalance (the model-cost precedent),
 * idempotent on the SAME (group, epoch, tick) key. The usage event is the
 * REQUESTED cost; the ledger is the ACTUAL debit (they legitimately differ when
 * balance is low — M2). Set debitCredits:false to meter without debiting.
 */
export async function accrueWarmSeconds(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sandboxGroupId: string;
    /** The epoch the tick observed; the fence — a stale writer no-ops. */
    expectedEpoch: number;
    /** usd_micros per warm-second for this box's backend (0 = meter only, no cost). */
    warmRateMicrosPerSecond: number;
    /** Optional attribution: the founding/observing session (visibility only — the
     *  group meter key makes the workspace charge correct regardless). */
    subjectId?: string | null;
    /** Debit credits for warm-cost (default true). The force-drain at 0 balance
     *  depends on this decrementing the balance. */
    debitCredits?: boolean;
  },
): Promise<AccrueWarmSecondsResult> {
  const none: AccrueWarmSecondsResult = { accrued: false, seconds: 0, tick: 0, costMicros: 0 };
  const result = await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        // Lock the group's lease row so the cursor advance + the usage insert are
        // one atomic step (no other tick can interleave between the diff and the
        // cursor write).
        const rows = await tx.execute<LeaseRow & { meter_elapsed_s: number | null }>(sql`
        select *,
          case when last_meter_at is null then null
               else floor(extract(epoch from (now() - last_meter_at)))::int end as meter_elapsed_s
        from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
        for update
      `);
        const row = rows[0];
        if (!row) return none;

        // Epoch fence + liveness guard: only a live-epoch warm box meters. A stale
        // (superseded) tick or a draining/cold/warming lease is a no-op.
        if (Number(row.lease_epoch) !== input.expectedEpoch || row.liveness !== "warm") {
          return none;
        }

        // First tick on a never-metered lease: SEED the cursor, accrue nothing.
        if (row.last_meter_at == null) {
          await tx.execute(sql`
          update sandbox_leases set last_meter_at = now(), updated_at = now()
          where id = ${row.id}
        `);
          return none;
        }

        const elapsedS = Number(row.meter_elapsed_s ?? 0);
        if (elapsedS <= 0) {
          // No whole second elapsed yet — leave the cursor untouched so the
          // remainder accrues on the next tick (no silent seconds loss).
          return none;
        }

        const tick = Number(row.last_meter_tick) + 1;
        const costMicros = Math.round(elapsedS * Math.max(0, input.warmRateMicrosPerSecond));

        // (1) The warm-seconds meter — GROUP+epoch+tick keyed, ON CONFLICT DO
        // NOTHING (the idempotency that makes a shared box one stream + a re-fire a
        // no-op). sourceResourceId is keyed on (group, epoch).
        await tx.execute(sql`
        insert into usage_events
          (account_id, workspace_id, subject_id, event_type, quantity, unit,
           source_resource_type, source_resource_id, idempotency_key, occurred_at)
        values
          (${input.accountId}, ${input.workspaceId}, ${input.subjectId ?? null},
           'sandbox.warm_seconds', ${elapsedS}, 'seconds',
           'sandbox_lease', ${`${input.sandboxGroupId}:${input.expectedEpoch}`},
           ${`usage:sandbox.warm_seconds:${input.sandboxGroupId}:${input.expectedEpoch}:${tick}`},
           now())
        on conflict (idempotency_key) do nothing
      `);

        // (2) The warm-cost meter (only when a rate is configured). Same keying.
        if (costMicros > 0) {
          await tx.execute(sql`
          insert into usage_events
            (account_id, workspace_id, subject_id, event_type, quantity, unit,
             source_resource_type, source_resource_id, idempotency_key, occurred_at)
          values
            (${input.accountId}, ${input.workspaceId}, ${input.subjectId ?? null},
             'sandbox.warm_cost', ${costMicros}, 'usd_micros',
             'sandbox_lease', ${`${input.sandboxGroupId}:${input.expectedEpoch}`},
             ${`usage:sandbox.warm_cost:${input.sandboxGroupId}:${input.expectedEpoch}:${tick}`},
             now())
          on conflict (idempotency_key) do nothing
        `);
        }

        // (3) Advance the cursor IN THE SAME TXN — the atomicity that makes the tick
        // index and the metered seconds inseparable.
        await tx.execute(sql`
        update sandbox_leases set
          last_meter_at = now(), last_meter_tick = ${tick}, updated_at = now()
        where id = ${row.id}
      `);

        return { accrued: true, seconds: elapsedS, tick, costMicros };
      }),
  );

  // Debit credits for the warm-cost OUTSIDE the lease-row txn (applyCreditDebit
  // takes its own per-account advisory lock — never nest it under the lease row
  // lock). Idempotent on the SAME (group, epoch, tick) key so a re-fire of an
  // already-committed tick cannot double-debit. The ledger records the ACTUAL
  // debit (min(requested, balance)); the warm_cost usage event above is the
  // requested cost.
  if (result.accrued && result.costMicros > 0 && (input.debitCredits ?? true)) {
    await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "sandbox.warm_cost",
      requestedAmountMicros: result.costMicros,
      sourceType: "sandbox_lease",
      sourceId: `${input.sandboxGroupId}:${input.expectedEpoch}`,
      idempotencyKey: `debit:sandbox.warm_cost:${input.sandboxGroupId}:${input.expectedEpoch}:${result.tick}`,
    }).catch(() => undefined);
  }

  return result;
}

// §2.2/2.3 — the per-workspace warm-cap + force-drain. Under the EXISTING usage
// lock (withWorkspaceUsageLock — NOT a bare count, so two concurrent ticks in
// different sessions of one workspace can't both read "under cap" and race past
// it). A workspace at 0 balance OR over its warm-second cap force-drains its
// VIEWER-ONLY boxes: CAS warm->draining guarded `AND turn_holders = 0` so a box
// with a running (paying) turn is NEVER killed. The reaper then issues the
// provider stop() at refcount 0 (this fn is DB-only — no provider call).
//
// Group-wide force-drain on workspace balance exhaustion is deliberate (one
// balance drains a multi-session box): the workspace, not the session, is the
// billing unit — correctness (charged once) is automatic from the group meter key.
export interface ForceDrainResult {
  /** Whether the workspace was over a limit (0 balance or over the warm cap). */
  overLimit: boolean;
  /** The reason, for observability. */
  reason: "balance" | "warm_cap" | null;
  /** The (workspaceId, sandboxGroupId) viewer-only boxes CASed warm->draining. */
  drained: { workspaceId: string; sandboxGroupId: string }[];
}

// Start of the current UTC month (the default warm-cap window). Local helper so
// packages/db has no dependency on a worker/api date util; callers may override
// via capWindowStart to keep the fn time-source-agnostic for tests.
function startOfUtcMonthDefault(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export async function forceDrainOverLimitViewerOnlyBoxes(
  db: Database,
  input: {
    workspaceId: string;
    /** account balance gate: when <= 0 (and a billing/managed mode is on) drain. */
    balanceMicros: number;
    enforceBalance: boolean;
    /** warm-second cap (cumulative this UTC month). 0 = unbounded (no cap gate). */
    maxWarmSecondsPerWorkspace: number;
    /** start of the cap window (caller passes startOfUtcMonth() so the fn stays
     *  time-source-agnostic for tests). */
    capWindowStart?: Date;
    /** drain-grace horizon stamped on the newly-draining rows (matches the reaper). */
    idleGraceMs: number;
  },
): Promise<ForceDrainResult> {
  return await withWorkspaceUsageLock(db, input.workspaceId, async (scopedDb) => {
    // Determine over-limit under the lock (so the cap read + the drain are one
    // serialized critical section per workspace).
    let reason: "balance" | "warm_cap" | null = null;
    if (input.enforceBalance && input.balanceMicros <= 0) {
      reason = "balance";
    } else if (input.maxWarmSecondsPerWorkspace > 0) {
      const since = input.capWindowStart ?? startOfUtcMonthDefault();
      const [{ total } = { total: 0 }] = await scopedDb
        .select({
          total: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
        })
        .from(schema.usageEvents)
        .where(
          and(
            eq(schema.usageEvents.workspaceId, input.workspaceId),
            eq(schema.usageEvents.eventType, "sandbox.warm_seconds"),
            gt(schema.usageEvents.occurredAt, since),
          ),
        );
      if (Number(total) >= input.maxWarmSecondsPerWorkspace) {
        reason = "warm_cap";
      }
    }

    if (!reason) {
      return { overLimit: false, reason: null, drained: [] };
    }

    // Force-drain VIEWER-ONLY warm boxes: CAS warm->draining guarded
    // turn_holders = 0 (a paying turn is NEVER killed). Stamp the grace deadline
    // so the reaper terminates at refcount 0 past the grace, exactly as a normal
    // refcount->0 drain would.
    // Drop the viewer holders of every warm VIEWER-ONLY lease (turn_holders=0 — a
    // paying turn is never killed) so refcount → 0 (otherwise the viewer holder
    // pins refcount > 0 and the reaper never terminates at refcount=0, and the
    // holder heartbeat would re-arm the lease). Scoped to the warm viewer-only
    // leases via a subselect so a turn-held box's holders are untouched.
    await scopedDb.execute(sql`
      delete from sandbox_lease_holders h
      where h.kind = 'viewer'
        and h.lease_id in (
          select id from sandbox_leases
          where workspace_id = ${input.workspaceId}
            and liveness = 'warm' and turn_holders = 0
        )
    `);
    // CAS the now-holderless leases warm→draining at refcount 0 with the grace
    // deadline stamped — so the SAME reaper sweep's refcount=0 drain predicate
    // then terminates the box.
    const drained = await rawRows<{ sandbox_group_id: string }>(
      scopedDb,
      sql`
      update sandbox_leases set
        liveness = 'draining',
        refcount = 0, turn_holders = 0, viewer_holders = 0,
        expires_at = now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval,
        updated_at = now()
      where workspace_id = ${input.workspaceId}
        and liveness = 'warm' and turn_holders = 0
      returning sandbox_group_id
    `,
    );

    return {
      overLimit: true,
      reason,
      drained: drained.map((r) => ({
        workspaceId: input.workspaceId,
        sandboxGroupId: r.sandbox_group_id,
      })),
    };
  });
}

export async function saveRunState(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedExecutionGeneration: number;
    expectedAttemptId: string;
    serializedRunState: string;
    pendingApprovals: unknown[];
    // The codex account freezing this state (the turn's resolved credential id),
    // or null on a non-codex turn. Stamped so a resume on a DIFFERENT codex
    // account can strip the blob's account-bound reasoning. Defaults null so
    // every legacy caller (and the non-codex path) is byte-identical.
    frozenCodexCredentialId?: string | null;
  },
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      return await scopedDb.transaction(async (tx) => {
        const allowed = await lockTurnAttemptWriteFenceTx(tx, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: input.expectedExecutionGeneration,
          attemptId: input.expectedAttemptId,
        });
        if (!allowed.allowed) return false;
        const [{ maxVersion } = { maxVersion: 0 }] = await tx
          .select({
            maxVersion: sql<number>`coalesce(max(${schema.agentRunStates.stateVersion}), 0)`,
          })
          .from(schema.agentRunStates)
          .where(
            and(
              eq(schema.agentRunStates.workspaceId, input.workspaceId),
              eq(schema.agentRunStates.sessionId, input.sessionId),
            ),
          );
        await tx.insert(schema.agentRunStates).values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          stateVersion: Number(maxVersion) + 1,
          serializedRunState: input.serializedRunState,
          pendingApprovals: input.pendingApprovals,
          frozenCodexCredentialId: input.frozenCodexCredentialId ?? null,
        });
        return true;
      });
    },
  );
}

export type CreateSessionGoalInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  text: string;
  successCriteria?: string | null;
  maxAutoContinuations?: number | null;
  createdBy: SessionGoalCreatedBy;
};

export async function createSessionGoal(
  db: Database,
  input: CreateSessionGoalInput,
): Promise<SessionGoal> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.sessionGoals)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          text: input.text,
          successCriteria: input.successCriteria ?? null,
          maxAutoContinuations: input.maxAutoContinuations ?? null,
          createdBy: input.createdBy,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create session goal");
      }
      return mapSessionGoal(row);
    },
  );
}

export async function getSessionGoal(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionGoal | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessionGoals)
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          eq(schema.sessionGoals.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row ? mapSessionGoal(row) : null;
  });
}

export async function clearSessionGoal(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<{ cleared: boolean; goal: SessionGoal | null; event: SessionEvent | null }> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          )
          .for("update")
          .limit(1);
        if (!session) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        const [existing] = await tx
          .select()
          .from(schema.sessionGoals)
          .where(
            and(
              eq(schema.sessionGoals.workspaceId, workspaceId),
              eq(schema.sessionGoals.sessionId, sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!existing) {
          return { cleared: false, goal: null, event: null };
        }
        await tx.delete(schema.sessionGoals).where(eq(schema.sessionGoals.id, existing.id));
        const sequence = session.lastSequence + 1;
        const [event] = await tx
          .insert(schema.sessionEvents)
          .values({
            accountId: session.accountId,
            workspaceId: session.workspaceId,
            sessionId,
            sequence,
            type: "goal.cleared",
            payload: sanitizeEventPayload({
              goalId: existing.id,
              text: existing.text,
              version: existing.version,
            }),
          })
          .returning();
        if (!event) throw new Error("Failed to create system-update pending event");
        await tx
          .update(schema.sessions)
          .set({ lastSequence: sequence, updatedAt: new Date() })
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          );
        if (!event) {
          throw new Error("Failed to append goal.cleared event");
        }
        return { cleared: true, goal: mapSessionGoal(existing), event: mapEvent(event) };
      }),
  );
}

/**
 * goal_set semantics: insert, or replace the existing goal in place. A replace
 * re-activates the goal (even when paused or completed), bumps the version,
 * and resets the continuation counters — re-stating the objective re-arms the
 * auto-continuation budget.
 */
export async function upsertSessionGoal(
  db: Database,
  input: CreateSessionGoalInput,
): Promise<{ goal: SessionGoal; replaced: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [existing] = await scopedDb
        .select()
        .from(schema.sessionGoals)
        .where(
          and(
            eq(schema.sessionGoals.workspaceId, input.workspaceId),
            eq(schema.sessionGoals.sessionId, input.sessionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!existing) {
        const [row] = await scopedDb
          .insert(schema.sessionGoals)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            text: input.text,
            successCriteria: input.successCriteria ?? null,
            maxAutoContinuations: input.maxAutoContinuations ?? null,
            createdBy: input.createdBy,
          })
          .returning();
        if (!row) {
          throw new Error("Failed to upsert session goal");
        }
        return { goal: mapSessionGoal(row), replaced: false };
      }
      const [row] = await scopedDb
        .update(schema.sessionGoals)
        .set({
          status: "active",
          text: input.text,
          successCriteria: input.successCriteria ?? null,
          maxAutoContinuations: input.maxAutoContinuations ?? null,
          evidence: null,
          rationale: null,
          pausedReason: null,
          createdBy: input.createdBy,
          version: existing.version + 1,
          autoContinuations: 0,
          noProgressStreak: 0,
          lastContinuationTurnId: null,
          versionAtLastContinuation: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.sessionGoals.id, existing.id))
        .returning();
      if (!row) {
        throw new Error("Failed to upsert session goal");
      }
      return { goal: mapSessionGoal(row), replaced: true };
    },
  );
}

/**
 * goal_update semantics: revise text/criteria without changing status. The
 * version bump counts as progress for the no-progress detector.
 */
export async function updateSessionGoal(
  db: Database,
  workspaceId: string,
  sessionId: string,
  input: {
    text?: string;
    successCriteria?: string | null;
  },
): Promise<SessionGoal> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.sessionGoals)
      .set({
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.successCriteria !== undefined ? { successCriteria: input.successCriteria } : {}),
        version: sql`${schema.sessionGoals.version} + 1`,
        noProgressStreak: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          eq(schema.sessionGoals.sessionId, sessionId),
        ),
      )
      .returning();
    if (!row) {
      throw new Error(`Session goal not found: ${sessionId}`);
    }
    return mapSessionGoal(row);
  });
}

/**
 * Sets a session's display title. The clobber guard lives entirely in this
 * single atomic UPDATE: a user-set title is permanent, so agent/auto writes
 * carry an `AND title_source IS DISTINCT FROM 'user'` guard (NULL-safe in
 * Postgres) while user writes are unconditional. Never read-modify-write.
 * Re-applying the exact title is also a no-op so a confused agent cannot churn
 * `updated_at` every turn. Returns `{ updated, title }`: `updated` is false when
 * the value was unchanged or an agent write was skipped because a user title
 * already pinned the session; `title` is always the resulting stored title when
 * the session exists.
 */
export async function updateSessionTitle(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    title: string;
    source: "user" | "agent";
  },
): Promise<{ updated: boolean; title: string | null }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .update(schema.sessions)
      .set({
        title: input.title,
        titleSource: input.source,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
          sql`${schema.sessions.title} is distinct from ${input.title}`,
          ...(input.source === "agent"
            ? [sql`${schema.sessions.titleSource} is distinct from 'user'`]
            : []),
        ),
      )
      .returning({ title: schema.sessions.title });
    if (row) {
      return { updated: true, title: row.title };
    }
    const [existing] = await scopedDb
      .select({ title: schema.sessions.title })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .limit(1);
    return { updated: false, title: existing?.title ?? null };
  });
}

/**
 * Status transition helper. Idempotent: requesting the current status returns
 * `changed: false` so callers can skip emitting a duplicate event. `completed`
 * is terminal for transitions; only `upsertSessionGoal` can replace a
 * completed goal. Resuming to `active` clears the pause fields and resets the
 * continuation counters.
 */
export async function setSessionGoalStatus(
  db: Database,
  workspaceId: string,
  sessionId: string,
  input: {
    status: SessionGoalStatus;
    evidence?: string;
    rationale?: string;
    pausedReason?: string;
  },
): Promise<{ goal: SessionGoal; changed: boolean; workflowWakeRevision: number | null }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const effectiveControl = await evaluateSessionControl(scopedDb, workspaceId, sessionId, {
      lock: "share",
    });
    const [workspace] = await scopedDb
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .for("update")
      .limit(1);
    const [session] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .for("update")
      .limit(1);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const [existing] = await scopedDb
      .select()
      .from(schema.sessionGoals)
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          eq(schema.sessionGoals.sessionId, sessionId),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) {
      throw new Error(`Session goal not found: ${sessionId}`);
    }
    if (existing.status === input.status) {
      return { goal: mapSessionGoal(existing), changed: false, workflowWakeRevision: null };
    }
    if (existing.status === "completed") {
      throw new Error("session goal is completed; set a new goal to continue");
    }
    const [row] = await scopedDb
      .update(schema.sessionGoals)
      .set({
        status: input.status,
        version: existing.version + 1,
        updatedAt: new Date(),
        ...(input.status === "completed"
          ? {
              evidence: input.evidence ?? null,
              pausedReason: null,
            }
          : {}),
        ...(input.status === "paused"
          ? {
              rationale: input.rationale ?? null,
              pausedReason: input.pausedReason ?? null,
            }
          : {}),
        ...(input.status === "active"
          ? {
              rationale: null,
              pausedReason: null,
              autoContinuations: 0,
              noProgressStreak: 0,
              // A re-armed goal starts a fresh continuation epoch; stale pointers to
              // a pre-pause continuation turn must not feed the progress detector.
              lastContinuationTurnId: null,
              versionAtLastContinuation: null,
            }
          : {}),
      })
      .where(eq(schema.sessionGoals.id, existing.id))
      .returning();
    if (!row) {
      throw new Error(`Session goal not found: ${sessionId}`);
    }
    let workflowWakeRevision: number | null = null;
    if (
      input.status === "active" &&
      session.status !== "cancelled" &&
      session.activeTurnId === null &&
      effectiveControl.state === "active"
    ) {
      workflowWakeRevision = await enqueueSessionWorkflowWakeInTransaction(scopedDb, {
        accountId: session.accountId,
        workspaceId,
        sessionId,
        temporalWorkflowId: session.temporalWorkflowId ?? `session-${sessionId}`,
        reason: "goal_resumed",
      });
    }
    return { goal: mapSessionGoal(row), changed: true, workflowWakeRevision };
  });
}

export async function setSessionGoalLastContinuationTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.sessionGoals)
      .set({
        lastContinuationTurnId: turnId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessionGoals.workspaceId, workspaceId),
          eq(schema.sessionGoals.sessionId, sessionId),
        ),
      );
  });
}

export type GoalContinuationDecision =
  | { decision: "none" }
  | { decision: "queue" }
  | {
      decision: "paused";
      reason: "no_progress" | "max_auto_continuations" | "limits";
      goal: SessionGoal;
    }
  | { decision: "continue"; goal: SessionGoal; autoContinuation: number; cap: number | null };

async function turnHasFailureCodeTx(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  code: string,
): Promise<boolean> {
  const [failure] = await tx
    .select({ id: schema.sessionEvents.id })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        eq(schema.sessionEvents.turnId, turnId),
        eq(schema.sessionEvents.type, "turn.failed"),
        sql`${schema.sessionEvents.payload} ->> 'code' = ${code}`,
      ),
    )
    .limit(1);
  return Boolean(failure);
}

async function latestFinishedTurnHasFailureCodeTx(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  code: string,
): Promise<boolean> {
  const [latestFinished] = await tx
    .select({ id: schema.sessionTurns.id })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        sql`${schema.sessionTurns.finishedAt} is not null`,
      ),
    )
    .orderBy(desc(schema.sessionTurns.position), desc(schema.sessionTurns.createdAt))
    .limit(1);
  return latestFinished
    ? await turnHasFailureCodeTx(tx, workspaceId, sessionId, latestFinished.id, code)
    : false;
}

/**
 * Core continuation decision, taken in one transaction with the goal row
 * locked. Queued work always wins; any non-terminal turn (queued, running, or
 * requires_action awaiting a human approval) blocks auto-continuation. The
 * no-progress and max-continuation guards mutate counters here only, so a
 * replaying workflow re-reads recorded activity results and never recomputes
 * them.
 */
export async function evaluateGoalContinuation(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    // Optional: when absent (the default posture) goals are uncapped and length
    // is governed by the no-progress and budget guards only.
    defaultMaxAutoContinuations?: number | null;
    noProgressLimit: number;
    // Caller-computed billing/limits block reason. Applied inside the locked
    // decision (before the counter bump) so a budget pause never consumes
    // continuation budget.
    budgetBlocked?: string | null;
  },
): Promise<GoalContinuationDecision> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [session] = await tx
          .select({
            id: schema.sessions.id,
          })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [row] = await tx
          .select()
          .from(schema.sessionGoals)
          .where(
            and(
              eq(schema.sessionGoals.workspaceId, input.workspaceId),
              eq(schema.sessionGoals.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!session || effectiveControl.state !== "active") {
          return { decision: "none" } as const;
        }
        if (!row || row.status !== "active") {
          return { decision: "none" } as const;
        }
        const [pendingTurn] = await tx
          .select({ id: schema.sessionTurns.id, status: schema.sessionTurns.status })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              inArray(schema.sessionTurns.status, ["queued", "running", "requires_action"]),
            ),
          )
          .limit(1);
        if (pendingTurn) {
          // "queue" tells the workflow to claim immediately; running/requires_action
          // turns (e.g. a pending approval on a restarted workflow) must not be
          // bypassed by a continuation, so they decline instead.
          return pendingTurn.status === "queued"
            ? ({ decision: "queue" } as const)
            : ({ decision: "none" } as const);
        }
        const [latestFinished] = await tx
          .select({ id: schema.sessionTurns.id })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              sql`${schema.sessionTurns.finishedAt} is not null`,
            ),
          )
          .orderBy(desc(schema.sessionTurns.position), desc(schema.sessionTurns.createdAt))
          .limit(1);
        const contextCompactionFailure = latestFinished
          ? await turnHasFailureCodeTx(
              tx as unknown as Database,
              input.workspaceId,
              input.sessionId,
              latestFinished.id,
              "context_compaction_failed",
            )
          : false;
        // A provider could not produce a durable checkpoint for the latest
        // inference. Re-running the unchanged active history autonomously only
        // repeats the same failure. Keep the active goal intact but inert until
        // a human/API prompt, agent Steer instruction, or explicit Compact
        // attempt creates newer truth. Ordinary internal updates stay pending;
        // this never creates queue work or consumes counters.
        if (contextCompactionFailure) {
          return { decision: "none" } as const;
        }
        let autoContinuations = row.autoContinuations;
        let noProgressStreak = row.noProgressStreak;
        // P3: a 429-failover continuation (the last continuation turn carried the `rotated`
        // marker) is a multi-account rotate, not goal progress OR a goal stall — it must not
        // burn the auto-continuation budget while walking accounts. Freezes the increment below,
        // mirroring the budget-pause precedent that a limits pause never consumes budget.
        let rotatedFailover = false;
        if (row.lastContinuationTurnId) {
          const lastFinished = latestFinished;
          if (lastFinished && lastFinished.id !== row.lastContinuationTurnId) {
            // A user/scheduled turn ran since the last continuation: human
            // re-engagement re-arms the auto-continuation budget.
            autoContinuations = 0;
            noProgressStreak = 0;
          } else if (lastFinished) {
            const [{ rotatedFailures } = { rotatedFailures: 0 }] = await tx
              .select({
                rotatedFailures: sql<number>`count(*)::int`,
              })
              .from(schema.sessionEvents)
              .where(
                and(
                  eq(schema.sessionEvents.workspaceId, input.workspaceId),
                  eq(schema.sessionEvents.turnId, row.lastContinuationTurnId),
                  eq(schema.sessionEvents.type, "turn.failed"),
                  sql`${schema.sessionEvents.payload} ->> 'rotated' = 'true'`,
                ),
              );
            rotatedFailover = Number(rotatedFailures) > 0;
            const [{ toolCalls } = { toolCalls: 0 }] = await tx
              .select({
                toolCalls: sql<number>`count(*)::int`,
              })
              .from(schema.sessionEvents)
              .where(
                and(
                  eq(schema.sessionEvents.workspaceId, input.workspaceId),
                  eq(schema.sessionEvents.turnId, row.lastContinuationTurnId),
                  eq(schema.sessionEvents.type, "agent.toolCall.created"),
                ),
              );
            const goalRevised =
              row.versionAtLastContinuation !== null && row.version > row.versionAtLastContinuation;
            if (Number(toolCalls) > 0 || goalRevised) {
              noProgressStreak = 0;
            } else {
              // A turn that died on retryable provider backpressure says nothing
              // about whether the goal can progress; freezing the streak keeps a
              // sustained rate-limit window from masquerading as a stuck goal.
              // The auto-continuation cap remains the backstop for a real outage.
              const [{ backpressureFailures } = { backpressureFailures: 0 }] = await tx
                .select({
                  backpressureFailures: sql<number>`count(*)::int`,
                })
                .from(schema.sessionEvents)
                .where(
                  and(
                    eq(schema.sessionEvents.workspaceId, input.workspaceId),
                    eq(schema.sessionEvents.turnId, row.lastContinuationTurnId),
                    eq(schema.sessionEvents.type, "turn.failed"),
                    sql`${schema.sessionEvents.payload} ->> 'recovery' = 'goal_continuation'`,
                  ),
                );
              if (Number(backpressureFailures) === 0) {
                noProgressStreak = noProgressStreak + 1;
              }
            }
          }
        }
        if (noProgressStreak >= input.noProgressLimit) {
          const [paused] = await tx
            .update(schema.sessionGoals)
            .set({
              status: "paused",
              pausedReason: "no_progress",
              autoContinuations,
              noProgressStreak,
              version: row.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.sessionGoals.id, row.id))
            .returning();
          return {
            decision: "paused",
            reason: "no_progress",
            goal: mapSessionGoal(paused!),
          } as const;
        }
        // No configured default means uncapped: goal length is bounded by the
        // no-progress and budget guards above, never by count. When a default is
        // configured it is a hard ceiling; per-goal overrides can only lower it.
        const capCandidates = [row.maxAutoContinuations, input.defaultMaxAutoContinuations].filter(
          (value): value is number => typeof value === "number",
        );
        const cap = capCandidates.length > 0 ? Math.min(...capCandidates) : null;
        if (cap !== null && autoContinuations >= cap) {
          const [paused] = await tx
            .update(schema.sessionGoals)
            .set({
              status: "paused",
              pausedReason: "max_auto_continuations",
              autoContinuations,
              noProgressStreak,
              version: row.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.sessionGoals.id, row.id))
            .returning();
          return {
            decision: "paused",
            reason: "max_auto_continuations",
            goal: mapSessionGoal(paused!),
          } as const;
        }
        if (input.budgetBlocked) {
          // Budget exhaustion pauses the goal visibly without bumping the
          // continuation counter — no turn is synthesized for this pass.
          const [paused] = await tx
            .update(schema.sessionGoals)
            .set({
              status: "paused",
              pausedReason: "limits",
              rationale: input.budgetBlocked,
              autoContinuations,
              noProgressStreak,
              version: row.version + 1,
              updatedAt: new Date(),
            })
            .where(eq(schema.sessionGoals.id, row.id))
            .returning();
          return { decision: "paused", reason: "limits", goal: mapSessionGoal(paused!) } as const;
        }
        // Freeze the counter on a rotation failover (invariant: a rotation walk never
        // consumes continuation budget); a normal continuation increments as before.
        const nextAutoContinuations = autoContinuations + (rotatedFailover ? 0 : 1);
        const [updated] = await tx
          .update(schema.sessionGoals)
          .set({
            autoContinuations: nextAutoContinuations,
            noProgressStreak,
            versionAtLastContinuation: row.version,
            updatedAt: new Date(),
          })
          .where(eq(schema.sessionGoals.id, row.id))
          .returning();
        return {
          decision: "continue",
          goal: mapSessionGoal(updated!),
          autoContinuation: nextAutoContinuations,
          cap,
        } as const;
      }),
  );
}

function mapSessionGoal(row: typeof schema.sessionGoals.$inferSelect): SessionGoal {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    status: row.status as SessionGoal["status"],
    text: row.text,
    successCriteria: row.successCriteria,
    evidence: row.evidence,
    rationale: row.rationale,
    pausedReason: row.pausedReason,
    createdBy: row.createdBy as SessionGoal["createdBy"],
    version: row.version,
    autoContinuations: row.autoContinuations,
    noProgressStreak: row.noProgressStreak,
    maxAutoContinuations: row.maxAutoContinuations,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type InitializeSessionStartInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  clientEventId?: string;
  reasoningEffortFallback: ReasoningEffort;
  createdEventPayload: Record<string, unknown>;
  goal?: {
    text: string;
    successCriteria?: string | null;
    maxAutoContinuations?: number | null;
  } | null;
};

export type InitializeSessionStartResult = {
  events: SessionEvent[];
  turn: SessionTurn | null;
  temporalWorkflowId: string;
  workflowWakeRevision: number | null;
};

/**
 * Install a newly created session's complete first runnable unit atomically.
 * The canonical user event, optional goal, queued turn, public status, and
 * workflow wake revision either all commit or all roll back. Retrying the same
 * create repairs any pre-transaction partial state and emits only missing
 * records; it never creates a second initial turn.
 */
export async function initializeSessionStartAtomically(
  db: Database,
  input: InitializeSessionStartInput,
): Promise<InitializeSessionStartResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [workspace] = await tx
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!workspace || !session) throw new Error(`Session not found: ${input.sessionId}`);

        const temporalWorkflowId = session.temporalWorkflowId ?? `session-${session.id}`;
        if (session.status === "cancelled") {
          return {
            events: [],
            turn: null,
            temporalWorkflowId,
            workflowWakeRevision: null,
          };
        }

        let [goal] = await tx
          .select()
          .from(schema.sessionGoals)
          .where(
            and(
              eq(schema.sessionGoals.workspaceId, input.workspaceId),
              eq(schema.sessionGoals.sessionId, session.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!goal && input.goal) {
          [goal] = await tx
            .insert(schema.sessionGoals)
            .values({
              accountId: session.accountId,
              workspaceId: input.workspaceId,
              sessionId: session.id,
              text: input.goal.text,
              successCriteria: input.goal.successCriteria ?? null,
              maxAutoContinuations: input.goal.maxAutoContinuations ?? null,
              createdBy: "api",
            })
            .returning();
          if (!goal) throw new Error("Failed to create initial session goal");
        }

        let [userEvent] = await tx
          .select()
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, input.workspaceId),
              eq(schema.sessionEvents.sessionId, session.id),
              eq(schema.sessionEvents.type, "user.message"),
            ),
          )
          .orderBy(asc(schema.sessionEvents.sequence))
          .limit(1);
        let sequence = session.lastSequence;
        const insertedEvents: Array<typeof schema.sessionEvents.$inferSelect> = [];
        const runnable = effectiveControl.state === "active";
        const publicQueuedStatus: SessionStatus = "queued";

        if (!userEvent) {
          const initialPayload = {
            text: session.initialMessage,
            ...(session.resources.length ? { resources: session.resources } : {}),
            ...(session.tools.length ? { tools: session.tools } : {}),
          };
          const rows = await tx
            .insert(schema.sessionEvents)
            .values([
              {
                accountId: session.accountId,
                workspaceId: input.workspaceId,
                sessionId: session.id,
                sequence: ++sequence,
                type: "session.created",
                payload: sanitizeEventPayload({
                  ...input.createdEventPayload,
                  status: publicQueuedStatus,
                }),
              },
              ...(goal
                ? [
                    {
                      accountId: session.accountId,
                      workspaceId: input.workspaceId,
                      sessionId: session.id,
                      sequence: ++sequence,
                      type: "goal.set" as const,
                      payload: sanitizeEventPayload({
                        goalId: goal.id,
                        text: goal.text,
                        ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
                        version: goal.version,
                        actor: "api",
                        replaced: false,
                      }),
                    },
                  ]
                : []),
              {
                accountId: session.accountId,
                workspaceId: input.workspaceId,
                sessionId: session.id,
                sequence: ++sequence,
                type: "user.message",
                payload: sanitizeEventPayload(initialPayload),
                clientEventId: input.clientEventId ?? `session-initial:${session.id}`,
              },
              {
                accountId: session.accountId,
                workspaceId: input.workspaceId,
                sessionId: session.id,
                sequence: ++sequence,
                type: "session.status.changed",
                payload: sanitizeEventPayload({ status: publicQueuedStatus }),
              },
            ])
            .returning();
          insertedEvents.push(...rows);
          userEvent = rows.find((event) => event.type === "user.message");
          if (!userEvent) throw new Error("Failed to create initial user event");
        }

        let [turn] = await tx
          .select()
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.sessionId, session.id),
              eq(schema.sessionTurns.triggerEventId, userEvent.id),
            ),
          )
          .orderBy(asc(schema.sessionTurns.createdAt))
          .limit(1);
        let insertedTurn = false;
        let queueTailPosition = Number(session.queueTailPosition);
        if (!turn) {
          queueTailPosition += 1;
          [turn] = await tx
            .insert(schema.sessionTurns)
            .values({
              accountId: session.accountId,
              workspaceId: input.workspaceId,
              sessionId: session.id,
              triggerEventId: userEvent.id,
              temporalWorkflowId,
              status: "queued",
              source: "user",
              position: queueTailPosition,
              prompt: session.initialMessage,
              resources: session.resources,
              tools: session.tools,
              model: session.model,
              reasoningEffort: reasoningEffortForMetadata(
                session.metadata,
                input.reasoningEffortFallback,
              ),
              sandboxBackend: session.sandboxBackend,
              sandboxOs: session.sandboxOs,
              metadata: {},
              lineage: {},
            })
            .returning();
          if (!turn) throw new Error("Failed to create initial session turn");
          insertedTurn = true;
        }

        const [queuedEvent] = await tx
          .select({ id: schema.sessionEvents.id })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, input.workspaceId),
              eq(schema.sessionEvents.sessionId, session.id),
              eq(schema.sessionEvents.turnId, turn.id),
              eq(schema.sessionEvents.type, "turn.queued"),
            ),
          )
          .limit(1);
        if (!queuedEvent) {
          const [event] = await tx
            .insert(schema.sessionEvents)
            .values({
              accountId: session.accountId,
              workspaceId: input.workspaceId,
              sessionId: session.id,
              turnId: turn.id,
              sequence: ++sequence,
              type: "turn.queued",
              payload: sanitizeEventPayload({
                turnId: turn.id,
                triggerEventId: userEvent.id,
                source: turn.source,
              }),
            })
            .returning();
          if (!event) throw new Error("Failed to create initial turn event");
          insertedEvents.push(event);
        }

        const turnNeedsWake = turn.status === "queued" && runnable;
        await tx
          .update(schema.sessions)
          .set({
            temporalWorkflowId,
            lastSequence: sequence,
            ...(insertedTurn
              ? {
                  queueVersion: session.queueVersion + 1,
                  queueTailPosition,
                }
              : {}),
            ...(turn.status === "queued" ? { status: publicQueuedStatus } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, session.id),
            ),
          );
        const workflowWakeRevision = turnNeedsWake
          ? await enqueueSessionWorkflowWakeInTransaction(tx as unknown as Database, {
              accountId: session.accountId,
              workspaceId: input.workspaceId,
              sessionId: session.id,
              temporalWorkflowId,
              reason: "initial_session",
            })
          : null;
        return {
          events: insertedEvents.map(mapEvent),
          turn: mapSessionTurn(turn),
          temporalWorkflowId,
          workflowWakeRevision,
        };
      }),
  );
}

export async function enqueueSessionTurn(
  db: Database,
  input: EnqueueSessionTurnInput,
): Promise<SessionTurn> {
  if (input.source !== "user" && input.source !== "api") {
    throw new Error("Only human prompts may enter the visible session queue");
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [lockedSession] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!lockedSession) {
          throw new Error(`Session not found: ${input.sessionId}`);
        }
        const atHead = input.placement === "head";
        const position = atHead
          ? Number(lockedSession.queueHeadPosition) - 1
          : Number(lockedSession.queueTailPosition) + 1;
        const [row] = await tx
          .insert(schema.sessionTurns)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            triggerEventId: input.triggerEventId,
            temporalWorkflowId: input.temporalWorkflowId,
            status: "queued",
            source: input.source,
            position,
            prompt: input.prompt,
            resources: input.resources,
            tools: input.tools,
            model: input.model,
            reasoningEffort: input.reasoningEffort,
            sandboxBackend: input.sandboxBackend,
            sandboxOs: input.sandboxOs ?? null,
            metadata: input.metadata,
            lineage: input.lineage ?? {},
          })
          .returning();
        if (!row) {
          throw new Error("Failed to enqueue session turn");
        }
        await tx
          .update(schema.sessions)
          .set({
            queueVersion: lockedSession.queueVersion + 1,
            ...(atHead ? { queueHeadPosition: position } : { queueTailPosition: position }),
            status:
              effectiveControl.state === "active" && lockedSession.activeTurnId === null
                ? "queued"
                : lockedSession.status,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );
        return mapSessionTurn(row);
      }),
  );
}

export type SessionWorkTrigger = { kind: "next" } | { kind: "approval"; triggerEventId: string };

export const MAX_INTERNAL_UPDATE_BYTES = 64 * 1024;
export const MAX_INTERNAL_UPDATE_BATCH_MEMBERS = 100;
export const MAX_INTERNAL_UPDATE_BATCH_BYTES = 256 * 1024;

export type ClaimSessionWorkForAttemptInput = {
  sessionId: string;
  workflowId: string;
  workflowRunId: string;
  attemptId: string;
  dispatchId: string;
  trigger: SessionWorkTrigger;
};

export type ClaimSessionWorkForAttemptResult =
  | { action: "claimed"; turn: SessionTurn }
  | {
      action: "unclaimed";
      reason: "gate-closed" | "no-work" | "stale-approval" | "control-pending";
    };

/**
 * Claim and register one inference attempt after a turn worker has accepted the
 * Temporal activity. This is the only transition into `running`: queue choice,
 * execution generation, active attempt identity, dispatch identity, and the
 * session's public state commit atomically under the workspace/session lock.
 */
export async function claimSessionWorkForAttempt(
  db: Database,
  workspaceId: string,
  input: ClaimSessionWorkForAttemptInput,
): Promise<ClaimSessionWorkForAttemptResult> {
  const { sessionId, workflowId } = input;
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const deliverPendingUpdates = async (
          accountId: string,
          turnId: string,
          turnGeneration: number,
          nextSequence: number,
          occurredAt: Date,
          triggerEventId?: string,
        ): Promise<{
          count: number;
          lastSequence: number;
          triggerEventId: string | null;
          updates: Array<typeof schema.sessionSystemUpdates.$inferSelect>;
        }> => {
          const [agentSteer] = await tx
            .select()
            .from(schema.sessionSystemUpdates)
            .where(
              and(
                eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
                eq(schema.sessionSystemUpdates.sessionId, sessionId),
                inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
                eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
              ),
            )
            .orderBy(
              desc(schema.sessionSystemUpdates.createdAt),
              desc(schema.sessionSystemUpdates.id),
            )
            .limit(1)
            .for("update");
          if (agentSteer) {
            await tx
              .update(schema.sessionSystemUpdates)
              .set({ state: "superseded" })
              .where(
                and(
                  eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
                  eq(schema.sessionSystemUpdates.sessionId, sessionId),
                  eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
                  inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
                  ne(schema.sessionSystemUpdates.id, agentSteer.id),
                ),
              );
          }
          const ordinary = await tx
            .select()
            .from(schema.sessionSystemUpdates)
            .where(
              and(
                eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
                eq(schema.sessionSystemUpdates.sessionId, sessionId),
                inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
                ne(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
              ),
            )
            .orderBy(
              asc(schema.sessionSystemUpdates.createdAt),
              asc(schema.sessionSystemUpdates.id),
            )
            .limit(MAX_INTERNAL_UPDATE_BATCH_MEMBERS + (agentSteer ? 0 : 1))
            .for("update");
          const updates = agentSteer ? [agentSteer, ...ordinary] : ordinary;
          if (updates.length === 0) {
            return { count: 0, lastSequence: nextSequence - 1, triggerEventId: null, updates: [] };
          }
          const deliverable: typeof updates = [];
          let deliveredBytes = 0;
          for (const update of updates) {
            const payload = update.payload;
            if (payload.type === "goal_continuation") {
              const goalId = typeof payload.goalId === "string" ? payload.goalId : null;
              const goalVersion =
                typeof payload.goalVersion === "number" ? payload.goalVersion : null;
              const [goal] = goalId
                ? await tx
                    .select({
                      status: schema.sessionGoals.status,
                      version: schema.sessionGoals.version,
                    })
                    .from(schema.sessionGoals)
                    .where(
                      and(
                        eq(schema.sessionGoals.workspaceId, workspaceId),
                        eq(schema.sessionGoals.sessionId, sessionId),
                        eq(schema.sessionGoals.id, goalId),
                      ),
                    )
                    .for("update")
                    .limit(1)
                : [];
              if (!goal || goal.status !== "active" || goal.version !== goalVersion) {
                await tx
                  .update(schema.sessionSystemUpdates)
                  .set({ state: "cancelled" })
                  .where(eq(schema.sessionSystemUpdates.id, update.id));
                continue;
              }
            }
            const updateBytes = Buffer.byteLength(
              JSON.stringify({
                id: update.id,
                kind: update.kind,
                classification: update.classification,
                sourceId: update.sourceId,
                summary: update.summary,
                payload: update.payload,
                lineage: update.lineage,
              }),
            );
            if (
              deliverable.length >= MAX_INTERNAL_UPDATE_BATCH_MEMBERS ||
              deliveredBytes + updateBytes > MAX_INTERNAL_UPDATE_BATCH_BYTES
            ) {
              break;
            }
            deliverable.push(update);
            deliveredBytes += updateBytes;
          }
          if (deliverable.length === 0) {
            return { count: 0, lastSequence: nextSequence - 1, triggerEventId: null, updates: [] };
          }
          await tx
            .update(schema.sessionSystemUpdates)
            .set({ state: "delivered", deliveredTurnId: turnId, deliveredAt: occurredAt })
            .where(
              and(
                eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
                eq(schema.sessionSystemUpdates.sessionId, sessionId),
                inArray(
                  schema.sessionSystemUpdates.id,
                  deliverable.map((update) => update.id),
                ),
              ),
            );
          const eventId = triggerEventId ?? crypto.randomUUID();
          await tx.insert(schema.sessionEvents).values({
            id: eventId,
            accountId,
            workspaceId,
            sessionId,
            turnId,
            turnGeneration,
            turnAttemptId: input.attemptId,
            turnAssociation: "current",
            sequence: nextSequence,
            type: "system.update.delivered",
            payload: sanitizeEventPayload({
              updateIds: deliverable.map((update) => update.id),
              count: deliverable.length,
              classifications: [...new Set(deliverable.map((update) => update.classification))],
            }),
            occurredAt,
          });
          return {
            count: deliverable.length,
            lastSequence: nextSequence,
            triggerEventId: eventId,
            updates: deliverable,
          };
        };

        // Capacity settlement and resume use session -> turn after their
        // workspace rotation lock. Claiming must preserve that shared order:
        // taking a queued turn first can deadlock with a settlement that owns
        // the session and is waiting for the same turn.
        const workspaceControl = await lockWorkspaceInferenceControl(
          tx as unknown as Database,
          workspaceId,
          "share",
        );
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          workspaceId,
          sessionId,
          { lock: "share" },
        );
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          )
          .for("update")
          .limit(1);
        if (!session) return { action: "unclaimed", reason: "no-work" };
        if (effectiveControl.state !== "active") {
          return { action: "unclaimed", reason: "gate-closed" };
        }
        // Quiescence is a session-wide admission fence, not a property of one
        // queue row. The user may delete/reorder the original Steer replacement
        // while its predecessor is still stopping, and recovery/internal-update
        // claimers must remain blocked just the same. The session lock serializes
        // this read with markSessionAttemptQuiesced's receipt transaction.
        const [unquiescedInterruption] = await tx
          .select({ attemptId: schema.sessionAttemptInterruptions.attemptId })
          .from(schema.sessionAttemptInterruptions)
          .innerJoin(
            schema.sessionTurnAttempts,
            and(
              eq(
                schema.sessionTurnAttempts.workspaceId,
                schema.sessionAttemptInterruptions.workspaceId,
              ),
              eq(schema.sessionTurnAttempts.id, schema.sessionAttemptInterruptions.attemptId),
            ),
          )
          .where(
            and(
              eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
              eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
              isNull(schema.sessionTurnAttempts.quiescedAt),
            ),
          )
          .orderBy(desc(schema.sessionAttemptInterruptions.requestedAt))
          .limit(1);
        if (unquiescedInterruption) {
          return { action: "unclaimed", reason: "control-pending" };
        }
        const registerAttempt = async (turn: typeof schema.sessionTurns.$inferSelect) =>
          await registerSessionTurnAttemptClaim(tx as unknown as Database, {
            id: input.attemptId,
            accountId: session.accountId,
            workspaceId,
            sessionId,
            turnId: turn.id,
            executionGeneration: turn.executionGeneration,
            temporalWorkflowId: workflowId,
            temporalWorkflowRunId: input.workflowRunId,
            temporalActivityId: input.dispatchId,
            verifiedControlRevision: Number(workspaceControl.revision),
          });
        if (session.activeTurnId !== null) {
          const [activeTurn] = await tx
            .select()
            .from(schema.sessionTurns)
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, workspaceId),
                eq(schema.sessionTurns.sessionId, sessionId),
                eq(schema.sessionTurns.id, session.activeTurnId),
              ),
            )
            .for("update")
            .limit(1);
          const parsedDispatch = readTurnDispatchMetadata(activeTurn?.metadata);
          if (parsedDispatch.kind === "malformed") {
            throw new Error(`Malformed turn dispatch metadata: ${parsedDispatch.reason}`);
          }
          const [pendingInterruption] = activeTurn?.activeAttemptId
            ? await tx
                .select({ id: schema.sessionAttemptInterruptions.id })
                .from(schema.sessionAttemptInterruptions)
                .where(
                  and(
                    eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
                    eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
                    eq(schema.sessionAttemptInterruptions.attemptId, activeTurn.activeAttemptId),
                    inArray(schema.sessionAttemptInterruptions.state, [
                      "pending",
                      "delivered",
                      "acknowledged",
                    ]),
                  ),
                )
                .limit(1)
            : [];
          if (pendingInterruption) {
            return { action: "unclaimed", reason: "control-pending" };
          }
          if (
            activeTurn?.status === "running" &&
            activeTurn.activeAttemptId === input.attemptId &&
            parsedDispatch.attempt?.id === input.dispatchId
          ) {
            await registerAttempt(activeTurn);
            return { action: "claimed", turn: mapSessionTurn(activeTurn) };
          }
          if (activeTurn?.status === "requires_action") {
            if (input.trigger.kind !== "approval") {
              return { action: "unclaimed", reason: "no-work" };
            }
            const advancesApproval = await isNewerApprovalTrigger(
              tx as unknown as Database,
              workspaceId,
              sessionId,
              activeTurn.triggerEventId,
              input.trigger.triggerEventId,
            );
            if (!advancesApproval) {
              return { action: "unclaimed", reason: "stale-approval" };
            }
            if (parsedDispatch.generation >= Number.MAX_SAFE_INTEGER) {
              throw new Error("Turn dispatch generation exhausted; refusing to wrap or reuse it");
            }
            const now = new Date();
            const dispatchGeneration = parsedDispatch.generation + 1;
            await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
            const [resumed] = await tx
              .update(schema.sessionTurns)
              .set({
                status: "running",
                triggerEventId: input.trigger.triggerEventId,
                temporalWorkflowId: workflowId,
                executionGeneration: sql`${schema.sessionTurns.executionGeneration} + 1`,
                activeAttemptId: input.attemptId,
                metadata: metadataWithTurnDispatchAttempt(activeTurn.metadata, {
                  id: input.dispatchId,
                  generation: dispatchGeneration,
                  triggerEventId: input.trigger.triggerEventId,
                }),
                version: sql`${schema.sessionTurns.version} + 1`,
                startedAt: now,
                finishedAt: null,
                updatedAt: now,
              })
              .where(eq(schema.sessionTurns.id, activeTurn.id))
              .returning();
            if (!resumed) throw new Error(`Approval turn not found: ${activeTurn.id}`);
            await tx
              .update(schema.sessions)
              .set({ status: "running", updatedAt: now })
              .where(eq(schema.sessions.id, sessionId));
            await registerAttempt(resumed);
            return { action: "claimed", turn: mapSessionTurn(resumed) };
          }
          if (activeTurn?.status === "recovering" || activeTurn?.status === "waiting_capacity") {
            if (input.trigger.kind !== "next") {
              return { action: "unclaimed", reason: "stale-approval" };
            }
            if (activeTurn.status === "waiting_capacity") {
              const [waiter] = await tx
                .select({ id: schema.codexCapacityWaiters.id })
                .from(schema.codexCapacityWaiters)
                .where(
                  and(
                    eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
                    eq(schema.codexCapacityWaiters.sessionId, sessionId),
                    eq(schema.codexCapacityWaiters.status, "waiting"),
                  ),
                )
                .limit(1);
              if (waiter) return { action: "unclaimed", reason: "no-work" };
            }
            if (parsedDispatch.generation >= Number.MAX_SAFE_INTEGER) {
              throw new Error("Turn dispatch generation exhausted; refusing to wrap or reuse it");
            }
            const now = new Date();
            const dispatchGeneration = parsedDispatch.generation + 1;
            await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
            const [resumed] = await tx
              .update(schema.sessionTurns)
              .set({
                status: "running",
                temporalWorkflowId: workflowId,
                executionGeneration: sql`${schema.sessionTurns.executionGeneration} + 1`,
                activeAttemptId: input.attemptId,
                metadata: metadataWithTurnDispatchAttempt(activeTurn.metadata, {
                  id: input.dispatchId,
                  generation: dispatchGeneration,
                  triggerEventId: activeTurn.triggerEventId,
                }),
                version: sql`${schema.sessionTurns.version} + 1`,
                startedAt: now,
                finishedAt: null,
                updatedAt: now,
              })
              .where(eq(schema.sessionTurns.id, activeTurn.id))
              .returning();
            if (!resumed) throw new Error(`Recovering turn not found: ${activeTurn.id}`);
            await tx
              .update(schema.sessions)
              .set({
                status: "running",
                updatedAt: now,
              })
              .where(eq(schema.sessions.id, sessionId));
            await registerAttempt(resumed);
            return { action: "claimed", turn: mapSessionTurn(resumed) };
          }
          if (activeTurn?.status === "running") {
            return { action: "unclaimed", reason: "no-work" };
          }
          throw new Error(
            `Session ${sessionId} has non-runnable active turn ${session.activeTurnId} (${activeTurn?.status ?? "missing"})`,
          );
        }

        // Row Steer deliberately detaches the superseded logical turn from the
        // session before its exact executing attempt has acknowledged the
        // interruption. The first-class live attempt remains the sandbox/write
        // owner during that short interval. Never let the replacement claim
        // until settlement closes that owner; otherwise the live-session
        // uniqueness fence would surface as an opaque database error and, more
        // importantly, two attempts could contend for the same session state.
        const [detachedLiveAttempt] = await tx
          .select({ id: schema.sessionTurnAttempts.id })
          .from(schema.sessionTurnAttempts)
          .where(
            and(
              eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
              eq(schema.sessionTurnAttempts.sessionId, sessionId),
              inArray(schema.sessionTurnAttempts.state, ["claimed", "running"]),
            ),
          )
          .for("update")
          .limit(1);
        if (detachedLiveAttempt) {
          return { action: "unclaimed", reason: "control-pending" };
        }

        if (input.trigger.kind === "approval") {
          return { action: "unclaimed", reason: "stale-approval" };
        }

        const [pendingAgentSteer] = await tx
          .select({ id: schema.sessionSystemUpdates.id })
          .from(schema.sessionSystemUpdates)
          .where(
            and(
              eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
              eq(schema.sessionSystemUpdates.sessionId, sessionId),
              eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
              inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
            ),
          )
          .orderBy(
            desc(schema.sessionSystemUpdates.createdAt),
            desc(schema.sessionSystemUpdates.id),
          )
          .limit(1)
          .for("update");
        const rows = pendingAgentSteer
          ? []
          : await rawRows<{
              id: string;
              trigger_event_id: string;
              metadata: Record<string, unknown>;
            }>(
              tx as unknown as Database,
              sql`select id, trigger_event_id, metadata from session_turns
              where workspace_id = ${workspaceId} and session_id = ${sessionId}
                and status = 'queued' and source in ('user', 'api')
              order by position asc, created_at asc, id asc
              for update skip locked limit 1`,
            );
        const queuedTurn = rows[0];
        const id = queuedTurn?.id;
        if (!id) {
          // Manual compaction is a first-class maintenance execution, never
          // prompt queue work. A waiting human/API prompt stays ahead because
          // its normal turn will consume the same durable request before its
          // first model call. Only an otherwise-idle session creates this
          // born-running execution so compaction happens immediately without a
          // fake conversation message, tools, or sandbox work.
          if (session.compactRequested) {
            const now = new Date();
            const turnId = crypto.randomUUID();
            const triggerEventId = crypto.randomUUID();
            const dispatchGeneration = 1;
            const [{ position } = { position: 1 }] = await tx
              .select({
                position: sql<number>`coalesce(max(${schema.sessionTurns.position}), 0) + 1`,
              })
              .from(schema.sessionTurns)
              .where(
                and(
                  eq(schema.sessionTurns.workspaceId, workspaceId),
                  eq(schema.sessionTurns.sessionId, sessionId),
                ),
              );
            const [latestStarted] = await tx
              .select({
                model: schema.sessionTurns.model,
                reasoningEffort: schema.sessionTurns.reasoningEffort,
                sandboxBackend: schema.sessionTurns.sandboxBackend,
                sandboxOs: schema.sessionTurns.sandboxOs,
              })
              .from(schema.sessionTurns)
              .where(
                and(
                  eq(schema.sessionTurns.workspaceId, workspaceId),
                  eq(schema.sessionTurns.sessionId, sessionId),
                  sql`${schema.sessionTurns.startedAt} is not null`,
                ),
              )
              .orderBy(desc(schema.sessionTurns.startedAt), desc(schema.sessionTurns.createdAt))
              .limit(1);
            await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
            const [compactionTurn] = await tx
              .insert(schema.sessionTurns)
              .values({
                id: turnId,
                accountId: session.accountId,
                workspaceId,
                sessionId,
                triggerEventId,
                temporalWorkflowId: workflowId,
                status: "running",
                executionGeneration: 1,
                activeAttemptId: input.attemptId,
                source: "compaction",
                position: Number(position),
                prompt: "",
                resources: [],
                tools: [],
                model: latestStarted?.model ?? session.model,
                reasoningEffort: reasoningEffortForMetadata(
                  { reasoningEffort: latestStarted?.reasoningEffort },
                  reasoningEffortForMetadata(session.metadata, "medium"),
                ),
                sandboxBackend: latestStarted?.sandboxBackend ?? session.sandboxBackend,
                sandboxOs: latestStarted?.sandboxOs ?? session.sandboxOs,
                metadata: metadataWithTurnDispatchAttempt(
                  { executionKind: "context_compaction" },
                  {
                    id: input.dispatchId,
                    generation: dispatchGeneration,
                    triggerEventId,
                  },
                ),
                startedAt: now,
              })
              .returning();
            if (!compactionTurn) throw new Error("Failed to create context compaction execution");
            const [requestedEvent] = await tx
              .insert(schema.sessionEvents)
              .values({
                id: triggerEventId,
                accountId: session.accountId,
                workspaceId,
                sessionId,
                turnId,
                turnGeneration: compactionTurn.executionGeneration,
                turnAttemptId: input.attemptId,
                turnAssociation: "current",
                sequence: session.lastSequence + 1,
                type: "session.context.compaction.requested",
                payload: { trigger: "operator" },
                occurredAt: now,
              })
              .returning();
            if (!requestedEvent) {
              throw new Error("Failed to create context compaction trigger event");
            }
            await tx
              .update(schema.sessions)
              .set({
                status: "running",
                activeTurnId: turnId,
                lastSequence: session.lastSequence + 1,
                updatedAt: now,
              })
              .where(
                and(
                  eq(schema.sessions.workspaceId, workspaceId),
                  eq(schema.sessions.id, sessionId),
                ),
              );
            await registerAttempt(compactionTurn);
            return { action: "claimed", turn: mapSessionTurn(compactionTurn) };
          }

          if (
            !pendingAgentSteer &&
            (await latestFinishedTurnHasFailureCodeTx(
              tx as unknown as Database,
              workspaceId,
              sessionId,
              "context_compaction_failed",
            ))
          ) {
            // Ordinary machine updates must not turn one failed compaction into
            // an autonomous retry loop. They remain pending and will attach to
            // the next human/API, Steer, or explicitly requested Compact run.
            return { action: "unclaimed", reason: "no-work" };
          }

          const pendingUpdates = await tx
            .select({ id: schema.sessionSystemUpdates.id })
            .from(schema.sessionSystemUpdates)
            .where(
              and(
                eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
                eq(schema.sessionSystemUpdates.sessionId, sessionId),
                eq(schema.sessionSystemUpdates.state, "pending"),
              ),
            )
            .limit(1)
            .for("update");
          if (pendingUpdates.length === 0) {
            return { action: "unclaimed", reason: "no-work" };
          }

          const now = new Date();
          const turnId = crypto.randomUUID();
          const triggerEventId = crypto.randomUUID();
          const [{ position } = { position: 1 }] = await tx
            .select({
              position: sql<number>`coalesce(max(${schema.sessionTurns.position}), 0) + 1`,
            })
            .from(schema.sessionTurns)
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, workspaceId),
                eq(schema.sessionTurns.sessionId, sessionId),
              ),
            );
          const delivered = await deliverPendingUpdates(
            session.accountId,
            turnId,
            1,
            session.lastSequence + 1,
            now,
            triggerEventId,
          );
          if (delivered.count === 0) {
            return { action: "unclaimed", reason: "no-work" };
          }
          const goalUpdate = delivered.updates.find(
            (update) => update.payload.type === "goal_continuation",
          );
          const goalPolicy =
            goalUpdate?.payload.policy && typeof goalUpdate.payload.policy === "object"
              ? (goalUpdate.payload.policy as Record<string, unknown>)
              : null;
          const [latestStarted] = await tx
            .select({
              model: schema.sessionTurns.model,
              reasoningEffort: schema.sessionTurns.reasoningEffort,
              tools: schema.sessionTurns.tools,
              sandboxBackend: schema.sessionTurns.sandboxBackend,
              sandboxOs: schema.sessionTurns.sandboxOs,
            })
            .from(schema.sessionTurns)
            .where(
              and(
                eq(schema.sessionTurns.workspaceId, workspaceId),
                eq(schema.sessionTurns.sessionId, sessionId),
                sql`${schema.sessionTurns.startedAt} is not null`,
              ),
            )
            .orderBy(desc(schema.sessionTurns.startedAt), desc(schema.sessionTurns.createdAt))
            .limit(1);
          const model =
            typeof goalPolicy?.model === "string"
              ? goalPolicy.model
              : (latestStarted?.model ?? session.model);
          const reasoningEffort = reasoningEffortForMetadata(
            { reasoningEffort: goalPolicy?.reasoningEffort ?? latestStarted?.reasoningEffort },
            reasoningEffortForMetadata(session.metadata, "medium"),
          );
          const tools = Array.isArray(goalPolicy?.tools)
            ? goalPolicy.tools
            : (latestStarted?.tools ?? session.tools);
          const sandboxBackend =
            typeof goalPolicy?.sandboxBackend === "string"
              ? goalPolicy.sandboxBackend
              : (latestStarted?.sandboxBackend ?? session.sandboxBackend);
          await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
          const [internalTurn] = await tx
            .insert(schema.sessionTurns)
            .values({
              id: turnId,
              accountId: session.accountId,
              workspaceId,
              sessionId,
              triggerEventId,
              temporalWorkflowId: workflowId,
              status: "running",
              executionGeneration: 1,
              activeAttemptId: input.attemptId,
              source: goalUpdate ? "goal" : "system",
              position: Number(position),
              prompt: "Process the delivered internal session updates.",
              resources: [],
              tools,
              model,
              reasoningEffort,
              sandboxBackend,
              sandboxOs: latestStarted?.sandboxOs ?? session.sandboxOs,
              metadata: metadataWithTurnDispatchAttempt(
                {
                  internalUpdateCount: delivered.count,
                  ...(goalUpdate ? { goalId: goalUpdate.payload.goalId } : {}),
                },
                { id: input.dispatchId, generation: 1, triggerEventId },
              ),
              startedAt: now,
            })
            .returning();
          if (!internalTurn) throw new Error("Failed to create internal update inference");
          if (goalUpdate && typeof goalUpdate.payload.goalId === "string") {
            await tx
              .update(schema.sessionGoals)
              .set({ lastContinuationTurnId: internalTurn.id, updatedAt: now })
              .where(
                and(
                  eq(schema.sessionGoals.workspaceId, workspaceId),
                  eq(schema.sessionGoals.sessionId, sessionId),
                  eq(schema.sessionGoals.id, goalUpdate.payload.goalId),
                  eq(schema.sessionGoals.status, "active"),
                ),
              );
          }
          await tx
            .update(schema.sessions)
            .set({
              status: "running",
              activeTurnId: internalTurn.id,
              lastSequence: delivered.lastSequence,
              updatedAt: now,
            })
            .where(
              and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
            );
          await registerAttempt(internalTurn);
          return { action: "claimed", turn: mapSessionTurn(internalTurn) };
        }
        const predecessorAttemptId = queuedSteerReplacementAttemptId(queuedTurn.metadata);
        if (predecessorAttemptId) {
          const [predecessor] = await tx
            .select({ quiescedAt: schema.sessionTurnAttempts.quiescedAt })
            .from(schema.sessionTurnAttempts)
            .where(
              and(
                eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
                eq(schema.sessionTurnAttempts.sessionId, sessionId),
                eq(schema.sessionTurnAttempts.id, predecessorAttemptId),
              ),
            )
            .limit(1);
          if (!predecessor) {
            throw new SessionControlInvariantError(
              `Queued Steer ${id} points to missing predecessor attempt ${predecessorAttemptId}`,
            );
          }
          if (!predecessor.quiescedAt) {
            return { action: "unclaimed", reason: "control-pending" };
          }
        }
        // The database guard makes this function the only supported
        // queued-to-running transition. Raw or stale claimers cannot bypass the
        // generation/active-pointer transaction.
        const now = new Date();
        const queuedDispatch = readTurnDispatchMetadata(queuedTurn?.metadata);
        if (queuedDispatch.kind === "malformed") {
          throw new Error(`Malformed turn dispatch metadata: ${queuedDispatch.reason}`);
        }
        if (queuedDispatch.generation >= Number.MAX_SAFE_INTEGER) {
          throw new Error("Turn dispatch generation exhausted; refusing to wrap or reuse it");
        }
        const dispatchGeneration = queuedDispatch.generation + 1;
        await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
        const [row] = await tx
          .update(schema.sessionTurns)
          .set({
            status: "running",
            temporalWorkflowId: workflowId,
            executionGeneration: sql`${schema.sessionTurns.executionGeneration} + 1`,
            activeAttemptId: input.attemptId,
            metadata: metadataWithTurnDispatchAttempt(queuedTurn?.metadata, {
              id: input.dispatchId,
              generation: dispatchGeneration,
              triggerEventId: queuedTurn!.trigger_event_id,
            }),
            version: sql`${schema.sessionTurns.version} + 1`,
            startedAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, id)),
          )
          .returning();
        if (!row) {
          throw new Error(`Session turn not found: ${id}`);
        }
        const [{ historyPosition } = { historyPosition: 0 }] = await tx
          .select({
            historyPosition: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1) + 1`,
          })
          .from(schema.sessionHistoryItems)
          .where(
            and(
              eq(schema.sessionHistoryItems.workspaceId, workspaceId),
              eq(schema.sessionHistoryItems.sessionId, sessionId),
            ),
          );
        await tx.insert(schema.sessionHistoryItems).values({
          accountId: session.accountId,
          workspaceId,
          sessionId,
          turnId: row.id,
          position: Number(historyPosition),
          item: sanitizeModelPayload({ type: "message", role: "user", content: row.prompt }),
          producerCodexCredentialId: null,
        });
        const delivered = await deliverPendingUpdates(
          session.accountId,
          row.id,
          row.executionGeneration,
          session.lastSequence + 1,
          now,
        );
        await tx
          .update(schema.sessions)
          .set({
            status: "running",
            activeTurnId: row.id,
            queueVersion: session.queueVersion + 1,
            lastSequence: delivered.lastSequence,
            updatedAt: now,
          })
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          );
        await registerAttempt(row);
        return { action: "claimed", turn: mapSessionTurn(row) };
      }),
  );
}

export type SessionAttemptInterruptionSettlement = {
  action: "paused" | "continue" | "stale";
  events: SessionEvent[];
  attemptId: string;
  turnId: string | null;
  outcome: SessionTurnAttemptOutcome | null;
};

/**
 * Acknowledge that the exact cancelled attempt reached its final quiescence
 * boundary: after this transaction it has no inference, user-visible output,
 * or workspace-persistence authority. Fenced/idempotent cleanup and telemetry
 * may still finish. This may race the workflow's logical settlement transaction
 * in either order; both use the same session-first lock order and require the
 * durable interruption. Temporal separately waits for the activity promise to
 * terminate before the workflow dispatches its replacement.
 */
export async function markSessionAttemptQuiesced(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    attemptId: string;
    temporalWorkflowId: string;
    /** The dying activity also reaches this boundary for non-control ownership
     * fences. It may no-op when no Pause/Steer interruption exists; the workflow
     * control fallback deliberately omits this and therefore remains strict. */
    allowUninterrupted?: boolean;
  },
): Promise<SessionEvent[]> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await lockWorkspaceInferenceControl(scopedDb, input.workspaceId, "share");
    const [session] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      )
      .for("update")
      .limit(1);
    const [attempt] = await scopedDb
      .select()
      .from(schema.sessionTurnAttempts)
      .where(
        and(
          eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
          eq(schema.sessionTurnAttempts.sessionId, input.sessionId),
          eq(schema.sessionTurnAttempts.id, input.attemptId),
          eq(schema.sessionTurnAttempts.temporalWorkflowId, input.temporalWorkflowId),
        ),
      )
      .for("update")
      .limit(1);
    const [interruption] = attempt
      ? await scopedDb
          .select({
            id: schema.sessionAttemptInterruptions.id,
            state: schema.sessionAttemptInterruptions.state,
          })
          .from(schema.sessionAttemptInterruptions)
          .where(
            and(
              eq(schema.sessionAttemptInterruptions.workspaceId, input.workspaceId),
              eq(schema.sessionAttemptInterruptions.sessionId, input.sessionId),
              eq(schema.sessionAttemptInterruptions.attemptId, input.attemptId),
            ),
          )
          .orderBy(asc(schema.sessionAttemptInterruptions.requestedAt))
          .limit(1)
      : [];
    if (!session || !attempt) {
      throw new SessionControlInvariantError(
        `Attempt ${input.attemptId} cannot acknowledge quiescence without its session ownership`,
      );
    }
    if (!interruption) {
      if (input.allowUninterrupted) return [];
      throw new SessionControlInvariantError(
        `Attempt ${input.attemptId} cannot acknowledge quiescence without its interruption`,
      );
    }
    const liveQuiescence =
      (attempt.state === "claimed" || attempt.state === "running") &&
      (interruption.state === "pending" ||
        interruption.state === "delivered" ||
        interruption.state === "acknowledged");
    const settledQuiescence =
      attempt.state === "closed" &&
      (interruption.state === "settled" || interruption.state === "rejected_stale");
    if (!liveQuiescence && !settledQuiescence) {
      throw new SessionControlInvariantError(
        `Attempt ${input.attemptId} cannot acknowledge quiescence from ${attempt.state}/${interruption.state}`,
      );
    }

    const clientEventId = `opengeni:attempt-quiesced:${input.attemptId}`;
    if (attempt.quiescedAt) {
      const [existing] = await scopedDb
        .select()
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.sessionId, input.sessionId),
            eq(schema.sessionEvents.clientEventId, clientEventId),
          ),
        )
        .limit(1);
      if (!existing) {
        // Migration 0065 seeds quiesced_at for interrupted attempts that were
        // already closed before queue-event receipts existed. A replaying
        // workflow may still execute this idempotent fallback after rollout;
        // there is nothing new to publish and admission is already safely open.
        return [];
      }
      return [mapEvent(existing)];
    }

    const now = new Date();
    const queueVersion = session.queueVersion + 1;
    const [marked] = await scopedDb
      .update(schema.sessionTurnAttempts)
      .set({
        quiescedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sessionTurnAttempts.workspaceId, input.workspaceId),
          eq(schema.sessionTurnAttempts.id, input.attemptId),
          isNull(schema.sessionTurnAttempts.quiescedAt),
        ),
      )
      .returning({ id: schema.sessionTurnAttempts.id });
    if (!marked) {
      throw new SessionControlInvariantError(`Attempt ${input.attemptId} quiescence CAS lost`);
    }
    const [event] = await scopedDb
      .insert(schema.sessionEvents)
      .values({
        accountId: session.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sequence: session.lastSequence + 1,
        type: "session.queue.changed",
        payload: sanitizeEventPayload({
          operation: "attempt_quiesced",
          attemptId: input.attemptId,
          queueVersion,
        }),
        clientEventId,
        turnId: attempt.turnId,
        turnGeneration: attempt.executionGeneration,
        turnAttemptId: attempt.id,
        turnAssociation: null,
        occurredAt: now,
      })
      .returning();
    if (!event) throw new Error("Attempt-quiesced queue event was not inserted");
    await scopedDb
      .update(schema.sessions)
      .set({ queueVersion, lastSequence: event.sequence, updatedAt: now })
      .where(
        and(
          eq(schema.sessions.workspaceId, input.workspaceId),
          eq(schema.sessions.id, input.sessionId),
        ),
      );
    return [mapEvent(event)];
  });
}

/**
 * Settle every durable interruption cause for one exact first-class attempt.
 * Steer wins the logical-turn fate when causes coexist; effective control after
 * settlement independently decides whether the workflow holds or continues.
 * The attempt remains the sole write owner until this transaction closes it.
 */
export async function settleSessionAttemptInterruptions(
  db: Database,
  workspaceId: string,
  sessionId: string,
  attemptId: string,
): Promise<SessionAttemptInterruptionSettlement> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
    scopedDb.transaction(async (tx) => {
      await lockWorkspaceInferenceControl(tx as unknown as Database, workspaceId, "share");
      const effectiveControl = await evaluateSessionControl(
        tx as unknown as Database,
        workspaceId,
        sessionId,
        { lock: "share" },
      );
      const [session] = await tx
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
        .for("update")
        .limit(1);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      const interruptions = await tx
        .select()
        .from(schema.sessionAttemptInterruptions)
        .where(
          and(
            eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
            eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
            eq(schema.sessionAttemptInterruptions.attemptId, attemptId),
            inArray(schema.sessionAttemptInterruptions.state, [
              "pending",
              "delivered",
              "acknowledged",
            ]),
          ),
        )
        .orderBy(
          asc(schema.sessionAttemptInterruptions.requestedAt),
          asc(schema.sessionAttemptInterruptions.id),
        )
        .for("update");
      if (interruptions.length === 0) {
        return {
          action: "stale",
          events: [],
          attemptId,
          turnId: null,
          outcome: null,
        };
      }

      const [attempt] = await tx
        .select()
        .from(schema.sessionTurnAttempts)
        .where(
          and(
            eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
            eq(schema.sessionTurnAttempts.id, attemptId),
          ),
        )
        .for("update")
        .limit(1);
      if (!attempt) {
        throw new Error(`Interruption points to missing attempt: ${attemptId}`);
      }
      const now = new Date();
      if (attempt.state === "closed") {
        await tx
          .update(schema.sessionAttemptInterruptions)
          .set({ state: "rejected_stale", settledAt: now })
          .where(
            inArray(
              schema.sessionAttemptInterruptions.id,
              interruptions.map((interruption) => interruption.id),
            ),
          );
        return {
          action: effectiveControl.state === "paused" ? "paused" : "continue",
          events: [],
          attemptId,
          turnId: attempt.turnId,
          outcome: null,
        };
      }

      const [turn] = await tx
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, sessionId),
            eq(schema.sessionTurns.id, attempt.turnId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !turn ||
        attempt.accountId !== session.accountId ||
        attempt.sessionId !== sessionId ||
        attempt.executionGeneration !== turn.executionGeneration ||
        turn.activeAttemptId !== attemptId
      ) {
        throw new Error(`Live interrupted attempt ${attemptId} lost its exact turn ownership`);
      }

      const steer = interruptions.some((interruption) => interruption.kind === "steer");
      const outcome: SessionTurnAttemptOutcome = steer ? "superseded" : "interrupted_recoverable";
      const reason = steer
        ? "steer"
        : interruptions.some((interruption) => interruption.kind === "workspace_pause")
          ? "workspace_pause"
          : interruptions.some((interruption) => interruption.kind === "maintenance")
            ? "maintenance"
            : "session_pause";
      let sequence = session.lastSequence;
      const closedTools = await closePendingSessionToolCallsInTransaction(
        tx as unknown as Database,
        {
          accountId: session.accountId,
          workspaceId,
          sessionId,
          turnId: turn.id,
          reason,
          sequence,
          now,
        },
      );
      sequence = closedTools.sequence;
      await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
        id: attemptId,
        accountId: session.accountId,
        workspaceId,
        sessionId,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        outcome,
        closedAt: now,
      });
      await requeueInterruptedSessionSystemUpdatesForTurnTx(
        tx as unknown as Database,
        workspaceId,
        sessionId,
        turn.id,
      );

      const eventValues: Array<typeof schema.sessionEvents.$inferInsert> = steer
        ? [
            {
              accountId: session.accountId,
              workspaceId,
              sessionId,
              sequence: ++sequence,
              type: "turn.superseded",
              turnId: turn.id,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: attemptId,
              turnAssociation: "current",
              payload: sanitizeEventPayload({ reason: "steer" }),
              occurredAt: now,
            },
            {
              accountId: session.accountId,
              workspaceId,
              sessionId,
              sequence: ++sequence,
              type: "session.status.changed",
              payload: sanitizeEventPayload({ status: "queued" }),
              occurredAt: now,
            },
          ]
        : [
            {
              accountId: session.accountId,
              workspaceId,
              sessionId,
              sequence: ++sequence,
              type: "turn.recovery.requested",
              turnId: turn.id,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: attemptId,
              turnAssociation: "current",
              payload: sanitizeEventPayload({ reason }),
              occurredAt: now,
            },
            {
              accountId: session.accountId,
              workspaceId,
              sessionId,
              sequence: ++sequence,
              type: "session.status.changed",
              turnId: turn.id,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: attemptId,
              turnAssociation: "current",
              payload: sanitizeEventPayload({ status: "recovering" }),
              occurredAt: now,
            },
          ];
      const eventRows = await tx.insert(schema.sessionEvents).values(eventValues).returning();
      await tx
        .update(schema.sessionTurns)
        .set(
          steer
            ? {
                status: "superseded",
                activeAttemptId: null,
                metadata: metadataWithoutTurnDispatchAttempt(turn.metadata),
                version: turn.version + 1,
                finishedAt: turn.finishedAt ?? now,
                updatedAt: now,
              }
            : {
                status: "recovering",
                activeAttemptId: null,
                metadata: metadataWithoutTurnDispatchAttempt(turn.metadata),
                cancelledBy: null,
                cancelReason: null,
                version: turn.version + 1,
                finishedAt: null,
                updatedAt: now,
              },
        )
        .where(eq(schema.sessionTurns.id, turn.id));
      await tx
        .update(schema.sessions)
        .set({
          status: steer ? "queued" : "recovering",
          activeTurnId: steer ? null : turn.id,
          lastSequence: sequence,
          updatedAt: now,
        })
        .where(eq(schema.sessions.id, sessionId));
      await tx
        .update(schema.sessionAttemptInterruptions)
        .set({
          state: "settled",
          deliveredAt: now,
          acknowledgedAt: now,
          settledAt: now,
        })
        .where(
          inArray(
            schema.sessionAttemptInterruptions.id,
            interruptions.map((interruption) => interruption.id),
          ),
        );
      return {
        action: effectiveControl.state === "paused" ? "paused" : "continue",
        events: [...closedTools.events, ...eventRows.map(mapEvent)],
        attemptId,
        turnId: turn.id,
        outcome,
      };
    }),
  );
}

export type SessionWorkPeek =
  | { kind: "runnable" }
  | { kind: "approval-pending"; triggerEventId: string }
  | { kind: "approval-wait" }
  | {
      kind: "capacity-wait";
      ref: {
        waiterId: string;
        generation: number;
        nextCheckAt: string;
        wakeRevision: number;
      };
    }
  | { kind: "interruption-pending"; attemptId: string }
  | { kind: "idle" };

/** Read durable session state without reserving a turn-worker slot or mutating it. */
export async function peekSessionWork(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionWorkPeek> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const effectiveControl = await evaluateSessionControl(scopedDb, workspaceId, sessionId, {
      lock: "share",
    });
    const [session] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!session) return { kind: "idle" };
    const [interruption] = await scopedDb
      .select({ attemptId: schema.sessionAttemptInterruptions.attemptId })
      .from(schema.sessionAttemptInterruptions)
      .where(
        and(
          eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
          eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
          inArray(schema.sessionAttemptInterruptions.state, [
            "pending",
            "delivered",
            "acknowledged",
          ]),
        ),
      )
      .orderBy(
        asc(schema.sessionAttemptInterruptions.requestedAt),
        asc(schema.sessionAttemptInterruptions.id),
      )
      .limit(1);
    if (interruption) {
      return { kind: "interruption-pending", attemptId: interruption.attemptId };
    }
    if (effectiveControl.state !== "active") return { kind: "idle" };

    const [capacityWait] = await scopedDb
      .select()
      .from(schema.codexCapacityWaiters)
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, workspaceId),
          eq(schema.codexCapacityWaiters.sessionId, sessionId),
          eq(schema.codexCapacityWaiters.status, "waiting"),
        ),
      )
      .limit(1);
    if (capacityWait) {
      return {
        kind: "capacity-wait",
        ref: {
          waiterId: capacityWait.id,
          generation: capacityWait.generation,
          nextCheckAt:
            capacityWait.wakeRevision > capacityWait.observedWakeRevision
              ? new Date(0).toISOString()
              : capacityWait.nextCheckAt.toISOString(),
          wakeRevision: capacityWait.wakeRevision,
        },
      };
    }

    if (session.activeTurnId) {
      const [turn] = await scopedDb
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, sessionId),
            eq(schema.sessionTurns.id, session.activeTurnId),
          ),
        )
        .limit(1);
      if (!turn) {
        throw new Error(
          `Session ${sessionId} points to missing active turn ${session.activeTurnId}`,
        );
      }
      if (turn.status === "recovering" || turn.status === "waiting_capacity") {
        return { kind: "runnable" };
      }
      if (turn.status === "requires_action") {
        const [currentTrigger] = await scopedDb
          .select({ sequence: schema.sessionEvents.sequence })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, workspaceId),
              eq(schema.sessionEvents.sessionId, sessionId),
              eq(schema.sessionEvents.id, turn.triggerEventId),
            ),
          )
          .limit(1);
        if (!currentTrigger) {
          throw new Error(`Turn ${turn.id} points to missing trigger ${turn.triggerEventId}`);
        }
        const [approval] = await scopedDb
          .select({ id: schema.sessionEvents.id })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, workspaceId),
              eq(schema.sessionEvents.sessionId, sessionId),
              eq(schema.sessionEvents.type, "user.approvalDecision"),
              gt(schema.sessionEvents.sequence, currentTrigger.sequence),
            ),
          )
          .orderBy(desc(schema.sessionEvents.sequence), desc(schema.sessionEvents.id))
          .limit(1);
        return approval
          ? { kind: "approval-pending", triggerEventId: approval.id }
          : { kind: "approval-wait" };
      }
      if (turn.status === "running") {
        throw new Error(
          `Session workflow reached admission with turn ${turn.id} still owned by attempt ${turn.activeAttemptId ?? "none"}`,
        );
      }
      throw new Error(`Session ${sessionId} has terminal active turn ${turn.id} (${turn.status})`);
    }

    const [queued] = await scopedDb
      .select({ id: schema.sessionTurns.id })
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.status, "queued"),
          inArray(schema.sessionTurns.source, ["user", "api"]),
        ),
      )
      .limit(1);
    if (queued || session.compactRequested) return { kind: "runnable" };
    const [pendingUpdate] = await scopedDb
      .select({ id: schema.sessionSystemUpdates.id })
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          eq(schema.sessionSystemUpdates.state, "pending"),
        ),
      )
      .limit(1);
    if (!pendingUpdate) return { kind: "idle" };
    if (
      !(await latestFinishedTurnHasFailureCodeTx(
        scopedDb,
        workspaceId,
        sessionId,
        "context_compaction_failed",
      ))
    ) {
      return { kind: "runnable" };
    }
    const [pendingAgentSteer] = await scopedDb
      .select({ id: schema.sessionSystemUpdates.id })
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          eq(schema.sessionSystemUpdates.state, "pending"),
          eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
        ),
      )
      .limit(1);
    return pendingAgentSteer ? { kind: "runnable" } : { kind: "idle" };
  });
}

/**
 * Commit the workflow's terminal-for-now idle decision and its parent delivery
 * source in one transaction. A crash after commit leaves a pending outbox row for
 * the global reconciler; a normal caller immediately enriches/delivers the same
 * dedupe identity through notifyParentOfChildIdle.
 */
export async function settleSessionIdleWithParentOutbox(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<
  | { action: "settled"; changed: boolean; episodeKey: string; events: SessionEvent[] }
  | { action: "stale"; episodeKey: null; events: [] }
> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const effectiveControl = await evaluateSessionControl(
        tx as unknown as Database,
        workspaceId,
        sessionId,
        { lock: "share" },
      );
      const [workspace] = await tx
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .for("update")
        .limit(1);
      const [session] = await tx
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
        .for("update")
        .limit(1);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (!workspace || effectiveControl.state !== "active" || session.activeTurnId !== null) {
        return { action: "stale", episodeKey: null, events: [] } as const;
      }
      const [queued] = await tx
        .select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, sessionId),
            eq(schema.sessionTurns.status, "queued"),
          ),
        )
        .limit(1);
      if (queued || !["queued", "running", "idle"].includes(session.status)) {
        return { action: "stale", episodeKey: null, events: [] } as const;
      }
      const [{ episodeSequence } = { episodeSequence: 0 }] = await tx
        .select({
          episodeSequence: sql<number>`coalesce(max(${schema.sessionEvents.sequence}), 0)::int`,
        })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.workspaceId, workspaceId),
            eq(schema.sessionEvents.sessionId, sessionId),
            ne(schema.sessionEvents.type, "session.status.changed"),
          ),
        );
      const now = new Date();
      let sequence = session.lastSequence;
      const events: SessionEvent[] = [];
      if (session.status === "queued" || session.status === "running") {
        const [event] = await tx
          .insert(schema.sessionEvents)
          .values({
            accountId: session.accountId,
            workspaceId,
            sessionId,
            sequence: ++sequence,
            type: "session.status.changed",
            payload: sanitizeEventPayload({ status: "idle" }),
            occurredAt: now,
          })
          .returning();
        if (event) events.push(mapEvent(event));
        await tx
          .update(schema.sessions)
          .set({ status: "idle", activeTurnId: null, lastSequence: sequence, updatedAt: now })
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          );
      }
      // Status-only idle churn is not a new work episode. Key the parent
      // notification to the newest non-status event, not to the idle status
      // event this settlement just appended (or a prior identical idle event).
      const episodeKey = String(Number(episodeSequence));
      if (!session.parentSessionId) {
        return {
          action: "settled",
          changed: events.length > 0,
          episodeKey,
          events,
        } as const;
      }
      const dedupeKey = `child-completion:${session.id}:${episodeKey}`;
      await tx
        .insert(schema.sessionSystemUpdateOutbox)
        .values({
          accountId: session.accountId,
          workspaceId,
          sourceSessionId: session.id,
          targetSessionId: session.parentSessionId,
          dedupeKey,
          kind: "child_terminal_result",
          classification: "success",
          sourceId: session.id,
          summary: "Child session reached a terminal idle boundary.",
          payload: { type: "child_terminal_result", childSessionId: session.id, status: "idle" },
          lineage: { childSessionId: session.id, parentSessionId: session.parentSessionId },
        })
        .onConflictDoNothing({
          target: [
            schema.sessionSystemUpdateOutbox.workspaceId,
            schema.sessionSystemUpdateOutbox.dedupeKey,
          ],
        });
      return {
        action: "settled",
        changed: events.length > 0,
        episodeKey,
        events,
      } as const;
    });
  });
}

export function buildChildCompletionDigest(summaries: string[], trailing: string): string {
  if (summaries.length <= 1) {
    return [summaries[0] ?? "", "", trailing].join("\n");
  }
  const header = `${summaries.length} worker sessions you spawned reached a terminal state:`;
  const numbered = summaries.map((summary, index) => `${index + 1}. ${summary}`).join("\n\n");
  return [header, "", numbered, "", trailing].join("\n");
}

export async function setTemporalWorkflowId(
  db: Database,
  workspaceId: string,
  sessionId: string,
  workflowId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb
      .update(schema.sessions)
      .set({
        temporalWorkflowId: workflowId,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

const TURN_DISPATCH_ATTEMPT_METADATA_KEY = "dispatchAttempt";
const TURN_DISPATCH_GENERATION_METADATA_KEY = "dispatchGeneration";

type TurnDispatchAttempt = {
  id: string;
  generation: number;
  triggerEventId: string;
};

type TurnDispatchMetadata =
  | { kind: "absent"; generation: 0; attempt: null }
  | { kind: "valid"; generation: number; attempt: TurnDispatchAttempt | null }
  | { kind: "malformed"; reason: string };

function readTurnDispatchMetadata(metadata: unknown): TurnDispatchMetadata {
  if (metadata === null || metadata === undefined) {
    return { kind: "absent", generation: 0, attempt: null };
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { kind: "malformed", reason: "turn metadata is not an object" };
  }
  const record = metadata as Record<string, unknown>;
  const hasAttempt = Object.prototype.hasOwnProperty.call(
    record,
    TURN_DISPATCH_ATTEMPT_METADATA_KEY,
  );
  const hasGeneration = Object.prototype.hasOwnProperty.call(
    record,
    TURN_DISPATCH_GENERATION_METADATA_KEY,
  );
  if (!hasAttempt && !hasGeneration) {
    return { kind: "absent", generation: 0, attempt: null };
  }

  const rawGeneration = record[TURN_DISPATCH_GENERATION_METADATA_KEY];
  if (
    hasGeneration &&
    (typeof rawGeneration !== "number" || !Number.isSafeInteger(rawGeneration) || rawGeneration < 0)
  ) {
    return { kind: "malformed", reason: "dispatchGeneration is not a safe non-negative integer" };
  }
  const generation = hasGeneration ? (rawGeneration as number) : null;

  if (!hasAttempt) {
    return {
      kind: "valid",
      generation: generation ?? 0,
      attempt: null,
    };
  }
  const value = record[TURN_DISPATCH_ATTEMPT_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "malformed", reason: "dispatchAttempt is not an object" };
  }
  const attempt = value as Record<string, unknown>;
  if (
    typeof attempt.id !== "string" ||
    attempt.id.length === 0 ||
    typeof attempt.generation !== "number" ||
    !Number.isSafeInteger(attempt.generation) ||
    attempt.generation < 1 ||
    typeof attempt.triggerEventId !== "string" ||
    attempt.triggerEventId.length === 0
  ) {
    return { kind: "malformed", reason: "dispatchAttempt has an invalid shape" };
  }
  if (generation === null || generation !== attempt.generation) {
    return { kind: "malformed", reason: "dispatchGeneration does not match dispatchAttempt" };
  }
  return {
    kind: "valid",
    generation: attempt.generation,
    attempt: {
      id: attempt.id,
      generation: attempt.generation,
      triggerEventId: attempt.triggerEventId,
    },
  };
}

function metadataWithTurnDispatchAttempt(
  metadata: Record<string, unknown> | null | undefined,
  attempt: TurnDispatchAttempt,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [TURN_DISPATCH_GENERATION_METADATA_KEY]: attempt.generation,
    [TURN_DISPATCH_ATTEMPT_METADATA_KEY]: attempt,
  };
}

function metadataWithoutTurnDispatchAttempt(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  delete next[TURN_DISPATCH_ATTEMPT_METADATA_KEY];
  return next;
}

type WorkerDeathRedispatchMetadata =
  | { kind: "valid"; count: number }
  | { kind: "malformed"; reason: string };

function readWorkerDeathRedispatchMetadata(metadata: unknown): WorkerDeathRedispatchMetadata {
  if (metadata === null || metadata === undefined) {
    return { kind: "valid", count: 0 };
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { kind: "malformed", reason: "turn metadata is not an object" };
  }
  const raw = (metadata as Record<string, unknown>).workerDeathRedispatches;
  if (raw === undefined) {
    return { kind: "valid", count: 0 };
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return {
      kind: "malformed",
      reason: "workerDeathRedispatches is not a safe non-negative integer",
    };
  }
  return { kind: "valid", count: raw };
}

async function isNewerApprovalTrigger(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  currentTriggerEventId: string,
  candidateTriggerEventId: string,
): Promise<boolean> {
  const rows = await tx
    .select({
      id: schema.sessionEvents.id,
      type: schema.sessionEvents.type,
      sequence: schema.sessionEvents.sequence,
    })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        inArray(schema.sessionEvents.id, [currentTriggerEventId, candidateTriggerEventId]),
      ),
    );
  const current = rows.find((row) => row.id === currentTriggerEventId);
  const candidate = rows.find((row) => row.id === candidateTriggerEventId);
  return Boolean(
    current &&
    candidate &&
    candidate.type === "user.approvalDecision" &&
    candidate.sequence > current.sequence,
  );
}

type SessionTurnRecordingSettlementBase = {
  recordingId: string;
  producerId?: string | null;
  producerSeq?: number | null;
  occurredAt?: Date;
};

export type SessionTurnRecordingSettlement =
  | (SessionTurnRecordingSettlementBase & {
      action: "available";
      storageKey: string;
      sizeBytes: number;
      durationSeconds: number;
    })
  | (SessionTurnRecordingSettlementBase & {
      action: "failed";
      reason: string;
      detail: string | null;
    })
  | (SessionTurnRecordingSettlementBase & { action: "discard" });

export type ApplySessionTurnSettlementInput = {
  sessionId: string;
  turnId: string;
  triggerEventId: string;
  attemptId: string;
  fromStatuses?: SessionTurnStatus[];
  turnStatus: SessionTurnStatus;
  sessionStatus: SessionStatus;
  activeTurnId: string | null;
  events: AppendEventInput[];
  recording?: SessionTurnRecordingSettlement;
  /**
   * Atomically consume an operator /compact request and record why it could
   * not install a replacement. This lives on the terminal turn settlement so
   * a worker crash can never clear the request without also publishing the
   * attempt-owned failure truth.
   */
  compactionRequestFailure?: {
    reason: "summarization_failed";
    producerId?: string | null;
    producerSeq?: number | null;
    occurredAt?: Date;
  };
};

export type ApplySessionTurnSettlementResult =
  | { action: "settled"; events: SessionEvent[]; recordingMutationApplied: boolean }
  | {
      action: "stale";
      events: [];
      turnStatus: SessionTurnStatus | null;
      activeTurnId: string | null;
    };

function attemptOutcomeForTurnStatus(status: SessionTurnStatus): SessionTurnAttemptOutcome | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
    case "requires_action":
      return status;
    default:
      return null;
  }
}

/**
 * Atomically append terminal/requires-action truth, update the exact turn, and
 * transition the owning session. A superseded dispatch or closed control gate
 * is an event-free stale result. This prevents a zombie
 * from appending a terminal event before losing a later turn/session CAS.
 */
export async function applySessionTurnSettlement(
  db: Database,
  workspaceId: string,
  input: ApplySessionTurnSettlementInput,
): Promise<ApplySessionTurnSettlementResult> {
  const fromStatuses = input.fromStatuses ?? ["running", "requires_action"];
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const effectiveControl = await evaluateSessionControl(
        tx as unknown as Database,
        workspaceId,
        input.sessionId,
        { lock: "share" },
      );
      const [workspace] = await tx
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .for("update")
        .limit(1);
      const [session] = await tx
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }
      const [turn] = await tx
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.id, input.turnId),
          ),
        )
        .for("update")
        .limit(1);
      const turnStatus = (turn?.status as SessionTurnStatus | undefined) ?? null;
      const [pendingInterruption] = turn
        ? await tx
            .select({ id: schema.sessionAttemptInterruptions.id })
            .from(schema.sessionAttemptInterruptions)
            .where(
              and(
                eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
                eq(schema.sessionAttemptInterruptions.sessionId, input.sessionId),
                eq(schema.sessionAttemptInterruptions.attemptId, input.attemptId),
                inArray(schema.sessionAttemptInterruptions.state, [
                  "pending",
                  "delivered",
                  "acknowledged",
                ]),
              ),
            )
            .limit(1)
        : [];
      if (
        !turn ||
        !workspace ||
        effectiveControl.state !== "active" ||
        pendingInterruption !== undefined ||
        session.activeTurnId !== input.turnId ||
        !fromStatuses.includes(turnStatus as SessionTurnStatus) ||
        turn.activeAttemptId !== input.attemptId ||
        (input.compactionRequestFailure !== undefined && !session.compactRequested)
      ) {
        return {
          action: "stale" as const,
          events: [] as [],
          turnStatus,
          activeTurnId: session.activeTurnId,
        };
      }

      let recordingEvent: AppendEventInput | null = null;
      let recordingMutationApplied = false;
      if (input.recording) {
        const [recording] = await tx
          .select()
          .from(schema.sessionRecordings)
          .where(
            and(
              eq(schema.sessionRecordings.accountId, session.accountId),
              eq(schema.sessionRecordings.workspaceId, workspaceId),
              eq(schema.sessionRecordings.sessionId, input.sessionId),
              eq(schema.sessionRecordings.turnId, input.turnId),
              eq(schema.sessionRecordings.id, input.recording.recordingId),
              eq(schema.sessionRecordings.mode, "on-turn"),
              inArray(schema.sessionRecordings.state, ["recording", "finalizing"]),
            ),
          )
          .for("update")
          .limit(1);
        if (recording) {
          const recordingInput = input.recording;
          if (recordingInput.action === "discard") {
            await tx
              .delete(schema.sessionRecordings)
              .where(eq(schema.sessionRecordings.id, recording.id));
          } else if (recordingInput.action === "available") {
            await tx
              .update(schema.sessionRecordings)
              .set({
                state: "available",
                storageKey: recordingInput.storageKey,
                sizeBytes: recordingInput.sizeBytes,
                durationSeconds: recordingInput.durationSeconds,
                reason: null,
                finalizedAt: new Date(),
              })
              .where(eq(schema.sessionRecordings.id, recording.id));
            recordingEvent = {
              type: "recording.available",
              payload: {
                recordingId: recording.id,
                turnId: input.turnId,
                codec: recording.codec,
                contentType: recording.codec === "vp9-webm" ? "video/webm" : "video/mp4",
                storageKey: recordingInput.storageKey,
                durationSeconds: recordingInput.durationSeconds,
                sizeBytes: recordingInput.sizeBytes,
                dimensions: [recording.width, recording.height],
              },
              ...(recordingInput.producerId != null
                ? { producerId: recordingInput.producerId }
                : {}),
              ...(recordingInput.producerSeq != null
                ? { producerSeq: recordingInput.producerSeq }
                : {}),
              ...(recordingInput.occurredAt ? { occurredAt: recordingInput.occurredAt } : {}),
            };
          } else {
            await tx
              .update(schema.sessionRecordings)
              .set({
                state: "failed",
                reason: recordingInput.detail,
                finalizedAt: new Date(),
              })
              .where(eq(schema.sessionRecordings.id, recording.id));
            recordingEvent = {
              type: "recording.failed",
              payload: {
                recordingId: recording.id,
                turnId: input.turnId,
                reason: recordingInput.reason,
                detail: recordingInput.detail,
              },
              ...(recordingInput.producerId != null
                ? { producerId: recordingInput.producerId }
                : {}),
              ...(recordingInput.producerSeq != null
                ? { producerSeq: recordingInput.producerSeq }
                : {}),
              ...(recordingInput.occurredAt ? { occurredAt: recordingInput.occurredAt } : {}),
            };
          }
          recordingMutationApplied = true;
        }
      }

      let effectiveSessionStatus = input.sessionStatus;
      if (input.sessionStatus === "idle" && input.activeTurnId === null) {
        const [waitingPrompt] = await tx
          .select({ id: schema.sessionTurns.id })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              eq(schema.sessionTurns.status, "queued"),
              inArray(schema.sessionTurns.source, ["user", "api"]),
            ),
          )
          .limit(1);
        if (waitingPrompt) effectiveSessionStatus = "queued";
      }
      const now = new Date();
      const attemptOutcome = attemptOutcomeForTurnStatus(input.turnStatus);
      if (attemptOutcome) {
        await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
          id: input.attemptId,
          accountId: session.accountId,
          workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: attemptOutcome,
          closedAt: now,
        });
      }
      let sequence = session.lastSequence;
      const closesAttempt = ["failed", "cancelled", "superseded"].includes(input.turnStatus);
      const closedTools = closesAttempt
        ? await closePendingSessionToolCallsInTransaction(tx as unknown as Database, {
            accountId: session.accountId,
            workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: `turn_${input.turnStatus}`,
            sequence,
            now,
          })
        : { sequence, events: [] as SessionEvent[], closed: 0 };
      sequence = closedTools.sequence;
      const compactionRequestEvent: AppendEventInput | null = input.compactionRequestFailure
        ? {
            type: "session.context.compaction.skipped",
            payload: { reason: input.compactionRequestFailure.reason },
            ...(input.compactionRequestFailure.producerId != null
              ? { producerId: input.compactionRequestFailure.producerId }
              : {}),
            ...(input.compactionRequestFailure.producerSeq != null
              ? { producerSeq: input.compactionRequestFailure.producerSeq }
              : {}),
            ...(input.compactionRequestFailure.occurredAt
              ? { occurredAt: input.compactionRequestFailure.occurredAt }
              : {}),
          }
        : null;
      const settlementEvents = [
        ...(recordingEvent ? [recordingEvent] : []),
        ...(compactionRequestEvent ? [compactionRequestEvent] : []),
        ...input.events,
      ];
      const values = settlementEvents.map((event) => {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        return {
          accountId: session.accountId,
          workspaceId,
          sessionId: input.sessionId,
          sequence: ++sequence,
          type: event.type,
          payload: sanitizeEventPayload(
            event.type === "session.status.changed" &&
              payload.status === input.sessionStatus &&
              effectiveSessionStatus !== input.sessionStatus
              ? { ...payload, status: effectiveSessionStatus }
              : payload,
          ),
          clientEventId: event.clientEventId ?? null,
          turnId: input.turnId,
          turnGeneration: turn.executionGeneration,
          turnAttemptId: input.attemptId,
          turnAssociation: "current" as const,
          producerId: event.producerId ?? null,
          producerSeq: event.producerSeq ?? null,
          occurredAt: event.occurredAt ?? now,
        };
      });
      const inserted =
        values.length > 0 ? await tx.insert(schema.sessionEvents).values(values).returning() : [];
      const terminal =
        input.turnStatus === "completed" ||
        input.turnStatus === "cancelled" ||
        input.turnStatus === "failed" ||
        input.turnStatus === "superseded";
      if (input.turnStatus === "running") {
        // Approval resume re-enters the same logical turn after a new fenced
        // dispatch has advanced its trigger. It is an authorized inference
        // transition, just like the initial claim, and must pass the database
        // guard without opening a second mutation path.
        await tx.execute(sql`set local opengeni.session_inference_claim = '1'`);
      }
      await tx
        .update(schema.sessionTurns)
        .set({
          status: input.turnStatus,
          activeAttemptId:
            terminal || input.turnStatus === "requires_action" ? null : turn.activeAttemptId,
          version: turn.version + 1,
          // A requires_action result is a completed activity attempt. Keep the
          // generation for monotonic fencing, but remove the old activity id so
          // a later typed SCHEDULE_TO_START timeout can recover an approval
          // dispatch that never registered without taking over a newer one.
          ...(input.turnStatus === "requires_action"
            ? { metadata: metadataWithoutTurnDispatchAttempt(turn.metadata) }
            : {}),
          finishedAt:
            input.turnStatus === "queued" ||
            input.turnStatus === "running" ||
            input.turnStatus === "requires_action"
              ? null
              : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.id, input.turnId),
          ),
        );
      if (input.turnStatus === "failed") {
        await enqueueFailedChildOutboxForTurnTx(
          tx as unknown as Database,
          workspaceId,
          session,
          turn,
        );
      }
      if (input.turnStatus === "failed") {
        await deferFailedSessionSystemUpdatesForTurnTx(
          tx as unknown as Database,
          workspaceId,
          input.sessionId,
          input.turnId,
        );
      } else if (["cancelled", "superseded"].includes(input.turnStatus)) {
        await requeueInterruptedSessionSystemUpdatesForTurnTx(
          tx as unknown as Database,
          workspaceId,
          input.sessionId,
          input.turnId,
        );
      }
      await tx
        .update(schema.sessions)
        .set({
          status: effectiveSessionStatus,
          activeTurnId: input.activeTurnId,
          ...(input.compactionRequestFailure ? { compactRequested: false } : {}),
          lastSequence: sequence,
          queueVersion: session.queueVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      return {
        action: "settled" as const,
        events: [...closedTools.events, ...inserted.map(mapEvent)],
        recordingMutationApplied,
      };
    });
  });
}

export type SettleCodexCredentialFailoverResult =
  | { action: "recovering"; failoverCount: number; events: SessionEvent[] }
  | { action: "stale"; failoverCount: number; events: [] }
  | { action: "limit_exceeded"; failoverCount: number; events: [] };

export type SettleCodexCredentialLeaseLossResult =
  | { action: "recovering"; events: SessionEvent[] }
  | { action: "failed"; events: SessionEvent[] }
  | { action: "stale"; events: [] };

/**
 * Settle an activity that discovered its Codex lease was lost before it could
 * make more model progress. A current attempt is checkpointed for recovery;
 * when that checkpoint failed, the turn fails honestly instead of replaying
 * unpersisted work. A successor holder or worker-death redispatch makes the
 * caller stale and therefore unable to mutate the shared turn/session.
 *
 * The lease row may be absent because another turn reaped its expired row. The
 * persisted worker-death counter is the second dispatch fence for that case.
 */
export async function settleCodexCredentialLeaseLoss(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    holderId: string;
    generation: number;
    expectedRedispatches: number;
    checkpointDurable: boolean;
    recoveryPayload: Record<string, unknown>;
    failedPayload: Record<string, unknown>;
  },
): Promise<SettleCodexCredentialLeaseLossResult> {
  if (!Number.isInteger(input.expectedRedispatches) || input.expectedRedispatches < 0) {
    throw new Error("Codex lease-loss redispatch fence must be a non-negative integer");
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [workspace] = await tx
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.accountId, input.accountId),
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [turn] = await tx
          .select({
            sessionId: schema.sessionTurns.sessionId,
            status: schema.sessionTurns.status,
            metadata: schema.sessionTurns.metadata,
            activeAttemptId: schema.sessionTurns.activeAttemptId,
            executionGeneration: schema.sessionTurns.executionGeneration,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.accountId, input.accountId),
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        if (
          !workspace ||
          !session ||
          !turn ||
          effectiveControl.state !== "active" ||
          session.activeTurnId !== input.turnId ||
          !["running", "requires_action"].includes(turn.status) ||
          turn.activeAttemptId !== input.attemptId ||
          currentRedispatches !== input.expectedRedispatches
        ) {
          return { action: "stale", events: [] } as const;
        }

        const leaseRows = await tx.execute(
          sql<{ holder_id: string; generation: number }>`
            select holder_id, generation from codex_credential_leases
            where account_id = ${input.accountId}
              and workspace_id = ${input.workspaceId}
              and turn_id = ${input.turnId}
            for update
          `,
        );
        const lease = leaseRows[0];
        if (
          lease &&
          (lease.holder_id !== input.holderId || Number(lease.generation) !== input.generation)
        ) {
          return { action: "stale", events: [] } as const;
        }

        const now = new Date();
        await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
          id: input.attemptId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: input.checkpointDurable ? "lease_lost_recoverable" : "failed",
          closedAt: now,
        });
        let sequence = session.lastSequence;
        const closedTools = await closePendingSessionToolCallsInTransaction(
          tx as unknown as Database,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "codex_credential_lease_loss",
            sequence,
            now,
          },
        );
        sequence = closedTools.sequence;
        const inserted = input.checkpointDurable
          ? await tx
              .insert(schema.sessionEvents)
              .values([
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "turn.recovery.requested",
                  payload: sanitizeEventPayload(input.recoveryPayload),
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "session.status.changed",
                  payload: { status: "recovering" },
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
              ])
              .returning()
          : await tx
              .insert(schema.sessionEvents)
              .values([
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "turn.failed",
                  payload: sanitizeEventPayload(input.failedPayload),
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
                {
                  accountId: input.accountId,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  sequence: ++sequence,
                  type: "session.status.changed",
                  payload: { status: "failed" },
                  turnId: input.turnId,
                  turnGeneration: turn.executionGeneration,
                  turnAttemptId: input.attemptId,
                  turnAssociation: "current",
                  occurredAt: now,
                },
              ])
              .returning();
        const settlementEvent = inserted[0];
        if (!settlementEvent) {
          throw new Error("Codex lease-loss settlement did not persist its checkpoint event");
        }

        await tx
          .update(schema.sessionTurns)
          .set(
            input.checkpointDurable
              ? {
                  status: "recovering",
                  activeAttemptId: null,
                  finishedAt: null,
                  updatedAt: now,
                }
              : {
                  status: "failed",
                  activeAttemptId: null,
                  finishedAt: now,
                  updatedAt: now,
                },
          )
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          );
        await tx
          .update(schema.sessions)
          .set({
            status: input.checkpointDurable ? "recovering" : "failed",
            activeTurnId: input.checkpointDurable ? input.turnId : null,
            lastSequence: sequence,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.activeTurnId, input.turnId),
            ),
          );
        if (!input.checkpointDurable) {
          await deferFailedSessionSystemUpdatesForTurnTx(
            tx as unknown as Database,
            input.workspaceId,
            input.sessionId,
            input.turnId,
          );
        }
        await tx.execute(sql`
          delete from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and holder_id = ${input.holderId}
            and generation = ${input.generation}
        `);
        return {
          action: input.checkpointDurable ? "recovering" : "failed",
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        } as const;
      }),
  );
}

/**
 * Atomically settle a definitive Codex credential failover. Conversation
 * history/RunState is persisted by the caller first; this transaction then
 * fences the exact activity lease, increments the bounded same-turn counter,
 * appends both durable events, marks the same turn recoverable, updates the
 * session, and releases the lease together. The exact holder remains provable
 * if its row just expired or was reaped; a successor, redispatch, or closed
 * inference gate makes the caller stale without a second settlement path.
 */
export async function settleCodexCredentialFailover(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    attemptId: string;
    holderId: string;
    generation: number;
    expectedRedispatches: number;
    maxFailovers: number;
    recoveryPayload: Record<string, unknown>;
  },
): Promise<SettleCodexCredentialFailoverResult> {
  if (!Number.isInteger(input.expectedRedispatches) || input.expectedRedispatches < 0) {
    throw new Error("Codex failover redispatch fence must be a non-negative integer");
  }
  if (!Number.isInteger(input.maxFailovers) || input.maxFailovers < 1) {
    throw new Error("Codex failover bound must be a positive integer");
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [workspace] = await tx
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.accountId, input.accountId),
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const [turn] = await tx
          .select({
            sessionId: schema.sessionTurns.sessionId,
            status: schema.sessionTurns.status,
            metadata: schema.sessionTurns.metadata,
            activeAttemptId: schema.sessionTurns.activeAttemptId,
            executionGeneration: schema.sessionTurns.executionGeneration,
          })
          .from(schema.sessionTurns)
          .where(
            and(
              eq(schema.sessionTurns.accountId, input.accountId),
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        const currentFailovers = Number(turn?.metadata?.codexCredentialFailovers ?? 0);
        const currentRedispatches = Number(turn?.metadata?.workerDeathRedispatches ?? 0);
        if (
          !workspace ||
          !session ||
          !turn ||
          effectiveControl.state !== "active" ||
          session.activeTurnId !== input.turnId ||
          !["running", "requires_action"].includes(turn.status) ||
          turn.activeAttemptId !== input.attemptId ||
          currentRedispatches !== input.expectedRedispatches
        ) {
          return { action: "stale", failoverCount: currentFailovers, events: [] } as const;
        }

        const leaseRows = await tx.execute(
          sql<{ holder_id: string; generation: number }>`
          select holder_id, generation from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
          for update
        `,
        );
        const lease = leaseRows[0];
        if (
          lease &&
          (lease.holder_id !== input.holderId || Number(lease.generation) !== input.generation)
        ) {
          return { action: "stale", failoverCount: currentFailovers, events: [] } as const;
        }

        const failoverCount = currentFailovers + 1;
        if (failoverCount > input.maxFailovers) {
          return { action: "limit_exceeded", failoverCount, events: [] } as const;
        }
        const now = new Date();
        await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
          id: input.attemptId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          executionGeneration: turn.executionGeneration,
          outcome: "lease_lost_recoverable",
          closedAt: now,
        });
        let sequence = session.lastSequence;
        const closedTools = await closePendingSessionToolCallsInTransaction(
          tx as unknown as Database,
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            reason: "codex_credential_failover",
            sequence,
            now,
          },
        );
        sequence = closedTools.sequence;
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values([
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "turn.recovery.requested",
              payload: sanitizeEventPayload({
                ...input.recoveryPayload,
                failoverCount,
              }),
              turnId: input.turnId,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              occurredAt: now,
            },
            {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "session.status.changed",
              payload: { status: "recovering" },
              turnId: input.turnId,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              occurredAt: now,
            },
          ])
          .returning();
        if (!inserted[0]) {
          throw new Error("Codex failover did not persist its checkpoint event");
        }

        await tx
          .update(schema.sessionTurns)
          .set({
            status: "recovering",
            activeAttemptId: null,
            metadata: { ...turn.metadata, codexCredentialFailovers: failoverCount },
            finishedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, input.workspaceId),
              eq(schema.sessionTurns.id, input.turnId),
            ),
          );
        await tx
          .update(schema.sessions)
          .set({
            status: "recovering",
            activeTurnId: input.turnId,
            lastSequence: sequence,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
              eq(schema.sessions.activeTurnId, input.turnId),
            ),
          );
        await tx.execute(sql`
          delete from codex_credential_leases
          where account_id = ${input.accountId}
            and workspace_id = ${input.workspaceId}
            and turn_id = ${input.turnId}
            and holder_id = ${input.holderId}
            and generation = ${input.generation}
        `);
        return {
          action: "recovering",
          failoverCount,
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        } as const;
      }),
  );
}

export type RequestSessionTurnRecoveryInput = {
  sessionId: string;
  turnId: string;
  triggerEventId: string;
  attemptId: string;
  reason: string;
  detail?: Record<string, unknown>;
  fromStatuses?: SessionTurnStatus[];
};

export type RequestSessionTurnRecoveryResult =
  | { action: "recovering"; events: SessionEvent[] }
  | {
      action: "stale";
      events: [];
      turnStatus: SessionTurnStatus | null;
      activeTurnId: string | null;
    };

export async function requestSessionTurnRecovery(
  db: Database,
  workspaceId: string,
  input: RequestSessionTurnRecoveryInput,
): Promise<RequestSessionTurnRecoveryResult> {
  const fromStatuses = input.fromStatuses ?? ["running", "requires_action"];
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const effectiveControl = await evaluateSessionControl(
        tx as unknown as Database,
        workspaceId,
        input.sessionId,
        { lock: "share" },
      );
      const [workspace] = await tx
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .for("update")
        .limit(1);
      const [session] = await tx
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      const [turn] = await tx
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.id, input.turnId),
          ),
        )
        .for("update")
        .limit(1);
      const turnStatus = (turn?.status as SessionTurnStatus | undefined) ?? null;
      if (
        !workspace ||
        !turn ||
        effectiveControl.state !== "active" ||
        session.activeTurnId !== input.turnId ||
        !fromStatuses.includes(turnStatus as SessionTurnStatus) ||
        turn.activeAttemptId !== input.attemptId
      ) {
        return {
          action: "stale" as const,
          events: [] as [],
          turnStatus,
          activeTurnId: session.activeTurnId,
        };
      }

      const now = new Date();
      await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
        id: input.attemptId,
        accountId: session.accountId,
        workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionGeneration: turn.executionGeneration,
        outcome: "interrupted_recoverable",
        closedAt: now,
      });
      let sequence = session.lastSequence;
      const closedTools = await closePendingSessionToolCallsInTransaction(
        tx as unknown as Database,
        {
          accountId: session.accountId,
          workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason: input.reason,
          sequence,
          now,
        },
      );
      sequence = closedTools.sequence;
      const inserted = await tx
        .insert(schema.sessionEvents)
        .values([
          {
            accountId: session.accountId,
            workspaceId,
            sessionId: input.sessionId,
            sequence: ++sequence,
            type: "turn.recovery.requested",
            turnId: input.turnId,
            turnGeneration: turn.executionGeneration,
            turnAttemptId: turn.activeAttemptId,
            turnAssociation: "current",
            payload: sanitizeEventPayload({
              ...(input.detail ?? {}),
              triggerEventId: input.triggerEventId,
              reason: input.reason,
            }),
            occurredAt: now,
          },
          {
            accountId: session.accountId,
            workspaceId,
            sessionId: input.sessionId,
            sequence: ++sequence,
            type: "session.status.changed",
            turnId: input.turnId,
            turnGeneration: turn.executionGeneration,
            turnAttemptId: turn.activeAttemptId,
            turnAssociation: "current",
            payload: sanitizeEventPayload({ status: "recovering" }),
            occurredAt: now,
          },
        ])
        .returning();
      const [updatedTurn] = await tx
        .update(schema.sessionTurns)
        .set({
          status: "recovering",
          triggerEventId: turn.triggerEventId,
          finishedAt: null,
          activeAttemptId: null,
          cancelledBy: null,
          cancelReason: null,
          version: turn.version + 1,
          metadata: metadataWithoutTurnDispatchAttempt(turn.metadata),
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.id, input.turnId),
            inArray(schema.sessionTurns.status, fromStatuses),
          ),
        )
        .returning({ id: schema.sessionTurns.id });
      if (!updatedTurn) {
        // The row is locked, so this is an invariant failure rather than a
        // legitimate race. Throwing rolls the events back too.
        throw new Error(`Recoverable session turn changed while locked: ${input.turnId}`);
      }

      const [updatedSession] = await tx
        .update(schema.sessions)
        .set({
          status: "recovering",
          activeTurnId: input.turnId,
          lastSequence: sequence,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, input.sessionId),
            eq(schema.sessions.activeTurnId, input.turnId),
          ),
        )
        .returning({ id: schema.sessions.id });
      if (!updatedSession) {
        throw new Error(`Active session turn changed while locked: ${input.turnId}`);
      }
      return {
        action: "recovering" as const,
        events: [...closedTools.events, ...inserted.map(mapEvent)],
      };
    });
  });
}

export type RecoverSessionDispatchInput = {
  sessionId: string;
  attemptId: string;
  timeoutType: "HEARTBEAT" | "SCHEDULE_TO_START";
  maxRedispatches: number;
};

export type RecoverSessionDispatchResult =
  | { action: "unclaimed"; events: [] }
  | { action: "recovering"; turnId: string; redispatches: number; events: SessionEvent[] }
  | { action: "exceeded"; turnId: string; redispatches: number; events: SessionEvent[] }
  | {
      action: "stale";
      events: [];
      turnStatus: SessionTurnStatus | null;
      activeTurnId: string | null;
    };

/**
 * Atomically recover the exact attempt that owned a running turn. An activity
 * that never reached the turn worker has no active attempt and returns
 * `unclaimed` without consuming the crash-loop budget.
 */
export async function recoverSessionDispatch(
  db: Database,
  workspaceId: string,
  input: RecoverSessionDispatchInput,
): Promise<RecoverSessionDispatchResult> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const effectiveControl = await evaluateSessionControl(
        tx as unknown as Database,
        workspaceId,
        input.sessionId,
        { lock: "share" },
      );
      const [workspace] = await tx
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .for("update")
        .limit(1);
      const [session] = await tx
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!session) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }
      const [turn] = await tx
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.activeAttemptId, input.attemptId),
          ),
        )
        .for("update")
        .limit(1);
      if (!turn) {
        return input.timeoutType === "SCHEDULE_TO_START"
          ? { action: "unclaimed", events: [] }
          : {
              action: "stale",
              events: [],
              turnStatus: null,
              activeTurnId: session.activeTurnId,
            };
      }
      const turnStatus = (turn?.status as SessionTurnStatus | undefined) ?? null;
      const parsedMetadata = readTurnDispatchMetadata(turn?.metadata);
      if (
        !workspace ||
        parsedMetadata.kind === "malformed" ||
        parsedMetadata.attempt === null ||
        effectiveControl.state !== "active" ||
        session.activeTurnId !== turn.id ||
        turnStatus !== "running" ||
        turn.activeAttemptId !== input.attemptId
      ) {
        return {
          action: "stale" as const,
          events: [] as [],
          turnStatus,
          activeTurnId: session.activeTurnId,
        };
      }

      const redispatchMetadata = readWorkerDeathRedispatchMetadata(turn.metadata);
      if (redispatchMetadata.kind === "malformed") {
        return {
          action: "stale" as const,
          events: [] as [],
          turnStatus,
          activeTurnId: session.activeTurnId,
        };
      }
      if (redispatchMetadata.count >= Number.MAX_SAFE_INTEGER) {
        return {
          action: "stale" as const,
          events: [] as [],
          turnStatus,
          activeTurnId: session.activeTurnId,
        };
      }
      const metadata = { ...(turn.metadata ?? {}) } as Record<string, unknown>;
      const redispatches = redispatchMetadata.count + 1;
      metadata.workerDeathRedispatches = redispatches;

      const now = new Date();
      await closeSessionTurnAttemptInTransaction(tx as unknown as Database, {
        id: input.attemptId,
        accountId: session.accountId,
        workspaceId,
        sessionId: input.sessionId,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        outcome: redispatches > input.maxRedispatches ? "failed" : "lease_lost_recoverable",
        closedAt: now,
      });
      let sequence = session.lastSequence;
      const closedTools = await closePendingSessionToolCallsInTransaction(
        tx as unknown as Database,
        {
          accountId: session.accountId,
          workspaceId,
          sessionId: input.sessionId,
          turnId: turn.id,
          reason: "worker_death",
          sequence,
          now,
        },
      );
      sequence = closedTools.sequence;
      if (redispatches > input.maxRedispatches) {
        const inserted = await tx
          .insert(schema.sessionEvents)
          .values([
            {
              accountId: session.accountId,
              workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "turn.failed",
              turnId: turn.id,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              payload: sanitizeEventPayload({
                triggerEventId: turn.triggerEventId,
                code: "worker_death_redispatch_exhausted",
                error: `Worker died ${redispatches} times while running this turn (heartbeat timeout); giving up after ${input.maxRedispatches} re-dispatches.`,
                redispatches: input.maxRedispatches,
              }),
              occurredAt: now,
            },
            {
              accountId: session.accountId,
              workspaceId,
              sessionId: input.sessionId,
              sequence: ++sequence,
              type: "session.status.changed",
              turnId: turn.id,
              turnGeneration: turn.executionGeneration,
              turnAttemptId: input.attemptId,
              turnAssociation: "current",
              payload: sanitizeEventPayload({ status: "failed" }),
              occurredAt: now,
            },
          ])
          .returning();
        await tx
          .update(schema.sessionTurns)
          .set({
            status: "failed",
            activeAttemptId: null,
            metadata,
            version: turn.version + 1,
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessionTurns.workspaceId, workspaceId),
              eq(schema.sessionTurns.sessionId, input.sessionId),
              eq(schema.sessionTurns.id, turn.id),
            ),
          );
        await enqueueFailedChildOutboxForTurnTx(
          tx as unknown as Database,
          workspaceId,
          session,
          turn,
        );
        await tx
          .update(schema.sessions)
          .set({
            status: "failed",
            activeTurnId: null,
            lastSequence: sequence,
            queueVersion: session.queueVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          );
        return {
          action: "exceeded" as const,
          turnId: turn.id,
          redispatches: input.maxRedispatches,
          events: [...closedTools.events, ...inserted.map(mapEvent)],
        };
      }

      const inserted = await tx
        .insert(schema.sessionEvents)
        .values([
          {
            accountId: session.accountId,
            workspaceId,
            sessionId: input.sessionId,
            sequence: ++sequence,
            type: "turn.recovery.requested",
            turnId: turn.id,
            turnGeneration: turn.executionGeneration,
            turnAttemptId: input.attemptId,
            turnAssociation: "current",
            payload: sanitizeEventPayload({
              triggerEventId: turn.triggerEventId,
              reason: "worker_death",
              redispatches,
            }),
            occurredAt: now,
          },
          {
            accountId: session.accountId,
            workspaceId,
            sessionId: input.sessionId,
            sequence: ++sequence,
            type: "session.status.changed",
            turnId: turn.id,
            turnGeneration: turn.executionGeneration,
            turnAttemptId: input.attemptId,
            turnAssociation: "current",
            payload: sanitizeEventPayload({ status: "recovering" }),
            occurredAt: now,
          },
        ])
        .returning();
      const requeuedMetadata = metadataWithoutTurnDispatchAttempt(metadata);
      await tx
        .update(schema.sessionTurns)
        .set({
          status: "recovering",
          triggerEventId: turn.triggerEventId,
          metadata: requeuedMetadata,
          activeAttemptId: null,
          cancelledBy: null,
          cancelReason: null,
          version: turn.version + 1,
          finishedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, input.sessionId),
            eq(schema.sessionTurns.id, turn.id),
          ),
        );
      await tx
        .update(schema.sessions)
        .set({
          status: "recovering",
          activeTurnId: turn.id,
          lastSequence: sequence,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.sessions.workspaceId, workspaceId),
            eq(schema.sessions.id, input.sessionId),
          ),
        );
      return {
        action: "recovering" as const,
        turnId: turn.id,
        redispatches,
        events: [...closedTools.events, ...inserted.map(mapEvent)],
      };
    });
  });
}

export async function getSessionTurn(
  db: Database,
  workspaceId: string,
  turnId: string,
): Promise<SessionTurn | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessionTurns)
      .where(
        and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId)),
      )
      .limit(1);
    return row ? mapSessionTurn(row) : null;
  });
}

export async function getSessionTurnForAttempt(
  db: Database,
  workspaceId: string,
  sessionId: string,
  attemptId: string,
): Promise<SessionTurn | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.activeAttemptId, attemptId),
        ),
      )
      .limit(1);
    return row ? mapSessionTurn(row) : null;
  });
}

/**
 * Return the newest turn that reached agent execution for a session. A claimed
 * turn's `started_at` is set before worker admission, so it is not sufficient
 * evidence that the turn's model/reasoning policy was actually used. The
 * durable `turn.started` event is emitted only after admission succeeds and is
 * therefore the continuation boundary used by goal and parent-wake synthesis.
 *
 * Preflight-rejected turns (credit/limit/config failures) deliberately do not
 * override the last effective policy. This matters when an explicit per-turn
 * model differs from the persisted session default: follow-up work must keep
 * the model that actually ran rather than reverting to a stale default.
 */
export async function getLatestStartedSessionTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionTurn | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const row = await latestStartedSessionTurnRow(scopedDb, workspaceId, sessionId);
    return row ? mapSessionTurn(row) : null;
  });
}

export async function listSessionTurns(
  db: Database,
  workspaceId: string,
  sessionId: string,
  limit = 100,
): Promise<SessionTurn[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
        ),
      )
      .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt))
      .limit(limit);
    return rows.map(mapSessionTurn);
  });
}

export async function listPendingSessionTurns(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionTurn[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          inArray(schema.sessionTurns.status, ["queued", "running", "requires_action"]),
        ),
      )
      .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt));
    return rows.map(mapSessionTurn);
  });
}

export async function getSessionQueueSnapshot(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionQueueSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const effectiveControl = await evaluateSessionControl(scopedDb, workspaceId, sessionId, {
      lock: "share",
    });
    const [session] = await scopedDb
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!session) return null;
    const rows = await scopedDb
      .select()
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, workspaceId),
          eq(schema.sessionTurns.sessionId, sessionId),
          eq(schema.sessionTurns.status, "queued"),
          inArray(schema.sessionTurns.source, ["user", "api"]),
        ),
      )
      .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt));
    const quiescenceCandidates = [
      ...new Set(
        rows.flatMap((row) => {
          const attemptId = queuedSteerReplacementAttemptId(row.metadata);
          return attemptId ? [attemptId] : [];
        }),
      ),
    ];
    const quiescenceAttempts =
      quiescenceCandidates.length === 0
        ? []
        : await scopedDb
            .select({
              id: schema.sessionTurnAttempts.id,
              quiescedAt: schema.sessionTurnAttempts.quiescedAt,
            })
            .from(schema.sessionTurnAttempts)
            .where(
              and(
                eq(schema.sessionTurnAttempts.workspaceId, workspaceId),
                eq(schema.sessionTurnAttempts.sessionId, sessionId),
                inArray(schema.sessionTurnAttempts.id, quiescenceCandidates),
              ),
            );
    const foundQuiescenceAttempts = new Set(quiescenceAttempts.map((attempt) => attempt.id));
    const missingQuiescenceAttempt = quiescenceCandidates.find(
      (attemptId) => !foundQuiescenceAttempts.has(attemptId),
    );
    if (missingQuiescenceAttempt) {
      throw new SessionControlInvariantError(
        `Queued Steer points to missing predecessor attempt ${missingQuiescenceAttempt}`,
      );
    }
    const nonQuiescedAttemptIds = new Set(
      quiescenceAttempts
        .filter((attempt) => attempt.quiescedAt === null)
        .map((attempt) => attempt.id),
    );
    const [sessionWideUnquiescedInterruption] = await scopedDb
      .select({ attemptId: schema.sessionAttemptInterruptions.attemptId })
      .from(schema.sessionAttemptInterruptions)
      .innerJoin(
        schema.sessionTurnAttempts,
        and(
          eq(
            schema.sessionTurnAttempts.workspaceId,
            schema.sessionAttemptInterruptions.workspaceId,
          ),
          eq(schema.sessionTurnAttempts.id, schema.sessionAttemptInterruptions.attemptId),
        ),
      )
      .where(
        and(
          eq(schema.sessionAttemptInterruptions.workspaceId, workspaceId),
          eq(schema.sessionAttemptInterruptions.sessionId, sessionId),
          isNull(schema.sessionTurnAttempts.quiescedAt),
        ),
      )
      .orderBy(desc(schema.sessionAttemptInterruptions.requestedAt))
      .limit(1);
    return {
      version: session.queueVersion,
      effectiveControl: serializeEffectiveSessionControl(effectiveControl),
      stoppingPreviousAttempt:
        rows.length > 0 &&
        (sessionWideUnquiescedInterruption !== undefined ||
          rows.some((row) => {
            const metadata = row.metadata as Record<string, unknown>;
            return (
              metadata.delivery === "steer" &&
              typeof metadata.replacedAttemptId === "string" &&
              nonQuiescedAttemptIds.has(metadata.replacedAttemptId)
            );
          })),
      items: rows.map(mapSessionTurn),
    };
  });
}

function queuedSteerReplacementAttemptId(metadata: Record<string, unknown>): string | null {
  if (metadata.delivery !== "steer") return null;
  const attemptId = metadata.replacedAttemptId;
  const interruptionCount = metadata.interruptionCount;
  if (attemptId === null && interruptionCount === 0) return null;
  if (
    typeof attemptId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId) &&
    typeof interruptionCount === "number" &&
    Number.isSafeInteger(interruptionCount) &&
    interruptionCount > 0
  ) {
    return attemptId;
  }
  throw new SessionControlInvariantError("Queued Steer has malformed predecessor metadata");
}

async function enqueueFailedChildOutboxForTurnTx(
  tx: Database,
  workspaceId: string,
  session: Pick<typeof schema.sessions.$inferSelect, "id" | "parentSessionId">,
  turn: Pick<typeof schema.sessionTurns.$inferSelect, "id" | "accountId" | "sessionId">,
): Promise<void> {
  if (!session.parentSessionId) return;
  const dedupeKey = `child-completion:${turn.sessionId}:turn:${turn.id}`;
  await tx
    .insert(schema.sessionSystemUpdateOutbox)
    .values({
      accountId: turn.accountId,
      workspaceId,
      sourceSessionId: turn.sessionId,
      targetSessionId: session.parentSessionId,
      dedupeKey,
      kind: "child_terminal_result",
      classification: "failure",
      sourceId: turn.sessionId,
      summary: "Child session failed; inspect the durable child timeline.",
      payload: {
        type: "child_terminal_result",
        childSessionId: turn.sessionId,
        status: "failed",
        turnId: turn.id,
      },
      lineage: {
        childSessionId: turn.sessionId,
        parentSessionId: session.parentSessionId,
        turnId: turn.id,
      },
    })
    .onConflictDoNothing({
      target: [
        schema.sessionSystemUpdateOutbox.workspaceId,
        schema.sessionSystemUpdateOutbox.dedupeKey,
      ],
    });
}

type ChildTerminalResultPayload = Extract<
  SessionSystemUpdatePayload,
  { type: "child_terminal_result" }
>;

function parseChildTerminalResultPayload(input: unknown): ChildTerminalResultPayload {
  const payload = SessionSystemUpdatePayload.parse(input);
  if (payload.type !== "child_terminal_result") {
    throw new Error(`Child-terminal outbox contains ${payload.type} payload`);
  }
  return payload;
}

export type SessionSystemUpdateOutboxDelivery = {
  id: string;
  status: "pending" | "delivered";
  accountId: string;
  workspaceId: string;
  sourceSessionId: string;
  targetSessionId: string;
  dedupeKey: string;
  kind: "child_terminal_result";
  classification: SystemUpdateClassification;
  sourceId: string;
  summary: string;
  payload: ChildTerminalResultPayload;
  lineage: Record<string, unknown>;
};

function mapSystemUpdateOutboxRow(row: {
  id: string;
  account_id: string;
  workspace_id: string;
  source_session_id: string;
  target_session_id: string;
  dedupe_key: string;
  kind: string;
  classification: string;
  source_id: string;
  summary: string;
  payload: Record<string, unknown>;
  lineage: Record<string, unknown>;
}): SessionSystemUpdateOutboxDelivery {
  if (row.kind !== "child_terminal_result") {
    throw new Error(`System-update outbox contains retired kind ${row.kind}`);
  }
  return {
    id: row.id,
    status: "pending",
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    dedupeKey: row.dedupe_key,
    kind: "child_terminal_result",
    classification: row.classification as SystemUpdateClassification,
    sourceId: row.source_id,
    summary: row.summary,
    payload: parseChildTerminalResultPayload(row.payload),
    lineage: row.lineage,
  };
}

/**
 * Read the exact durable parent-update row created by terminal turn settlement.
 * Failure delivery must never upsert this row: settlement owns its payload and
 * turn provenance, while the activity layer only delivers the committed fact.
 */
export async function getSessionSystemUpdateOutboxByDedupeKey(
  db: Database,
  input: { accountId: string; workspaceId: string; dedupeKey: string },
): Promise<SessionSystemUpdateOutboxDelivery | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.sessionSystemUpdateOutbox)
        .where(
          and(
            eq(schema.sessionSystemUpdateOutbox.workspaceId, input.workspaceId),
            eq(schema.sessionSystemUpdateOutbox.dedupeKey, input.dedupeKey),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (row.kind !== "child_terminal_result") {
        throw new Error(`System-update outbox contains retired kind ${row.kind}`);
      }
      return {
        id: row.id,
        status: row.status as "pending" | "delivered",
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        sourceSessionId: row.sourceSessionId,
        targetSessionId: row.targetSessionId,
        dedupeKey: row.dedupeKey,
        kind: "child_terminal_result",
        classification: row.classification as SystemUpdateClassification,
        sourceId: row.sourceId,
        summary: row.summary,
        payload: parseChildTerminalResultPayload(row.payload),
        lineage: row.lineage,
      };
    },
  );
}

export async function claimPendingSessionSystemUpdateOutbox(
  db: Database,
  limit = 100,
): Promise<SessionSystemUpdateOutboxDelivery[]> {
  const rows = await rawRows<{
    id: string;
    account_id: string;
    workspace_id: string;
    source_session_id: string;
    target_session_id: string;
    dedupe_key: string;
    kind: string;
    classification: string;
    source_id: string;
    summary: string;
    payload: Record<string, unknown>;
    lineage: Record<string, unknown>;
  }>(db, sql`select * from opengeni_private.claim_session_system_update_outbox(${limit})`);
  return rows.map(mapSystemUpdateOutboxRow);
}

export type SessionWorkflowWake = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  temporalWorkflowId: string;
  wakeRevision: number;
  interruptionRequested: boolean;
};

/**
 * Record a new workflow nudge in the same transaction as the state mutation
 * that made it necessary. Concurrent producers serialize on the one
 * per-session row and each receive the exact committed revision they own.
 */
export async function enqueueSessionWorkflowWakeInTransaction(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
    reason: string;
    notBefore?: Date;
  },
): Promise<number> {
  const now = new Date();
  const nextAttemptAt = input.notBefore ?? now;
  const [row] = await tx
    .insert(schema.sessionWorkflowWakeOutbox)
    .values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      temporalWorkflowId: input.temporalWorkflowId,
      reason: input.reason,
      nextAttemptAt,
    })
    .onConflictDoUpdate({
      target: schema.sessionWorkflowWakeOutbox.sessionId,
      set: {
        temporalWorkflowId: input.temporalWorkflowId,
        wakeRevision: sql`${schema.sessionWorkflowWakeOutbox.wakeRevision} + 1`,
        reason: input.reason,
        attempts: 0,
        nextAttemptAt,
        lastError: null,
        updatedAt: now,
      },
    })
    .returning({ wakeRevision: schema.sessionWorkflowWakeOutbox.wakeRevision });
  if (!row) throw new Error(`Failed to enqueue workflow wake for session ${input.sessionId}`);
  return row.wakeRevision;
}

/** Standalone transactional producer for operations not already in a DB txn. */
export async function enqueueSessionWorkflowWake(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
    reason: string;
    notBefore?: Date;
  },
): Promise<number> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await enqueueSessionWorkflowWakeInTransaction(scopedDb, input),
  );
}

/**
 * Re-deliver already-committed session work only when admission currently
 * allows this session to run. The workspace-then-session lock order matches
 * every Pause/Resume producer, so a retry cannot race around either gate.
 */
export async function enqueueSessionWorkflowWakeIfRunnable(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    temporalWorkflowId: string;
    reason: string;
    notBefore?: Date;
  },
): Promise<number | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [workspace] = await tx
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!workspace || !session) throw new Error(`Session not found: ${input.sessionId}`);
        const runnable =
          session.status !== "cancelled" &&
          session.activeTurnId === null &&
          effectiveControl.state === "active";
        return runnable
          ? await enqueueSessionWorkflowWakeInTransaction(tx as unknown as Database, input)
          : null;
      }),
  );
}

/** Claim only explicit, undelivered wake revisions; never infer work by scan. */
export async function claimPendingSessionWorkflowWakes(
  db: Database,
  limit = 100,
): Promise<SessionWorkflowWake[]> {
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    session_id: string;
    temporal_workflow_id: string;
    wake_revision: number | string;
    interruption_requested: boolean;
  }>(db, sql`select * from opengeni_private.claim_session_workflow_wakes(${limit})`);
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    temporalWorkflowId: row.temporal_workflow_id,
    wakeRevision: Number(row.wake_revision),
    interruptionRequested: row.interruption_requested,
  }));
}

/**
 * Acknowledge an immediate post-commit signal. An older sender may advance only
 * its own revision; it cannot clear a claim or failure state belonging to a
 * newer revision.
 */
export async function markSessionWorkflowWakeDelivered(
  db: Database,
  input: Omit<SessionWorkflowWake, "interruptionRequested">,
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .update(schema.sessionWorkflowWakeOutbox)
        .set({
          deliveredRevision: sql`greatest(${schema.sessionWorkflowWakeOutbox.deliveredRevision}, ${input.wakeRevision})`,
          attempts: sql`case when ${schema.sessionWorkflowWakeOutbox.wakeRevision} = ${input.wakeRevision} then 0 else ${schema.sessionWorkflowWakeOutbox.attempts} end`,
          lastError: sql`case when ${schema.sessionWorkflowWakeOutbox.wakeRevision} = ${input.wakeRevision} then null else ${schema.sessionWorkflowWakeOutbox.lastError} end`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessionWorkflowWakeOutbox.workspaceId, input.workspaceId),
            eq(schema.sessionWorkflowWakeOutbox.sessionId, input.sessionId),
            gte(schema.sessionWorkflowWakeOutbox.wakeRevision, input.wakeRevision),
          ),
        )
        .returning({ sessionId: schema.sessionWorkflowWakeOutbox.sessionId });
      if (!row) {
        throw new Error(
          `Workflow wake revision ${input.wakeRevision} is not current for session ${input.sessionId}`,
        );
      }
    },
  );
}

/** Record delivery failure; the claim already scheduled the bounded retry. */
export async function markSessionWorkflowWakeFailed(
  db: Database,
  input: SessionWorkflowWake,
  error: string,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .update(schema.sessionWorkflowWakeOutbox)
        .set({
          lastError: error.slice(0, 500),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessionWorkflowWakeOutbox.sessionId, input.sessionId),
            eq(schema.sessionWorkflowWakeOutbox.workspaceId, input.workspaceId),
            eq(schema.sessionWorkflowWakeOutbox.wakeRevision, input.wakeRevision),
          ),
        )
        .returning({ sessionId: schema.sessionWorkflowWakeOutbox.sessionId });
      return row !== undefined;
    },
  );
}

export async function getOrCreateSessionSystemUpdateOutbox(
  db: Database,
  input: Omit<SessionSystemUpdateOutboxDelivery, "id" | "status">,
): Promise<SessionSystemUpdateOutboxDelivery> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [row] = await scopedDb
        .insert(schema.sessionSystemUpdateOutbox)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          dedupeKey: input.dedupeKey,
          kind: input.kind,
          classification: input.classification,
          sourceId: input.sourceId,
          summary: input.summary,
          payload: input.payload,
          lineage: input.lineage,
        })
        .onConflictDoUpdate({
          target: [
            schema.sessionSystemUpdateOutbox.workspaceId,
            schema.sessionSystemUpdateOutbox.dedupeKey,
          ],
          set: {
            kind: input.kind,
            classification: input.classification,
            sourceId: input.sourceId,
            summary: input.summary,
            payload: input.payload,
            lineage: input.lineage,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Failed to persist system-update outbox row");
      return {
        id: row.id,
        status: row.status as "pending" | "delivered",
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        sourceSessionId: row.sourceSessionId,
        targetSessionId: row.targetSessionId,
        dedupeKey: row.dedupeKey,
        kind: "child_terminal_result",
        classification: row.classification as SystemUpdateClassification,
        sourceId: row.sourceId,
        summary: row.summary,
        payload: parseChildTerminalResultPayload(row.payload),
        lineage: row.lineage,
      };
    },
  );
}

export async function markSessionSystemUpdateOutboxFailed(
  db: Database,
  input: Pick<SessionSystemUpdateOutboxDelivery, "accountId" | "workspaceId" | "id">,
  error: string,
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb
        .update(schema.sessionSystemUpdateOutbox)
        .set({ lastError: error.slice(0, 500), updatedAt: new Date() })
        .where(
          and(
            eq(schema.sessionSystemUpdateOutbox.workspaceId, input.workspaceId),
            eq(schema.sessionSystemUpdateOutbox.id, input.id),
            eq(schema.sessionSystemUpdateOutbox.status, "pending"),
          ),
        );
    },
  );
}

/** DB-only callback for addSessionSystemUpdateWithSourceMutation. */
export async function markSessionSystemUpdateOutboxDeliveredInTransaction(
  tx: Database,
  input: Pick<SessionSystemUpdateOutboxDelivery, "workspaceId" | "id">,
): Promise<void> {
  const [row] = await tx
    .update(schema.sessionSystemUpdateOutbox)
    .set({ status: "delivered", deliveredAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.sessionSystemUpdateOutbox.workspaceId, input.workspaceId),
        eq(schema.sessionSystemUpdateOutbox.id, input.id),
        eq(schema.sessionSystemUpdateOutbox.status, "pending"),
      ),
    )
    .returning({ id: schema.sessionSystemUpdateOutbox.id });
  if (!row) {
    const [existing] = await tx
      .select({ status: schema.sessionSystemUpdateOutbox.status })
      .from(schema.sessionSystemUpdateOutbox)
      .where(
        and(
          eq(schema.sessionSystemUpdateOutbox.workspaceId, input.workspaceId),
          eq(schema.sessionSystemUpdateOutbox.id, input.id),
        ),
      )
      .limit(1);
    if (existing?.status !== "delivered") {
      throw new Error(`System-update outbox row not pending: ${input.id}`);
    }
  }
}

type SessionSystemUpdateInputVariant = {
  [Kind in SessionSystemUpdateKind]: {
    kind: Kind;
    payload: Extract<SessionSystemUpdatePayload, { type: Kind }>;
  };
}[SessionSystemUpdateKind];

export type AddSessionSystemUpdateInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  classification: SystemUpdateClassification;
  sourceId: string;
  dedupeKey: string;
  summary: string;
  lineage?: Record<string, unknown>;
} & SessionSystemUpdateInputVariant;

export type AddSessionSystemUpdateResult =
  | { added: false; reason: "session_cancelled" }
  | {
      added: boolean;
      reason: "added" | "duplicate";
      update: SessionSystemUpdate;
      shouldWake: boolean;
      workflowWakeRevision: number | null;
      wakeEventId: string;
      temporalWorkflowId: string | null;
      events: SessionEvent[];
    };

export async function addSessionSystemUpdate(
  db: Database,
  input: AddSessionSystemUpdateInput,
): Promise<AddSessionSystemUpdateResult> {
  if (input.payload.type !== input.kind) {
    throw new Error(`Internal update payload discriminator must equal kind ${input.kind}`);
  }
  return await addSessionSystemUpdateWithSourceMutation(db, input, async () => undefined);
}

async function requeueInterruptedSessionSystemUpdatesForTurnTx(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await tx
    .update(schema.sessionSystemUpdates)
    .set({ state: "pending", deliveredTurnId: null, deliveredAt: null })
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, sessionId),
        eq(schema.sessionSystemUpdates.deliveredTurnId, turnId),
        eq(schema.sessionSystemUpdates.state, "delivered"),
      ),
    );
}

/**
 * A failed internal-only inference must not manufacture another inference by
 * making its inputs immediately runnable again. Preserve ordinary internal
 * updates as deferred input for the next real prompt/new update. Goal
 * continuation notices are derivable from the durable goal and become terminal
 * so the goal evaluator can pause or synthesize the next valid continuation.
 */
async function deferFailedSessionSystemUpdatesForTurnTx(
  tx: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await tx
    .update(schema.sessionSystemUpdates)
    .set({
      state: sql`case when ${schema.sessionSystemUpdates.payload} ->> 'type' = 'goal_continuation' then 'failed' else 'deferred' end`,
      deliveredTurnId: null,
      deliveredAt: null,
    })
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, sessionId),
        eq(schema.sessionSystemUpdates.deliveredTurnId, turnId),
        eq(schema.sessionSystemUpdates.state, "delivered"),
      ),
    );
}

/**
 * Persist one internal update without fabricating a user prompt or queue row.
 * Dedupe and any producer/outbox mutation commit in the same transaction.
 */
export async function addSessionSystemUpdateWithSourceMutation(
  db: Database,
  input: AddSessionSystemUpdateInput,
  mutateSource: (tx: Database, wakeEventId: string | null) => Promise<void>,
): Promise<AddSessionSystemUpdateResult> {
  if (Buffer.byteLength(JSON.stringify(input.payload)) > MAX_INTERNAL_UPDATE_BYTES) {
    throw new Error(`Internal update payload exceeds ${MAX_INTERNAL_UPDATE_BYTES} bytes`);
  }
  if (Buffer.byteLength(input.summary) > MAX_INTERNAL_UPDATE_BYTES) {
    throw new Error(`Internal update summary exceeds ${MAX_INTERNAL_UPDATE_BYTES} bytes`);
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const effectiveControl = await evaluateSessionControl(
          tx as unknown as Database,
          input.workspaceId,
          input.sessionId,
          { lock: "share" },
        );
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        // The session row is the sequence and wake owner. Taking an unrelated
        // exclusive lock on its workspace here creates an inverse lock edge
        // with an active turn that already owns the session and is inserting a
        // workspace-scoped event (the FK check then waits on the workspace).
        // The session FK already proves workspace existence, so serialize only
        // on the actual mutable owner.
        if (!session) throw new Error(`Session not found: ${input.sessionId}`);
        if (session.status === "cancelled") {
          await mutateSource(tx as unknown as Database, null);
          return { added: false, reason: "session_cancelled" } as const;
        }

        const [inserted] = await tx
          .insert(schema.sessionSystemUpdates)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            kind: input.kind,
            classification: input.classification,
            sourceId: input.sourceId,
            dedupeKey: input.dedupeKey,
            summary: input.summary,
            payload: input.payload,
            lineage: input.lineage ?? {},
            state: "pending",
          })
          .onConflictDoNothing({
            target: [
              schema.sessionSystemUpdates.workspaceId,
              schema.sessionSystemUpdates.sessionId,
              schema.sessionSystemUpdates.dedupeKey,
            ],
          })
          .returning();
        if (!inserted) {
          const [existing] = await tx
            .select()
            .from(schema.sessionSystemUpdates)
            .where(
              and(
                eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
                eq(schema.sessionSystemUpdates.sessionId, input.sessionId),
                eq(schema.sessionSystemUpdates.dedupeKey, input.dedupeKey),
              ),
            )
            .limit(1);
          if (!existing) throw new Error("System-update dedupe row disappeared");
          const [pendingEvent] = await tx
            .select({ id: schema.sessionEvents.id })
            .from(schema.sessionEvents)
            .where(
              and(
                eq(schema.sessionEvents.workspaceId, input.workspaceId),
                eq(schema.sessionEvents.sessionId, input.sessionId),
                eq(schema.sessionEvents.type, "system.update.pending"),
                sql`${schema.sessionEvents.payload} ->> 'updateId' = ${existing.id}`,
              ),
            )
            .limit(1);
          if (!pendingEvent) throw new Error("System-update pending event disappeared");
          await mutateSource(tx as unknown as Database, pendingEvent.id);
          return {
            added: false,
            reason: "duplicate",
            update: mapSessionSystemUpdate(existing),
            shouldWake: false,
            workflowWakeRevision: null,
            wakeEventId: pendingEvent.id,
            temporalWorkflowId: session.temporalWorkflowId,
            events: [],
          };
        }

        const now = new Date();
        const [event] = await tx
          .insert(schema.sessionEvents)
          .values({
            accountId: session.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            sequence: session.lastSequence + 1,
            type: "system.update.pending",
            payload: sanitizeEventPayload({
              updateId: inserted.id,
              kind: input.kind,
              classification: input.classification,
              sourceId: input.sourceId,
              summary: input.summary,
            }),
            occurredAt: now,
          })
          .returning();
        if (!event) throw new Error("Failed to create system-update pending event");
        await mutateSource(tx as unknown as Database, event.id);
        const shouldWake = session.activeTurnId === null && effectiveControl.state === "active";
        const wake = shouldWake
          ? await registerInternalUpdateWakeInTransaction(tx as unknown as Database, {
              accountId: session.accountId,
              workspaceId: input.workspaceId,
              sessionId: session.id,
              temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
            })
          : null;
        await tx
          .update(schema.sessions)
          .set({
            lastSequence: session.lastSequence + 1,
            ...(shouldWake ? { status: "queued" as const } : {}),
            updatedAt: now,
          })
          .where(eq(schema.sessions.id, session.id));
        return {
          added: true,
          reason: "added",
          update: mapSessionSystemUpdate(inserted),
          shouldWake: wake?.shouldSignal ?? false,
          workflowWakeRevision: wake?.wakeRevision ?? null,
          wakeEventId: event.id,
          temporalWorkflowId: session.temporalWorkflowId,
          events: event ? [mapEvent(event)] : [],
        };
      }),
  );
}

export async function listOutstandingSessionSystemUpdates(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<SessionSystemUpdate[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
        ),
      )
      .orderBy(asc(schema.sessionSystemUpdates.createdAt), asc(schema.sessionSystemUpdates.id));
    return rows.map(mapSessionSystemUpdate);
  });
}

/** Internal updates atomically attached when this inference was claimed. */
export async function listSessionSystemUpdatesForTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<SessionSystemUpdate[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.sessionSystemUpdates)
      .where(
        and(
          eq(schema.sessionSystemUpdates.workspaceId, workspaceId),
          eq(schema.sessionSystemUpdates.sessionId, sessionId),
          eq(schema.sessionSystemUpdates.deliveredTurnId, turnId),
          eq(schema.sessionSystemUpdates.state, "delivered"),
        ),
      )
      .orderBy(asc(schema.sessionSystemUpdates.createdAt), asc(schema.sessionSystemUpdates.id));
    return rows.map(mapSessionSystemUpdate);
  });
}

function mapSessionSystemUpdate(
  row: typeof schema.sessionSystemUpdates.$inferSelect,
): SessionSystemUpdate {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind as SessionSystemUpdateKind,
    classification: row.classification as SystemUpdateClassification,
    sourceId: row.sourceId,
    dedupeKey: row.dedupeKey,
    summary: row.summary,
    payload: SessionSystemUpdatePayload.parse(row.payload),
    lineage: row.lineage,
    state: row.state as SessionSystemUpdateState,
    deliveredTurnId: row.deliveredTurnId,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function appendSessionEvents(
  db: Database,
  workspaceId: string,
  sessionId: string,
  inputs: AppendEventInput[],
): Promise<SessionEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        // Generic API/system event appends participate in the same lock order
        // as durable queue controls. Without this workspace lock an append can
        // hold the session row and then request a workspace FK key-share while
        // a concurrent stop/steer holds workspace FOR UPDATE and waits on the
        // session — a real PostgreSQL deadlock whose caller may treat the live
        // fanout as best-effort and accidentally hide a lost terminal event.
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId))
          .for("update")
          .limit(1);
        const [row] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          )
          .for("update")
          .limit(1);
        if (!row) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        let sequence = row.lastSequence;
        const values = inputs.map((input) => ({
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          sessionId,
          sequence: ++sequence,
          type: input.type,
          payload: sanitizeEventPayload(input.payload ?? {}),
          clientEventId: input.clientEventId ?? null,
          turnId: input.turnId ?? null,
          turnGeneration: input.turnGeneration ?? null,
          turnAttemptId: input.turnAttemptId ?? null,
          turnAssociation: input.turnAssociation ?? (input.turnId ? "current" : null),
          duplicateOfEventId: input.duplicateOfEventId ?? null,
          duplicateReason: input.duplicateReason ?? null,
          producerId: input.producerId ?? null,
          producerSeq: input.producerSeq ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        }));
        const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
        await tx
          .update(schema.sessions)
          .set({ lastSequence: sequence, updatedAt: new Date() })
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          );
        return inserted.map(mapEvent);
      }),
  );
}

export type AcceptSessionApprovalDecisionResult =
  | {
      action: "accepted";
      event: SessionEvent;
      events: SessionEvent[];
      workflowWakeRevision: number;
    }
  | { action: "conflict"; sessionStatus: SessionStatus };

/**
 * Accept exactly one decision for the currently waiting approval boundary.
 * The session and active turn are locked with the append so concurrent Pause,
 * Steer, and duplicate decisions cannot manufacture a second resume trigger.
 */
export async function acceptSessionApprovalDecision(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    payload: Record<string, unknown>;
    clientEventId?: string | null;
  },
): Promise<AcceptSessionApprovalDecisionResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, input.workspaceId))
          .for("update")
          .limit(1);
        const [session] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, input.workspaceId),
              eq(schema.sessions.id, input.sessionId),
            ),
          )
          .for("update")
          .limit(1);
        if (!session) throw new Error(`Session not found: ${input.sessionId}`);
        if (input.clientEventId) {
          const [existing] = await tx
            .select()
            .from(schema.sessionEvents)
            .where(
              and(
                eq(schema.sessionEvents.workspaceId, input.workspaceId),
                eq(schema.sessionEvents.sessionId, input.sessionId),
                eq(schema.sessionEvents.clientEventId, input.clientEventId),
              ),
            )
            .limit(1);
          if (existing) {
            if (existing.type !== "user.approvalDecision") {
              throw new Error("clientEventId belongs to a different session event");
            }
            const workflowWakeRevision = await enqueueSessionWorkflowWakeInTransaction(
              tx as unknown as Database,
              {
                accountId: session.accountId,
                workspaceId: input.workspaceId,
                sessionId: session.id,
                temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
                reason: "approval_decision",
              },
            );
            return {
              action: "accepted",
              event: mapEvent(existing),
              events: [],
              workflowWakeRevision,
            } as const;
          }
        }
        const [turn] = session.activeTurnId
          ? await tx
              .select()
              .from(schema.sessionTurns)
              .where(
                and(
                  eq(schema.sessionTurns.workspaceId, input.workspaceId),
                  eq(schema.sessionTurns.sessionId, input.sessionId),
                  eq(schema.sessionTurns.id, session.activeTurnId),
                ),
              )
              .for("update")
              .limit(1)
          : [];
        if (session.status !== "requires_action" || turn?.status !== "requires_action") {
          return {
            action: "conflict",
            sessionStatus: session.status as SessionStatus,
          } as const;
        }
        const [trigger] = await tx
          .select({ sequence: schema.sessionEvents.sequence })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, input.workspaceId),
              eq(schema.sessionEvents.sessionId, input.sessionId),
              eq(schema.sessionEvents.id, turn.triggerEventId),
            ),
          )
          .limit(1);
        if (!trigger) throw new Error(`Turn trigger not found: ${turn.triggerEventId}`);
        const [alreadyAccepted] = await tx
          .select({ id: schema.sessionEvents.id })
          .from(schema.sessionEvents)
          .where(
            and(
              eq(schema.sessionEvents.workspaceId, input.workspaceId),
              eq(schema.sessionEvents.sessionId, input.sessionId),
              eq(schema.sessionEvents.type, "user.approvalDecision"),
              gt(schema.sessionEvents.sequence, trigger.sequence),
            ),
          )
          .limit(1);
        if (alreadyAccepted) {
          return { action: "conflict", sessionStatus: "requires_action" } as const;
        }
        const [event] = await tx
          .insert(schema.sessionEvents)
          .values({
            accountId: session.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId: turn.id,
            turnGeneration: turn.executionGeneration,
            turnAssociation: "current",
            sequence: session.lastSequence + 1,
            type: "user.approvalDecision",
            payload: sanitizeEventPayload(input.payload),
            clientEventId: input.clientEventId ?? null,
          })
          .returning();
        if (!event) throw new Error("Failed to append approval decision");
        await tx
          .update(schema.sessions)
          .set({ lastSequence: session.lastSequence + 1, updatedAt: new Date() })
          .where(eq(schema.sessions.id, session.id));
        const workflowWakeRevision = await enqueueSessionWorkflowWakeInTransaction(
          tx as unknown as Database,
          {
            accountId: session.accountId,
            workspaceId: input.workspaceId,
            sessionId: session.id,
            temporalWorkflowId: session.temporalWorkflowId ?? `session-${session.id}`,
            reason: "approval_decision",
          },
        );
        const mapped = mapEvent(event);
        return {
          action: "accepted",
          event: mapped,
          events: [mapped],
          workflowWakeRevision,
        } as const;
      }),
  );
}

/**
 * Durable attempt fence for activity-produced events. A cancelled or replaced
 * attempt may still flush SDK callbacks after Temporal cancellation; those late
 * events remain associated with their producer in logs but are not admitted to
 * the current durable timeline once the turn row moved generation or terminal.
 */
export async function appendSessionEventsForTurnAttempt(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  executionGeneration: number,
  attemptId: string,
  inputs: AppendEventInput[],
): Promise<{ events: SessionEvent[]; accepted: boolean }> {
  if (inputs.length === 0) return { events: [], accepted: true };
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const fence = await lockTurnAttemptWriteFenceTx(tx, {
        workspaceId,
        sessionId,
        turnId,
        executionGeneration,
        attemptId,
      });
      const session = fence.session;
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      let sequence = session.lastSequence;
      const now = new Date();
      const usageSourceKey = (input: AppendEventInput): string | null => {
        if (
          input.type !== "agent.model.usage" ||
          !input.payload ||
          typeof input.payload !== "object"
        ) {
          return null;
        }
        const value = (input.payload as Record<string, unknown>).sourceKey;
        return typeof value === "string" && value.length > 0 ? value : null;
      };
      const incomingUsageKeys = [
        ...new Set(inputs.map(usageSourceKey).filter((value): value is string => value !== null)),
      ];
      const existingUsageRows =
        fence.allowed && incomingUsageKeys.length > 0
          ? await tx
              .select({ id: schema.sessionEvents.id, payload: schema.sessionEvents.payload })
              .from(schema.sessionEvents)
              .where(
                and(
                  eq(schema.sessionEvents.workspaceId, workspaceId),
                  eq(schema.sessionEvents.sessionId, sessionId),
                  eq(schema.sessionEvents.turnId, turnId),
                  eq(schema.sessionEvents.type, "agent.model.usage"),
                  eq(schema.sessionEvents.turnAssociation, "current"),
                  inArray(
                    sql<string>`${schema.sessionEvents.payload} ->> 'sourceKey'`,
                    incomingUsageKeys,
                  ),
                ),
              )
          : [];
      const canonicalUsageIds = new Map<string, string>();
      for (const row of existingUsageRows) {
        const value =
          row.payload && typeof row.payload === "object"
            ? (row.payload as Record<string, unknown>).sourceKey
            : null;
        if (typeof value === "string" && value.length > 0) {
          canonicalUsageIds.set(value, row.id);
        }
      }
      const values = inputs.map((input) => {
        const id = crypto.randomUUID();
        if (!fence.allowed) {
          return {
            id,
            accountId: session.accountId,
            workspaceId,
            sessionId,
            sequence: ++sequence,
            type: "turn.event.rejected_late",
            payload: sanitizeEventPayload({
              rejectedType: input.type,
              rejectedPayload: input.payload ?? {},
              reason: fence.reason,
              expectedExecutionGeneration: executionGeneration,
              rejectedAttemptId: attemptId,
              currentExecutionGeneration: fence.turn?.executionGeneration ?? null,
              currentAttemptId: fence.turn?.activeAttemptId ?? null,
              currentTurnStatus: fence.turn?.status ?? null,
              currentActiveTurnId: session.activeTurnId,
            }),
            clientEventId: input.clientEventId ?? null,
            turnId,
            turnGeneration: executionGeneration,
            turnAttemptId: attemptId,
            turnAssociation: "late_rejected" as const,
            duplicateOfEventId: null,
            duplicateReason: null,
            producerId: input.producerId ?? null,
            producerSeq: input.producerSeq ?? null,
            occurredAt: input.occurredAt ?? now,
          };
        }
        const sourceKey = usageSourceKey(input);
        const duplicateOfEventId = sourceKey ? (canonicalUsageIds.get(sourceKey) ?? null) : null;
        if (sourceKey && !duplicateOfEventId) {
          canonicalUsageIds.set(sourceKey, id);
        }
        return {
          id,
          accountId: session.accountId,
          workspaceId,
          sessionId,
          sequence: ++sequence,
          type: input.type,
          payload: sanitizeEventPayload(input.payload ?? {}),
          clientEventId: input.clientEventId ?? null,
          turnId,
          turnGeneration: executionGeneration,
          turnAttemptId: attemptId,
          turnAssociation: duplicateOfEventId ? ("duplicate" as const) : ("current" as const),
          duplicateOfEventId,
          duplicateReason: duplicateOfEventId ? "duplicate_provider_response_usage" : null,
          producerId: input.producerId ?? null,
          producerSeq: input.producerSeq ?? null,
          occurredAt: input.occurredAt ?? now,
        };
      });
      const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
      await tx
        .update(schema.sessions)
        .set({ lastSequence: sequence, updatedAt: now })
        .where(
          and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
        );
      return { events: inserted.map(mapEvent), accepted: fence.allowed };
    });
  });
}

export async function appendSessionEventToSandboxGroup(
  db: Database,
  workspaceId: string,
  sandboxGroupId: string,
  input: AppendEventInput,
): Promise<SessionEvent[]> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, workspaceId),
              eq(schema.sessions.sandboxGroupId, sandboxGroupId),
            ),
          )
          .orderBy(asc(schema.sessions.createdAt))
          .for("update");
        if (rows.length === 0) {
          return [];
        }
        const occurredAt = input.occurredAt ?? new Date();
        const values = rows.map((row) => ({
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          sessionId: row.id,
          sequence: row.lastSequence + 1,
          type: input.type,
          payload: sanitizeEventPayload(input.payload ?? {}),
          clientEventId: input.clientEventId ?? null,
          turnId: input.turnId ?? null,
          turnGeneration: input.turnGeneration ?? null,
          producerId: input.producerId ?? null,
          producerSeq: input.producerSeq ?? null,
          occurredAt,
        }));
        const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
        await tx
          .update(schema.sessions)
          .set({
            lastSequence: sql`${schema.sessions.lastSequence} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.sessions.workspaceId, workspaceId),
              eq(schema.sessions.sandboxGroupId, sandboxGroupId),
            ),
          );
        return inserted.map(mapEvent);
      }),
  );
}

export async function appendSessionEventsAndUpdateSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
  inputs: AppendEventInput[],
  update: {
    resources?: ResourceRef[];
    tools?: ToolRef[];
    model?: string;
    metadata?: Record<string, unknown>;
    status?: SessionStatus;
    activeTurnId?: string | null;
  },
): Promise<SessionEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          )
          .for("update")
          .limit(1);
        if (!row) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        let sequence = row.lastSequence;
        const now = new Date();
        const values = inputs.map((input) => ({
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          sessionId,
          sequence: ++sequence,
          type: input.type,
          payload: sanitizeEventPayload(input.payload ?? {}),
          clientEventId: input.clientEventId ?? null,
          turnId: input.turnId ?? null,
          turnGeneration: input.turnGeneration ?? null,
          producerId: input.producerId ?? null,
          producerSeq: input.producerSeq ?? null,
          occurredAt: input.occurredAt ?? now,
        }));
        const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
        await tx
          .update(schema.sessions)
          .set({
            lastSequence: sequence,
            ...(update.resources !== undefined ? { resources: update.resources } : {}),
            ...(update.tools !== undefined ? { tools: update.tools } : {}),
            ...(update.model !== undefined ? { model: update.model } : {}),
            ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
            ...(update.status !== undefined ? { status: update.status } : {}),
            ...(update.activeTurnId !== undefined ? { activeTurnId: update.activeTurnId } : {}),
            updatedAt: now,
          })
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          );
        return inserted.map(mapEvent);
      }),
  );
}

type LockedSessionUpdateContext = {
  updateSessionMcpServerCredentials: (
    updates: UpdateSessionMcpServerCredentialsInput[],
  ) => Promise<UpdateSessionMcpServerCredentialsResult>;
  listPendingSessionTurns: () => Promise<SessionTurn[]>;
};

type LockedSessionUpdateResult = {
  events: AppendEventInput[];
  update?: {
    resources?: ResourceRef[];
    tools?: ToolRef[];
    model?: string;
    metadata?: Record<string, unknown>;
    status?: SessionStatus;
    activeTurnId?: string | null;
  };
};

export async function appendSessionEventsWithLockedSessionUpdate(
  db: Database,
  workspaceId: string,
  sessionId: string,
  build: (
    session: Session,
    context: LockedSessionUpdateContext,
  ) => LockedSessionUpdateResult | Promise<LockedSessionUpdateResult>,
): Promise<SessionEvent[]> {
  return await withWorkspaceRls(
    db,
    workspaceId,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockWorkspaceInferenceControl(tx as unknown as Database, workspaceId, "share");
        const [sessionRow] = await tx
          .select()
          .from(schema.sessions)
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          )
          .for("update")
          .limit(1);
        if (!sessionRow) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        const mappedSession = await mapSessionWithControl(tx as unknown as Database, sessionRow);
        const built = await build(mappedSession, {
          updateSessionMcpServerCredentials: async (updates) =>
            await updateSessionMcpServerCredentialsInTransaction(tx, {
              workspaceId,
              sessionId,
              updates,
            }),
          listPendingSessionTurns: async () => {
            const rows = await tx
              .select()
              .from(schema.sessionTurns)
              .where(
                and(
                  eq(schema.sessionTurns.workspaceId, workspaceId),
                  eq(schema.sessionTurns.sessionId, sessionId),
                  inArray(schema.sessionTurns.status, ["queued", "running", "requires_action"]),
                ),
              )
              .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt));
            return rows.map(mapSessionTurn);
          },
        });
        if (built.events.length === 0) {
          return [];
        }
        let sequence = sessionRow.lastSequence;
        const now = new Date();
        const values = built.events.map((input) => ({
          accountId: sessionRow.accountId,
          workspaceId: sessionRow.workspaceId,
          sessionId,
          sequence: ++sequence,
          type: input.type,
          payload: sanitizeEventPayload(input.payload ?? {}),
          clientEventId: input.clientEventId ?? null,
          turnId: input.turnId ?? null,
          turnGeneration: input.turnGeneration ?? null,
          producerId: input.producerId ?? null,
          producerSeq: input.producerSeq ?? null,
          occurredAt: input.occurredAt ?? now,
        }));
        const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
        const update = built.update ?? {};
        await tx
          .update(schema.sessions)
          .set({
            lastSequence: sequence,
            ...(update.resources !== undefined ? { resources: update.resources } : {}),
            ...(update.tools !== undefined ? { tools: update.tools } : {}),
            ...(update.model !== undefined ? { model: update.model } : {}),
            ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
            ...(update.status !== undefined ? { status: update.status } : {}),
            ...(update.activeTurnId !== undefined ? { activeTurnId: update.activeTurnId } : {}),
            updatedAt: now,
          })
          .where(
            and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)),
          );
        return inserted.map(mapEvent);
      }),
  );
}

export function sessionSubject(workspaceId: string, sessionId: string): string {
  return `workspaces.${workspaceId}.sessions.${sessionId}.events`;
}

async function sessionControlProjections(
  db: Database,
  workspaceId: string,
  sessionIds: string[],
): Promise<Map<string, Session["effectiveControl"]>> {
  const controls = await evaluateSessionControls(db, workspaceId, sessionIds, { lock: "share" });
  return new Map(
    [...controls].map(([sessionId, control]) => [
      sessionId,
      serializeEffectiveSessionControl(control),
    ]),
  );
}

async function mapSessionWithControl(
  db: Database,
  row: typeof schema.sessions.$inferSelect,
  mcpServers: SessionMcpServerMetadata[] = [],
  pin: Pick<Session, "pinned" | "pinnedAt" | "pinVersion"> = mapSessionPin(null),
): Promise<Session> {
  const controls = await sessionControlProjections(db, row.workspaceId, [row.id]);
  const control = controls.get(row.id);
  if (!control) throw new Error(`Effective control missing for session ${row.id}`);
  return mapSession(row, control, mcpServers, pin);
}

function mapSession(
  row: typeof schema.sessions.$inferSelect,
  effectiveControl: Session["effectiveControl"],
  mcpServers: SessionMcpServerMetadata[] = [],
  pin: Pick<Session, "pinned" | "pinnedAt" | "pinVersion"> = mapSessionPin(null),
): Session {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    status: row.status as SessionStatus,
    initialMessage: row.initialMessage,
    title: row.title ?? null,
    titleSource: (row.titleSource as "user" | "agent" | null) ?? null,
    instructions: row.instructions ?? null,
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    metadata: row.metadata,
    model: row.model,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    sandboxOs: row.sandboxOs as SandboxOs,
    sandboxGroupId: row.sandboxGroupId,
    // The first-class swappable-sandbox pointer (M2). null == use the group
    // sandbox; active_epoch is the swap fence. Defensive Number() coercion keeps
    // the fence exact even if the column type ever drifts (the lease-epoch lesson).
    activeSandboxId: row.activeSandboxId ?? null,
    activeEpoch: Number(row.activeEpoch),
    variableSetId: row.variableSetId,
    environmentId: row.variableSetId,
    // The rig + frozen rig version the session rides (M3). Both null for a
    // rig-less session; frozen at create so a later promote never moves them.
    rigId: row.rigId ?? null,
    rigVersionId: row.rigVersionId ?? null,
    rigDefaultVariableSetsAuthorized: row.rigDefaultVariableSetsAuthorized,
    firstPartyMcpPermissions: (row.firstPartyMcpPermissions as Permission[] | null) ?? null,
    mcpServers,
    parentSessionId: row.parentSessionId ?? null,
    createIdempotencyKey: row.createIdempotencyKey ?? null,
    temporalWorkflowId: row.temporalWorkflowId,
    activeTurnId: row.activeTurnId,
    lastInputTokens: row.lastInputTokens ?? null,
    queueVersion: row.queueVersion,
    queueHeadPosition: Number(row.queueHeadPosition),
    queueTailPosition: Number(row.queueTailPosition),
    effectiveControl,
    lastSequence: row.lastSequence,
    codexPinnedCredentialId: row.codexPinnedCredentialId ?? null,
    codexLastCredentialId: row.codexLastCredentialId ?? null,
    ...pin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEventType,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
    turnGeneration: row.turnGeneration,
    turnAttemptId: row.turnAttemptId,
    turnAssociation: row.turnAssociation as SessionEvent["turnAssociation"],
    duplicateOfEventId: row.duplicateOfEventId,
    duplicateReason: row.duplicateReason,
  };
}

function mapSessionTurn(row: typeof schema.sessionTurns.$inferSelect): SessionTurn {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    temporalWorkflowId: row.temporalWorkflowId,
    status: row.status as SessionTurnStatus,
    source: row.source as SessionTurnSource,
    position: row.position,
    prompt: row.prompt,
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    model: row.model,
    reasoningEffort: row.reasoningEffort as ReasoningEffort,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    sandboxOs: (row.sandboxOs as SandboxOs | null) ?? null,
    metadata: row.metadata,
    version: row.version,
    executionGeneration: row.executionGeneration,
    activeAttemptId: row.activeAttemptId,
    lineage: row.lineage,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function latestStartedSessionTurnRow(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<typeof schema.sessionTurns.$inferSelect | null> {
  const [row] = await db
    .select({ turn: schema.sessionTurns })
    .from(schema.sessionEvents)
    .innerJoin(
      schema.sessionTurns,
      and(
        eq(schema.sessionEvents.workspaceId, schema.sessionTurns.workspaceId),
        eq(schema.sessionEvents.sessionId, schema.sessionTurns.sessionId),
        eq(schema.sessionEvents.turnId, schema.sessionTurns.id),
      ),
    )
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, workspaceId),
        eq(schema.sessionEvents.sessionId, sessionId),
        eq(schema.sessionEvents.type, "turn.started"),
      ),
    )
    // session_events_workspace_session_sequence_idx supports this backward
    // scan; the PK join then fetches exactly one turn row even for very long
    // sessions with thousands of timeline deltas per turn.
    .orderBy(desc(schema.sessionEvents.sequence))
    .limit(1);
  return row?.turn ?? null;
}

function mapFile(row: typeof schema.files.$inferSelect): FileAsset {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status as FileStatus,
    filename: row.filename,
    safeFilename: row.safeFilename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    bucket: row.bucket,
    objectKey: row.objectKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapScheduledTask(row: typeof schema.scheduledTasks.$inferSelect): ScheduledTask {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as ScheduledTaskStatus,
    schedule: row.schedule as ScheduledTaskScheduleSpec,
    temporalScheduleId: row.temporalScheduleId,
    runMode: row.runMode as ScheduledTaskRunMode,
    overlapPolicy: row.overlapPolicy as ScheduledTaskOverlapPolicy,
    agentConfig: row.agentConfig as ScheduledTaskAgentConfig,
    reusableSessionId: row.reusableSessionId,
    variableSetId: row.variableSetId,
    environmentId: row.variableSetId,
    rigId: row.rigId ?? null,
    rigDefaultVariableSetsAuthorized: row.rigDefaultVariableSetsAuthorized,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapScheduledTaskRun(row: typeof schema.scheduledTaskRuns.$inferSelect): ScheduledTaskRun {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    taskId: row.taskId,
    status: row.status as ScheduledTaskRunStatus,
    triggerType: row.triggerType as ScheduledTaskTriggerType,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    firedAt: row.firedAt.toISOString(),
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapAccount(row: typeof schema.managedAccounts.$inferSelect): ManagedAccount {
  return {
    id: row.id,
    name: row.name,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapPackInstallation(row: typeof schema.packInstallations.$inferSelect): PackInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    packId: row.packId,
    status: row.status as PackInstallationStatus,
    metadata: row.metadata,
    enabledAt: row.enabledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWorkspacePack(row: typeof schema.workspacePacks.$inferSelect): WorkspaceRegisteredPack {
  return {
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    // Manifests are validated with the CapabilityPack contract at the API
    // boundary before they are stored.
    pack: row.manifest as unknown as CapabilityPack,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapImportBatch(row: typeof schema.importBatches.$inferSelect): ImportBatch {
  return {
    id: row.id,
    source: row.source,
    snapshotDate: row.snapshotDate.toISOString(),
    snapshotRef: row.snapshotRef,
    attributionNote: row.attributionNote,
    importedCount: row.importedCount,
    skippedCount: row.skippedCount,
    quarantinedCount: row.quarantinedCount,
    logoFailureCount: row.logoFailureCount,
    staleCount: row.staleCount,
    details: row.details,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCapabilityCatalogItem(
  row: typeof schema.capabilityCatalogItems.$inferSelect,
): CapabilityCatalogItem {
  const runtime =
    row.kind === "mcp" && row.endpointUrl
      ? {
          available: true,
          mcpServerId: mcpServerIdForCapability(row.id, row.metadata),
          transport: row.transport ?? "streamable-http",
          notes: row.authModel
            ? "Requires credential headers supplied in the enable request."
            : null,
        }
      : {
          available: false,
          notes:
            row.kind === "mcp"
              ? "Remote streamable HTTP endpoint is required for runtime use."
              : null,
        };
  return {
    id: row.id,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    kind: row.kind as CapabilityKind,
    source: row.source as CapabilitySource,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: row.tags,
    homepageUrl: row.homepageUrl,
    endpointUrl: row.endpointUrl,
    installUrl: row.installUrl,
    authModel: row.authModel,
    providerDomain: row.providerDomain,
    surfaceType: row.surfaceType,
    transport: row.transport,
    mcpUrl: row.mcpUrl,
    authKind: row.authKind as CapabilityCatalogItem["authKind"],
    credentialFacts: row.credentialFacts,
    tier: row.tier as CapabilityCatalogItem["tier"],
    provenance: row.provenance,
    logoAssetPath: row.logoAssetPath,
    importBatchId: row.importBatchId,
    stale: row.stale,
    staleAt: row.staleAt?.toISOString() ?? null,
    tools: [],
    runtime,
    enabled: false,
    enabledReason: null,
    // Overwritten by applyCapabilityEnablement in @opengeni/core, which knows
    // the installation; a freshly-read catalog row carries no connection.
    connectionRef: null,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function workspaceControlProjection(
  db: Database,
  workspaceId: string,
): Promise<Workspace["inferenceControl"]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [control] = await scopedDb
      .select()
      .from(schema.workspaceInferenceControls)
      .where(eq(schema.workspaceInferenceControls.workspaceId, workspaceId))
      .limit(1);
    if (!control) throw new Error(`Workspace ${workspaceId} has no inference control`);
    return {
      state: control.workspaceState as "active" | "paused",
      revision: Number(control.revision),
      reason: control.reason,
      changedBy: control.changedBy,
      changedAt: control.changedAt?.toISOString() ?? null,
    };
  });
}

function mapWorkspace(
  row: typeof schema.workspaces.$inferSelect,
  inferenceControl: Workspace["inferenceControl"],
): Workspace {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    slug: row.slug,
    externalSource: row.externalSource,
    externalId: row.externalId,
    agentInstructions: row.agentInstructions ?? null,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    inferenceControl,
    defaultRigId: row.defaultRigId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWorkspaceMember(row: typeof schema.workspaceMemberships.$inferSelect): WorkspaceMember {
  return {
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    role: row.role,
    permissions: row.permissions as Permission[],
    createdAt: row.createdAt.toISOString(),
  };
}

function mapCapabilityInstallation(
  row: typeof schema.capabilityInstallations.$inferSelect,
): CapabilityInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    capabilityId: row.capabilityId,
    kind: row.kind as CapabilityKind,
    status: row.status as CapabilityInstallationStatus,
    config: redactInstallationConfig(row.config),
    metadata: row.metadata,
    enabledAt: row.enabledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Stored credential-header ciphertext never leaves the database through the
 * generic installation mapping — callers see only the sorted header names.
 * The runtime reads ciphertext through listEnabledMcpCapabilityServers and
 * the enable flow through getStoredCapabilityHeaderCiphertext.
 */
function redactInstallationConfig(config: Record<string, unknown>): Record<string, unknown> {
  const headersEncrypted = encryptedHeadersConfig(config.headersEncrypted);
  if (!headersEncrypted) {
    return config;
  }
  const { headersEncrypted: _omitted, ...rest } = config;
  return { ...rest, headerNames: Object.keys(headersEncrypted).sort() };
}

function mapConnectionMetadata(row: {
  id: string;
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  providerDomain: string;
  kind: string;
  status: string;
  grantedScopes: string[];
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  version: number;
  metadata: Record<string, unknown>;
  createdBySubjectId: string | null;
  updatedBySubjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ConnectionMetadata {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    subjectId: row.subjectId,
    providerDomain: row.providerDomain,
    kind: row.kind as ConnectionKind,
    status: row.status as ConnectionStatus,
    grantedScopes: row.grantedScopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastRefreshAt: row.lastRefreshAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastError: row.lastError,
    version: row.version,
    metadata: row.metadata,
    createdBySubjectId: row.createdBySubjectId,
    updatedBySubjectId: row.updatedBySubjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapKnowledgeMemory(row: typeof schema.knowledgeMemories.$inferSelect): KnowledgeMemory {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status as KnowledgeMemoryStatus,
    kind: row.kind as KnowledgeMemoryKind,
    scope: row.scope,
    text: row.text,
    sourceRefs: Array.isArray(row.sourceRefs) ? (row.sourceRefs as KnowledgeSourceRef[]) : [],
    confidence: confidenceFromStorage(row.confidence),
    metadata: row.metadata,
    createdBySessionId: row.createdBySessionId,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    pinned: row.pinned,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSocialConnection(row: typeof schema.socialConnections.$inferSelect): SocialConnection {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    provider: row.provider as SocialProvider,
    accountHandle: row.accountHandle,
    accountName: row.accountName,
    externalAccountId: row.externalAccountId,
    status: row.status as SocialConnectionStatus,
    scopes: row.scopes,
    credentialRef: row.credentialRef,
    tokenMetadata: row.tokenMetadata,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapApiKey(row: typeof schema.apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions as Permission[],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapGitHubInstallation(
  row: typeof schema.githubInstallations.$inferSelect,
): GitHubInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapUsageEvent(row: typeof schema.usageEvents.$inferSelect): UsageEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    subjectId: row.subjectId,
    eventType: row.eventType as UsageEvent["eventType"],
    quantity: row.quantity,
    unit: row.unit,
    sourceResourceType: row.sourceResourceType,
    sourceResourceId: row.sourceResourceId,
    idempotencyKey: row.idempotencyKey,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    exportedToBillingAt: row.exportedToBillingAt ? row.exportedToBillingAt.toISOString() : null,
    billingProviderEventId: row.billingProviderEventId,
  };
}

function mapSocialPost(row: typeof schema.socialPosts.$inferSelect): SocialPost {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    provider: row.provider as SocialProvider,
    externalPostId: row.externalPostId,
    url: row.url,
    authorHandle: row.authorHandle,
    text: row.text,
    publishedAt: row.publishedAt.toISOString(),
    metrics: row.metrics,
    raw: row.raw,
    createdAt: row.createdAt.toISOString(),
  };
}

function stringArrayConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return values.length > 0 ? [...new Set(values.map((item) => item.trim()))] : undefined;
}

function cleanDbString(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireDbString(value: string, field: string): string {
  const trimmed = cleanDbString(value);
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function confidenceToStorage(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.round(Math.min(Math.max(value, 0), 1) * 100);
}

function confidenceFromStorage(value: number): number {
  return Number((Math.min(Math.max(value, 0), 100) / 100).toFixed(2));
}

function positiveIntegerConfig(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return undefined;
}

function booleanConfig(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function encryptedHeadersConfig(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mcpConnectivityOk(metadata: Record<string, unknown>): boolean {
  const value = metadata.mcpConnectivity;
  return (
    !!value &&
    typeof value === "object" &&
    "status" in value &&
    (value.status === "ok" || value.status === "auth_deferred")
  );
}

function connectionRefConfig(value: unknown): McpServerConnectionRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.providerDomain !== "string" || record.providerDomain.length === 0) {
    return undefined;
  }
  const ref: McpServerConnectionRef = { providerDomain: record.providerDomain };
  if (typeof record.connectionId === "string" && record.connectionId.length > 0) {
    ref.connectionId = record.connectionId;
  }
  if (
    typeof record.kind === "string" &&
    ["oauth2", "api_key", "app_install", "delegated"].includes(record.kind)
  ) {
    ref.kind = record.kind as ConnectionKind;
  }
  if (Array.isArray(record.scopes)) {
    const scopes = record.scopes.filter(
      (scope): scope is string => typeof scope === "string" && scope.length > 0,
    );
    if (scopes.length > 0) {
      ref.scopes = scopes;
    }
  }
  if (typeof record.resource === "string" && record.resource.length > 0) {
    ref.resource = record.resource;
  }
  if (record.subjectScope === "workspace" || record.subjectScope === "subject") {
    ref.subjectScope = record.subjectScope;
  }
  return ref;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

// Shared, refreshing, id-addressed Codex token resolver + the per-account usage
// wrapper (P2). Placed at the END so every accessor it orchestrates
// (loadCodexCredentialForRun / recordCodexTokenRefresh / setCodexCredentialStatus /
// recordCodexAccountUsage) is already initialized when its default-deps bag
// evaluates under the index↔resolver module cycle.
export * from "./codex-token-resolver";
export * from "./connection-token-resolver";
