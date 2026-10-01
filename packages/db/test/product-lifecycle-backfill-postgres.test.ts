import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PRODUCT_LIFECYCLE_FACT_ATTRIBUTES } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  completeSelfServiceOrganizationSetup,
  createConnection,
  createDb,
  registerHostExportConsumer,
  revokeConnection,
  type DbClient,
} from "../src";
import {
  backfillProductLifecycleFacts,
  LIFECYCLE_BACKFILL_SOURCES,
} from "../src/lifecycle-fact-backfill";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// Replaying the full migration ledger is slow and grows with every migration.
setDefaultTimeout(180_000);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let exporter: DbClient | null = null;
let ownerSql: postgres.Sql | null = null;

type FactRow = {
  source_id: string;
  event_type: string;
  account_id: string | null;
  workspace_id: string | null;
  initiator: { kind: string; subjectId: string } | null;
  payload: { factType: string; attribute: string | null; subjectKind: string };
  occurred_at: Date;
};

async function lifecycleRows(): Promise<FactRow[]> {
  return await owned!.admin<FactRow[]>`
    select source_id::text, event_type, account_id::text, workspace_id::text,
      initiator, payload, occurred_at
    from host_export_outbox
    where export_kind = 'lifecycle_fact'
    order by export_cursor`;
}

async function insertAuthUser(createdAt: Date): Promise<{ userId: string; subjectId: string }> {
  const userId = crypto.randomUUID();
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values (${userId}, 'Backfill Person', ${`backfill-${userId}@example.test`}, true,
      ${createdAt}, ${createdAt})`;
  await owned!.admin`
    insert into auth_identities (id, user_id, account_id, provider_id, created_at, updated_at)
    values (${crypto.randomUUID()}, ${userId}, ${`google-${userId}`}, 'google',
      ${createdAt}, ${createdAt})`;
  return { userId, subjectId: `user:${userId}` };
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("product-lifecycle-backfill");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("lifecycle backfill PostgreSQL fixture is unavailable");
    return;
  }
  // The NOSUPERUSER NOBYPASSRLS owner, exactly like production: the backfill
  // must see FORCE-RLS source rows without any tenant GUC.
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  exporter = createDb(owned.ownerUrl, { max: 2 });
  ownerSql = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await Promise.allSettled([client?.close(), exporter?.close(), ownerSql?.end()]);
  await owned?.release();
}, 180_000);

describe("product lifecycle fact backfill (real PostgreSQL)", () => {
  test("backfills history once, with original timestamps and live-capture fact ids", async () => {
    if (!owned || !client || !exporter || !ownerSql) return;

    // History written before any lifecycle consumer existed captures nothing.
    const signedUpAt = new Date("2026-09-03T08:15:00.000Z");
    const person = await insertAuthUser(signedUpAt);
    const setup = await completeSelfServiceOrganizationSetup(client.db, {
      authUserId: person.userId,
      actorSubjectId: person.subjectId,
      organizationName: "Backfill org",
      operationId: crypto.randomUUID(),
      requestFingerprint: "e".repeat(64),
      trialCreditsEnabled: true,
    });
    await applyCreditLedgerEntry(client.db, {
      accountId: setup.organizationId,
      type: "credit_topup",
      amountMicros: 20_000_000,
      sourceType: "stripe_checkout_session",
      sourceId: `cs_test_${crypto.randomUUID()}`,
      idempotencyKey: `backfill-topup:${crypto.randomUUID()}`,
    });
    const key = crypto.randomUUID();
    const grant = (
      await bootstrapWorkspace(client.db, {
        accountExternalSource: "backfill-test",
        accountExternalId: key,
        accountName: "Backfill tenant",
        workspaceExternalSource: "backfill-test",
        workspaceExternalId: key,
        workspaceName: "Backfill workspace",
        subjectId: person.subjectId,
      })
    ).workspaceGrants[0]!;
    const target = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
    const connect = (providerDomain: string) =>
      createConnection(client!.db, {
        ...target,
        subjectId: null,
        providerDomain,
        kind: "api_key",
        credentialEncrypted: `ciphertext-${crypto.randomUUID()}`,
        grantedScopes: [],
        metadata: {},
        createdBySubjectId: person.subjectId,
      });
    const slack = await connect("slack.com");
    const github = await connect("github.com");
    await revokeConnection(client.db, target.workspaceId, github.id, person.subjectId);
    const connectionCreatedAt = new Date("2026-09-10T12:00:00.000Z");
    await owned.admin`update connections set created_at = ${connectionCreatedAt}
      where id = ${slack.id}`;
    expect(await lifecycleRows()).toEqual([]);

    // No consumer yet: the backfill refuses rather than enqueueing nowhere.
    let refused: unknown = null;
    try {
      await backfillProductLifecycleFacts(ownerSql, { sources: ["auth.sign_up"] });
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain("no enabled lifecycle_fact consumer");

    // The migration predates this history, but no consumer was registered,
    // so the revocation above was never captured live: the backfill's
    // boundary for the new kinds is the consumer registration.
    await registerHostExportConsumer(exporter.db, {
      kind: "lifecycle_fact",
      consumerId: "backfill-test",
    });
    // Live capture after registration: this connection's fact must not be
    // duplicated by the backfill.
    const live = await connect("linear.app");
    expect((await lifecycleRows()).map((row) => row.event_type)).toEqual(["connection.created"]);

    const batches: string[] = [];
    const results = await backfillProductLifecycleFacts(ownerSql, {
      batchSize: 1,
      onBatch: (batch) => batches.push(batch.source),
    });
    expect(results.map((result) => result.source)).toEqual([...LIFECYCLE_BACKFILL_SOURCES]);
    // A one-row batch walks every source in several transactions.
    expect(batches.filter((source) => source === "connection.created").length).toBeGreaterThan(2);

    const rows = await lifecycleRows();
    const ids = rows.map((row) => row.source_id);
    expect(new Set(ids).size).toBe(ids.length);
    const of = (type: string) => rows.filter((row) => row.event_type === type);
    expect(of("auth.sign_up").map((row) => [row.payload.attribute, row.occurred_at])).toEqual([
      ["google", signedUpAt],
    ]);
    expect(of("auth.email_verified").map((row) => row.occurred_at)).toEqual([signedUpAt]);
    expect(of("organization.setup").map((row) => row.payload.attribute)).toEqual(["created"]);
    expect(of("credits.purchased")).toHaveLength(1);
    expect(
      of("credits.granted").map((row) => [row.payload.attribute, row.initiator?.subjectId]),
    ).toEqual([["signup_trial", person.subjectId]]);
    const created = of("connection.created");
    expect(created.map((row) => row.payload.attribute).sort()).toEqual([
      "github",
      "linear",
      "slack",
    ]);
    expect(created.find((row) => row.payload.attribute === "slack")?.occurred_at).toEqual(
      connectionCreatedAt,
    );
    expect(created.filter((row) => row.payload.attribute === "linear")).toHaveLength(1);
    expect(of("connection.revoked").map((row) => row.payload.attribute)).toEqual(["github"]);
    for (const row of rows) {
      const allowed: readonly string[] =
        PRODUCT_LIFECYCLE_FACT_ATTRIBUTES[
          row.event_type as keyof typeof PRODUCT_LIFECYCLE_FACT_ATTRIBUTES
        ];
      expect(allowed).toBeDefined();
      expect(Object.keys(row.payload).sort()).toEqual(["attribute", "factType", "subjectKind"]);
    }
    expect(JSON.stringify(rows)).not.toContain("@");
    expect(JSON.stringify(rows)).not.toContain("Backfill");

    // A revocation after the live-capture boundary is captured live and is
    // never re-derived by a later backfill.
    await revokeConnection(client.db, target.workspaceId, live.id, person.subjectId);
    const revoked = (await lifecycleRows()).filter(
      (row) => row.event_type === "connection.revoked",
    );
    expect(revoked.map((row) => row.payload.attribute).sort()).toEqual(["github", "linear"]);

    // FORCE RLS is restored on every source table.
    const unforced = await owned.admin<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relrowsecurity and not c.relforcerowsecurity
        and c.relname in ('connections', 'credit_ledger_entries', 'session_turns',
          'organization_memberships', 'canonical_human_login_bindings')`;
    expect(unforced.map((row) => row.relname)).toEqual([]);

    // A completed run is a no-op, and even a forced restart of every cursor
    // enqueues nothing new: fact ids are deterministic.
    const before = (await lifecycleRows()).length;
    const again = await backfillProductLifecycleFacts(ownerSql);
    expect(again.every((result) => result.enqueued === 0 && result.scanned === 0)).toBe(true);
    await owned.admin`
      update opengeni_private.product_lifecycle_backfill_progress
      set materialized_at = null, cursor_seq = 0, completed_at = null`;
    const restarted = await backfillProductLifecycleFacts(ownerSql, { batchSize: 50 });
    expect(restarted.reduce((sum, result) => sum + result.enqueued, 0)).toBe(0);
    expect(restarted.reduce((sum, result) => sum + result.scanned, 0)).toBeGreaterThan(5);
    expect(await lifecycleRows()).toHaveLength(before);
  });

  test("runtime roles can neither forge facts nor run the backfill", async () => {
    if (!owned || !client) return;
    const attempts = [
      sql`select opengeni_private.enqueue_product_lifecycle_fact(
        'auth.sign_up', 'email', 'user:forged-subject-1', null, null, 'forged')`,
      sql`select opengeni_private.enqueue_product_lifecycle_fact_at(
        'auth.sign_up', 'email', 'user:forged-subject-1', null, null, 'forged', now())`,
      sql`select * from opengeni_private.backfill_product_lifecycle_facts('auth.sign_up', 10)`,
    ];
    for (const attempt of attempts) {
      let refused: unknown = null;
      try {
        await client.db.execute(attempt);
      } catch (error) {
        refused = error;
      }
      expect(refused).not.toBeNull();
    }
    const forged = await owned.admin`
      select 1 from host_export_outbox
      where export_kind = 'lifecycle_fact' and initiator ->> 'subjectId' = 'user:forged-subject-1'`;
    expect(forged).toHaveLength(0);
  });

  test("a backfill batch holds only ACCESS SHARE on source tables", async () => {
    if (!owned || !ownerSql) return;
    await owned.admin`
      update opengeni_private.product_lifecycle_backfill_progress
      set materialized_at = null, cursor_seq = 0, completed_at = null
      where source in ('connection.created', 'credits.granted', 'model.connected')`;
    const reserved = await ownerSql.reserve();
    const held: { relname: string; mode: string }[] = [];
    try {
      for (const source of ["connection.created", "credits.granted", "model.connected"]) {
        await reserved`begin`;
        const [backend] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await reserved`
          select * from opengeni_private.backfill_product_lifecycle_facts(${source}, 1)`;
        // Observed from a second connection while the batch transaction is open.
        held.push(
          ...(await owned.admin<{ relname: string; mode: string }[]>`
            select c.relname::text as relname, l.mode
            from pg_locks l join pg_class c on c.oid = l.relation
            where l.pid = ${backend!.pid} and l.locktype = 'relation'`),
        );
        await reserved`commit`;
      }
    } finally {
      reserved.release();
    }
    const sourceTables = new Set([
      "connections",
      "credit_ledger_entries",
      "codex_subscription_credentials",
      "xai_subscription_credentials",
      "organization_model_provider_connections",
      "organization_model_provider_connection_operations",
    ]);
    expect(held.filter((lock) => sourceTables.has(lock.relname)).length).toBeGreaterThan(0);
    for (const lock of held) {
      expect(["AccessExclusiveLock", "ExclusiveLock", "ShareRowExclusiveLock"]).not.toContain(
        lock.mode,
      );
      if (sourceTables.has(lock.relname)) expect(lock.mode).toBe("AccessShareLock");
    }
  });

  test("batches page an index, so a large source drains in linear time", async () => {
    if (!owned || !ownerSql || !client) return;
    const [account] = await owned.admin<{ id: string }[]>`
      select id::text from managed_accounts order by created_at limit 1`;
    const rows = 50_000;
    await owned.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into credit_ledger_entries (
          account_id, type, amount_micros, source_type, source_id, idempotency_key,
          created_at, occurred_at
        )
        select ${account!.id}::uuid, 'credit_topup', 1000, 'stripe_checkout_session',
          'cs_perf_' || n, 'backfill-perf:' || n,
          now() - (n || ' seconds')::interval, now() - (n || ' seconds')::interval
        from generate_series(1, ${rows}) as n`;
    });
    await owned.admin`
      update opengeni_private.product_lifecycle_backfill_progress
      set materialized_at = null, cursor_seq = 0, completed_at = null
      where source = 'credits.purchased'`;
    const durations: number[] = [];
    let enqueued = 0;
    for (;;) {
      const started = performance.now();
      const [batch] = await ownerSql<
        { enqueued_count: number; scanned_count: number; backfill_completed: boolean }[]
      >`select * from opengeni_private.backfill_product_lifecycle_facts('credits.purchased', 5000)`;
      durations.push(performance.now() - started);
      enqueued += Number(batch!.enqueued_count);
      if (batch!.backfill_completed) break;
    }
    expect(enqueued).toBe(rows);
    // The first call includes the one-pass materialization; later pages must
    // not grow with the remaining backlog (no rescans of the source).
    const pages = durations.slice(1, -1);
    const firstPages = pages.slice(0, 3);
    const lastPages = pages.slice(-3);
    const average = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    expect(average(lastPages)).toBeLessThan(average(firstPages) * 3 + 250);
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeLessThan(120_000);
  });
});
