import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import {
  bootstrapWorkspace,
  createDb,
  seedOrganizationClaudeDefaultModels,
  seedWorkspaceClaudeDefaultModels,
  type DbClient,
} from "../src/index";

// A new Claude connection offers the default models once per scope, and
// migration 0684 adds Haiku 5.5 where Claude models were already set up.
let shared: SharedTestDatabase;
let client: DbClient;
const hash = "0".repeat(64);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0684-claude-haiku-default");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Admin = SharedTestDatabase["admin"];

/** A workspace whose subject owns the organization. */
async function organization(db: DbClient["db"], admin: Admin) {
  const suffix = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: `claude-defaults-${suffix}`,
      accountName: "Claude defaults",
      workspaceExternalSource: "test",
      workspaceExternalId: `claude-defaults-${suffix}`,
      workspaceName: "Claude defaults",
      subjectId: `user:claude-defaults-${suffix}`,
    })
  ).workspaceGrants[0]!;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Claude defaults Personal workspace') returning id`;
  await admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'owner', 'active', ${personal!.id})`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function organizationModels(admin: Admin, accountId: string, providerKind: string) {
  const rows = await admin<{ upstream_model_id: string; active: boolean }[]>`
    select upstream_model_id, retired_at is null as active
    from organization_model_provider_custom_models
    where account_id = ${accountId} and provider_kind = ${providerKind}
    order by upstream_model_id, retired_at nulls first`;
  return rows.map((row) => `${row.upstream_model_id}${row.active ? "" : " (removed)"}`);
}

async function workspaceModels(admin: Admin, workspaceId: string, providerKind: string) {
  const rows = await admin<{ upstream_model_id: string; active: boolean }[]>`
    select upstream_model_id, retired_at is null as active
    from workspace_gateway_custom_models
    where workspace_id = ${workspaceId} and provider_kind = ${providerKind}
    order by upstream_model_id, retired_at nulls first`;
  return rows.map((row) => `${row.upstream_model_id}${row.active ? "" : " (removed)"}`);
}

async function addOrganizationModel(
  admin: Admin,
  accountId: string,
  providerKind: string,
  upstreamModelId: string,
  removed = false,
) {
  await admin`
    insert into organization_model_provider_custom_models (account_id, provider_kind,
      upstream_model_id, create_operation_id, create_request_hash, created_by_subject_id,
      retired_at, delete_operation_id, delete_request_hash)
    values (${accountId}, ${providerKind}, ${upstreamModelId}, ${crypto.randomUUID()}, ${hash},
      'user:fixture', ${removed ? new Date() : null}, ${removed ? crypto.randomUUID() : null},
      ${removed ? hash : null})`;
}

async function addWorkspaceModel(
  admin: Admin,
  scope: { accountId: string; workspaceId: string },
  providerKind: string,
  upstreamModelId: string,
  removed = false,
) {
  await admin`
    insert into workspace_gateway_custom_models (account_id, workspace_id, provider_kind,
      upstream_model_id, create_operation_id, create_request_hash, created_by_subject_id,
      retired_at, delete_operation_id, delete_request_hash)
    values (${scope.accountId}, ${scope.workspaceId}, ${providerKind}, ${upstreamModelId},
      ${crypto.randomUUID()}, ${hash}, 'user:fixture', ${removed ? new Date() : null},
      ${removed ? crypto.randomUUID() : null}, ${removed ? hash : null})`;
}

const DEFAULTS = ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"];

describe("default Claude models", () => {
  test("a first organization connection offers the defaults once", async () => {
    const scope = await organization(client.db, shared.admin);
    const actor = { organizationId: scope.accountId, actorSubjectId: scope.subjectId };
    expect(
      await seedOrganizationClaudeDefaultModels(client.db, {
        ...actor,
        providerKind: "claude_subscription",
      }),
    ).toBe(3);
    expect(await organizationModels(shared.admin, scope.accountId, "claude_subscription")).toEqual(
      DEFAULTS,
    );
    // Reconnecting, or the same request retried, adds nothing.
    expect(
      await seedOrganizationClaudeDefaultModels(client.db, {
        ...actor,
        providerKind: "claude_subscription",
      }),
    ).toBe(0);
    // The other connection kind is configured separately.
    expect(await organizationModels(shared.admin, scope.accountId, "anthropic")).toEqual([]);
  }, 60_000);

  test("a configured or trimmed organization list is left alone", async () => {
    const scope = await organization(client.db, shared.admin);
    await addOrganizationModel(shared.admin, scope.accountId, "anthropic", "claude-opus-5-5", true);
    expect(
      await seedOrganizationClaudeDefaultModels(client.db, {
        organizationId: scope.accountId,
        actorSubjectId: scope.subjectId,
        providerKind: "anthropic",
      }),
    ).toBe(0);
    expect(await organizationModels(shared.admin, scope.accountId, "anthropic")).toEqual([
      "claude-opus-5-5 (removed)",
    ]);
  }, 60_000);

  test("a first workspace connection offers the defaults once", async () => {
    const scope = await organization(client.db, shared.admin);
    const input = {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      actorSubjectId: scope.subjectId,
      providerKind: "anthropic" as const,
    };
    expect(await seedWorkspaceClaudeDefaultModels(client.db, input)).toBe(3);
    expect(await seedWorkspaceClaudeDefaultModels(client.db, input)).toBe(0);
    expect(await workspaceModels(shared.admin, scope.workspaceId, "anthropic")).toEqual(DEFAULTS);

    const trimmed = await organization(client.db, shared.admin);
    await addWorkspaceModel(shared.admin, trimmed, "claude_subscription", "claude-sonnet-5-5");
    expect(
      await seedWorkspaceClaudeDefaultModels(client.db, {
        ...input,
        accountId: trimmed.accountId,
        workspaceId: trimmed.workspaceId,
        providerKind: "claude_subscription",
      }),
    ).toBe(0);
    expect(await workspaceModels(shared.admin, trimmed.workspaceId, "claude_subscription")).toEqual(
      ["claude-sonnet-5-5"],
    );
  }, 60_000);

  test("migration 0684, run as the non-superuser owner, adds Haiku 5.5 only where Claude is in use", async () => {
    const owned = await acquireOwnerMigratedTestDatabase("migration-0684-owner");
    if (!owned) throw new Error("PostgreSQL verification requires the test fixture");
    const owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
    const ownerApp = createDb(owned.adminUrl, { max: 2 });
    try {
      await migrate(owned.ownerUrl);
      const admin = owned.admin;
      // Organization subscription with Opus added by hand: gains Haiku.
      const inUse = await organization(ownerApp.db, admin);
      await addOrganizationModel(admin, inUse.accountId, "claude_subscription", "claude-opus-5-5");
      // Organization API key where someone removed Haiku: stays removed.
      await addOrganizationModel(admin, inUse.accountId, "anthropic", "claude-opus-5-5");
      await addOrganizationModel(admin, inUse.accountId, "anthropic", "claude-haiku-5-5", true);
      // Not a Claude connection: untouched.
      await addOrganizationModel(admin, inUse.accountId, "openrouter", "vendor/model");
      // Workspace API key in use: gains Haiku.
      await addWorkspaceModel(admin, inUse, "anthropic", "claude-sonnet-5-5");
      // Workspace subscription whose only model was removed: not in use, untouched.
      const idle = await organization(ownerApp.db, admin);
      await addWorkspaceModel(admin, idle, "claude_subscription", "claude-opus-5-5", true);

      const migration = await readFile(
        join(import.meta.dir, "../drizzle/0684_claude_haiku_5_5_default_model.sql"),
        "utf8",
      );
      await owner.unsafe(migration);
      // Rerunning is harmless.
      await owner.unsafe(migration);

      expect(await organizationModels(admin, inUse.accountId, "claude_subscription")).toEqual([
        "claude-haiku-5-5",
        "claude-opus-5-5",
      ]);
      expect(await organizationModels(admin, inUse.accountId, "anthropic")).toEqual([
        "claude-haiku-5-5 (removed)",
        "claude-opus-5-5",
      ]);
      expect(await organizationModels(admin, inUse.accountId, "openrouter")).toEqual([
        "vendor/model",
      ]);
      expect(await workspaceModels(admin, inUse.workspaceId, "anthropic")).toEqual([
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ]);
      expect(await workspaceModels(admin, idle.workspaceId, "claude_subscription")).toEqual([
        "claude-opus-5-5 (removed)",
      ]);
      const [forced] = await admin<Array<{ count: number }>>`
        select count(*)::int as count from pg_class
        where relname in ('organization_model_provider_custom_models',
          'workspace_gateway_custom_models') and relforcerowsecurity`;
      expect(forced!.count).toBe(2);
    } finally {
      await owner.end().catch(() => undefined);
      await ownerApp.close().catch(() => undefined);
      await owned.release();
    }
  }, 600_000);
});
