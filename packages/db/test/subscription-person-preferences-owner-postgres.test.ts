// Migration 0729 under the documented migration posture: the database is
// migrated by a NOSUPERUSER, NOBYPASSRLS owner, so FORCE row security on
// organization_memberships binds the SECURITY DEFINER routine that answers
// "which membership is mine". Runtime calls run as the restricted application
// role. A person reads and changes their own personal-fallback opt-in, the
// picker reports it, and the owner-only membership read the routine opens
// admits nothing to anyone else (design docs/design/subscription-core-2026-10-07.md,
// 5.6).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  readSubscriptionCoreSessionAccountChoice,
  readSubscriptionPersonPreferences,
  withSessionRlsActorContext,
  writeSubscriptionPersonPreferences,
  type DbClient,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

type Org = { accountId: string; ownerSubjectId: string; personalWorkspaceId: string };

async function organization(): Promise<Org> {
  const userId = `person-preferences-owner-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Person preferences owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await database!.admin<{ workspace_id: string }[]>`
    select personal_workspace_id::text as workspace_id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null`;
  return { accountId, ownerSubjectId, personalWorkspaceId: membership!.workspace_id };
}

async function member(org: Org): Promise<string> {
  const subjectId = `user:person-preferences-member-${crypto.randomUUID()}`;
  const [workspace] = await database!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${org.accountId}::uuid, 'Member Personal') returning id::text as id`;
  await database!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}::uuid, ${subjectId}, 'member', 'active', ${workspace!.id}::uuid)`;
  return subjectId;
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-person-preferences-owner");
  if (!database) throw new Error("Real PostgreSQL is required");
  await migrate(database.ownerUrl);
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("0729 person preferences under the owner posture", () => {
  test("the owner and the application role are bound by row security", async () => {
    const roles = await database!.admin<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`select rolname, rolsuper, rolbypassrls from pg_roles
      where rolname in (${database!.ownerRole}, 'opengeni_app') order by rolname`;
    expect(roles).toHaveLength(2);
    for (const role of roles) expect([role.rolsuper, role.rolbypassrls]).toEqual([false, false]);
  });

  test("a person reads and changes their own opt-in, and the picker reports it", async () => {
    const org = await organization();
    const owner = { accountId: org.accountId, subjectId: org.ownerSubjectId };
    const initial = await readSubscriptionPersonPreferences(client!.db, owner);
    expect(initial).not.toBeNull();
    const turnedOn = await writeSubscriptionPersonPreferences(
      client!.db,
      { ...owner, personalFallbackOptIn: true, expectedVersion: initial!.version },
      [],
    );
    expect(turnedOn).toMatchObject({
      outcome: "written",
      preferences: { personalFallbackOptIn: true, version: initial!.version + 1 },
    });
    expect(await readSubscriptionPersonPreferences(client!.db, owner)).toEqual({
      personalFallbackOptIn: true,
      version: initial!.version + 1,
    });
    const session = await withSessionRlsActorContext({ subjectId: owner.subjectId }, () =>
      createSession(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        subjectId: owner.subjectId,
        initialMessage: "Check the deployment",
        resources: [],
        metadata: {},
        model: "codex/gpt-5.5",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        visibility: "user_private",
        createdBy: { kind: "subject", subjectId: owner.subjectId },
        createdByContext: {},
      }),
    );
    const choice = await readSubscriptionCoreSessionAccountChoice(
      client!.db,
      { ...owner, workspaceId: org.personalWorkspaceId, sessionId: session.id },
      [],
    );
    expect(choice?.personal.fallbackOptIn).toBe(true);
    // Turning it off is the person's own write too.
    expect(
      await writeSubscriptionPersonPreferences(
        client!.db,
        { ...owner, personalFallbackOptIn: false, expectedVersion: initial!.version + 1 },
        [],
      ),
    ).toEqual({
      outcome: "written",
      preferences: { personalFallbackOptIn: false, version: initial!.version + 2 },
      wakes: [],
    });
  });

  test("another member keeps their own row and sees nothing of the owner's", async () => {
    const org = await organization();
    const owner = { accountId: org.accountId, subjectId: org.ownerSubjectId };
    const memberScope = { accountId: org.accountId, subjectId: await member(org) };
    await writeSubscriptionPersonPreferences(
      client!.db,
      { ...owner, personalFallbackOptIn: true },
      [],
    );
    expect(await readSubscriptionPersonPreferences(client!.db, memberScope)).toEqual({
      personalFallbackOptIn: false,
      version: 0,
    });
    expect(
      await writeSubscriptionPersonPreferences(
        client!.db,
        { ...memberScope, personalFallbackOptIn: true, expectedVersion: 0 },
        [],
      ),
    ).toMatchObject({
      outcome: "written",
      preferences: { personalFallbackOptIn: true, version: 1 },
    });
    await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: null },
      async (tx) => {
        await setSubjectRlsContext(tx, memberScope.subjectId);
        const rows = await rawRows<{ count: number }>(
          tx,
          sql`select count(*)::int as count from subscription_person_preferences`,
        );
        expect(rows[0]!.count).toBe(1);
      },
    );
  });

  test("the owner-only membership read admits nothing to the application role", async () => {
    const org = await organization();
    // The runtime role has no privilege on the table at all, so setting the
    // marker itself opens nothing; the policy is SELECT-only and fenced to
    // the migration owner, the caller's account and the caller's subject.
    const [privilege] = await database!.admin<{ select: boolean }[]>`
      select has_table_privilege('opengeni_app', 'organization_memberships', 'SELECT') as select`;
    expect(privilege!.select).toBe(false);
    const [policy] = await database!.admin<{ cmd: string; qual: string; roles: string[] }[]>`
      select cmd, qual, roles::text[] as roles from pg_policies
      where tablename = 'organization_memberships'
        and policyname = 'subscription_own_person_membership_read'`;
    expect(policy!.cmd).toBe("SELECT");
    expect(policy!.qual).toContain(`CURRENT_USER = '${database!.ownerRole}'`);
    expect(policy!.qual).toContain("subscription_own_person_membership");
    expect(policy!.qual).toContain("current_subject_id()");
    expect(policy!.qual).toContain("opengeni.account_id");
    // The routine restores the caller's marker value after its read.
    await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: null },
      async (tx) => {
        await setSubjectRlsContext(tx, org.ownerSubjectId);
        const [row] = await rawRows<{ id: string | null; marker: string | null }>(
          tx,
          sql`select opengeni_private.subscription_own_person_membership_id(${org.accountId}::uuid)::text as id,
          nullif(current_setting('opengeni.organization_tenancy_lifecycle', true), '') as marker`,
        );
        expect(row!.id).not.toBeNull();
        expect(row!.marker).toBeNull();
      },
    );
    // Another organization's scope answers null.
    const other = await organization();
    await withRlsContext(
      client!.db,
      { accountId: other.accountId, workspaceId: null },
      async (tx) => {
        await setSubjectRlsContext(tx, org.ownerSubjectId);
        const [row] = await rawRows<{ id: string | null }>(
          tx,
          sql`select opengeni_private.subscription_own_person_membership_id(${org.accountId}::uuid)::text as id`,
        );
        expect(row!.id).toBeNull();
      },
    );
  });
});
