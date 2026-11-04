/**
 * Migration 1211: opengeni_private.list_organization_member_names_v1, the
 * names-only member list every member of an organization may read. It is a
 * SECURITY DEFINER owned by the membership tables' owner, never PUBLIC, with
 * a pinned search_path, and the runtime has no EXECUTE until a later
 * migration grants it. It answers only for the transaction's own organization
 * and only to an active person there; it lists only active people, with no
 * email, role or status; and it leaves the caller's lifecycle marker as it
 * found it. Runs on real PostgreSQL as the application role.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { createDb, listOrganizationMemberNames, type DbClient } from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";

setDefaultTimeout(180_000);

let shared: SharedTestDatabase;
let client: DbClient;
const users: string[] = [];
const accounts: string[] = [];

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-1211-member-names");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  for (const id of accounts)
    await shared.admin`delete from managed_accounts where id = ${id}::uuid`.catch(() => undefined);
  for (const id of users)
    await shared.admin`delete from auth_users where id = ${id}`.catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 180_000);

async function organization(): Promise<string> {
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Member names fixture') returning id::text as id`;
  accounts.push(account!.id);
  return account!.id;
}

async function join(
  accountId: string,
  subjectId: string,
  role: "owner" | "admin" | "member" = "member",
  status: "active" | "suspended" | "provisioning" = "active",
): Promise<string> {
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
    returning id::text as id`;
  const [membership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}::uuid, ${subjectId}, ${role}, ${status},
      ${status === "provisioning" ? null : workspace!.id}::uuid)
    returning id::text as id`;
  return membership!.id;
}

async function personIn(
  accountId: string,
  name: string | null,
  role: "owner" | "admin" | "member" = "member",
  status: "active" | "suspended" | "provisioning" = "active",
): Promise<{ subjectId: string; membershipId: string }> {
  const userId = `member-names-db-${crypto.randomUUID()}`;
  users.push(userId);
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${name ?? ""}, ${`${userId}@example.test`}, true)`;
  const subjectId = `user:${userId}`;
  return { subjectId, membershipId: await join(accountId, subjectId, role, status) };
}

/** Calls the routine in this RLS context and returns its result, or the SQLSTATE it raised. */
async function call(input: {
  contextAccountId: string;
  subjectId: string;
  accountId: string;
}): Promise<unknown> {
  try {
    return await withRlsContext(
      client.db,
      { accountId: input.contextAccountId, workspaceId: null },
      async (db) => {
        await setSubjectRlsContext(db, input.subjectId);
        const [row] = await rawRows<{ result: unknown }>(
          db,
          sql`select opengeni_private.list_organization_member_names_v1(${input.accountId}::uuid)
            as result`,
        );
        return row?.result;
      },
    );
  } catch (error) {
    let current: unknown = error;
    while (current && typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return { sqlState: code };
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
}

describe("migration 1211 organization member names", () => {
  test("is an owner-only definer the runtime cannot call until it is granted", async () => {
    const [routine] = await shared.admin<
      {
        securityDefiner: boolean;
        config: string[] | null;
        ownerMatches: boolean;
        publicExecute: boolean;
        appExecute: boolean;
      }[]
    >`
      select p.prosecdef as "securityDefiner", p.proconfig as config,
        p.proowner = (select relowner from pg_class
          where oid = to_regclass('organization_memberships')) as "ownerMatches",
        has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute",
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as "appExecute"
      from pg_proc p
      where p.oid = to_regprocedure('opengeni_private.list_organization_member_names_v1(uuid)')`;
    expect(routine).toBeDefined();
    expect(routine!.securityDefiner).toBe(true);
    expect(routine!.config?.some((entry) => entry.startsWith("search_path=pg_catalog,"))).toBe(
      true,
    );
    expect(routine!.ownerMatches).toBe(true);
    expect(routine!.publicExecute).toBe(false);
    expect(routine!.appExecute).toBe(false);

    // The runtime treats the withheld routine as "not yet".
    const accountId = await organization();
    const reader = await personIn(accountId, "Withheld reader");
    expect(
      await listOrganizationMemberNames(client.db, {
        organizationId: accountId,
        actorSubjectId: reader.subjectId,
      }),
    ).toBeNull();
    expect(await call({ contextAccountId: accountId, ...reader, accountId })).toEqual({
      sqlState: "42501",
    });
  });

  test("lists only the active people of the caller's own organization, by name", async () => {
    await grantDeferredRuntimeAccess(shared.admin);
    const accountId = await organization();
    const otherAccountId = await organization();
    const member = await personIn(accountId, "  Zoe Member  ");
    const owner = await personIn(accountId, "Ann Owner", "owner");
    const nameless = await personIn(accountId, null);
    await personIn(accountId, "Pat Provisioning", "member", "provisioning");
    const suspended = await personIn(accountId, "Sid Suspended", "member", "suspended");
    await join(accountId, `external_user:${crypto.randomUUID()}`);
    await join(accountId, `api_key:${crypto.randomUUID()}`);
    await join(accountId, `service:${crypto.randomUUID()}`);
    const stranger = await personIn(otherAccountId, "Sam Stranger");

    expect(
      await listOrganizationMemberNames(client.db, {
        organizationId: accountId,
        actorSubjectId: member.subjectId,
      }),
    ).toEqual([
      { id: owner.membershipId, name: "Ann Owner", you: false },
      { id: member.membershipId, name: "Zoe Member", you: true },
      { id: nameless.membershipId, name: null, you: false },
    ]);

    // Another organization's member, in their own context or claiming this one.
    expect(await call({ contextAccountId: otherAccountId, ...stranger, accountId })).toEqual({
      sqlState: "42501",
    });
    expect(await call({ contextAccountId: accountId, ...stranger, accountId })).toEqual({
      sqlState: "42501",
    });
    // A member of this organization asking for another's names.
    expect(
      await call({ contextAccountId: accountId, ...member, accountId: otherAccountId }),
    ).toEqual({ sqlState: "42501" });
    expect(
      await call({ contextAccountId: otherAccountId, ...member, accountId: otherAccountId }),
    ).toEqual({ sqlState: "42501" });
    // People who aren't active, and anyone who isn't a person, get nothing.
    expect(await call({ contextAccountId: accountId, ...suspended, accountId })).toEqual({
      sqlState: "42501",
    });
    for (const subjectId of [
      `external_user:${crypto.randomUUID()}`,
      `api_key:${crypto.randomUUID()}`,
      `service:${crypto.randomUUID()}`,
    ]) {
      await join(accountId, subjectId);
      expect(await call({ contextAccountId: accountId, subjectId, accountId })).toEqual({
        sqlState: "42501",
      });
    }
  });

  test("caps a very long name at what the API accepts, so one name can't break the list", async () => {
    await grantDeferredRuntimeAccess(shared.admin);
    const accountId = await organization();
    const member = await personIn(accountId, ` ${"N".repeat(3000)} `);
    const listed = await listOrganizationMemberNames(client.db, {
      organizationId: accountId,
      actorSubjectId: member.subjectId,
    });
    expect(listed).toEqual([{ id: member.membershipId, name: "N".repeat(1024), you: true }]);
  });

  test("leaves the caller's lifecycle marker as it found it", async () => {
    await grantDeferredRuntimeAccess(shared.admin);
    const accountId = await organization();
    const reader = await personIn(accountId, "Marker reader");
    const markers = await withRlsContext(
      client.db,
      { accountId, workspaceId: null },
      async (db) => {
        await setSubjectRlsContext(db, reader.subjectId);
        const read = async () =>
          (
            await rawRows<{ marker: string | null }>(
              db,
              sql`select current_setting('opengeni.organization_tenancy_lifecycle', true) as marker`,
            )
          )[0]?.marker ?? null;
        const before = await read();
        await rawRows(
          db,
          sql`select opengeni_private.list_organization_member_names_v1(${accountId}::uuid)`,
        );
        const after = await read();
        return { before, after };
      },
    );
    expect(markers.after).not.toBe("organization_membership_lifecycle");
    expect(markers.after ?? "").toBe(markers.before ?? "");
  });
});
