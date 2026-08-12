import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0226_personal_codex_authority_foundation.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let migration = "";
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof postgres> | null = null;

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect((failure as { code?: string } | undefined)?.code).toBe(state);
}

async function setAppContext(accountId: string, workspaceId: string): Promise<void> {
  if (!app) throw new Error("application database unavailable");
  await app`select set_config('opengeni.account_id', ${accountId}, false)`;
  await app`select set_config('opengeni.workspace_id', ${workspaceId}, false)`;
}

beforeAll(async () => {
  migration = await readFile(migrationPath, "utf8");
  shared = await acquireSharedTestDatabase("migration-0226-personal-codex-authority-foundation");
  if (!shared && requireRealDatabase) {
    throw new Error(
      "[migration-0226-personal-codex-authority-foundation] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) app = postgres(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0226 personal Codex authority foundation", () => {
  test("is rolling, explicit, inert, and identifier-free at the snapshot boundary", () => {
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    const backfill = migration.indexOf('UPDATE "codex_subscription_credentials"');
    const notNull = migration.indexOf('ALTER COLUMN "authority_scope" SET NOT NULL');
    expect(backfill).toBeGreaterThanOrEqual(0);
    expect(notNull).toBeGreaterThan(backfill);
    expect(migration).toContain("authority.status = 'active'");
    expect(migration).toContain("authority.resource_kind = 'codex_subscription'");
    expect(migration).toContain("authority.resource_id = NEW.id");
    expect(migration).toContain(
      "authority.generation = NEW.organization_user_resource_authority_generation",
    );
    expect(migration).not.toContain("connected_by_subject_id =");
    expect(migration).not.toContain("INSERT INTO organization_user_resource_authorities");
    expect(migration).not.toContain("INSERT INTO organization_user_resource_grants");
    expect(migration).not.toContain("GRANT SELECT");
    expect(migration).not.toContain("GRANT INSERT");
    expect(migration).not.toContain("GRANT UPDATE");
    expect(migration).not.toContain("GRANT DELETE");
    for (const forbidden of [
      "subjectId",
      "membershipId",
      "credentialId",
      "providerAccountId",
      '"label"',
      '"quota"',
      '"token"',
      '"plan"',
    ]) {
      expect(
        migration.slice(
          migration.indexOf("codex_provider_account_authority_snapshot_v1_valid"),
          migration.indexOf("COMMENT ON COLUMN"),
        ),
      ).not.toContain(forbidden);
    }
  });

  test("keeps legacy and omitted runtime rows workspace-scoped", async () => {
    if (!shared || !app) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('personal-codex-workspace-default') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal-codex-workspace-default') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    await setAppContext(account!.id, workspace!.id);
    const [credential] = await app<{ id: string }[]>`
      insert into codex_subscription_credentials (
        account_id, workspace_id, credential_encrypted, status
      ) values (
        ${account!.id}, ${workspace!.id}, 'ciphertext', 'active'
      ) returning id`;
    const [stored] = await shared.admin<
      Array<{
        scope: string;
        owner: string | null;
        authority: string | null;
        kind: string | null;
        generation: number | null;
      }>
    >`
      select authority_scope as scope,
        owner_organization_membership_id as owner,
        organization_user_resource_authority_id as authority,
        organization_user_resource_kind as kind,
        organization_user_resource_authority_generation as generation
      from codex_subscription_credentials where id = ${credential!.id}`;
    expect(stored).toEqual({
      scope: "workspace",
      owner: null,
      authority: null,
      kind: null,
      generation: null,
    });
  });

  test("binds user scope to the exact active same-account membership/resource/generation tuple", async () => {
    if (!shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('personal-codex-user-authority') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal-codex-user-authority') returning id`;
    const membershipId = crypto.randomUUID();
    await shared.admin`
      insert into organization_memberships (
        id, account_id, subject_id, status, personal_workspace_id
      ) values (
        ${membershipId}, ${account!.id}, ${`user:${crypto.randomUUID()}`}, 'active', ${workspace!.id}
      )`;

    const credentialId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    await shared.admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind,
        resource_id, origin_workspace_id, generation, status
      ) values (
        ${authorityId}, ${account!.id}, ${membershipId}, 'codex_subscription',
        ${credentialId}, ${workspace!.id}, 9, 'active'
      )`;
    await shared.admin`
      insert into codex_subscription_credentials (
        id, account_id, workspace_id, credential_encrypted, status,
        authority_scope, owner_organization_membership_id,
        organization_user_resource_authority_id,
        organization_user_resource_kind,
        organization_user_resource_authority_generation
      ) values (
        ${credentialId}, ${account!.id}, ${workspace!.id}, 'ciphertext', 'active',
        'user', ${membershipId}, ${authorityId}, 'codex_subscription', 9
      )`;

    await expectSqlState(
      () =>
        shared!.admin`
          update codex_subscription_credentials
          set organization_user_resource_authority_generation = 10
          where id = ${credentialId}`,
      "23514",
    );
    await expectSqlState(
      () =>
        shared!.admin`
          update organization_user_resource_authorities
          set resource_kind = 'variable_set'
          where id = ${authorityId}`,
      "23503",
    );

    const otherCredentialId = crypto.randomUUID();
    await expectSqlState(
      () =>
        shared!.admin`
          insert into codex_subscription_credentials (
            id, account_id, workspace_id, credential_encrypted, status,
            authority_scope, owner_organization_membership_id,
            organization_user_resource_authority_id,
            organization_user_resource_kind,
            organization_user_resource_authority_generation
          ) values (
            ${otherCredentialId}, ${account!.id}, ${workspace!.id}, 'ciphertext', 'active',
            'user', ${membershipId}, ${authorityId}, 'codex_subscription', 9
          )`,
      "23514",
    );
    await expectSqlState(
      () =>
        shared!.admin`
          insert into codex_subscription_credentials (
            account_id, workspace_id, credential_encrypted, status, authority_scope
          ) values (${account!.id}, ${workspace!.id}, 'ciphertext', 'active', 'user')`,
      "23514",
    );
  });

  test("does not let the application role manufacture user scope", async () => {
    if (!shared || !app) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('personal-codex-app-deny') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal-codex-app-deny') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const membershipId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    await shared.admin`
      insert into organization_memberships (
        id, account_id, subject_id, status, personal_workspace_id
      ) values (
        ${membershipId}, ${account!.id}, ${`user:${crypto.randomUUID()}`}, 'active', ${workspace!.id}
      )`;
    await shared.admin`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind,
        resource_id, origin_workspace_id, generation, status
      ) values (
        ${authorityId}, ${account!.id}, ${membershipId}, 'codex_subscription',
        ${credentialId}, ${workspace!.id}, 1, 'active'
      )`;
    await setAppContext(account!.id, workspace!.id);
    await expectSqlState(
      () =>
        app!`
          insert into codex_subscription_credentials (
            id, account_id, workspace_id, credential_encrypted, status,
            authority_scope, owner_organization_membership_id,
            organization_user_resource_authority_id,
            organization_user_resource_kind,
            organization_user_resource_authority_generation
          ) values (
            ${credentialId}, ${account!.id}, ${workspace!.id}, 'ciphertext', 'active',
            'user', ${membershipId}, ${authorityId}, 'codex_subscription', 1
          )`,
      "42501",
    );
  });

  test("enforces strict immutable snapshots on every accepted-work boundary", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{ tableName: string; columnDefault: string; nullable: string }>
    >`
      select table_name as "tableName", column_default as "columnDefault", is_nullable as nullable
      from information_schema.columns
      where table_schema = current_schema()
        and column_name = 'codex_provider_account_authority_snapshot'
        and table_name = any(array[
          'session_turns', 'scheduled_tasks', 'session_system_updates',
          'session_system_update_outbox'
        ]::text[])
      order by table_name`;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.nullable).toBe("NO");
      expect(row.columnDefault).toContain('"scope": "workspace"');
    }

    const samples = [
      { name: "empty", value: {}, valid: false },
      { name: "workspace", value: { version: 1, scope: "workspace" }, valid: true },
      {
        name: "workspace with generation",
        value: { version: 1, scope: "workspace", authorityGeneration: 1 },
        valid: false,
      },
      {
        name: "user",
        value: { version: 1, scope: "user", authorityGeneration: 7 },
        valid: true,
      },
      {
        name: "user with zero generation",
        value: { version: 1, scope: "user", authorityGeneration: 0 },
        valid: false,
      },
      {
        name: "user with identifier",
        value: {
          version: 1,
          scope: "user",
          authorityGeneration: 1,
          credentialId: crypto.randomUUID(),
        },
        valid: false,
      },
    ];
    for (const sample of samples) {
      const [result] = await shared.admin<{ valid: boolean }[]>`
        select codex_provider_account_authority_snapshot_v1_valid(
          ${shared.admin.json(sample.value)}
        ) as valid`;
      expect({ name: sample.name, valid: result?.valid }).toEqual({
        name: sample.name,
        valid: sample.valid,
      });
    }

    const triggerRows = await shared.admin<{ tableName: string }[]>`
      select event_object_table as "tableName"
      from information_schema.triggers
      where trigger_name = any(array[
        'session_turns_codex_authority_snapshot_immutable_trg',
        'scheduled_tasks_codex_authority_snapshot_immutable_trg',
        'session_updates_codex_authority_snapshot_immutable_trg',
        'system_update_outbox_codex_authority_snapshot_immutable_trg'
      ]::text[])
      order by event_object_table`;
    expect(triggerRows.map((row) => row.tableName)).toEqual([
      "scheduled_tasks",
      "session_system_update_outbox",
      "session_system_updates",
      "session_turns",
    ]);
  });

  test("preserves FORCE RLS and zero direct app DML on organization authority tables", async () => {
    if (!shared) return;
    const rows = await shared.admin<
      Array<{
        tableName: string;
        rls: boolean;
        forceRls: boolean;
        selectPrivilege: boolean;
        insertPrivilege: boolean;
        updatePrivilege: boolean;
        deletePrivilege: boolean;
      }>
    >`
      select c.relname as "tableName", c.relrowsecurity as rls,
        c.relforcerowsecurity as "forceRls",
        has_table_privilege('opengeni_app', c.oid, 'SELECT') as "selectPrivilege",
        has_table_privilege('opengeni_app', c.oid, 'INSERT') as "insertPrivilege",
        has_table_privilege('opengeni_app', c.oid, 'UPDATE') as "updatePrivilege",
        has_table_privilege('opengeni_app', c.oid, 'DELETE') as "deletePrivilege"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relname = any(array[
          'organization_user_resource_authorities', 'organization_user_resource_grants'
        ]::text[])
      order by c.relname`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        rls: true,
        forceRls: true,
        selectPrivilege: false,
        insertPrivilege: false,
        updatePrivilege: false,
        deletePrivilege: false,
      });
    }
  });
});
