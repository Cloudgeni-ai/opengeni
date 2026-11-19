// organization_console_roles (migration 1509) under the production database
// setup (NOSUPERUSER NOBYPASSRLS owner, FORCE RLS, restricted runtime role):
// rows stay in their organization, the runtime reads, inserts and updates but
// never deletes, the CHECK refuses malformed rows, an invitation row can only
// name the same organization's invitation, and the db helpers keep one audit
// row per change.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyInvitationConsoleRole,
  clearConsoleMemberRole,
  ConsoleRoleTargetNotFoundError,
  createDb,
  getConsoleMemberRole,
  listConsoleMemberRoles,
  setConsoleMemberRole,
} from "../src/index";

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
let appSql: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("organization-console-roles");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
  appSql = postgres(shared.appUrl, { max: 2, connection: { search_path: shared.schema } });
}, 900_000);

afterAll(async () => {
  await appSql?.end().catch(() => undefined);
  await app?.close();
  await shared?.release();
}, 60_000);

/** An organization with an owner membership and one pending invitation. */
async function organization() {
  const accountId = crypto.randomUUID();
  const personal = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const invitationId = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Console roles')`;
  await shared.admin`insert into workspaces (id, account_id, name) values (${personal}, ${accountId}, 'Personal')`;
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into organization_memberships (id, account_id, subject_id, role, status, personal_workspace_id)
      values (${membershipId}, ${accountId}, ${owner}, 'owner', 'active', ${personal})`;
    await tx`insert into organization_membership_invitations
      (id, account_id, target_email, role, status, created_by_membership_id, expires_at)
      values (${invitationId}, ${accountId}, ${`${crypto.randomUUID()}@example.test`}, 'member',
        'pending', ${membershipId}, now() + interval '1 hour')`;
  });
  return { accountId, invitationId, owner, personal };
}

async function asAccount<T>(
  accountId: string,
  run: (sql: postgres.TransactionSql) => Promise<T>,
  workspaceId = "",
) {
  return (await appSql.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', '', true)`;
    return await run(sql);
  })) as T;
}

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

describe("organization_console_roles", () => {
  test("rows stay in their organization", async () => {
    const a = await organization();
    const b = await organization();
    const member = `user:${crypto.randomUUID()}`;
    await asAccount(
      a.accountId,
      (sql) =>
        sql`insert into organization_console_roles (account_id, subject_id, role, updated_by_subject_id)
        values (${a.accountId}, ${member}, 'viewer', ${a.owner})`,
    );
    const seenByB = await asAccount(
      b.accountId,
      (sql) => sql`select count(*)::int as count from organization_console_roles`,
    );
    expect(seenByB[0]!.count).toBe(0);
    const seenByA = await asAccount(
      a.accountId,
      (sql) => sql`select role from organization_console_roles where subject_id = ${member}`,
    );
    expect(seenByA.map((row) => row.role)).toEqual(["viewer"]);
    // Writing another organization's row is refused by the policy.
    expect(
      await sqlState(() =>
        asAccount(
          b.accountId,
          (sql) =>
            sql`insert into organization_console_roles (account_id, subject_id, role, updated_by_subject_id)
            values (${a.accountId}, ${`user:${crypto.randomUUID()}`}, 'editor', ${b.owner})`,
        ),
      ),
    ).toBe("42501");
    const updated = await asAccount(
      b.accountId,
      (
        sql,
      ) => sql`update organization_console_roles set role = 'editor' where subject_id = ${member}
        returning id`,
    );
    expect(updated).toHaveLength(0);
    // Without an account context nothing is visible.
    const none = await appSql.begin(
      (sql) => sql`select count(*)::int as count from organization_console_roles`,
    );
    expect((none as unknown as { count: number }[])[0]!.count).toBe(0);
  });

  test("the runtime reads, inserts and updates, never deletes", async () => {
    const a = await organization();
    const member = `user:${crypto.randomUUID()}`;
    await asAccount(
      a.accountId,
      (sql) =>
        sql`insert into organization_console_roles (account_id, subject_id, role, updated_by_subject_id)
        values (${a.accountId}, ${member}, 'viewer', ${a.owner})`,
    );
    expect(
      await sqlState(() =>
        asAccount(a.accountId, (sql) => sql`delete from organization_console_roles`),
      ),
    ).toBe("42501");
    const grants = await shared.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_name = 'organization_console_roles' and grantee = 'opengeni_app'
      order by privilege_type`;
    expect(grants.map((row) => row.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const [posture] = await shared.admin<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relrowsecurity, relforcerowsecurity from pg_class
      where oid = 'organization_console_roles'::regclass`;
    expect(posture).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test("a workspace context of the organization reads roles but never writes them", async () => {
    const a = await organization();
    const member = `user:${crypto.randomUUID()}`;
    await asAccount(
      a.accountId,
      (sql) =>
        sql`insert into organization_console_roles (account_id, subject_id, role, updated_by_subject_id)
        values (${a.accountId}, ${member}, 'viewer', ${a.owner})`,
    );
    const inWorkspace = <T>(run: (sql: postgres.TransactionSql) => Promise<T>) =>
      asAccount(a.accountId, run, a.personal);
    expect(
      (
        await inWorkspace(
          (sql) => sql`select role from organization_console_roles where subject_id = ${member}`,
        )
      ).map((row) => row.role),
    ).toEqual(["viewer"]);
    expect(
      await sqlState(() =>
        inWorkspace(
          (sql) =>
            sql`insert into organization_console_roles (account_id, subject_id, role, updated_by_subject_id)
            values (${a.accountId}, ${`user:${crypto.randomUUID()}`}, 'editor', ${a.owner})`,
        ),
      ),
    ).toBe("42501");
    const updated = await inWorkspace(
      (sql) => sql`update organization_console_roles set role = 'editor'
        where subject_id = ${member} returning id`,
    );
    expect(updated).toHaveLength(0);
    // The account context (every writer) still writes them.
    const accountUpdate = await asAccount(
      a.accountId,
      (sql) => sql`update organization_console_roles set role = 'editor'
        where subject_id = ${member} returning role`,
    );
    expect(accountUpdate.map((row) => row.role)).toEqual(["editor"]);
  });

  test("the CHECK refuses malformed rows", async () => {
    const a = await organization();
    const insert = (columns: {
      subject: string | null;
      invitation: string | null;
      role: string;
      applied?: boolean;
    }) =>
      sqlState(() =>
        asAccount(
          a.accountId,
          (sql) =>
            sql`insert into organization_console_roles
            (account_id, subject_id, invitation_id, role, applied_at, updated_by_subject_id)
            values (${a.accountId}, ${columns.subject}, ${columns.invitation}, ${columns.role},
              ${columns.applied ? new Date() : null}, ${a.owner})`,
        ),
      );
    expect(
      await insert({ subject: `user:${crypto.randomUUID()}`, invitation: null, role: "admin" }),
    ).toBe("23514");
    expect(await insert({ subject: "api_key:x", invitation: null, role: "viewer" })).toBe("23514");
    expect(await insert({ subject: null, invitation: null, role: "viewer" })).toBe("23514");
    expect(
      await insert({
        subject: `user:${crypto.randomUUID()}`,
        invitation: a.invitationId,
        role: "viewer",
      }),
    ).toBe("23514");
    expect(
      await insert({
        subject: `user:${crypto.randomUUID()}`,
        invitation: null,
        role: "viewer",
        applied: true,
      }),
    ).toBe("23514");
    expect(await insert({ subject: null, invitation: a.invitationId, role: "editor" })).toBeNull();
  });

  test("an invitation row names its own organization's invitation", async () => {
    const a = await organization();
    const b = await organization();
    expect(
      await sqlState(() =>
        asAccount(
          a.accountId,
          (sql) =>
            sql`insert into organization_console_roles (account_id, invitation_id, role, updated_by_subject_id)
            values (${a.accountId}, ${b.invitationId}, 'viewer', ${a.owner})`,
        ),
      ),
    ).toBe("23503");
    await expect(
      setConsoleMemberRole(app.db, {
        accountId: a.accountId,
        target: { invitationId: b.invitationId },
        role: "viewer",
        actorSubjectId: a.owner,
        actorLabel: null,
      }),
    ).rejects.toBeInstanceOf(ConsoleRoleTargetNotFoundError);
  });

  test("helpers set, list, apply once and clear, with one audit row per change", async () => {
    const a = await organization();
    const member = `user:${crypto.randomUUID()}`;
    const set = await setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { subjectId: member },
      role: "viewer",
      actorSubjectId: a.owner,
      actorLabel: "Owner",
    });
    expect([set.from, set.changed, set.entry.role]).toEqual(["none", true, "viewer"]);
    const again = await setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { subjectId: member },
      role: "viewer",
      actorSubjectId: a.owner,
      actorLabel: "Owner",
    });
    expect(again.changed).toBe(false);
    expect(await getConsoleMemberRole(app.db, a.accountId, member)).toBe("viewer");

    await setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { invitationId: a.invitationId },
      role: "editor",
      actorSubjectId: a.owner,
      actorLabel: "Owner",
    });
    const invitee = `user:${crypto.randomUUID()}`;
    expect(
      await applyInvitationConsoleRole(app.db, {
        accountId: a.accountId,
        invitationId: a.invitationId,
        subjectId: invitee,
      }),
    ).toBe("editor");
    // Applied once: a replayed acceptance never overwrites a later change.
    await setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { subjectId: invitee },
      role: "viewer",
      actorSubjectId: a.owner,
      actorLabel: "Owner",
    });
    expect(
      await applyInvitationConsoleRole(app.db, {
        accountId: a.accountId,
        invitationId: a.invitationId,
        subjectId: invitee,
      }),
    ).toBeNull();
    expect(await getConsoleMemberRole(app.db, a.accountId, invitee)).toBe("viewer");

    const listed = await listConsoleMemberRoles(app.db, a.accountId);
    expect(listed.map((entry) => [entry.subjectId, entry.invitationId, entry.role]).sort()).toEqual(
      [
        [invitee, null, "viewer"],
        [member, null, "viewer"],
      ].sort(),
    );

    expect(
      await clearConsoleMemberRole(app.db, {
        accountId: a.accountId,
        subjectId: member,
        actorSubjectId: a.owner,
        actorLabel: null,
        reason: "member_offboarded",
      }),
    ).toBe("viewer");
    expect(await getConsoleMemberRole(app.db, a.accountId, member)).toBe("none");

    const audit = await shared.admin<{ detail: Record<string, unknown> }[]>`
      select detail from organization_console_audit_events
      where account_id = ${a.accountId} and action = 'member.console_role_changed'
      order by created_at, id`;
    expect(audit.map((row) => [row.detail.from, row.detail.to])).toEqual([
      ["none", "viewer"],
      ["none", "editor"],
      ["none", "editor"],
      ["editor", "viewer"],
      ["viewer", "none"],
    ]);
  });

  test("accepting an invitation without a Console role resets a leftover one, once", async () => {
    const a = await organization();
    const returning = `user:${crypto.randomUUID()}`;
    // A role left from an earlier membership.
    await setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { subjectId: returning },
      role: "editor",
      actorSubjectId: a.owner,
      actorLabel: null,
    });
    expect(
      await applyInvitationConsoleRole(app.db, {
        accountId: a.accountId,
        invitationId: a.invitationId,
        subjectId: returning,
      }),
    ).toBe("none");
    expect(await getConsoleMemberRole(app.db, a.accountId, returning)).toBe("none");
    // A replayed acceptance leaves a role set afterwards alone.
    await setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { subjectId: returning },
      role: "viewer",
      actorSubjectId: a.owner,
      actorLabel: null,
    });
    expect(
      await applyInvitationConsoleRole(app.db, {
        accountId: a.accountId,
        invitationId: a.invitationId,
        subjectId: returning,
      }),
    ).toBeNull();
    expect(await getConsoleMemberRole(app.db, a.accountId, returning)).toBe("viewer");
    const reasons = await shared.admin<{ detail: Record<string, unknown> }[]>`
      select detail from organization_console_audit_events
      where account_id = ${a.accountId} and action = 'member.console_role_changed'
      order by created_at, id`;
    expect(reasons.map((row) => [row.detail.to, row.detail.reason ?? null])).toEqual([
      ["editor", null],
      ["none", "invitation_accepted"],
      ["viewer", null],
    ]);
  });

  test("a role write's check runs after its lock, so a concurrent clear isn't overtaken", async () => {
    const a = await organization();
    const member = `user:${crypto.randomUUID()}`;
    let releaseCheck!: () => void;
    const checkHeld = new Promise<void>((resolve) => (releaseCheck = resolve));
    let checking!: () => void;
    const checkStarted = new Promise<void>((resolve) => (checking = resolve));
    // The write holds the person's lock while its check runs ...
    const write = setConsoleMemberRole(app.db, {
      accountId: a.accountId,
      target: { subjectId: member },
      role: "editor",
      actorSubjectId: a.owner,
      actorLabel: null,
      verifyTarget: async () => {
        checking();
        await checkHeld;
      },
    });
    await checkStarted;
    // ... so a clear (an offboarding) waits for it and runs after.
    let cleared = false;
    const clear = clearConsoleMemberRole(app.db, {
      accountId: a.accountId,
      subjectId: member,
      actorSubjectId: a.owner,
      actorLabel: null,
      reason: "member_offboarded",
    }).then((from) => {
      cleared = true;
      return from;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cleared).toBe(false);
    releaseCheck();
    await write;
    expect(await clear).toBe("editor");
    expect(await getConsoleMemberRole(app.db, a.accountId, member)).toBe("none");
  });
});
