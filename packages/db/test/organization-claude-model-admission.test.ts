import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, type DbClient } from "../src";
import { withWorkspaceSubjectRls } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import {
  createWorkspaceProviderCustomModel,
  lockActiveWorkspaceProviderCustomModelForAdmission,
} from "../src/model-catalog";
import {
  createOrganizationModelProviderCustomModel,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  retireOrganizationModelProviderCustomModel,
} from "../src/organization-model-providers";

// Claude subscription custom-model admission after the drained cutover
// (design 5.3, C4): the legacy pool admission is deleted, so at both scopes a
// Claude custom model is live only while the shared core serves it in the
// workspace (the 0720 receipt, an enabled organization cutover and a serving
// shared Claude connection that allows the exact product model). Everything
// else fails closed. Runs on the fully migrated schema (the 0720 receipt is
// present) as the non-owner application role.
let shared: SharedTestDatabase;
let client: DbClient;
const key = Buffer.alloc(32, 41);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-claude-model-admission");
  if (!acquired) throw new Error("Claude custom-model admission tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `claude-admission-${suffix}`,
    accountName: "Claude admission account",
    workspaceExternalSource: "test",
    workspaceExternalId: `claude-admission-${suffix}`,
    workspaceName: "Claude admission workspace",
    subjectId: `user:claude-admission-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Claude admission Personal workspace') returning id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'owner', 'active', ${personal!.id})`;
  const actor = { organizationId: grant.accountId, actorSubjectId: grant.subjectId };
  const organizationModel = await createOrganizationModelProviderCustomModel(client.db, {
    ...actor,
    providerKind: "claude_subscription",
    upstreamModelId: "claude-opus-5-5",
    operationId: crypto.randomUUID(),
  });
  await createWorkspaceProviderCustomModel(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    providerKind: "claude_subscription",
    upstreamModelId: "claude-sonnet-5-5",
    operationId: crypto.randomUUID(),
    requestHash: "c".repeat(64),
    createdBySubjectId: grant.subjectId,
  });
  return { grant, actor, organizationModel };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setCutover(input: Fixture, enabled: boolean) {
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${input.grant.accountId}::uuid, 'claude', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

async function addConnection(input: Fixture, allowedModelIds: string[] | null = null) {
  const label = `claude-admission-${crypto.randomUUID()}`;
  const [row] = await shared.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, provider_subject_id, label,
      status, allowed_model_ids
    ) values (
      ${input.grant.accountId}::uuid, 'claude', 'subscription',
      ${encryptEnvironmentValue(key, "claude-admission-credential")}, 'shared', 'organization',
      true, ${label}, ${label}, ${label}, 'active', ${allowedModelIds}::text[]
    ) returning id::text as id`;
  return row!.id;
}

async function admitOrganization(input: Fixture): Promise<boolean> {
  const admitted = await withWorkspaceSubjectRls(
    client.db,
    input.grant.workspaceId,
    input.grant.subjectId,
    (tx) =>
      lockActiveOrganizationModelProviderCustomModelForAdmission(tx, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        providerKind: "claude_subscription",
        upstreamModelId: "claude-opus-5-5",
      }),
  );
  return admitted !== null;
}

async function admitWorkspace(input: Fixture): Promise<boolean> {
  const admitted = await withWorkspaceSubjectRls(
    client.db,
    input.grant.workspaceId,
    input.grant.subjectId,
    (tx) =>
      lockActiveWorkspaceProviderCustomModelForAdmission(tx, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        providerKind: "claude_subscription",
        upstreamModelId: "claude-sonnet-5-5",
      }),
  );
  return admitted !== null;
}

async function admitBoth(input: Fixture) {
  return { organization: await admitOrganization(input), workspace: await admitWorkspace(input) };
}

test("runs as the non-owner application role", async () => {
  const [posture] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
  expect(posture).toEqual({ rolsuper: false, rolbypassrls: false });
});

test("both scopes are admitted on the core route with a serving connection", async () => {
  const input = await fixture();
  // Receipt present, but the organization has no cutover row: maintenance.
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: false });
  await setCutover(input, true);
  // Core route, but no serving shared Claude connection.
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: false });
  await addConnection(input);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
  // An operator hold (maintenance) refuses both again.
  await setCutover(input, false);
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: false });
});

test("the serving connection must allow the exact product model", async () => {
  const input = await fixture();
  await setCutover(input, true);
  await addConnection(input, ["organization-claude-subscription/claude-opus-5-5"]);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: false });
  await addConnection(input, ["workspace-claude-subscription/claude-sonnet-5-5"]);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
});

test("an unhealthy connection does not serve, and a retired model is never admitted", async () => {
  const input = await fixture();
  await setCutover(input, true);
  const connectionId = await addConnection(input);
  await shared.admin`
    update subscription_connections set status = 'error'
    where id = ${connectionId}::uuid`;
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: false });
  await addConnection(input);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
  await retireOrganizationModelProviderCustomModel(client.db, {
    ...input.actor,
    providerKind: "claude_subscription",
    customModelId: input.organizationModel.id,
    expectedVersion: input.organizationModel.version,
    operationId: crypto.randomUUID(),
  });
  expect(await admitOrganization(input)).toBe(false);
  // The workspace model is a separate definition and stays admitted.
  expect(await admitWorkspace(input)).toBe(true);
});
