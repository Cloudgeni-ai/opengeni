import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createConnection,
  createClaudeSubscriptionAccount,
  createDb,
  getOrganizationModelProviderCatalogForWorkspace,
  getWorkspaceProviderApiKeyConnectionMetadata,
  listConnectionsMetadata,
  listClaudeSubscriptionAccountsMetadata,
  listOrganizationModelProviderCustomModelsForWorkspace,
  listWorkspaceProviderCustomModels,
  listWorkspaceProviderCustomModelsByKind,
  organizationModelProviderConnectionActiveForWorkspace,
  setInitialActiveClaudeCredential,
  updateModelConnectionAccess,
  upsertOrganizationClaudeSubscription,
  workspaceClaudeSubscriptionActiveForAuthority,
  workspaceProviderApiKeyConnectionMetadataFromConnections,
  workspaceProviderApiKeyConnectionSpec,
  type DbClient,
  type WorkspaceCustomModelProviderKind,
} from "../src";
import { withDatabaseTimingObserver } from "../src/database-timing";
import * as schema from "../src/schema";

const providerKinds: WorkspaceCustomModelProviderKind[] = [
  "vercel_gateway",
  "openrouter",
  "anthropic",
  "claude_subscription",
];
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let scope: { accountId: string; workspaceId: string };
let otherScope: typeof scope;
let siblingId: string;
let personalId: string;
const actor = "user:provider-catalog-fixture";
const hash = "a".repeat(64);
const claudePools = new Map<string, { workspace: string; organization: string }>();
const encryptionKey = Buffer.alloc(32, 7);
const claudeSecret = () => ({
  version: 1 as const,
  token: "sk-ant-oat01-provider-catalog-fixture",
  identity: { accountUuid: crypto.randomUUID(), deviceId: "a".repeat(64) },
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("provider-catalog-reads");
  if (!shared) throw new Error("provider catalog reads require PostgreSQL");
  client = createDb(shared.appUrl);
  const bootstrap = async (suffix: string) => {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: `Catalog fixture ${suffix}`,
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: `Catalog fixture ${suffix}`,
      subjectId: actor,
    });
    const grant = access.workspaceGrants[0]!;
    return { accountId: grant.accountId, workspaceId: grant.workspaceId };
  };
  scope = await bootstrap("one");
  otherScope = await bootstrap("two");
  const siblings = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${scope.accountId}, 'Sibling fixture'), (${scope.accountId}, 'Personal fixture')
    returning id`;
  siblingId = siblings[0]!.id;
  personalId = siblings[1]!.id;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${scope.accountId}, ${actor}, 'owner', 'active', ${personalId})`;
  const [otherPersonal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${otherScope.accountId}, 'Other personal fixture') returning id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${otherScope.accountId}, ${actor}, 'owner', 'active', ${otherPersonal!.id})`;
  for (const target of [scope, otherScope]) {
    for (const providerKind of providerKinds) {
      if (providerKind === "claude_subscription") {
        // 0598 rejects both legacy credential stores. Seed real, separate
        // workspace/organization pools without changing custom-model storage.
        const secret = claudeSecret();
        const connected = await createClaudeSubscriptionAccount(client.db, {
          ...target,
          subjectId: actor,
          encryptionKey,
          secret,
          providerAccountId: secret.identity.accountUuid,
        });
        await setInitialActiveClaudeCredential(client.db, {
          ...target,
          subjectId: actor,
          credentialId: connected.account.id,
          authoritySnapshot: connected.authoritySnapshot,
        });
        const organizationSecret = claudeSecret();
        const organization = await upsertOrganizationClaudeSubscription(client.db, {
          organizationId: target.accountId,
          actorSubjectId: actor,
          encryptionKey,
          secret: organizationSecret,
          providerAccountId: organizationSecret.identity.accountUuid,
          label: null,
          accountEmail: null,
          expiresAt: null,
        });
        expect(
          await updateModelConnectionAccess(
            client.db,
            {
              accountId: target.accountId,
              workspaceId: null,
              subjectId: actor,
              kind: "claude_subscription",
              connectionId: organization.account.id,
            },
            {
              allowedModels: null,
              allowedWorkspaces: [target.workspaceId],
              allowPersonalWorkspaces: false,
              version: 1,
            },
          ),
        ).toMatchObject({ version: 2, allowedWorkspaces: [target.workspaceId] });
        claudePools.set(target.workspaceId, {
          workspace: connected.account.id,
          organization: organization.account.id,
        });
      } else {
        const spec = workspaceProviderApiKeyConnectionSpec(providerKind);
        await createConnection(client.db, {
          ...target,
          subjectId: null,
          providerDomain: spec.providerDomain.toUpperCase(),
          kind: "api_key",
          credentialEncrypted: "fixture-ciphertext-not-a-key",
          metadata: { credentialRole: spec.credentialRole },
          createdBySubjectId: actor,
        });
        await shared.admin`
          insert into organization_model_provider_connections
            (account_id, provider_kind, credential_encrypted, operation_id, request_hash,
             updated_by_subject_id, allowed_workspace_ids, allow_personal_workspaces)
          values (${target.accountId}, ${providerKind}, 'fixture-ciphertext-not-a-key',
            ${crypto.randomUUID()}, ${hash}, ${actor}, array[${target.workspaceId}::uuid], false)`;
      }
      await shared.admin`
        insert into organization_model_provider_custom_models
          (account_id, provider_kind, upstream_model_id, create_operation_id, create_request_hash,
           created_by_subject_id)
        values (${target.accountId}, ${providerKind}, 'organization-fixture',
          ${crypto.randomUUID()}, ${hash}, ${actor})`;
      for (const [upstream, retired] of [
        ["b-fixture", false],
        ["a-fixture", false],
        ["retired-fixture", true],
      ] as const) {
        await shared.admin`
          insert into workspace_gateway_custom_models
            (account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
             create_request_hash, created_by_subject_id, created_at, retired_at)
          values (${target.accountId}, ${target.workspaceId}, ${providerKind}, ${upstream},
            ${crypto.randomUUID()}, ${hash}, ${actor}, '2026-01-01', ${retired ? new Date() : null})`;
      }
    }
  }
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("batch reads retain per-provider results, scopes and metadata-only queries", async () => {
  const sqlClient = postgres(shared!.appUrl, { max: 1, prepare: false });
  const queries: string[] = [];
  const db = drizzle(sqlClient, { schema, logger: { logQuery: (query) => queries.push(query) } });
  let transactions = 0;
  try {
    const [posture] = await sqlClient`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(posture).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const [connections, workspace, organization] = await withDatabaseTimingObserver(
      (event) => {
        if (event.stage === "transaction_admission") transactions++;
      },
      () =>
        Promise.all([
          listConnectionsMetadata(db, scope.workspaceId, null),
          listWorkspaceProviderCustomModelsByKind(db, { ...scope, providerKinds }),
          getOrganizationModelProviderCatalogForWorkspace(db, { ...scope, providerKinds }),
        ]),
    );
    expect(transactions).toBe(3);
    expect(
      queries.filter((query) => query.includes('from "workspace_gateway_custom_models"')),
    ).toHaveLength(1);
    expect(
      queries.filter((query) => query.includes('from "organization_model_provider_connections"')),
    ).toHaveLength(1);
    expect(
      queries.filter((query) => query.includes('from "organization_model_provider_custom_models"')),
    ).toHaveLength(1);
    expect(queries.join("\n")).not.toContain("credential_encrypted");
    for (const providerKind of providerKinds) {
      expect(workspace[providerKind]).toEqual(
        await listWorkspaceProviderCustomModels(client.db, { ...scope, providerKind }),
      );
      expect(organization[providerKind].active).toBe(
        await organizationModelProviderConnectionActiveForWorkspace(client.db, {
          ...scope,
          providerKind,
        }),
      );
      expect(organization[providerKind].models).toEqual(
        await listOrganizationModelProviderCustomModelsForWorkspace(client.db, {
          ...scope,
          providerKind,
        }),
      );
      expect(
        workspaceProviderApiKeyConnectionMetadataFromConnections(connections, providerKind),
      ).toEqual(
        await getWorkspaceProviderApiKeyConnectionMetadata(
          client.db,
          scope.workspaceId,
          providerKind,
        ),
      );
    }
    expect(JSON.stringify({ connections, workspace, organization })).not.toContain(
      "fixture-ciphertext",
    );
  } finally {
    await sqlClient.end();
  }
});

test("canonical Claude pools are ready and their batched metadata never reads secrets", async () => {
  const sqlClient = postgres(shared!.appUrl, { max: 1, prepare: false });
  const queries: string[] = [];
  const db = drizzle(sqlClient, { schema, logger: { logQuery: (query) => queries.push(query) } });
  let transactions = 0;
  try {
    const accounts = await withDatabaseTimingObserver(
      (event) => {
        if (event.stage === "transaction_admission") transactions++;
      },
      () =>
        listClaudeSubscriptionAccountsMetadata(db, {
          workspaceId: scope.workspaceId,
          subjectId: actor,
        }),
    );
    expect(transactions).toBe(1);
    expect(
      queries.filter((query) => query.includes('from "claude_subscription_credentials"')),
    ).toHaveLength(1);
    expect(queries.join("\n")).not.toContain("credential_encrypted");
    const pool = claudePools.get(scope.workspaceId)!;
    expect(accounts.map((account) => account.id).sort()).toEqual(
      [pool.workspace, pool.organization].sort(),
    );
    for (const authorityScope of ["workspace", "organization"] as const) {
      expect(accounts.find((account) => account.id === pool[authorityScope])).toMatchObject({
        scope: authorityScope,
        status: "active",
      });
      expect(
        await workspaceClaudeSubscriptionActiveForAuthority(
          client.db,
          { claudeSubscriptionEnabled: true },
          {
            workspaceId: scope.workspaceId,
            subjectId: actor,
            authoritySnapshot: { version: 1, scope: authorityScope },
          },
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(accounts)).not.toContain("sk-ant-oat01");
    expect(JSON.stringify(accounts)).not.toContain("credentialEncrypted");
    expect(
      await getWorkspaceProviderApiKeyConnectionMetadata(
        client.db,
        scope.workspaceId,
        "claude_subscription",
      ),
    ).toBeNull();
    expect(
      await organizationModelProviderConnectionActiveForWorkspace(client.db, {
        ...scope,
        providerKind: "claude_subscription",
      }),
    ).toBe(false);
  } finally {
    await sqlClient.end();
  }
});

test("workspace assignment, personal-workspace policy and account isolation still apply", async () => {
  for (const workspaceId of [siblingId, personalId]) {
    const input = { accountId: scope.accountId, workspaceId, providerKinds };
    const catalog = await getOrganizationModelProviderCatalogForWorkspace(client.db, input);
    for (const providerKind of providerKinds) {
      expect(catalog[providerKind].active).toBe(false);
      expect(catalog[providerKind].active).toBe(
        await organizationModelProviderConnectionActiveForWorkspace(client.db, {
          ...input,
          providerKind,
        }),
      );
    }
    const models = await listWorkspaceProviderCustomModelsByKind(client.db, input);
    expect(Object.values(models).flat()).toEqual([]);
    expect(
      await listClaudeSubscriptionAccountsMetadata(client.db, { workspaceId, subjectId: actor }),
    ).toEqual([]);
    expect(
      await workspaceClaudeSubscriptionActiveForAuthority(
        client.db,
        { claudeSubscriptionEnabled: true },
        {
          workspaceId,
          subjectId: actor,
          authoritySnapshot: { version: 1, scope: "organization" },
        },
      ),
    ).toBe(false);
  }
  const organization = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
    ...otherScope,
    providerKinds,
  });
  const workspace = await listWorkspaceProviderCustomModelsByKind(client.db, {
    ...otherScope,
    providerKinds,
  });
  expect(
    Object.values(organization)
      .flatMap((provider) => provider.models)
      .every((model) => model.accountId === otherScope.accountId),
  ).toBe(true);
  const otherAccounts = await listClaudeSubscriptionAccountsMetadata(client.db, {
    workspaceId: otherScope.workspaceId,
    subjectId: actor,
  });
  const otherPool = claudePools.get(otherScope.workspaceId)!;
  expect(otherAccounts.map((account) => account.id).sort()).toEqual(
    [otherPool.workspace, otherPool.organization].sort(),
  );
  expect(
    otherAccounts.some((account) =>
      Object.values(claudePools.get(scope.workspaceId)!).includes(account.id),
    ),
  ).toBe(false);
  expect(
    Object.values(workspace)
      .flat()
      .every((model) => model.workspaceId === otherScope.workspaceId),
  ).toBe(true);
});

test("only requested provider kinds are loaded; duplicate kinds do not duplicate rows", async () => {
  const requested = ["anthropic", "anthropic"] as const;
  const workspace = await listWorkspaceProviderCustomModelsByKind(client.db, {
    ...scope,
    providerKinds: requested,
  });
  const organization = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
    ...scope,
    providerKinds: requested,
  });
  expect(workspace.anthropic).toHaveLength(2);
  expect(organization.anthropic.models).toHaveLength(1);
  expect(workspace.claude_subscription).toEqual([]);
  expect(organization.claude_subscription).toEqual({ active: false, models: [] });
  expect(
    Object.values(
      await listWorkspaceProviderCustomModelsByKind(client.db, { ...scope, providerKinds: [] }),
    ).flat(),
  ).toEqual([]);
});

test("metadata selection preserves newest-first order and all credential-role filters", async () => {
  const connections = await listConnectionsMetadata(client.db, scope.workspaceId, null);
  const active = connections.find(
    (connection) => connection.metadata.credentialRole === "anthropic",
  )!;
  const invalid = [
    { ...active, subjectId: actor },
    { ...active, status: "revoked" as const },
    { ...active, kind: "oauth2" as const },
    { ...active, providerDomain: "provider.example.test" },
    { ...active, metadata: { credentialRole: "claude_subscription" } },
  ];
  expect(workspaceProviderApiKeyConnectionMetadataFromConnections(invalid, "anthropic")).toBeNull();
  const older = { ...active, id: crypto.randomUUID(), version: active.version + 1 };
  expect(
    workspaceProviderApiKeyConnectionMetadataFromConnections(
      [...invalid, active, older],
      "anthropic",
    ),
  ).toEqual({
    connectionId: active.id,
    version: active.version,
  });
});

test("a new request sees revoked connections and retired models", async () => {
  await shared!.admin`
    update organization_model_provider_connections set status = 'revoked'
    where account_id = ${scope.accountId} and provider_kind = 'openrouter'`;
  await shared!.admin`
    update workspace_gateway_custom_models set retired_at = now()
    where workspace_id = ${scope.workspaceId} and provider_kind = 'openrouter'`;
  const organization = await getOrganizationModelProviderCatalogForWorkspace(client.db, {
    ...scope,
    providerKinds,
  });
  const workspace = await listWorkspaceProviderCustomModelsByKind(client.db, {
    ...scope,
    providerKinds,
  });
  expect(organization.openrouter.active).toBe(false);
  expect(workspace.openrouter).toEqual([]);
  expect(workspace.anthropic).toHaveLength(2);
});

test("the limit belongs to each provider, including an overflowing later provider", async () => {
  for (const providerKind of providerKinds) {
    await shared!.admin`
      insert into workspace_gateway_custom_models
        (account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
         create_request_hash, created_by_subject_id)
      select ${scope.accountId}, ${siblingId}, ${providerKind}, 'bounded-' || n,
        gen_random_uuid(), ${hash}, ${actor} from generate_series(1, 100) n`;
  }
  const input = { accountId: scope.accountId, workspaceId: siblingId, providerKinds };
  const workspace = await listWorkspaceProviderCustomModelsByKind(client.db, input);
  for (const providerKind of providerKinds) {
    expect(workspace[providerKind]).toHaveLength(100);
    expect(workspace[providerKind]).toEqual(
      await listWorkspaceProviderCustomModels(client.db, { ...input, providerKind }),
    );
  }
  await shared!.admin`
    insert into workspace_gateway_custom_models
      (account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
       create_request_hash, created_by_subject_id)
    values (${scope.accountId}, ${siblingId}, 'claude_subscription', 'overflow-fixture',
      ${crypto.randomUUID()}, ${hash}, ${actor})`;
  await expect(listWorkspaceProviderCustomModelsByKind(client.db, input)).rejects.toThrow(
    "Workspace Claude custom model limit reached",
  );
  await expect(
    listWorkspaceProviderCustomModels(client.db, { ...input, providerKind: "claude_subscription" }),
  ).rejects.toThrow("Workspace Claude custom model limit reached");
});
