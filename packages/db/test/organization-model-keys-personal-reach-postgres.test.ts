import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type BlankTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  getOrganizationModelProviderCatalogForWorkspace,
  listOrganizationModelProviderCustomModelsForWorkspace,
  organizationModelProviderConnectionActiveForWorkspace,
  type DbClient,
  type OrganizationModelCatalogProviderKind,
} from "../src";
import { migrate } from "../src/migrate";

// Organization model-provider API keys (Gateway, OpenRouter, Opper, OpenAI,
// Azure OpenAI, Anthropic) reach Personal workspaces like the organization's
// subscriptions do (migration 1094): "every workspace" includes everyone's
// Personal workspace, "Only selected workspaces" follows its own Personal
// switch, and nothing ever reaches another organization. Runs as the
// non-superuser opengeni_app role, so FORCE RLS applies.

const MIGRATION = "1094_organization_model_keys_reach_personal.sql";
const actor = "user:organization-keys-personal-fixture";
const hash = "b".repeat(64);

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
type Org = { accountId: string; sharedId: string; otherSharedId: string; personalId: string };
let one: Org;
let two: Org;

async function seedOrganization(admin: postgres.Sql, label: string): Promise<Org> {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: `Keys fixture ${label}`,
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: `Keys fixture ${label}`,
    subjectId: actor,
  });
  const grant = access.workspaceGrants[0]!;
  const [otherShared, personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Other shared'), (${grant.accountId}, 'Personal')
    returning id`;
  // The same person belongs to both organizations, with a Personal workspace in each.
  await admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${actor}, 'member', 'active', ${personal!.id})`;
  return {
    accountId: grant.accountId,
    sharedId: grant.workspaceId,
    otherSharedId: otherShared!.id,
    personalId: personal!.id,
  };
}

async function insertConnection(
  admin: postgres.Sql,
  accountId: string,
  providerKind: OrganizationModelCatalogProviderKind,
  reach: { allowedWorkspaces: string[] | null; allowPersonalWorkspaces: boolean },
) {
  await admin`
    insert into organization_model_provider_connections
      (account_id, provider_kind, credential_encrypted, operation_id, request_hash,
       updated_by_subject_id, allowed_workspace_ids, allow_personal_workspaces)
    values (${accountId}, ${providerKind}, 'fixture-ciphertext-not-a-key',
      ${crypto.randomUUID()}, ${hash}, ${actor},
      ${reach.allowedWorkspaces === null ? null : admin.array(reach.allowedWorkspaces)}::uuid[],
      ${reach.allowPersonalWorkspaces})`;
  await admin`
    insert into organization_model_provider_custom_models
      (account_id, provider_kind, upstream_model_id, create_operation_id, create_request_hash,
       created_by_subject_id)
    values (${accountId}, ${providerKind}, ${`${providerKind}-fixture`},
      ${crypto.randomUUID()}, ${hash}, ${actor})`;
}

// One kind per reach: an organization has at most one active connection per kind.
const EVERY_WORKSPACE = "openrouter";
const SELECTED_WITHOUT_PERSONAL = "vercel_gateway";
const SELECTED_WITH_PERSONAL = "opper";
const PERSONAL_SWITCHED_OFF = "openai";
const kinds: OrganizationModelCatalogProviderKind[] = [
  EVERY_WORKSPACE,
  SELECTED_WITHOUT_PERSONAL,
  SELECTED_WITH_PERSONAL,
  PERSONAL_SWITCHED_OFF,
];

async function reachOf(accountId: string, workspaceId: string) {
  const catalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
    accountId,
    workspaceId,
    providerKinds: kinds,
  });
  const result: Record<string, { active: boolean; models: string[] }> = {};
  for (const providerKind of kinds) {
    const active = await organizationModelProviderConnectionActiveForWorkspace(client.db, {
      accountId,
      workspaceId,
      providerKind,
    });
    const models = await listOrganizationModelProviderCustomModelsForWorkspace(client.db, {
      accountId,
      workspaceId,
      providerKind,
    });
    expect(catalog[providerKind].active).toBe(active);
    for (const model of [...models, ...catalog[providerKind].models])
      expect(model.accountId).toBe(accountId);
    result[providerKind] = { active, models: models.map((model) => model.upstreamModelId) };
  }
  return result;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-keys-personal");
  if (!shared) {
    available = false;
    console.warn("[organization-keys-personal] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  one = await seedOrganization(shared.admin, "one");
  two = await seedOrganization(shared.admin, "two");
  for (const org of [one, two]) {
    await insertConnection(shared.admin, org.accountId, EVERY_WORKSPACE, {
      allowedWorkspaces: null,
      allowPersonalWorkspaces: true,
    });
    await insertConnection(shared.admin, org.accountId, SELECTED_WITHOUT_PERSONAL, {
      allowedWorkspaces: [org.sharedId],
      allowPersonalWorkspaces: false,
    });
    await insertConnection(shared.admin, org.accountId, SELECTED_WITH_PERSONAL, {
      allowedWorkspaces: [org.sharedId],
      allowPersonalWorkspaces: true,
    });
    await insertConnection(shared.admin, org.accountId, PERSONAL_SWITCHED_OFF, {
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
    });
  }
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("an organization key for every workspace serves its Personal workspaces too", async () => {
  if (!available) return;
  for (const org of [one, two]) {
    const personal = await reachOf(org.accountId, org.personalId);
    expect(personal[EVERY_WORKSPACE]).toEqual({
      active: true,
      models: [`${EVERY_WORKSPACE}-fixture`],
    });
    // Shared workspaces keep exactly the reach they had.
    for (const workspaceId of [org.sharedId, org.otherSharedId]) {
      expect((await reachOf(org.accountId, workspaceId))[EVERY_WORKSPACE]!.active).toBe(true);
    }
  }
});

test("selected workspaces follow the connection's own Personal workspaces switch", async () => {
  if (!available) return;
  const personal = await reachOf(one.accountId, one.personalId);
  expect(personal[SELECTED_WITHOUT_PERSONAL]!.active).toBe(false);
  expect(personal[SELECTED_WITH_PERSONAL]!.active).toBe(true);
  expect(personal[PERSONAL_SWITCHED_OFF]!.active).toBe(false);
  const listed = await reachOf(one.accountId, one.sharedId);
  expect(listed[SELECTED_WITHOUT_PERSONAL]!.active).toBe(true);
  expect(listed[SELECTED_WITH_PERSONAL]!.active).toBe(true);
  expect(listed[PERSONAL_SWITCHED_OFF]!.active).toBe(true);
  const unlisted = await reachOf(one.accountId, one.otherSharedId);
  expect(unlisted[SELECTED_WITHOUT_PERSONAL]!.active).toBe(false);
  expect(unlisted[SELECTED_WITH_PERSONAL]!.active).toBe(false);
  // The organization's model list reads the same in a Personal workspace as
  // in any shared one; a connection that doesn't reach it serves none of them.
  expect(personal).toEqual({
    ...unlisted,
    [SELECTED_WITH_PERSONAL]: personal[SELECTED_WITH_PERSONAL]!,
    [PERSONAL_SWITCHED_OFF]: personal[PERSONAL_SWITCHED_OFF]!,
  });
  for (const providerKind of kinds)
    expect(personal[providerKind]!.models).toEqual([`${providerKind}-fixture`]);
});

test("nothing crosses organizations, even for a person in both", async () => {
  if (!available) return;
  // A workspace named under the other organization's scope never reads either
  // organization's keys: rows need the caller's organization, and the scope
  // function needs a workspace of that same organization.
  for (const [org, other] of [
    [one, two],
    [two, one],
  ] as const) {
    for (const workspaceId of [other.personalId, other.sharedId]) {
      // Refused outright: the workspace isn't one of this organization's.
      await expect(reachOf(org.accountId, workspaceId)).rejects.toThrow();
    }
  }
  // A raw read under one organization's Personal workspace scope returns only
  // that organization's rows.
  const sql = postgres(shared!.appUrl, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${one.accountId}, true),
        set_config('opengeni.workspace_id', ${one.personalId}, true)`;
      return await tx<{ account_id: string; provider_kind: string }[]>`
        select account_id, provider_kind from organization_model_provider_connections`;
    });
    expect(rows.map((row) => row.account_id)).toEqual([one.accountId, one.accountId]);
    expect(rows.map((row) => row.provider_kind).sort()).toEqual(
      [EVERY_WORKSPACE, SELECTED_WITH_PERSONAL].sort(),
    );
    const models = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${one.accountId}, true),
        set_config('opengeni.workspace_id', ${one.personalId}, true)`;
      return await tx<{ account_id: string }[]>`
        select account_id from organization_model_provider_custom_models`;
    });
    expect(new Set(models.map((row) => row.account_id))).toEqual(new Set([one.accountId]));
  } finally {
    await sql.end({ timeout: 5 });
  }
});

describe("migration 1094 normalizes the stored Personal switch", () => {
  let blank: BlankTestDatabase | null = null;
  let migrations: string | null = null;
  let admin: postgres.Sql | null = null;

  beforeAll(async () => {
    if (!available) return;
    blank = await acquireBlankTestDatabase("organization-keys-personal-migration");
    if (!blank) throw new Error("PostgreSQL test database unavailable");
    const shipped = new URL("../drizzle/", import.meta.url).pathname;
    migrations = await mkdtemp(join(tmpdir(), "organization-keys-personal-"));
    for (const file of await readdir(shipped)) {
      if (file.endsWith(".sql") && file < MIGRATION) {
        await symlink(join(shipped, file), join(migrations, file));
      }
    }
    await migrate(blank.databaseUrl, undefined, { migrationsDirectory: migrations });
    admin = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
  }, 900_000);

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await blank?.release();
    if (migrations) await rm(migrations, { recursive: true, force: true });
  }, 180_000);

  test("every workspace gains Personal, selected lists keep excluding it", async () => {
    if (!available || !admin || !migrations) return;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (external_source, external_id, name)
      values ('test', ${crypto.randomUUID()}, 'Migration fixture') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
    const seeded: Array<[OrganizationModelCatalogProviderKind, string[] | null, boolean]> = [
      // Saved by the account page, which kept the column default (true).
      ["openrouter", [workspace!.id], true],
      // Saved by the connect step for a selected audience.
      ["vercel_gateway", [workspace!.id], false],
      ["opper", null, true],
      ["openai", null, false],
    ];
    for (const [providerKind, allowedWorkspaces, allowPersonalWorkspaces] of seeded) {
      await insertConnection(admin, account!.id, providerKind, {
        allowedWorkspaces,
        allowPersonalWorkspaces,
      });
    }
    const before = await admin<{ provider_kind: string; version: number }[]>`
      select provider_kind, access_policy_version as version
      from organization_model_provider_connections where account_id = ${account!.id}`;

    const shipped = new URL("../drizzle/", import.meta.url).pathname;
    await symlink(join(shipped, MIGRATION), join(migrations, MIGRATION));
    await migrate(blank!.databaseUrl, undefined, { migrationsDirectory: migrations });

    const after = await admin<
      { provider_kind: string; allow_personal_workspaces: boolean; version: number }[]
    >`select provider_kind, allow_personal_workspaces, access_policy_version as version
      from organization_model_provider_connections where account_id = ${account!.id}
      order by provider_kind`;
    const version = (kind: string) => before.find((row) => row.provider_kind === kind)!.version;
    expect([...after]).toEqual([
      { provider_kind: "openai", allow_personal_workspaces: true, version: version("openai") + 1 },
      {
        provider_kind: "openrouter",
        allow_personal_workspaces: false,
        version: version("openrouter") + 1,
      },
      { provider_kind: "opper", allow_personal_workspaces: true, version: version("opper") },
      {
        provider_kind: "vercel_gateway",
        allow_personal_workspaces: false,
        version: version("vercel_gateway"),
      },
    ]);
    // FORCE RLS and the access-policy guard are back in force.
    const [table] = await admin<{ forced: boolean; guard: string }[]>`
      select c.relforcerowsecurity as forced, t.tgenabled as guard
      from pg_class c
      join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'model_connection_access_update_guard'
      where c.oid = 'organization_model_provider_connections'::regclass`;
    expect(table).toEqual({ forced: true, guard: "O" });
  }, 900_000);
});
