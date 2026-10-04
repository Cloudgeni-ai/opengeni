import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  assertRuntimeDatabasePosture,
  completeSelfServiceOrganizationSetup,
  createDb,
  createSessionWithIdempotencyKeyResult,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  getPrivateSessionCreatePolicy,
  updateOrganizationPrivateSessionSettings,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0611_universal_session_tenancy_activation.sql";
const source = readFileSync(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let owned: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0611-universal-tenancy");
  if (!owned) {
    if (requireRealDatabase) throw new Error("migration 0611 requires local PostgreSQL");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await owner?.end({ timeout: 5 });
  await owned?.release();
}, 180_000);

type Human = {
  subjectId: string;
  accountId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string | null;
};

async function receiptCount(accountId: string): Promise<number> {
  const [row] = await owned!.admin<{ count: number }[]>`
    select count(*)::int as count from session_tenancy_activations
    where account_id = ${accountId}`;
  return row?.count ?? 0;
}

/** An existing (pre-0611) organization: shared default workspace, no receipt. */
async function existingOrganizationHuman(): Promise<Human> {
  const userId = `universal-${crypto.randomUUID()}`;
  const context = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Universal tenancy owner",
  });
  const sharedWorkspaceId = context.defaultWorkspaceId!;
  const personal = context.workspaceGrants.find((grant) => grant.workspaceId !== sharedWorkspaceId);
  if (!personal) throw new Error("managed human provisioned without a personal workspace");
  return {
    subjectId: `user:${userId}`,
    accountId: personal.accountId,
    sharedWorkspaceId,
    personalWorkspaceId: personal.workspaceId,
  };
}

/** A brand-new self-service signup through the 0348/0349 setup lifecycle. */
async function selfServiceSignupHuman(): Promise<Human> {
  const userId = crypto.randomUUID();
  await owned!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Fresh signup', ${`${userId}@example.test`}, true)`;
  const setup = await completeSelfServiceOrganizationSetup(client!.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Fresh Signup Org",
    operationId: crypto.randomUUID(),
    requestFingerprint: "f".repeat(64),
  });
  return {
    subjectId: `user:${userId}`,
    accountId: setup.organizationId,
    personalWorkspaceId: setup.personalWorkspaceId,
    sharedWorkspaceId: null,
  };
}

async function createPrivate(human: Human, workspaceId: string) {
  return await createSessionWithIdempotencyKeyResult(client!.db, {
    accountId: human.accountId,
    workspaceId,
    visibility: "user_private",
    initialMessage: "only me",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: human.subjectId },
    subjectId: human.subjectId,
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createIdempotencyKey: `0611-${crypto.randomUUID()}`,
  });
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("migration 0611 universal session tenancy activation", () => {
  test("is a rolling catalog-only rewrite that writes no receipt or setting", () => {
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).not.toContain("opengeni.migration_application_roles");
    expect(source).not.toMatch(/\bLOCK TABLE\b/);
    expect(source).not.toMatch(/NO FORCE ROW LEVEL SECURITY/);
    expect(source).not.toMatch(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+[a-z_]+\s/u);
    expect(source).not.toMatch(/backfill_organization_/u);
  });

  test("a fresh self-service signup gets Only me with no operator action or boundary witness", async () => {
    if (!owned || !client) return;
    // Runs first on a freshly migrated database: no organization holds a
    // receipt, so 0349's greenfield helper has no boundary witness (the
    // production state that left every signup without Only me).
    const [witnesses] = await owned.admin<{ count: number }[]>`
      select count(*)::int as count from session_tenancy_activations`;
    expect(witnesses?.count).toBe(0);
    const human = await selfServiceSignupHuman();
    expect(await receiptCount(human.accountId)).toBe(0);
    await expect(
      getOrganizationPrivateSessionSettings(client.db, {
        organizationId: human.accountId,
        actorSubjectId: human.subjectId,
      }),
    ).resolves.toMatchObject({ enabled: true, available: true });
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: human.personalWorkspaceId,
        actorSubjectId: human.subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: true,
      platformAvailable: true,
      organizationEnabled: true,
    });
    await expect(createPrivate(human, human.personalWorkspaceId)).resolves.toMatchObject({
      created: true,
      denied: false,
    });
  }, 180_000);

  test("predicates no longer consult a receipt; legacy-lane retirement stays receipt-keyed", async () => {
    if (!owned || !owner) return;
    const [account] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0611 receiptless') returning id`;
    const accountId = account!.id;
    const [activated] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0611 operator activated') returning id`;
    await owned.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${activated!.id}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'operator-fixture')`;
    expect(await receiptCount(accountId)).toBe(0);
    const probe = async (target: string) =>
      await owner!.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${target}, true)`;
        const [row] = await transaction<
          {
            activated: boolean;
            wrongVersion: boolean;
            nullAccount: boolean;
            otherAccount: boolean;
            legacyLaneRetired: boolean;
            anyActivation: boolean;
          }[]
        >`
          select session_tenancy_product_activated(${target}::uuid, 1) as activated,
            session_tenancy_product_activated(${target}::uuid, 2) as "wrongVersion",
            session_tenancy_product_activated(null, 1) as "nullAccount",
            session_tenancy_product_activated(gen_random_uuid(), 1) as "otherAccount",
            opengeni_private.session_tenancy_account_activated(${target}::uuid) as "legacyLaneRetired",
            session_tenancy_any_product_activation() as "anyActivation"`;
        return row;
      });
    expect(await probe(accountId)).toEqual({
      activated: true,
      wrongVersion: false,
      nullAccount: false,
      otherAccount: false,
      // No receipt: the legacy connection/writer compatibility lanes stay open.
      legacyLaneRetired: false,
      // The retired startup-interlock witness never fires, even with a receipt present.
      anyActivation: false,
    });
    expect(await probe(activated!.id)).toMatchObject({
      activated: true,
      legacyLaneRetired: true,
      anyActivation: false,
    });
    const [table] = await owned.admin<{ force: boolean }[]>`
      select relforcerowsecurity as force from pg_class where oid = 'session_tenancy_activations'::regclass`;
    expect(table?.force).toBe(true);
    const readers = await owned.admin<{ name: string }[]>`
      select proname as name from pg_proc
      where prosrc like '%session_tenancy_activations%'
      order by proname`;
    expect(readers.map((row) => row.name)).toEqual([
      "activate_greenfield_session_tenancy_from_setup",
      "activate_session_tenancy_from_additional_organization",
      "activate_session_tenancy_product",
      "enable_organization_private_sessions_from_activation",
      "session_tenancy_account_activated",
    ]);
    // A durable receipt no longer requires any deployment switch at startup.
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    const runtime = createDb(appUrl.toString(), { max: 1 });
    try {
      await expect(
        assertRuntimeDatabasePosture(runtime.db, {
          rlsStrategy: "force",
          expectedRole: "opengeni_app",
          targetSchema: "public",
        }),
      ).resolves.toBeDefined();
    } finally {
      await runtime.close();
    }
  }, 180_000);

  test("an existing receiptless organization gets Only me by default; an explicit owner disable still gates shared workspaces", async () => {
    if (!owned || !client) return;
    const human = await existingOrganizationHuman();
    const sharedWorkspaceId = human.sharedWorkspaceId!;
    expect(await receiptCount(human.accountId)).toBe(0);

    await expect(
      getOrganizationPrivateSessionSettings(client.db, {
        organizationId: human.accountId,
        actorSubjectId: human.subjectId,
      }),
    ).resolves.toMatchObject({ enabled: true, available: true, version: 0 });
    await expect(
      getPrivateSessionCreatePolicy(client.db, {
        workspaceId: sharedWorkspaceId,
        actorSubjectId: human.subjectId,
      }),
    ).resolves.toEqual({
      personalWorkspace: false,
      platformAvailable: true,
      organizationEnabled: true,
    });
    await expect(createPrivate(human, human.personalWorkspaceId)).resolves.toMatchObject({
      created: true,
      denied: false,
    });
    await expect(createPrivate(human, sharedWorkspaceId)).resolves.toMatchObject({
      created: true,
      denied: false,
    });

    const disabled = await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: human.accountId,
      actorSubjectId: human.subjectId,
      enabled: false,
      expectedVersion: 0,
      operationId: crypto.randomUUID(),
    });
    expect(disabled).toMatchObject({ enabled: false, available: true, version: 1, changed: true });
    const denied = await captureError(() => createPrivate(human, sharedWorkspaceId));
    expect(denied).toHaveProperty("name", "SessionTenancyNotActivatedError");
    // The setting never gates the member's own Personal workspace.
    await expect(createPrivate(human, human.personalWorkspaceId)).resolves.toMatchObject({
      created: true,
      denied: false,
    });

    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: human.accountId,
      actorSubjectId: human.subjectId,
      enabled: true,
      expectedVersion: 1,
      operationId: crypto.randomUUID(),
    });
    await expect(createPrivate(human, sharedWorkspaceId)).resolves.toMatchObject({
      created: true,
      denied: false,
    });
    expect(await receiptCount(human.accountId)).toBe(0);
  }, 180_000);
});
