/**
 * Migration 0897: a workspace membership whose role is "owner" (how a
 * configured deployment's own subject is provisioned) or whose permissions
 * include workspace:admin administers the workspace's subscriptions, exactly
 * like role "admin". Before 0897 the API admitted such a subject and the
 * database then refused it. Runs on real PostgreSQL as the application role.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  ensureManagedAccessForUser,
  readWorkspaceSubscriptionSettings,
  updateWorkspaceSubscriptionSettings,
  type DbClient,
} from "../src";

setDefaultTimeout(180_000);

let shared: SharedTestDatabase;
let client: DbClient;
let accountId = "";
let workspaceId = "";

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-owner-administers-v1");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const userId = `workspace-owner-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Workspace owner administers",
  });
  accountId = access.workspaceGrants[0]!.accountId;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Owner-administered shared workspace') returning id::text as id`;
  workspaceId = workspace!.id;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

/** A subject with no organization administration and one workspace membership. */
async function workspaceSubject(role: string, permissions: string[] = []): Promise<string> {
  const subjectId = `configured:${role}-${crypto.randomUUID()}`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${role},
      to_jsonb(${permissions}::text[]))`;
  return subjectId;
}

async function editsSettings(subjectId: string): Promise<{ canEdit: boolean; wrote: boolean }> {
  const { canEdit } = await readWorkspaceSubscriptionSettings(client.db, {
    accountId,
    workspaceId,
    subjectId,
  });
  const wrote = await updateWorkspaceSubscriptionSettings(client.db, {
    accountId,
    workspaceId,
    subjectId,
    patch: { crossProviderFailover: true },
  }).then(
    () => true,
    () => false,
  );
  return { canEdit, wrote };
}

describe("workspace subscription administration", () => {
  test("an owner membership administers like an admin membership", async () => {
    expect(await editsSettings(await workspaceSubject("owner"))).toEqual({
      canEdit: true,
      wrote: true,
    });
    expect(await editsSettings(await workspaceSubject("admin"))).toEqual({
      canEdit: true,
      wrote: true,
    });
  });

  test("a custom membership administers only with workspace:admin", async () => {
    expect(await editsSettings(await workspaceSubject("custom", ["workspace:admin"]))).toEqual({
      canEdit: true,
      wrote: true,
    });
    expect(await editsSettings(await workspaceSubject("custom", ["sessions:create"]))).toEqual({
      canEdit: false,
      wrote: false,
    });
  });

  test("member and viewer memberships do not administer", async () => {
    for (const role of ["member", "viewer"])
      expect(await editsSettings(await workspaceSubject(role))).toEqual({
        canEdit: false,
        wrote: false,
      });
  });

  test("no routine or row policy tests a workspace membership for the literal admin role", async () => {
    const routines = await shared.admin<{ name: string }[]>`
      select procedure.oid::regprocedure::text as name
      from pg_proc procedure
      where procedure.prosrc ~ '\\m(manager|workspace_membership|grant_row)\\.role\\s*=\\s*''admin'''`;
    expect(routines.map((row) => row.name)).toEqual([]);
    const policies = await shared.admin<{ name: string }[]>`
      select tablename || '.' || policyname as name from pg_policies
      where coalesce(qual, '') || coalesce(with_check, '')
        ~ '\\m(manager|workspace_membership|grant_row)\\.role\\s*=\\s*''admin'''`;
    expect(policies.map((row) => row.name)).toEqual([]);
    const [rewritten] = await shared.admin<{ routines: number; policies: number }[]>`
      select
        (select count(*)::int from pg_proc
          where prosrc like '%workspace_membership_administers(%') as routines,
        (select count(*)::int from pg_policies
          where coalesce(qual, '') || coalesce(with_check, '')
            like '%workspace_membership_administers(%') as policies`;
    expect(rewritten).toEqual({ routines: 6, policies: 4 });
  });
});
