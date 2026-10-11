import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, type DbClient } from "../src";
import { withWorkspaceSubjectRls } from "../src/database";
import {
  createOrganizationModelProviderCustomModel,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  type OrganizationClaudeModelAdmissionAuthority,
} from "../src/organization-model-providers";

// The legacy Claude pool admission is deleted (design 5.3, C4). Until the core
// admission arrives (C2a), no organization Claude subscription custom model is
// admitted, whatever authority the caller presents (fail closed). Runs on the
// fully migrated schema as the non-owner application role.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-claude-model-admission");
  if (!acquired) throw new Error("Organization Claude admission tests require real PostgreSQL");
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
  const model = await createOrganizationModelProviderCustomModel(client.db, {
    ...actor,
    providerKind: "claude_subscription",
    upstreamModelId: "claude-opus-5-5",
    operationId: crypto.randomUUID(),
  });
  return { grant, actor, model };
}

async function admit(
  input: Awaited<ReturnType<typeof fixture>>,
  claudeAuthority: OrganizationClaudeModelAdmissionAuthority | undefined,
) {
  return await withWorkspaceSubjectRls(
    client.db,
    input.grant.workspaceId,
    input.grant.subjectId,
    (tx) =>
      lockActiveOrganizationModelProviderCustomModelForAdmission(tx, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        providerKind: "claude_subscription",
        upstreamModelId: input.model.upstreamModelId,
        ...(claudeAuthority ? { claudeAuthority } : {}),
      }),
  );
}

test("organization Claude custom-model admission fails closed without the legacy pool", async () => {
  const input = await fixture();
  const [posture] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
  expect(posture).toEqual({ rolsuper: false, rolbypassrls: false });
  const sessionId = crypto.randomUUID();
  for (const claudeAuthority of [
    undefined,
    { authoritySnapshot: { version: 1, scope: "organization" } as const },
    { authoritySnapshot: { version: 1, scope: "workspace" } as const },
    { sessionId },
  ] satisfies Array<OrganizationClaudeModelAdmissionAuthority | undefined>) {
    expect(await admit(input, claudeAuthority)).toBeNull();
  }
  // The definition itself is unchanged: only admission refuses it.
  const [stored] = await shared.admin<{ retired_at: Date | null }[]>`
    select retired_at from organization_model_provider_custom_models where id = ${input.model.id}`;
  expect(stored?.retired_at).toBeNull();
});
