// Migration 0733: per-provider session bindings (D-32 of
// docs/subscription-accounts.md). The database is migrated by the
// NOSUPERUSER, NOBYPASSRLS owner without 0733, bindings are written the way
// the previous binary writes them, then 0733 is applied alone. Both sides of
// the rolling window run as the restricted application role: the previous
// binary's SQL (conflict target (workspace_id, session_id), which also sets
// provider) against the new key, and the new writer (conflict target
// (workspace_id, session_id, provider)) against rows the previous binary
// wrote. While the rolling index exists a session still holds at most one
// binding row; once the next drained provider cutover drops it (with every
// previous binary gone), providers coexist and the previous upsert fails. A
// live binding writer that overlaps 0733 must not deadlock with it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSessionRlsActorContext,
  type DbClient,
  retiredSubscriptionObjectDescriptions,
  retiredSubscriptionObjectViolation,
  RUNTIME_SESSION_USAGE_LIMIT_PRIVATE_TABLES,
  SESSION_USAGE_LIMIT_INTERNAL_ROUTINES,
  SESSION_USAGE_LIMIT_RUNTIME_ROUTINES,
} from "../src";
import { rawRows, withRlsContext, type Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  isSubscriptionSessionBindingRollingConflict,
  readSubscriptionSessionBinding,
  writeSubscriptionSessionBinding,
} from "../src/subscription-core-repository";
import {
  stageVaultPolicyColumns,
  withoutAbsentLaterPosture,
  withoutAbsentVaultPosture,
  stageConnectionAccountIntentColumns,
  stageSiteSessionAudienceColumns,
} from "./vault-policy-column-fixture";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0733_subscription_session_bindings_per_provider.sql";
const ROLLING_INDEX = "subscription_session_bindings_rolling_session_idx";

type Org = { accountId: string; subjectId: string; workspaceId: string };
type Provider = "codex" | "xai" | "claude";
type StoredRow = Record<string, unknown>;

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let org: Org | null = null;
/** Sessions whose bindings were written before 0733, and their rows then. */
let staged: { sessions: string[]; rows: StoredRow[] } | null = null;
let posture: { unprovisioned: string[]; provisioned: string[] } | null = null;
/** How a live binding writer and 0733 ended when they overlapped. */
let overlap: { writer: string | null; migration: string | null } | null = null;

async function stageOrganization(): Promise<Org> {
  const admin = database!.admin;
  const userId = `bindings-per-provider-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Per-provider bindings",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const subjectId = `user:${userId}`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Per-provider bindings shared') returning id::text as id`;
  await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${subjectId}, 'owner')`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  return { accountId, subjectId, workspaceId: workspace!.id };
}

async function session(): Promise<string> {
  const created = await withSessionRlsActorContext({ subjectId: org!.subjectId }, () =>
    createSession(client!.db, {
      accountId: org!.accountId,
      workspaceId: org!.workspaceId,
      subjectId: org!.subjectId,
      initialMessage: "Bindings",
      resources: [],
      metadata: {},
      model: "codex/gpt-5.5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: "workspace_shared",
      createdBy: { kind: "subject", subjectId: org!.subjectId },
      createdByContext: {},
    }),
  );
  return created.id;
}

async function connection(provider: Provider): Promise<string> {
  const [row] = await database!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, credential_encrypted, ownership, scope_kind
    ) values (${org!.accountId}::uuid, ${provider}, ${`v1:bindings-${provider}`}, 'shared',
      'organization')
    returning id::text as id`;
  return row!.id;
}

/** Runs as the application role in the session's scope, as a pin or placement does. */
async function asApp<T>(run: (db: Database) => Promise<T>): Promise<T> {
  return await withSessionRlsActorContext(
    { subjectId: org!.subjectId, initiatingHumanSubjectId: org!.subjectId },
    () =>
      withRlsContext(
        client!.db,
        { accountId: org!.accountId, workspaceId: org!.workspaceId },
        (db) => run(db as unknown as Database),
      ),
  );
}

type BindingInput = {
  sessionId: string;
  provider: Provider;
  connectionId: string | null;
  choice: "automatic" | "explicit";
  expectedVersion?: number | null;
};

/**
 * The previous binary's binding writer, verbatim apart from its inputs
 * (packages/db/src/subscription-core-repository.ts before 0733): one row per
 * session, conflict target (workspace_id, session_id), provider overwritten.
 */
async function previousBinaryWrite(input: BindingInput): Promise<number | null> {
  return await asApp(async (db) => {
    const [row] = await rawRows<{ version: number | string }>(
      db,
      sql`insert into subscription_session_bindings (
        account_id, workspace_id, session_id, provider, connection_id, model_id,
        choice, only_this_model, last_model_call_at, last_switch_reason, version
      ) values (
        ${org!.accountId}::uuid, ${org!.workspaceId}::uuid, ${input.sessionId}::uuid,
        ${input.provider}, ${input.connectionId}::uuid, ${`${input.provider}/model`},
        ${input.choice}, false, ${new Date().toISOString()}::timestamptz,
        ${input.choice === "explicit" ? "explicit_choice" : "initial"}, 1
      )
      on conflict (workspace_id, session_id) do update
        set provider = excluded.provider,
            connection_id = excluded.connection_id,
            model_id = excluded.model_id,
            choice = excluded.choice,
            only_this_model = excluded.only_this_model,
            last_model_call_at = excluded.last_model_call_at,
            last_switch_reason = excluded.last_switch_reason,
            version = subscription_session_bindings.version + 1
        where ${input.expectedVersion ?? null}::bigint is not null
          and subscription_session_bindings.account_id = excluded.account_id
          and subscription_session_bindings.version = ${input.expectedVersion ?? null}::bigint
      returning version`,
    );
    return row ? Number(row.version) : null;
  });
}

/** This binary's writer. */
async function currentWrite(input: BindingInput): Promise<number | null> {
  return await asApp(
    async (db) =>
      await writeSubscriptionSessionBinding(db, {
        accountId: org!.accountId,
        workspaceId: org!.workspaceId,
        sessionId: input.sessionId,
        provider: input.provider,
        connectionId: input.connectionId,
        modelId: `${input.provider}/model`,
        choice: input.choice,
        onlyThisModel: false,
        lastModelCallAt: new Date(),
        lastSwitchReason: input.choice === "explicit" ? "explicit_choice" : "initial",
        expectedVersion: input.expectedVersion ?? null,
      }),
  );
}

async function rows(sessionIds: string[]): Promise<StoredRow[]> {
  return [
    ...(await database!.admin<StoredRow[]>`
      select session_id::text as session_id, provider, connection_id::text as connection_id,
        model_id, choice, only_this_model, last_model_call_at, last_switch_reason,
        version::int as version
      from subscription_session_bindings
      where session_id::text in ${database!.admin(sessionIds)}
      order by session_id, provider`),
  ];
}

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const code =
      (error as { code?: unknown } | null)?.code ??
      (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return typeof code === "string" ? code : String(error);
  }
}

async function rollingIndexExists(): Promise<boolean> {
  const [row] = await database!.admin<{ present: boolean }[]>`
    select to_regclass(${ROLLING_INDEX}) is not null as present`;
  return row!.present;
}

/** Waits until some transaction queues for a lock on the bindings table. */
async function bindingLockWaiter(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [row] = await database!.admin<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_locks l join pg_class c on c.oid = l.relation
      where c.relname = 'subscription_session_bindings' and not l.granted`;
    if (row!.waiting > 0) return;
    await Bun.sleep(25);
  }
  throw new Error("0733 never queued for the bindings table");
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-session-bindings-per-provider");
  if (!database) throw new Error("Real PostgreSQL is required");
  // A provisioned database before 0733: 0733 and every later migration are
  // held back, and only 0733 is applied below.
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= MIGRATION)
    .sort();
  const staging = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await stageVaultPolicyColumns(database.ownerUrl);
    await stageConnectionAccountIntentColumns(database.ownerUrl);
    await stageSiteSessionAudienceColumns(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 4 });
  org = await stageOrganization();

  // The previous binary's bindings: an explicit pin, an automatic placement
  // moved once by compare-and-swap, and a pin whose account was deleted.
  const codex = await connection("codex");
  const doomed = await connection("codex");
  const pinned = await session();
  const automatic = await session();
  const deleted = await session();
  expect(
    await previousBinaryWrite({
      sessionId: pinned,
      provider: "codex",
      connectionId: codex,
      choice: "explicit",
    }),
  ).toBe(1);
  expect(
    await previousBinaryWrite({
      sessionId: automatic,
      provider: "codex",
      connectionId: codex,
      choice: "automatic",
    }),
  ).toBe(1);
  expect(
    await previousBinaryWrite({
      sessionId: automatic,
      provider: "codex",
      connectionId: null,
      choice: "automatic",
      expectedVersion: 1,
    }),
  ).toBe(2);
  expect(
    await previousBinaryWrite({
      sessionId: deleted,
      provider: "codex",
      connectionId: doomed,
      choice: "explicit",
    }),
  ).toBe(1);
  await database.admin`delete from subscription_connections where id = ${doomed}::uuid`;
  const sessions = [pinned, automatic, deleted];
  staged = { sessions, rows: await rows(sessions) };

  // A rolling migration keeps the previous binary's runtime posture until
  // roles are provisioned again: apply 0733 alone, evaluate as the runtime
  // role, then provision and evaluate again.
  const applying = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await applying`delete from schema_migrations where name = ${MIGRATION}`;
    // A live binding writer overlaps 0733: it reads its row FOR UPDATE, 0733
    // starts and queues behind it, then the writer writes the row and commits,
    // as a placement, a pin or a request's cache clock does. Neither may fail.
    let migrating = null as Promise<string | null> | null;
    const writer = await sqlState(() =>
      asApp(async (db) => {
        const locked = await rawRows<{ version: number | string }>(
          db,
          sql`select version from subscription_session_bindings
            where workspace_id = ${org!.workspaceId}::uuid and session_id = ${pinned}::uuid
            for update`,
        );
        if (locked.length !== 1) throw new Error("the live writer did not lock its binding");
        migrating = sqlState(() => migrate(database!.ownerUrl));
        await bindingLockWaiter();
        await rawRows(
          db,
          sql`update subscription_session_bindings set only_this_model = only_this_model
            where workspace_id = ${org!.workspaceId}::uuid and session_id = ${pinned}::uuid`,
        );
      }),
    );
    overlap = { writer, migration: migrating ? await migrating : "migration never started" };
    if (overlap.migration !== null) await migrate(database.ownerUrl);
    const [applied] = await applying<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${MIGRATION}`;
    if (applied?.count !== 1) throw new Error("0733 was not applied by the second migrate");
  } finally {
    await applying.end();
  }
  const options = {
    rlsStrategy: "force" as const,
    expectedRole: "opengeni_app",
    targetSchema: "public",
    requiredRuntimeRoutines: [],
  };
  // Stopped before 0739 and 0761: the absent vault and exhausted-schedule
  // objects are expected.
  const evaluate = async () =>
    withoutAbsentLaterPosture(
      withoutAbsentVaultPosture(
        evaluateRuntimeDatabasePosture(
          await inspectRuntimeDatabasePosture(client!.db, options),
          options,
        ),
      ),
    );
  const unprovisioned = await evaluate();
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  posture = { unprovisioned, provisioned: await evaluate() };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("0733 per-provider session bindings", () => {
  test("restricted roles; the rolling posture holds before and after provisioning", async () => {
    const roles = await database!.admin<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname in (${database!.ownerRole}, 'opengeni_app')`;
    expect([...roles]).toEqual([
      { superuser: false, bypass: false },
      { superuser: false, bypass: false },
    ]);
    const [identity] = await rawRows<{ role: string }>(
      client!.db,
      sql`select current_user::text as role`,
    );
    expect(identity!.role).toBe("opengeni_app");
    // This historical fixture applies only 0733, not the later 0735 owned-usage
    // routines. Current readiness must report exactly those missing routines
    // both before and after provisioning; no other posture failure is allowed.
    const SITE_DATA_TABLES = [
      // 0792 (schedule blocker reviews) is also a later runtime/protected table.
      "scheduled_task_blocker_reviews",
      "site_abuse_reports",
      "site_auth_codes",
      "site_data_collections",
      "site_data_files",
      "site_data_rate_windows",
      "site_data_record_values",
      "site_data_records",
      "site_data_usage",
      "site_data_validation_windows",
      "site_data_workspace_validation_windows",
      "site_hostname_holds",
      "site_hostnames",
      "site_limit_profiles",
      "site_platform_brake",
      "site_platform_storage",
      "site_platform_totals",
      "site_platform_usage",
      "site_publications",
      "site_runtime_conversations",
      "site_runtime_rate_windows",
      "site_runtime_usage",
      "site_sql_databases",
      "site_sql_migrations",
      "site_sql_queries",
      "site_sql_rate_windows",
      "site_sql_usage",
      "site_viewer_sessions",
    ];
    const missing0735Routines = [
      "subscription M3 precursor private routine read_subscription_core_owned_connection_credential(text, uuid, uuid, text, uuid) is missing or unsafe",
      "subscription M3 precursor private routine begin_subscription_core_owned_connection_refresh(text, uuid, uuid, text, uuid) is missing or unsafe",
      "subscription M3 precursor private routine record_subscription_core_owned_connection_quota(text, uuid, uuid, text, uuid, bigint, bigint, jsonb, timestamp with time zone) is missing or unsafe",
    ];
    // Nor the later provider cutovers (0747, 0748), the drained retirement
    // (0751) or personal sharing (0752), whose absence readiness also reports.
    const expected = [
      ...retiredSubscriptionObjectDescriptions().map(retiredSubscriptionObjectViolation),
      "database is missing the xai subscription-core cutover receipt (0747_subscription_core_xai_cutover.sql); apply the pending migrations first",
      "database is missing the claude subscription-core cutover receipt (0748_subscription_core_claude_cutover.sql); apply the pending migrations first",
      "subscription M3 precursor private routine subscription_core_personal_sharing(text, uuid, text, uuid, integer) is missing or unsafe",
      ...missing0735Routines,
      // Nor Site Data (0776), published Sites (0782) or Site SQL (0783), whose
      // tables the runtime and protected contracts list.
      `runtime privilege tables are missing: ${SITE_DATA_TABLES.join(", ")}`,
      `protected tables are missing: ${SITE_DATA_TABLES.join(", ")}`,
      // Nor per-task usage limits (0773).
      ...SESSION_USAGE_LIMIT_INTERNAL_ROUTINES.map(
        (routine) => `owner-internal target-schema helper ${routine} is missing or ambiguous`,
      ),
      ...SESSION_USAGE_LIMIT_RUNTIME_ROUTINES.map(
        (routine) => `target-schema runtime capability ${routine} is missing or ambiguous`,
      ),
      ...RUNTIME_SESSION_USAGE_LIMIT_PRIVATE_TABLES.map(
        (table) => `session usage limit private table ${table} is missing or unsafe`,
      ),
      "session usage limit capability has unsafe owner or direct runtime privileges",
      // Nor the later Site lifecycle cancellation capability (0795).
      "Site cancellation capability ledger is missing or unsafe",
      "Site cancellation policy predicate is missing or unsafe",
      "Site cancellation routine begin_site_session_cancellation(uuid, uuid, uuid, uuid) is missing or unsafe",
      "Site cancellation routine end_site_session_cancellation(uuid) is missing or unsafe",
    ];
    expect(posture).toEqual({ unprovisioned: expected, provisioned: expected });
  });

  test("every binding the previous binary wrote keeps every value across 0733", async () => {
    expect(staged!.rows).toHaveLength(3);
    expect(staged!.rows.map((row) => [row.choice, row.connection_id === null])).toEqual(
      expect.arrayContaining([
        ["explicit", false],
        ["automatic", true],
        ["explicit", true],
      ]),
    );
    expect(await rows(staged!.sessions)).toEqual(staged!.rows);
  });

  test("a live binding writer and 0733 overlap without a deadlock", async () => {
    // 0733 takes its whole lock set first, so it waits for the writer that
    // locked its row, and the writer's write is not blocked by a SHARE lock.
    expect(overlap).toEqual({ writer: null, migration: null });
  });

  test("the key, the rolling index, the provider trigger and its grants", async () => {
    const [key] = await database!.admin<{ columns: string[] }[]>`
      select array_agg(attribute.attname::text order by keys.position) as columns
      from pg_constraint constraint_row
      cross join lateral unnest(constraint_row.conkey) with ordinality keys(attnum, position)
      join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid
        and attribute.attnum = keys.attnum
      where constraint_row.conrelid = 'subscription_session_bindings'::regclass
        and constraint_row.contype = 'p'`;
    expect(key!.columns).toEqual(["workspace_id", "session_id", "provider"]);
    const [index] = await database!.admin<{ definition: string; comment: string | null }[]>`
      select pg_get_indexdef(${ROLLING_INDEX}::regclass) as definition,
        obj_description(${ROLLING_INDEX}::regclass, 'pg_class') as comment`;
    expect(index!.definition).toContain(
      "CREATE UNIQUE INDEX subscription_session_bindings_rolling_session_idx",
    );
    expect(index!.definition).toContain("(workspace_id, session_id)");
    expect(index!.comment).toContain("Dropped by the next drained provider cutover");
    // Nothing else references the binding key.
    const referencing = await database!.admin<{ name: string }[]>`
      select conname::text as name from pg_constraint
      where confrelid = 'subscription_session_bindings'::regclass`;
    expect([...referencing]).toEqual([]);
    const [trigger] = await database!.admin<{ definition: string }[]>`
      select pg_get_triggerdef(oid) as definition from pg_trigger
      where tgrelid = 'subscription_session_bindings'::regclass
        and tgname = 'subscription_session_bindings_provider_fixed'`;
    expect(trigger!.definition).toContain("BEFORE UPDATE OF provider");
    expect(trigger!.definition).toContain(
      "EXECUTE FUNCTION opengeni_private.guard_subscription_binding_provider()",
    );
    const [routine] = await database!.admin<
      { definer: boolean; config: string[]; public: boolean; app: boolean }[]
    >`
      select proc.prosecdef as definer, coalesce(proc.proconfig, '{}') as config,
        has_function_privilege('public', proc.oid, 'execute') as public,
        has_function_privilege('opengeni_app', proc.oid, 'execute') as app
      from pg_proc proc
      where proc.oid = 'opengeni_private.guard_subscription_binding_provider()'::regprocedure`;
    expect(routine).toEqual({
      definer: false,
      config: ["search_path=pg_catalog, pg_temp"],
      public: false,
      app: true,
    });
  });

  test("rolling window: the previous binary on the new key, and this binary on its rows", async () => {
    expect(await rollingIndexExists()).toBe(true);
    const [pinned, automatic] = staged!.sessions as [string, string, string];
    const xai = await connection("xai");
    const codex = await connection("codex");

    // This binary moves a binding the previous binary wrote, by version.
    const before = (await rows([automatic]))[0]!;
    expect(
      await currentWrite({
        sessionId: automatic,
        provider: "codex",
        connectionId: codex,
        choice: "automatic",
        expectedVersion: before.version as number,
      }),
    ).toBe((before.version as number) + 1);
    // This binary reads it by provider; another provider has no binding.
    const read = (provider: Provider, sessionId: string) =>
      asApp((db) =>
        readSubscriptionSessionBinding(db, {
          workspaceId: org!.workspaceId,
          sessionId,
          provider,
        }),
      );
    expect(await read("codex", pinned)).toMatchObject({ provider: "codex", choice: "explicit" });
    expect(await read("xai", pinned)).toBeNull();

    // The previous binary moves a binding this binary wrote, by version.
    const fresh = await session();
    expect(
      await currentWrite({
        sessionId: fresh,
        provider: "codex",
        connectionId: codex,
        choice: "automatic",
      }),
    ).toBe(1);
    expect(
      await previousBinaryWrite({
        sessionId: fresh,
        provider: "codex",
        connectionId: null,
        choice: "automatic",
        expectedVersion: 1,
      }),
    ).toBe(2);
    // A stale version stays a lost compare-and-swap for both binaries.
    expect(
      await previousBinaryWrite({
        sessionId: fresh,
        provider: "codex",
        connectionId: codex,
        choice: "automatic",
        expectedVersion: 1,
      }),
    ).toBeNull();
    expect(
      await currentWrite({
        sessionId: fresh,
        provider: "codex",
        connectionId: codex,
        choice: "automatic",
        expectedVersion: 1,
      }),
    ).toBeNull();

    // The previous binary can never flip a binding to another provider...
    const snapshot = await rows([fresh, pinned]);
    expect(
      await sqlState(() =>
        previousBinaryWrite({
          sessionId: fresh,
          provider: "xai",
          connectionId: xai,
          choice: "automatic",
          expectedVersion: 2,
        }),
      ),
    ).toBe("23514");
    expect(
      await sqlState(() =>
        asApp((db) =>
          rawRows(
            db,
            sql`update subscription_session_bindings set provider = 'xai', connection_id = null
              where workspace_id = ${org!.workspaceId}::uuid and session_id = ${pinned}::uuid`,
          ),
        ),
      ),
    ).toBe("23514");
    // ...and neither binary can add a second provider's row in the window,
    // so the previous binary always reads the session's only row.
    expect(
      await sqlState(() =>
        currentWrite({ sessionId: fresh, provider: "xai", connectionId: xai, choice: "automatic" }),
      ),
    ).toBe("23505");
    // That violation is how a racing first binding meets the rolling index;
    // placement and the pin recognize it as a lost compare-and-swap.
    let violation: unknown = null;
    try {
      await currentWrite({
        sessionId: fresh,
        provider: "xai",
        connectionId: xai,
        choice: "automatic",
      });
    } catch (error) {
      violation = error;
    }
    expect(isSubscriptionSessionBindingRollingConflict(violation)).toBe(true);
    expect(isSubscriptionSessionBindingRollingConflict(new Error("other"))).toBe(false);
    expect(await rows([fresh, pinned])).toEqual(snapshot);
  });

  // Only the previous upsert fails without the index; the previous binary's
  // reads and Codex pin UPDATE carry no provider, so the drop needs every
  // previous binary gone (the drained cutover's preflight), not this 42P10.
  test("after the drained cutover drops the rolling index, providers coexist and the previous upsert fails", async () => {
    // What the next drained provider cutover does, after its preflight.
    await database!.admin.unsafe(`DROP INDEX ${ROLLING_INDEX}`);
    const [pinned] = staged!.sessions as [string, string, string];
    const xai = await connection("xai");
    const before = await rows([pinned]);
    expect(before.map((row) => row.provider)).toEqual(["codex"]);
    expect(
      await currentWrite({
        sessionId: pinned,
        provider: "xai",
        connectionId: xai,
        choice: "explicit",
      }),
    ).toBe(1);
    const after = await rows([pinned]);
    expect(after.map((row) => [row.provider, row.choice])).toEqual([
      ["codex", "explicit"],
      ["xai", "explicit"],
    ]);
    // The Codex pin is exactly as it was.
    expect(after[0]).toEqual(before[0]);
    // A writer that still uses the previous conflict target cannot run.
    expect(
      await sqlState(() =>
        previousBinaryWrite({
          sessionId: pinned,
          provider: "codex",
          connectionId: null,
          choice: "automatic",
          expectedVersion: 1,
        }),
      ),
    ).toBe("42P10");
    // The provider still never changes, and each provider's row moves alone.
    expect(
      await sqlState(() =>
        asApp((db) =>
          rawRows(
            db,
            sql`update subscription_session_bindings set provider = 'claude', connection_id = null
              where workspace_id = ${org!.workspaceId}::uuid and session_id = ${pinned}::uuid
                and provider = 'xai'`,
          ),
        ),
      ),
    ).toBe("23514");
    expect(
      await currentWrite({
        sessionId: pinned,
        provider: "xai",
        connectionId: null,
        choice: "automatic",
        expectedVersion: 1,
      }),
    ).toBe(2);
    expect((await rows([pinned]))[0]).toEqual(before[0]);
  });
});
