import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  registerHostExportConsumer,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

const migration = "1122_drop_retired_subscription_pools.sql";
const providers = ["codex", "claude", "xai"] as const;
const tables = [
  "claude_credential_leases",
  "claude_rotation_settings",
  "claude_session_account_pins",
  "claude_subscription_account_usage",
  "claude_subscription_credentials",
  "codex_apps_settings",
  "codex_credential_leases",
  "codex_rotation_settings",
  "codex_subscription_credentials",
  "codex_turn_source_bindings",
  "organization_codex_rotation_settings",
  "subscription_provider_cutovers",
  "workspace_codex_subscription_preferences",
  "xai_credential_leases",
  "xai_rotation_settings",
  "xai_session_account_pins",
  "xai_subscription_credentials",
];
const names = [
  "backfill_product_lifecycle_facts",
  "capture_product_lifecycle_fact",
  "check_organization_tenancy_parity_pre_0340",
  "activate_session_tenancy_product",
  "finalize_organization_retention_deletion",
  "inventory_organization_tenancy",
  "fork_session_content",
];
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let exporter: DbClient | null = null;
let owner: postgres.Sql | null = null;
let prefix: string | null = null;
let scope: { accountId: string; workspaceId: string };
let sessionId: string;
let turnId: string;
let before: Awaited<ReturnType<typeof definitions>> = [];
const credentialIds = new Map<string, string>();

async function definitions() {
  return Array.from(
    await owned!.admin`
    select p.oid, p.proowner, p.proacl, p.prosecdef, p.prorettype, p.prosrc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'opengeni_private') and p.proname = any(${names}::text[])
    order by p.oid`,
  );
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("retired-subscription-pool-contract");
  if (!owned) throw new Error("Real PostgreSQL is required for pool contraction");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-pool-contract-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source))
    if (name.endsWith(".sql") && name < migration)
      await copyFile(join(source, name), join(prefix, name));
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  exporter = createDb(owned.ownerUrl, { max: 1 });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "pool-retirement-test",
    accountExternalId: crypto.randomUUID(),
    workspaceExternalSource: "pool-retirement-test",
    workspaceExternalId: crypto.randomUUID(),
    accountName: "Pool retirement",
    workspaceName: "Pool retirement",
    subjectId: "pool-retirement-test",
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "current queued work",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const [turn] = await owned.admin<
    { id: string }[]
  >`select id from session_turns where session_id = ${sessionId} order by position limit 1`;
  if (!turn) throw new Error("Current session admission did not enqueue its turn");
  turnId = turn.id;
  // Synthetic old records, not an invocation of the deleted runtime. All real
  // migration checks below run as the restricted owner with FORCE RLS enabled.
  await owned.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const provider of providers) {
      const id = crypto.randomUUID();
      credentialIds.set(provider, id);
      await tx.unsafe(
        `insert into ${provider}_subscription_credentials (id, account_id, workspace_id, credential_encrypted, created_at) values ($1, $2, $3, 'test-only', '2026-09-01T10:00:00Z')`,
        [id, scope.accountId, scope.workspaceId],
      );
    }
  });
  before = await definitions();
}, 600_000);

afterAll(async () => {
  await client?.close();
  await exporter?.close();
  await owner?.end();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

async function assertRolledBack() {
  expect(await definitions()).toEqual(before);
  const rows = await owned!.admin<
    { name: string; forced: boolean }[]
  >`select c.relname as name, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${tables}::text[]) order by c.relname`;
  expect(Array.from(rows)).toEqual([...tables].sort().map((name) => ({ name, forced: true })));
  const [state] = await owned!.admin<
    { applied: boolean }[]
  >`select exists(select 1 from schema_migrations where name = ${migration}) as applied`;
  expect(state?.applied).toBe(false);
  expect(
    await owned!
      .admin`select 1 from opengeni_private.product_lifecycle_backfill_queue where source = 'model.connected'`,
  ).toHaveLength(0);
  await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
}

describe.skipIf(!realDatabase)("retired subscription pool contraction", () => {
  test("uses the non-superuser non-bypass migration owner", async () => {
    const [role] =
      await owner!`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await assertRolledBack();
  }, 180_000);

  for (const provider of providers)
    test(`${provider}: an owner-hidden live lease refuses the entire contraction`, async () => {
      const id = crypto.randomUUID();
      await owned!.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        const columns = provider === "codex" ? "" : ", authority_scope";
        const values = provider === "codex" ? "" : ", 'workspace'";
        await tx.unsafe(
          `insert into ${provider}_credential_leases (id, account_id, workspace_id, credential_id, turn_id, holder_id, leased_until${columns}) values ($1, $2, $3, $4, $5, 'historical-test', now() + interval '1 hour'${values})`,
          [id, scope.accountId, scope.workspaceId, credentialIds.get(provider)!, turnId],
        );
      });
      try {
        expect(await owner!.unsafe(`select id from ${provider}_credential_leases`)).toHaveLength(0);
        await expect(migrate(owned!.ownerUrl)).rejects.toThrow(
          "legacy subscription leases must drain",
        );
        await assertRolledBack();
      } finally {
        await owned!.admin.unsafe(`delete from ${provider}_credential_leases where id = $1`, [id]);
      }
    }, 180_000);

  test("an unexpected dependent view refuses RESTRICT and preserves the source and fact queue", async () => {
    await owner!`create view unexpected_pool_reader as select id from codex_subscription_credentials`;
    try {
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow("depend");
      await assertRolledBack();
    } finally {
      await owner!`drop view unexpected_pool_reader`;
    }
  }, 180_000);

  test("a schema-bound Insights reader prevents replacement without being cascaded away", async () => {
    await owner!`create view unexpected_insights_reader as select id from insights_audience_sessions`;
    try {
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow("depend");
      await assertRolledBack();
    } finally {
      await owner!`drop view unexpected_insights_reader`;
    }
  }, 180_000);

  test("unmapped view-column grants refuse contraction rather than silently disappearing", async () => {
    await owner!`grant select (id) on insights_audience_sessions to opengeni_app`;
    try {
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow(
        "view column grants require explicit review",
      );
      await assertRolledBack();
    } finally {
      await owner!`revoke select (id) on insights_audience_sessions from opengeni_app`;
    }
  }, 180_000);

  test("an unexpectedly large old history refuses the atomic copy instead of doing unbounded work", async () => {
    await owned!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into codex_subscription_credentials
        (account_id, workspace_id, credential_encrypted)
        select ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, 'large-history-test'
        from generate_series(1, 10000)`;
    });
    try {
      await expect(migrate(owned!.ownerUrl)).rejects.toThrow(
        "large retired credential history requires batched preservation",
      );
      await assertRolledBack();
    } finally {
      await owned!
        .admin`delete from codex_subscription_credentials where credential_encrypted = 'large-history-test'`;
    }
  }, 180_000);

  test("removes retired pools without changing current resources, accepted work or routine authority", async () => {
    await owned!
      .admin`insert into subscription_connections (account_id, provider, credential_encrypted, scope_kind) values (${scope.accountId}, 'codex', 'current-test-only', 'organization')`;
    const current = await owned!
      .admin`select * from subscription_connections where account_id = ${scope.accountId}`;
    const turn = await owned!.admin`select * from session_turns where id = ${turnId}`;
    const identities = (await definitions()).map(({ prosrc: _body, ...row }) => row);
    const viewAuthority = () => owned!.admin`
      select c.relowner, c.reloptions, acl.grantee, acl.privilege_type, acl.is_grantable
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
      where c.oid = 'insights_audience_sessions'::regclass
      order by acl.grantee, acl.privilege_type`;
    const beforeView = await viewAuthority();
    await migrate(owned!.ownerUrl);
    expect(
      await owned!
        .admin`select * from subscription_connections where account_id = ${scope.accountId}`,
    ).toEqual(current);
    expect(await owned!.admin`select * from session_turns where id = ${turnId}`).toEqual(turn);
    expect((await definitions()).map(({ prosrc: _body, ...row }) => row)).toEqual(identities);
    expect(await viewAuthority()).toEqual(beforeView);
    expect(
      await owned!
        .admin`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${tables}::text[])`,
    ).toHaveLength(0);
    const pattern =
      tables.join("|") + "|codex_pinned_credential_id|codex_last_credential_id|codex_pin_source";
    expect(
      await owned!
        .admin`select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'opengeni_private') and p.prokind in ('f','p') and p.prosrc ~ ${pattern}`,
    ).toHaveLength(0);
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await provisionRoles(owned!.adminUrl, { appPassword: owned!.appPassword });
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await createSession(client!.db, {
      ...scope,
      initialMessage: "post-contract session",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const after = await definitions();
    await migrate(owned!.ownerUrl);
    expect(await definitions()).toEqual(after);
  }, 180_000);

  test("retains exactly the historical lifecycle inputs for later bounded backfill", async () => {
    const queued = await owned!.admin<
      { attribute: string; dedupe_key: string; occurred_at: Date }[]
    >`select attribute, dedupe_key, occurred_at from opengeni_private.product_lifecycle_backfill_queue where source = 'model.connected' order by attribute`;
    expect(queued.map((row) => ({ attribute: row.attribute, id: row.dedupe_key }))).toEqual([
      { attribute: "codex", id: credentialIds.get("codex")! },
      { attribute: "supergrok", id: credentialIds.get("xai")! },
    ]);
    expect(
      queued.every((row) => row.occurred_at.toISOString() === "2026-09-01T10:00:00.000Z"),
    ).toBe(true);
    await registerHostExportConsumer(exporter!.db, {
      kind: "lifecycle_fact",
      consumerId: "retired-pool-backfill",
    });
    await owner!`select * from opengeni_private.backfill_product_lifecycle_facts('model.connected', 500)`;
    const facts = await owned!.admin<
      { attribute: string; occurred_at: Date }[]
    >`select payload->>'attribute' as attribute, occurred_at from host_export_outbox where export_kind = 'lifecycle_fact' and event_type = 'model.connected' order by attribute`;
    expect(facts.map((row) => row.attribute)).toEqual(["codex", "supergrok"]);
    expect(facts.every((row) => row.occurred_at.toISOString() === "2026-09-01T10:00:00.000Z")).toBe(
      true,
    );
    expect(
      await owned!
        .admin`select 1 from opengeni_private.product_lifecycle_backfill_queue where source = 'model.connected'`,
    ).toHaveLength(0);
    const [progress] = await owned!.admin`
      select materialized::int, scanned::int, enqueued::int, completed_at is not null as complete
      from opengeni_private.product_lifecycle_backfill_progress where source = 'model.connected'`;
    expect(progress).toEqual({ materialized: 2, scanned: 2, enqueued: 2, complete: true });
  }, 180_000);
});
