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
import { readSubscriptionCoreRouteFunding } from "../src/subscription-core/route-readiness";

// Claude subscription custom-model admission after the drained cutover
// (design 5.3, C4): organization-model admission requires explicit caller
// authority and a serving core connection. The workspace helper locks only
// custom-model metadata; it is not a credential/capacity authorization. Public
// workspace admission is covered in gateway-custom-models.test.ts. Runs on the
// fully migrated schema as the non-owner application role.
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
  const [membership] = await shared.admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'owner', 'active', ${personal!.id})
    returning id::text as id`;
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
  return {
    grant,
    actor,
    organizationModel,
    membershipId: membership!.id,
    personalWorkspaceId: personal!.id as string,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setCutover(input: Fixture, enabled: boolean) {
  await shared.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${input.grant.accountId}::uuid, 'claude', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

async function addConnection(
  input: Fixture,
  allowedModelIds: string[] | null = null,
  workspaceIds: string[] | null = null,
) {
  const label = `claude-admission-${crypto.randomUUID()}`;
  const [row] = await shared.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, provider_subject_id, label,
      status, allowed_model_ids
    ) values (
      ${input.grant.accountId}::uuid, 'claude', 'subscription',
      ${encryptEnvironmentValue(key, "claude-admission-credential")}, 'shared',
      ${workspaceIds ? "workspaces" : "organization"}, ${!workspaceIds},
      ${label}, ${label}, ${label}, 'active', ${allowedModelIds}::text[]
    ) returning id::text as id`;
  for (const workspaceId of workspaceIds ?? [])
    await shared.admin`
      insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${input.grant.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid)`;
  return row!.id;
}

/** The fixture subject's own personal Claude connection (all models allowed). */
async function addPersonalConnection(input: Fixture) {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  const label = `claude-admission-personal-${connectionId}`;
  await shared.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${input.grant.accountId}::uuid, ${input.membershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, 1, 'active'
    )`;
  await shared.admin`
    insert into subscription_connections (
      id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id,
      provider_subject_id, label, status
    ) values (
      ${connectionId}::uuid, ${input.grant.accountId}::uuid, 'claude', 'subscription',
      ${encryptEnvironmentValue(key, "claude-admission-personal")}, 'personal', 'people',
      ${input.membershipId}::uuid, ${input.grant.subjectId}, ${authorityId}::uuid,
      'subscription_connection', 1, ${label}, ${label}, ${label}, 'active'
    )`;
  return connectionId;
}

async function admitOrganization(
  input: Fixture,
  workspaceId: string = input.grant.workspaceId,
): Promise<boolean> {
  const admitted = await withWorkspaceSubjectRls(
    client.db,
    workspaceId,
    input.grant.subjectId,
    (tx) =>
      lockActiveOrganizationModelProviderCustomModelForAdmission(tx, {
        accountId: input.grant.accountId,
        workspaceId,
        providerKind: "claude_subscription",
        upstreamModelId: "claude-opus-5-5",
        claudeAuthority: { authoritySnapshot: { version: 1, scope: "organization" } },
      }),
  );
  return admitted !== null;
}

async function admitWorkspace(
  input: Fixture,
  workspaceId: string = input.grant.workspaceId,
): Promise<boolean> {
  const admitted = await withWorkspaceSubjectRls(
    client.db,
    workspaceId,
    input.grant.subjectId,
    (tx) =>
      lockActiveWorkspaceProviderCustomModelForAdmission(tx, {
        accountId: input.grant.accountId,
        workspaceId,
        providerKind: "claude_subscription",
        upstreamModelId: "claude-sonnet-5-5",
      }),
  );
  return admitted !== null;
}

async function admitBoth(input: Fixture, workspaceId: string = input.grant.workspaceId) {
  return {
    organization: await admitOrganization(input, workspaceId),
    workspace: await admitWorkspace(input, workspaceId),
  };
}

test("runs as the non-owner application role", async () => {
  const [posture] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
  expect(posture).toEqual({ rolsuper: false, rolbypassrls: false });
});

test("organization admission requires serving core capacity; workspace metadata is independent", async () => {
  const input = await fixture();
  // A new organization is on the core, but has no serving connection.
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
  await setCutover(input, true);
  // Core route, but no serving shared Claude connection.
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
  await addConnection(input);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
  // Maintenance refuses execution, not reading an existing model definition.
  await setCutover(input, false);
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
});

test("the serving connection must allow the exact product model", async () => {
  const input = await fixture();
  await setCutover(input, true);
  await addConnection(input, ["workspace-claude-subscription/claude-sonnet-5-5"]);
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
  await addConnection(input, ["organization-claude-subscription/claude-opus-5-5"]);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
});

test("an unhealthy connection does not serve, and a retired model is never admitted", async () => {
  const input = await fixture();
  await setCutover(input, true);
  const connectionId = await addConnection(input);
  await shared.admin`
    update subscription_connections set status = 'error'
    where id = ${connectionId}::uuid`;
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
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

test("a personal Claude connection does not admit an organization model, even in its owner's Personal workspace", async () => {
  const input = await fixture();
  await setCutover(input, true);
  // The same Claude workspace-scope model in the owner's Personal workspace.
  await shared.admin`
    insert into workspace_gateway_custom_models (
      account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
      create_request_hash, created_by_subject_id
    ) values (
      ${input.grant.accountId}::uuid, ${input.personalWorkspaceId}::uuid, 'claude_subscription',
      'claude-sonnet-5-5', ${crypto.randomUUID()}::uuid, ${"d".repeat(64)}, ${input.grant.subjectId}
    )`;
  // Only the admitting subject's own personal connection exists. Admission
  // runs under that owner's subject, but asks the core for shared capacity
  // only, so the personal connection cannot serve the organization prefix.
  await addPersonalConnection(input);
  // The connection is serviceable: the core funds its owner's own turn in
  // the Personal workspace with it.
  expect(
    await readSubscriptionCoreRouteFunding(client.db, {
      provider: "claude",
      accountId: input.grant.accountId,
      workspaceId: input.personalWorkspaceId,
      subjectId: input.grant.subjectId,
      productModelId: "organization-claude-subscription/claude-opus-5-5",
    }),
  ).toEqual({ route: "core", value: true });
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
  expect(await admitBoth(input, input.personalWorkspaceId)).toEqual({
    organization: false,
    workspace: true,
  });
  // A shared organization connection (personal workspaces allowed) admits
  // the organization model in both workspaces, unlike personal ownership.
  await addConnection(input);
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
  expect(await admitBoth(input, input.personalWorkspaceId)).toEqual({
    organization: true,
    workspace: true,
  });
});

test("a shared connection scoped to other workspaces does not admit here", async () => {
  const input = await fixture();
  await setCutover(input, true);
  const [other] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${input.grant.accountId}, 'Claude admission other workspace') returning id::text as id`;
  const connectionId = await addConnection(input, null, [other!.id]);
  expect(await admitBoth(input)).toEqual({ organization: false, workspace: true });
  // Covering this workspace too admits it.
  await shared.admin`
    insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
    values (${input.grant.accountId}::uuid, ${connectionId}::uuid, ${input.grant.workspaceId}::uuid)`;
  expect(await admitBoth(input)).toEqual({ organization: true, workspace: true });
});
