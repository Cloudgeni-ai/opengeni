import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PRODUCT_LIFECYCLE_FACT_ATTRIBUTES } from "@opengeni/contracts";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
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

    // The revocation above happened before this deployment's live capture
    // of connection.revoked began; mark that boundary after the history.
    await owned.admin`
      update opengeni_private.product_lifecycle_backfill_progress
      set live_capture_from = clock_timestamp()
      where source in ('connection.revoked', 'user.active')`;
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
      set cursor_at = '-infinity', cursor_id = '', completed_at = null`;
    const restarted = await backfillProductLifecycleFacts(ownerSql, { batchSize: 50 });
    expect(restarted.reduce((sum, result) => sum + result.enqueued, 0)).toBe(0);
    expect(restarted.reduce((sum, result) => sum + result.scanned, 0)).toBeGreaterThan(5);
    expect(await lifecycleRows()).toHaveLength(before);
  });
});
