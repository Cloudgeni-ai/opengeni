import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, createSession, type DbClient } from "../src";
import {
  upsertOrganizationClaudeSubscription,
  updateOrganizationClaudeSubscription,
} from "../src/claude-subscription-accounts";
import {
  withRlsContext,
  withSessionRlsActorContext,
  withWorkspaceSubjectRls,
} from "../src/database";
import {
  createOrganizationModelProviderCustomModel,
  lockActiveOrganizationModelProviderCustomModelForAdmission,
  retireOrganizationModelProviderCustomModel,
  type OrganizationClaudeModelAdmissionAuthority,
} from "../src/organization-model-providers";

let shared: SharedTestDatabase;
let client: DbClient;
const organizationAuthority = { version: 1, scope: "organization" } as const;
const encryptionKey = Buffer.alloc(32, 7);

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

async function connect(input: Awaited<ReturnType<typeof fixture>>) {
  const secret = {
    version: 1 as const,
    token: "sk-ant-oat01-admission-fixture",
    identity: { accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64) },
  };
  return await upsertOrganizationClaudeSubscription(client.db, {
    ...input.actor,
    encryptionKey,
    secret,
    providerAccountId: secret.identity.accountUuid,
    label: null,
    accountEmail: null,
    expiresAt: null,
  });
}

function admissionInput(input: Awaited<ReturnType<typeof fixture>>) {
  return {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    providerKind: "claude_subscription" as const,
    upstreamModelId: input.model.upstreamModelId,
  };
}

async function admit(
  input: Awaited<ReturnType<typeof fixture>>,
  claudeAuthority: OrganizationClaudeModelAdmissionAuthority | undefined = {
    authoritySnapshot: organizationAuthority,
  },
) {
  return await withWorkspaceSubjectRls(
    client.db,
    input.grant.workspaceId,
    input.grant.subjectId,
    (tx) =>
      lockActiveOrganizationModelProviderCustomModelForAdmission(tx, {
        ...admissionInput(input),
        ...(claudeAuthority ? { claudeAuthority } : {}),
      }),
  );
}

test("organization Claude admission requires canonical readiness, with no legacy credential row", async () => {
  const input = await fixture();
  expect(await admit(input)).toBeNull();
  await connect(input);
  expect((await admit(input))?.id).toBe(input.model.id);
  const [legacy] = await shared.admin<{ count: number }[]>`
    select count(*)::integer as count from organization_model_provider_connections
    where account_id = ${input.grant.accountId} and provider_kind = 'claude_subscription'`;
  expect(legacy?.count).toBe(0);
  await withWorkspaceSubjectRls(
    client.db,
    input.grant.workspaceId,
    input.grant.subjectId,
    async (tx) => {
      expect(
        await lockActiveOrganizationModelProviderCustomModelForAdmission(tx, admissionInput(input)),
      ).toBeNull();
    },
  );
  for (const authoritySnapshot of [
    { version: 1, scope: "workspace" } as const,
    { version: 1, scope: "user", authorityGeneration: 1 } as const,
  ]) {
    expect(await admit(input, { authoritySnapshot })).toBeNull();
  }
  expect(
    await withRlsContext(client.db, admissionInput(input), (tx) =>
      lockActiveOrganizationModelProviderCustomModelForAdmission(tx, {
        ...admissionInput(input),
        claudeAuthority: { authoritySnapshot: organizationAuthority },
      }),
    ),
  ).toBeNull();
});

test("session-source admission keeps the stored pool instead of selecting a live organization pool", async () => {
  const input = await fixture();
  await connect(input);
  const session = (
    authoritySnapshot: typeof organizationAuthority | { version: 1; scope: "workspace" },
  ) =>
    withSessionRlsActorContext({ subjectId: input.grant.subjectId }, () =>
      createSession(client.db, {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        initialMessage: "Accepted Claude authority fixture",
        resources: [],
        metadata: {},
        model: `organization-claude-subscription/${input.model.upstreamModelId}`,
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: input.grant.subjectId },
        subjectId: input.grant.subjectId,
        initialClaudeProviderAccountAuthoritySnapshot: authoritySnapshot,
      }),
    );
  const workspace = await session({ version: 1, scope: "workspace" });
  expect(await admit(input, { sessionId: workspace.id })).toBeNull();
  const organization = await session(organizationAuthority);
  expect((await admit(input, { sessionId: organization.id }))?.id).toBe(input.model.id);
  expect(await admit(input, { sessionId: crypto.randomUUID() })).toBeNull();
});

test("allocator-disabled, disconnected and retired organization Claude sources fail closed", async () => {
  const input = await fixture();
  const connected = await connect(input);
  expect((await admit(input))?.id).toBe(input.model.id);
  await updateOrganizationClaudeSubscription(client.db, {
    ...input.actor,
    credentialId: connected.account.id,
    allocatorEnabled: false,
    expectedAllocatorVersion: connected.account.allocatorVersion,
  });
  expect(await admit(input)).toBeNull();
  await updateOrganizationClaudeSubscription(client.db, {
    ...input.actor,
    credentialId: connected.account.id,
    disconnect: true,
  });
  expect(await admit(input)).toBeNull();
  await connect(input);
  expect((await admit(input))?.id).toBe(input.model.id);
  await retireOrganizationModelProviderCustomModel(client.db, {
    ...input.actor,
    providerKind: "claude_subscription",
    customModelId: input.model.id,
    expectedVersion: input.model.version,
    operationId: crypto.randomUUID(),
  });
  expect(await admit(input)).toBeNull();
});
