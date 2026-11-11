// Migration 1232 backfills the owner's row (1231) in every existing managed
// Personal workspace. It runs as the production migration principal (a
// NOSUPERUSER NOBYPASSRLS owner), for whom FORCE RLS on organization_memberships
// hides every row unless migrate.ts opens the lifecycle policy arm.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  ensureManagedAccessForUserWithOrganizationMemberships,
  managedPersonalWorkspacePermissions,
  updateOrganizationMember,
  type DbClient,
} from "../src/index";
import { executeMigrationFile, migrate, parseBatchedBackfillMigration } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const MIGRATION = "1232_personal_workspace_owner_membership_backfill.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(120_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let owner: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("personal-owner-row-backfill");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("owner-row backfill PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  owner = postgres(owned.ownerUrl, { max: 1, prepare: false, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await client?.close();
  await owned?.release();
}, 60_000);

type Person = { userId: string; subjectId: string };

function person(label: string): Person {
  const userId = `owner-backfill-${label}-${crypto.randomUUID()}`;
  return { userId, subjectId: `user:${userId}` };
}

async function provision(who: Person) {
  return await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId: who.userId,
    email: `${who.userId}@example.test`,
    name: "Backfill",
  });
}

type Row = { subjectId: string; role: string; permissions: string[] };

async function rows(workspaceId: string): Promise<Row[]> {
  return [
    ...(await owned!.admin<Row[]>`
      select subject_id as "subjectId", role, permissions
      from workspace_memberships where workspace_id = ${workspaceId} order by subject_id`),
  ];
}

const ownerRow = (subjectId: string): Row => ({
  subjectId,
  role: "member",
  permissions: managedPersonalWorkspacePermissions,
});

/** Write as a release before 1159/1231 could have: no triggers. */
async function legacy(write: (tx: postgres.TransactionSql) => Promise<unknown>) {
  await owned!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await write(tx);
  });
}

describe("1232 backfills the Personal owner's row", () => {
  test("only where pointer and identity agree, and only for the active owner", async () => {
    if (!client) return;
    const founder = person("founder");
    const org = (await provision(founder)).organizationMemberships[0]!;
    const joined: Array<Person & { membershipId: string; personalWorkspaceId: string }> = [];
    for (const label of ["legacy", "suspended", "moved"]) {
      const who = person(label);
      await provision(who);
      const invitation = await createOrganizationInvitation(client.db, {
        organizationId: org.organizationId,
        actorSubjectId: founder.subjectId,
        operationId: crypto.randomUUID(),
        targetSubjectId: who.subjectId,
        targetEmail: `${who.userId}@example.test`,
        role: "member",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const accepted = await acceptOrganizationInvitation(client.db, {
        organizationId: org.organizationId,
        actorSubjectId: who.subjectId,
        operationId: crypto.randomUUID(),
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      });
      joined.push({
        ...who,
        membershipId: accepted.membership.id,
        personalWorkspaceId: accepted.membership.personalWorkspaceId!,
      });
    }
    const [legacyOwner, suspended, moved] = joined as [
      (typeof joined)[number],
      (typeof joined)[number],
      (typeof joined)[number],
    ];
    // 1231's trigger already ran for these as the non-superuser owner.
    expect(await rows(org.personalWorkspaceId!)).toEqual([ownerRow(founder.subjectId)]);
    const [revision] = await owned!.admin<Array<{ revision: number }>>`
      select authorization_revision::int as revision from organization_memberships
      where id = ${suspended.membershipId}`;
    await updateOrganizationMember(client.db, {
      organizationId: org.organizationId,
      actorSubjectId: founder.subjectId,
      operationId: crypto.randomUUID(),
      membershipId: suspended.membershipId,
      transition: {
        kind: "suspend",
        expectedAuthorizationRevision: revision!.revision,
        operationId: crypto.randomUUID(),
      },
    });

    // Recreate what the data looked like before 1231.
    const strayWorkspaceId = crypto.randomUUID();
    await legacy(async (tx) => {
      await tx`
        delete from workspace_memberships
        where workspace_id in (${org.personalWorkspaceId!}, ${legacyOwner.personalWorkspaceId},
          ${moved.personalWorkspaceId})`;
      // An owner row from before 1159 that administered its Personal workspace.
      await tx`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${org.organizationId}, ${legacyOwner.personalWorkspaceId}, ${legacyOwner.subjectId},
          'owner', '["workspace:admin"]'::jsonb)`;
      // Someone else's row in the founder's Personal workspace: reported, not touched.
      await tx`
        insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
        values (${org.organizationId}, ${org.personalWorkspaceId!}, ${legacyOwner.subjectId},
          'member', '["workspace:read"]'::jsonb)`;
      // A membership whose pointer names a workspace without its Personal identity.
      await tx`
        insert into workspaces (id, account_id, name)
        values (${strayWorkspaceId}, ${org.organizationId}, 'Not Personal')`;
      await tx`
        update organization_memberships set personal_workspace_id = ${strayWorkspaceId}
        where id = ${moved.membershipId}`;
    });

    const migration = await readFile(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    const statement = parseBatchedBackfillMigration(MIGRATION, migration)!.statement;
    // Without the lifecycle arm, FORCE RLS hides every membership from the owner.
    const hidden = await owner!.begin(async (tx) => await tx.unsafe(statement));
    expect(hidden.length).toBe(0);
    expect(await rows(org.personalWorkspaceId!)).toEqual([
      { subjectId: legacyOwner.subjectId, role: "member", permissions: ["workspace:read"] },
    ]);

    await executeMigrationFile(owner!, MIGRATION, migration);

    expect(await rows(org.personalWorkspaceId!)).toEqual(
      [
        ownerRow(founder.subjectId),
        { subjectId: legacyOwner.subjectId, role: "member", permissions: ["workspace:read"] },
      ].sort((left, right) => left.subjectId.localeCompare(right.subjectId)),
    );
    expect(await rows(legacyOwner.personalWorkspaceId)).toEqual([ownerRow(legacyOwner.subjectId)]);
    expect(await rows(suspended.personalWorkspaceId)).toEqual([]);
    expect(await rows(moved.personalWorkspaceId)).toEqual([]);
    expect(await rows(strayWorkspaceId)).toEqual([]);

    // Done: another run changes nothing.
    const again = await owner!.begin(async (tx) => {
      await tx`select set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true)`;
      return await tx.unsafe(statement);
    });
    expect(again.length).toBe(0);
  });
});
