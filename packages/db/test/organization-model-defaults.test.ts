import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";

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
  test("a workspace's own allowlist only narrows the organization's", async () => {
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
      allowCreditModels: true,
    });

    // "Allow every model" in a workspace means every model the organization allows.
    await upsertWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      allowedProviders: null,
      allowedModels: null,
    });
    expect(await getWorkspaceModelPolicyLayers(db, org.workspaceId)).toEqual({
      workspace: { allowedProviders: null, allowedModels: null },
      organization: { allowedProviders: null, allowedModels: ["model-a"] },
      allowCreditModels: true,
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
      allowCreditModels: true,
    });

    // Its own list keeps only what the organization allows.
    await upsertWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      allowedProviders: ["openai"],
      allowedModels: ["model-a", "model-b"],
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: ["openai"],
      allowedModels: ["model-a"],
      allowCreditModels: true,
    });
    // Providers narrow the same way.
    await updateOrganizationModelDefaults(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      patch: { modelPolicy: { allowedProviders: ["openai", "anthropic"], allowedModels: null } },
    });
    await upsertWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      allowedProviders: ["anthropic", "xai"],
      allowedModels: null,
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: ["anthropic"],
      allowedModels: null,
      allowCreditModels: true,
    });
    await updateOrganizationModelDefaults(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      patch: { modelPolicy: { allowedProviders: null, allowedModels: ["model-a"] } },
    });

    // Removing it uses the organization's list as is.
    await deleteWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
      allowCreditModels: true,
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
      allowCreditModels: true,
    });
  });

  test("the workspace credit switch holds whichever allowlist the workspace follows", async () => {
    if (!client) return;
    const db = client.db;
    const org = await organization("org-defaults-credit-switch");
    await updateOrganizationModelDefaults(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      patch: { modelPolicy: { allowedProviders: null, allowedModels: ["model-a"] } },
    });

    // Turning credits off is a workspace setting: no policy row, so the
    // workspace keeps following the organization's allowlist.
    await updateWorkspaceSettings(db, org.workspaceId, { allowCreditModels: false });
    expect(await getWorkspaceModelPolicyLayers(db, org.workspaceId)).toEqual({
      workspace: null,
      organization: { allowedProviders: null, allowedModels: ["model-a"] },
      allowCreditModels: false,
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
      allowCreditModels: false,
    });

    // Saving or removing the workspace's own allowlist never turns it back on.
    await upsertWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      allowedProviders: null,
      allowedModels: null,
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: ["model-a"],
      allowCreditModels: false,
    });
    await deleteWorkspaceModelPolicy(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
    });
    expect((await getWorkspaceModelPolicy(db, org.workspaceId))?.allowCreditModels).toBe(false);

    // An unrelated settings write keeps it (top-level merge).
    await updateWorkspaceSettings(db, org.workspaceId, { agentHumanInputEnabled: false });
    expect((await getWorkspaceModelPolicy(db, org.workspaceId))?.allowCreditModels).toBe(false);

    // With nothing else restricted, credits off still reads as a policy.
    await updateOrganizationModelDefaults(db, {
      organizationId: org.accountId,
      actorSubjectId: org.owner,
      patch: { modelPolicy: null },
    });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toEqual({
      allowedProviders: null,
      allowedModels: null,
      allowCreditModels: false,
    });

    await updateWorkspaceSettings(db, org.workspaceId, { allowCreditModels: true });
    expect(await getWorkspaceModelPolicy(db, org.workspaceId)).toBeNull();
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
