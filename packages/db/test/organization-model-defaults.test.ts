import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

import {
  createDb,
  deleteWorkspaceModelPolicy,
  getOrganizationModelDefaults,
  getOrganizationModelDefaultsForAdministrator,
  getWorkspaceModelPolicy,
  getWorkspaceModelPolicyLayers,
  updateOrganizationModelDefaults,
  updateWorkspaceSettings,
  upsertWorkspaceModelPolicy,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

// Organization model defaults: every workspace follows them until it saves
// its own value, field by field.
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-model-defaults");
  if (!shared && requireRealDatabase) throw new Error("PostgreSQL test database unavailable");
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization(label: string) {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${label}) returning id`;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Shared') returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const owner = `user:${crypto.randomUUID()}`;
  const member = `user:${crypto.randomUUID()}`;
  const [memberPersonal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Personal') returning id`;
  await shared!.admin`
    insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id)
    values (${account!.id}, ${owner}, 'owner', 'active', ${personal!.id})`;
  await shared!.admin`
    insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id)
    values (${account!.id}, ${member}, 'member', 'active', ${memberPersonal!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id, owner, member };
}

describe("organization model defaults", () => {
  test("ships as a rolling FORCE RLS table the runtime may change", async () => {
    const migration = await readFile(
      new URL("../drizzle/0689_organization_model_defaults.sql", import.meta.url),
      "utf8",
    );
    expect(migration.split("\n")[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(FORCE_RLS_TABLES).toContain("organization_model_defaults");
    expect(RUNTIME_FULL_DML_TABLES).toContain("organization_model_defaults");
  });

  test("workspaces follow the organization's allowlist until they choose their own", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("org-defaults-policy");
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toBeNull();

    await updateOrganizationModelDefaults(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      patch: { modelPolicy: { allowedProviders: null, allowedModels: ["model-a"] } },
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
    });

    // A workspace's own choice wins, including "allow every model".
    await upsertWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      allowedProviders: null,
      allowedModels: null,
    });
    expect(await getWorkspaceModelPolicyLayers(db, org.workspaceId)).toEqual({
      workspace: { allowedProviders: null, allowedModels: null },
      organization: { allowedProviders: null, allowedModels: ["model-a"] },
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: null,
    });

    // Removing it follows the organization again.
    await deleteWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
    });

    // Another organization's defaults never reach this workspace.
    const other = await organization("org-defaults-policy-other");
    await updateOrganizationModelDefaults(db, {
      organizationId: other.accountId,
      actorSubjectId: other.owner,
      patch: { modelPolicy: { allowedProviders: null, allowedModels: [] } },
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
    });
  });

  test("updates field by field and merges compaction limits by model", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("org-defaults-merge");
    const update = (patch: Parameters<typeof updateOrganizationModelDefaults>[1]["patch"]) =>
      updateOrganizationModelDefaults(db, {
        organizationId: org.accountId,
        actorSubjectId: org.owner,
        patch,
      });
    await update({ sessionDefaults: { model: "model-a", reasoningEffort: "high" } });
    await update({ modelCompactionThresholds: { "model-a": 300_000, "model-b": 90_000 } });
    await update({ modelCompactionThresholds: { "model-b": null, "model-c": 120_000 } });
    const saved = await getOrganizationModelDefaults(db, org.accountId);
    expect(saved.sessionDefaults).toEqual({ model: "model-a", reasoningEffort: "high" });
    expect(saved.allowedModels).toBeNull();
    expect(saved.modelCompactionThresholds).toEqual({ "model-a": 300_000, "model-c": 120_000 });

    await update({ sessionDefaults: null });
    const cleared = await getOrganizationModelDefaults(db, org.accountId);
    expect(cleared.sessionDefaults).toBeNull();
    expect(cleared.modelCompactionThresholds).toEqual({ "model-a": 300_000, "model-c": 120_000 });
  });

  test("only owners and admins read or change them through the administrator path", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("org-defaults-admin");
    await expect(
      updateOrganizationModelDefaults(db, {
        organizationId: org.accountId,
        actorSubjectId: org.member,
        patch: { sessionDefaults: { model: "model-a", reasoningEffort: "low" } },
      }),
    ).rejects.toThrow();
    await expect(
      getOrganizationModelDefaultsForAdministrator(db, {
        organizationId: org.accountId,
        actorSubjectId: org.member,
      }),
    ).rejects.toThrow();
    expect((await getOrganizationModelDefaults(db, org.accountId)).sessionDefaults).toBeNull();
  });

  test("clearing a workspace default removes it so the organization's applies", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("org-defaults-workspace-clear");
    await updateWorkspaceSettings(db, org.workspaceId, {
      sessionDefaults: { model: "model-b", reasoningEffort: "low" },
    });
    const cleared = await updateWorkspaceSettings(db, org.workspaceId, { sessionDefaults: null });
    expect(Object.hasOwn(cleared.settings as object, "sessionDefaults")).toBe(false);
  });
});
