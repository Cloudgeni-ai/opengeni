import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  getPrivateSessionCreatePolicy,
  nestedPostgresSqlState,
  openPrivateSessionCreateCapability,
  SessionTenancyNotActivatedError,
  setSubjectRlsContext,
  updateOrganizationPrivateSessionSettings,
  withRlsContext,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "0611_universal_session_tenancy_activation.sql";
const MIGRATION_ACTOR = "opengeni:migration:0611_universal_session_tenancy_activation";
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

/** The exact organization-activation section, run again as the real owner. */
function activationSection(): string {
  const begin = source.indexOf("-- universal-activation:begin");
  const end = source.indexOf("-- universal-activation:end");
  if (begin < 0 || end < begin) throw new Error("activation section markers are missing");
  return [
    "ALTER TABLE session_tenancy_activations NO FORCE ROW LEVEL SECURITY;",
    source.slice(begin, end),
    "ALTER TABLE session_tenancy_activations FORCE ROW LEVEL SECURITY;",
  ].join("\n");
}

async function runActivationSection(): Promise<void> {
  await owner!.begin((transaction) => transaction.unsafe(activationSection()));
}

async function receipt(accountId: string) {
  const [row] = await owned!.admin<
    { activatedBy: string; inventoryDigest: string; parityDigest: string; receipts: number }[]
  >`
    select activated_by as "activatedBy", inventory_digest as "inventoryDigest",
      parity_digest as "parityDigest", cardinality(backfill_receipt_ids) as receipts
    from session_tenancy_activations where account_id = ${accountId}`;
  return row ?? null;
}

async function managedHuman() {
  const userId = `universal-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Universal tenancy owner",
  });
  const sharedWorkspaceId = context.defaultWorkspaceId!;
  const personal = context.workspaceGrants.find((grant) => grant.workspaceId !== sharedWorkspaceId);
  if (!personal) throw new Error("managed human provisioned without a personal workspace");
  return {
    subjectId,
    accountId: personal.accountId,
    sharedWorkspaceId,
    personalWorkspaceId: personal.workspaceId,
  };
}

async function openPrivateCreate(
  human: Awaited<ReturnType<typeof managedHuman>>,
  workspaceId: string,
): Promise<unknown> {
  return await withRlsContext(
    client!.db,
    { accountId: human.accountId, workspaceId },
    async (transaction) => {
      await setSubjectRlsContext(transaction, human.subjectId);
      return await openPrivateSessionCreateCapability(transaction, {
        accountId: human.accountId,
        workspaceId,
        sessionId: crypto.randomUUID(),
        actorSubjectId: human.subjectId,
      });
    },
  );
}

describe("migration 0611 universal session tenancy activation", () => {
  test("is a drained maintenance cutover with a fail-loud activation section", () => {
    expect(source.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain(
      "ALTER TABLE session_tenancy_activations NO FORCE ROW LEVEL SECURITY;",
    );
    expect(source).toContain("ALTER TABLE session_tenancy_activations FORCE ROW LEVEL SECURITY;");
    expect(source).toContain("USING ERRCODE = '55000'");
    // Convergence uses only the reviewed deterministic seams; nothing else writes authority.
    expect(source).toContain(
      "backfill_organization_connection_authority(organization_id, 5000, false)",
    );
    expect(source).toContain(
      "backfill_organization_session_ownership(organization_id, 5000, false, NULL)",
    );
    expect(source).not.toMatch(
      /INSERT INTO organization_memberships|UPDATE sessions|UPDATE connections/,
    );
  });

  test("predicates no longer consult a receipt and FORCE RLS is restored", async () => {
    if (!owned || !owner) return;
    const [account] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0611 receiptless') returning id`;
    const accountId = account!.id;
    expect(await receipt(accountId)).toBeNull();
    const rows = await owner.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
      return await transaction<
        {
          activated: boolean;
          wrongVersion: boolean;
          nullAccount: boolean;
          otherAccount: boolean;
          privateActivated: boolean;
          anyActivation: boolean;
        }[]
      >`
        select session_tenancy_product_activated(${accountId}::uuid, 1) as activated,
          session_tenancy_product_activated(${accountId}::uuid, 2) as "wrongVersion",
          session_tenancy_product_activated(null, 1) as "nullAccount",
          session_tenancy_product_activated(gen_random_uuid(), 1) as "otherAccount",
          opengeni_private.session_tenancy_account_activated(${accountId}::uuid) as "privateActivated",
          session_tenancy_any_product_activation() as "anyActivation"`;
    });
    expect(rows[0]).toEqual({
      activated: true,
      wrongVersion: false,
      nullAccount: false,
      otherAccount: false,
      // The legacy connection/writer lane retirement stays receipt-keyed.
      privateActivated: false,
      anyActivation: false,
    });
    const [table] = await owned.admin<{ force: boolean }[]>`
      select relforcerowsecurity as force from pg_class where oid = 'session_tenancy_activations'::regclass`;
    expect(table?.force).toBe(true);
    const [role] = await owned.admin<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = ${owned.ownerRole}`;
    expect(role).toEqual({ superuser: false, bypass: false });
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
  }, 180_000);

  test("activates receiptless organizations idempotently and refuses unactivatable ones by id", async () => {
    if (!owned || !owner || !client) return;
    // Organization that the retired operator command already activated.
    const [preactivated] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0611 pre-activated') returning id`;
    await owned.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${preactivated!.id}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'operator-fixture')`;
    // Ordinary managed human organization without any receipt.
    const human = await managedHuman();
    // A deterministic legacy personal connection (its subject holds an active
    // membership) is converged by the reviewed seam inside the migration.
    const legacyConnectionId = await owned.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      const [row] = await transaction<{ id: string }[]>`
        insert into connections (
          account_id, workspace_id, origin_workspace_id, subject_id, provider_domain, kind,
          credential_encrypted, authority_scope
        ) values (
          ${human.accountId}, ${human.sharedWorkspaceId}, ${human.sharedWorkspaceId},
          ${human.subjectId}, 'legacy-0611.example', 'api_key', 'ciphertext', 'legacy_user'
        ) returning id`;
      return row!.id;
    });
    // An organization whose data cannot be activated: a human with workspace
    // access but no organization-membership anchor (never inferred).
    const [blocked] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0611 blocked') returning id`;
    const [workspace] = await owned.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${blocked!.id}, '0611 blocked') returning id`;
    await owned.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${blocked!.id}, ${workspace!.id}, ${`user:anchorless-${crypto.randomUUID()}`}, 'member')`;

    let failure: unknown;
    try {
      await runActivationSection();
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("55000");
    expect(String((failure as Error).message)).toContain(blocked!.id);
    expect(String((failure as Error).message)).toContain(
      "lane:workspaceMemberSubjectsWithoutMembershipAnchor",
    );
    expect(String((failure as Error).message)).not.toContain(human.accountId);
    // All-or-nothing: no organization was activated by the refused run.
    expect(await receipt(human.accountId)).toBeNull();
    expect(await receipt(blocked!.id)).toBeNull();

    // Once the blocker is resolved through its own lifecycle, the rerun succeeds.
    await owned.admin`delete from workspace_memberships where workspace_id = ${workspace!.id}`;
    await runActivationSection();
    for (const accountId of [human.accountId, blocked!.id]) {
      const activated = await receipt(accountId);
      expect(activated?.activatedBy).toBe(MIGRATION_ACTOR);
      expect(activated?.inventoryDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(activated?.parityDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(activated?.receipts).toBe(0);
      const [lane] = await owner.begin(async (transaction) => {
        await transaction`select set_config('opengeni.account_id', ${accountId}, true)`;
        return await transaction<{ retired: boolean }[]>`
          select opengeni_private.session_tenancy_account_activated(${accountId}::uuid) as retired`;
      });
      expect(lane?.retired).toBe(true);
    }
    const [converged] = await owned.admin<{ scope: string; membership: string | null }[]>`
      select authority_scope as scope, owner_organization_membership_id::text as membership
      from connections where id = ${legacyConnectionId}`;
    expect(converged?.scope).toBe("user");
    expect(converged?.membership).toEqual(expect.any(String));
    expect(await receipt(preactivated!.id)).toEqual({
      activatedBy: "operator-fixture",
      inventoryDigest: "a".repeat(64),
      parityDigest: "b".repeat(64),
      receipts: 0,
    });

    // Idempotent: a second run changes nothing and raises nothing.
    const [before] = await owned.admin<{ count: number }[]>`
      select count(*)::int as count from session_tenancy_activations`;
    await runActivationSection();
    const [after] = await owned.admin<{ count: number }[]>`
      select count(*)::int as count from session_tenancy_activations`;
    expect(after?.count).toBe(before?.count);
  }, 180_000);

  test("a receiptless organization creates private sessions; the owner setting still gates shared workspaces", async () => {
    if (!owned || !client) return;
    const human = await managedHuman();
    expect(await receipt(human.accountId)).toBeNull();

    const personalPolicy = await getPrivateSessionCreatePolicy(client.db, {
      workspaceId: human.personalWorkspaceId,
      actorSubjectId: human.subjectId,
    });
    expect(personalPolicy).toMatchObject({ personalWorkspace: true, platformAvailable: true });
    await expect(openPrivateCreate(human, human.personalWorkspaceId)).resolves.toMatchObject({
      capabilityId: expect.any(String),
    });

    const sharedPolicy = await getPrivateSessionCreatePolicy(client.db, {
      workspaceId: human.sharedWorkspaceId,
      actorSubjectId: human.subjectId,
    });
    expect(sharedPolicy).toMatchObject({
      personalWorkspace: false,
      platformAvailable: true,
      organizationEnabled: false,
    });
    await expect(openPrivateCreate(human, human.sharedWorkspaceId)).rejects.toBeInstanceOf(
      SessionTenancyNotActivatedError,
    );

    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: human.accountId,
      actorSubjectId: human.subjectId,
    });
    expect(settings.enabled).toBe(false);
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: human.accountId,
      actorSubjectId: human.subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    await expect(openPrivateCreate(human, human.sharedWorkspaceId)).resolves.toMatchObject({
      capabilityId: expect.any(String),
    });
  }, 180_000);
});
