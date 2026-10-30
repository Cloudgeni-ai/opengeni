import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const migration = readFileSync(
  new URL("../drizzle/1152_own_login_turned_on_per_workspace.sql", import.meta.url),
  "utf8",
);
// The one-time backfill, from relaxing FORCE ROW LEVEL SECURITY to restoring it.
const backfill = migration.slice(
  migration.indexOf('ALTER TABLE "organization_memberships" NO FORCE ROW LEVEL SECURITY;'),
);

let owned: OwnerMigratedTestDatabase | null = null;
let ownerSql: postgres.Sql | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("own-login-turned-on-backfill");
  if (!owned) {
    if (requireRealDatabase)
      throw new Error("own-login backfill PostgreSQL fixture is unavailable");
    return;
  }
  // The NOSUPERUSER NOBYPASSRLS owner, exactly like production.
  await migrate(owned.ownerUrl);
  ownerSql = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await ownerSql?.end().catch(() => undefined);
  await owned?.release();
}, 180_000);

async function workspace(accountId: string, name: string) {
  const [row] = await owned!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`;
  await owned!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}, ${accountId})`;
  return row!.id;
}

async function turnedOnIn(authorityId: string) {
  const rows = await owned!.admin<{ workspaceId: string }[]>`
    select workspace_id as "workspaceId" from organization_user_resource_grants
    where authority_id = ${authorityId} and action = 'connection.use'
      and mode = 'always' and context = 'workspace_shared' and status = 'active'
    order by workspace_id`;
  return rows.map((row) => row.workspaceId);
}

describe("1152 turns existing own logins on where their owners work (real PostgreSQL)", () => {
  test("every shared workspace the owner belongs to, never Personal, once", async () => {
    if (!owned || !ownerSql) return;
    const [account] = await owned.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('own login backfill') returning id`;
    const accountId = account!.id;
    const personal = await workspace(accountId, "owner personal");
    const first = await workspace(accountId, "first shared");
    const second = await workspace(accountId, "second shared");
    const elsewhere = await workspace(accountId, "not a member");
    const subjectId = `user:${crypto.randomUUID()}`;
    await owned.admin`
      insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${accountId}, ${subjectId}, 'active', ${personal})`;
    await owned.admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${first}, ${subjectId}), (${accountId}, ${second}, ${subjectId})`;
    // A login added in the Personal workspace before this change.
    const login = await owned.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${personal}, true)`;
      await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
      const [row] = await tx<{ authorityId: string }[]>`
        insert into connections (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values (${accountId}, ${personal}, ${subjectId}, 'linear.app', 'oauth2', 'ciphertext')
        returning authority_id as "authorityId"`;
      return row!;
    });
    expect(await turnedOnIn(login.authorityId)).toEqual([]);

    await ownerSql.unsafe(`BEGIN; ${backfill} COMMIT;`);
    const expected = [first, second].sort();
    expect(await turnedOnIn(login.authorityId)).toEqual(expected);
    expect(await turnedOnIn(login.authorityId)).not.toContain(personal);
    expect(await turnedOnIn(login.authorityId)).not.toContain(elsewhere);

    // Running it again adds nothing.
    await ownerSql.unsafe(`BEGIN; ${backfill} COMMIT;`);
    expect(await turnedOnIn(login.authorityId)).toEqual(expected);

    // The owner role is left under FORCE ROW LEVEL SECURITY again.
    const forced = await owned.admin<{ relname: string; forced: boolean }[]>`
      select relname, relforcerowsecurity as forced from pg_class
      where relname in ('organization_memberships', 'organization_user_resource_authorities',
        'organization_user_resource_grants')`;
    expect(forced.every((row) => row.forced)).toBe(true);
  }, 180_000);
});
