import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  CLAUDE_CONNECTION_KINDS,
  claudeProviderId,
  configuredModels,
  ORGANIZATION_GATEWAY_MODEL_ID_PREFIX,
  ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  WORKSPACE_OPENROUTER_MODEL_ID_PREFIX,
} from "@opengeni/config";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  getWorkspaceProviderApiKeyConnectionMetadata,
  listOrganizationModelProviderCustomModelsForWorkspace,
  listWorkspaceProviderCustomModels,
  organizationModelProviderConnectionActiveForWorkspace,
  withDatabaseTimingObserver,
  workspaceProviderApiKeyConnectionSpec,
  type DbClient,
  type WorkspaceCustomModelProviderKind,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { loadWorkspaceModelSelectionInput } from "../src/default-session-model";
import { resolveWorkspaceCatalogSettings } from "../src/model-catalog";

// Real-PostgreSQL proof that the session-create model readers use the batched
// catalog-family readers without changing what they return: every provider's
// active/retired filter, workspace/organization scope and readiness must equal
// the per-provider readers they replaced.

const providerKinds: WorkspaceCustomModelProviderKind[] = [
  "vercel_gateway",
  "openrouter",
  "anthropic",
  "claude_subscription",
];
const actor = "user:model-selection-batched-reads";
const hash = "b".repeat(64);
const settings = testSettings({ claudeSubscriptionEnabled: true });
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let scope: { accountId: string; workspaceId: string };
let otherScope: typeof scope;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("model-selection-batched-reads");
  if (!shared) throw new Error("model selection batched reads require PostgreSQL");
  client = createDb(shared.appUrl);
  const bootstrap = async (suffix: string) => {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: `Batched catalog ${suffix}`,
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: `Batched catalog ${suffix}`,
      subjectId: actor,
    });
    const grant = access.workspaceGrants[0]!;
    return { accountId: grant.accountId, workspaceId: grant.workspaceId };
  };
  scope = await bootstrap("one");
  otherScope = await bootstrap("two");
  for (const target of [scope, otherScope]) {
    for (const providerKind of providerKinds) {
      // Readiness differs by provider so a crossed provider slot is visible:
      // only the gateway and Anthropic have workspace API keys, and only the
      // gateway and OpenRouter have an active organization connection.
      if (providerKind === "vercel_gateway" || providerKind === "anthropic") {
        const spec = workspaceProviderApiKeyConnectionSpec(providerKind);
        await createConnection(client.db, {
          ...target,
          subjectId: null,
          providerDomain: spec.providerDomain,
          kind: "api_key",
          credentialEncrypted: "fixture-ciphertext-not-a-key",
          metadata: { credentialRole: spec.credentialRole },
          createdBySubjectId: actor,
        });
      }
      if (providerKind === "vercel_gateway" || providerKind === "openrouter") {
        await shared.admin`
          insert into organization_model_provider_connections
            (account_id, provider_kind, credential_encrypted, operation_id, request_hash,
             updated_by_subject_id, allowed_workspace_ids, allow_personal_workspaces)
          values (${target.accountId}, ${providerKind}, 'fixture-ciphertext-not-a-key',
            ${crypto.randomUUID()}, ${hash}, ${actor}, array[${target.workspaceId}::uuid], false)`;
      }
      for (const [upstream, retired] of [
        [`fixture/${providerKind}-org`, false],
        [`fixture/${providerKind}-org-retired`, true],
      ] as const) {
        await shared.admin`
          insert into organization_model_provider_custom_models
            (account_id, provider_kind, upstream_model_id, create_operation_id,
             create_request_hash, created_by_subject_id, retired_at)
          values (${target.accountId}, ${providerKind}, ${upstream}, ${crypto.randomUUID()},
            ${hash}, ${actor}, ${retired ? new Date() : null})`;
      }
      for (const [upstream, retired] of [
        [`fixture/${providerKind}-b`, false],
        [`fixture/${providerKind}-a`, false],
        [`fixture/${providerKind}-retired`, true],
      ] as const) {
        await shared.admin`
          insert into workspace_gateway_custom_models
            (account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
             create_request_hash, created_by_subject_id, created_at, retired_at)
          values (${target.accountId}, ${target.workspaceId}, ${providerKind}, ${upstream},
            ${crypto.randomUUID()}, ${hash}, ${actor}, '2026-01-01',
            ${retired ? new Date() : null})`;
      }
    }
  }
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const sortById = <T extends { id: string }>(rows: readonly T[]) =>
  [...rows].sort((left, right) => left.id.localeCompare(right.id));

async function transactionsDuring<T>(work: () => Promise<T>): Promise<[T, number]> {
  let transactions = 0;
  const value = await withDatabaseTimingObserver((event) => {
    if (event.stage === "transaction_admission") transactions++;
  }, work);
  return [value, transactions];
}

test("model admission input equals the per-provider readers it replaced", async () => {
  const context = { ...scope, subjectId: actor };
  const loaded = await loadWorkspaceModelSelectionInput(client.db, settings, context, {
    observeAvailability: false,
  });
  const orgActive = async (providerKind: "vercel_gateway" | "openrouter" | "anthropic") =>
    await organizationModelProviderConnectionActiveForWorkspace(client.db, {
      ...scope,
      providerKind,
    });
  const orgModels = async (providerKind: WorkspaceCustomModelProviderKind) =>
    sortById(
      await listOrganizationModelProviderCustomModelsForWorkspace(client.db, {
        ...scope,
        providerKind,
      }),
    );
  const workspaceModels = async (providerKind: WorkspaceCustomModelProviderKind) =>
    await listWorkspaceProviderCustomModels(client.db, { ...scope, providerKind });
  const workspaceActive = async (providerKind: "vercel_gateway" | "openrouter" | "anthropic") =>
    (await getWorkspaceProviderApiKeyConnectionMetadata(
      client.db,
      scope.workspaceId,
      providerKind,
    )) !== null;

  expect(loaded.workspaceGatewayConnectionActive).toBe(true);
  expect(loaded.workspaceGatewayConnectionActive).toBe(await workspaceActive("vercel_gateway"));
  expect(loaded.workspaceOpenRouterConnectionActive).toBe(false);
  expect(loaded.workspaceOpenRouterConnectionActive).toBe(await workspaceActive("openrouter"));
  expect(loaded.workspaceGatewayCustomModels).toEqual(await workspaceModels("vercel_gateway"));
  expect(loaded.workspaceOpenRouterCustomModels).toEqual(await workspaceModels("openrouter"));
  expect(loaded.organizationGatewayConnectionActive).toBe(true);
  expect(loaded.organizationGatewayConnectionActive).toBe(await orgActive("vercel_gateway"));
  expect(loaded.organizationOpenRouterConnectionActive).toBe(await orgActive("openrouter"));
  expect(sortById(loaded.organizationGatewayCustomModels as never)).toEqual(
    await orgModels("vercel_gateway"),
  );
  expect(sortById(loaded.organizationOpenRouterCustomModels as never)).toEqual(
    await orgModels("openrouter"),
  );
  for (const kind of CLAUDE_CONNECTION_KINDS) {
    expect(sortById(loaded.claudeConnections![kind]!.models as never)).toEqual(
      await orgModels(kind),
    );
    expect(loaded.workspaceClaudeConnections![kind]!.models).toEqual(await workspaceModels(kind));
  }
  expect(loaded.claudeConnections!.anthropic!.active).toBe(await orgActive("anthropic"));
  expect(loaded.workspaceClaudeConnections!.anthropic!.active).toBe(true);
  expect(loaded.workspaceClaudeConnections!.anthropic!.active).toBe(
    await workspaceActive("anthropic"),
  );
  // Retired rows and the other organization's rows never enter the catalog.
  const allModels = [
    ...(loaded.workspaceGatewayCustomModels ?? []),
    ...(loaded.workspaceOpenRouterCustomModels ?? []),
    ...(loaded.organizationGatewayCustomModels ?? []),
    ...(loaded.organizationOpenRouterCustomModels ?? []),
    ...Object.values(loaded.claudeConnections ?? {}).flatMap((entry) => entry?.models ?? []),
    ...Object.values(loaded.workspaceClaudeConnections ?? {}).flatMap(
      (entry) => entry?.models ?? [],
    ),
  ] as { upstreamModelId: string; accountId: string }[];
  expect(allModels.length).toBe(4 * 2 + 4);
  expect(allModels.every((model) => !model.upstreamModelId.includes("retired"))).toBe(true);
  expect(allModels.every((model) => model.accountId === scope.accountId)).toBe(true);
});

test("a disabled Claude subscription still omits only its catalog entry", async () => {
  const loaded = await loadWorkspaceModelSelectionInput(
    client.db,
    { ...settings, claudeSubscriptionEnabled: false },
    { ...scope, subjectId: actor },
    { observeAvailability: false },
  );
  expect(loaded.claudeConnections).not.toHaveProperty("claude_subscription");
  expect(loaded.workspaceClaudeConnections).not.toHaveProperty("claude_subscription");
  expect(loaded.claudeConnections?.anthropic?.models).toHaveLength(1);
});

test("the loader reads the catalog families in three transactions instead of fourteen", async () => {
  const context = { ...scope, subjectId: actor };
  const [, batched] = await transactionsDuring(() =>
    loadWorkspaceModelSelectionInput(client.db, settings, context, {
      observeAvailability: false,
    }),
  );
  // The replaced per-provider readers: three organization readiness reads,
  // four organization model lists, three workspace API-key metadata reads
  // and four workspace model lists, one scoped transaction each.
  const [, perProvider] = await transactionsDuring(() =>
    Promise.all([
      ...(["vercel_gateway", "openrouter", "anthropic"] as const).flatMap((providerKind) => [
        organizationModelProviderConnectionActiveForWorkspace(client.db, {
          ...scope,
          providerKind,
        }),
        getWorkspaceProviderApiKeyConnectionMetadata(client.db, scope.workspaceId, providerKind),
      ]),
      ...providerKinds.flatMap((providerKind) => [
        listOrganizationModelProviderCustomModelsForWorkspace(client.db, {
          ...scope,
          providerKind,
        }),
        listWorkspaceProviderCustomModels(client.db, { ...scope, providerKind }),
      ]),
    ]),
  );
  expect(perProvider).toBe(14);
  // 13 non-catalog reads (restrictions, readiness, policy, Codex) plus the
  // three catalog-family reads. The per-provider loader took 13 + 14 = 27.
  expect(batched).toBeLessThanOrEqual(16);
});

test("workspace catalog settings expose the same active and retained custom models", async () => {
  const workspaceGateway = `${WORKSPACE_GATEWAY_MODEL_ID_PREFIX}fixture/vercel_gateway-a`;
  const workspaceOpenRouter = `${WORKSPACE_OPENROUTER_MODEL_ID_PREFIX}fixture/openrouter-b`;
  const organizationGateway = `${ORGANIZATION_GATEWAY_MODEL_ID_PREFIX}fixture/vercel_gateway-org`;
  const organizationOpenRouter = `${ORGANIZATION_OPENROUTER_MODEL_ID_PREFIX}fixture/openrouter-org`;
  const claudeIds = CLAUDE_CONNECTION_KINDS.flatMap((kind) => [
    `${claudeProviderId(kind)}/fixture/${kind}-org`,
    `${claudeProviderId(kind, "workspace")}/fixture/${kind}-a`,
  ]);
  const retainedWorkspaceGateway = `${WORKSPACE_GATEWAY_MODEL_ID_PREFIX}fixture/vercel_gateway-retired`;
  const retainedOrganizationAnthropic = `${claudeProviderId("anthropic")}/fixture/anthropic-org-retired`;
  const retainedWorkspaceAnthropic = `${claudeProviderId("anthropic", "workspace")}/fixture/anthropic-retired`;

  const [active, activeTransactions] = await transactionsDuring(() =>
    resolveWorkspaceCatalogSettings(client.db, settings, scope),
  );
  const activeIds = new Set(configuredModels(active.settings).map((model) => model.id));
  for (const id of [
    workspaceGateway,
    workspaceOpenRouter,
    organizationGateway,
    organizationOpenRouter,
    ...claudeIds,
  ])
    expect(activeIds.has(id)).toBe(true);
  for (const id of [
    retainedWorkspaceGateway,
    retainedOrganizationAnthropic,
    retainedWorkspaceAnthropic,
  ])
    expect(activeIds.has(id)).toBe(false);
  // Deployment-default (code) catalog: workspace custom models, organization
  // catalog and workspace connection metadata — one transaction per family.
  expect(activeTransactions).toBe(3);

  const retained = await resolveWorkspaceCatalogSettings(client.db, settings, {
    ...scope,
    retainedProductModelIds: [
      retainedWorkspaceGateway,
      retainedOrganizationAnthropic,
      retainedWorkspaceAnthropic,
    ],
  });
  const retainedIds = new Set(configuredModels(retained.settings).map((model) => model.id));
  for (const id of [
    retainedWorkspaceGateway,
    retainedOrganizationAnthropic,
    retainedWorkspaceAnthropic,
    workspaceGateway,
    ...claudeIds,
  ])
    expect(retainedIds.has(id)).toBe(true);

  const other = await resolveWorkspaceCatalogSettings(client.db, settings, otherScope);
  const otherIds = configuredModels(other.settings).map((model) => model.id);
  // Same upstream ids exist in the other organization, but only its own rows
  // are visible; the scope never crosses.
  expect(otherIds).toContain(workspaceGateway);
  const disabled = await resolveWorkspaceCatalogSettings(
    client.db,
    { ...settings, claudeSubscriptionEnabled: false },
    scope,
  );
  const disabledIds = new Set(configuredModels(disabled.settings).map((model) => model.id));
  expect(
    disabledIds.has(
      `${claudeProviderId("claude_subscription", "workspace")}/fixture/claude_subscription-a`,
    ),
  ).toBe(false);
});
