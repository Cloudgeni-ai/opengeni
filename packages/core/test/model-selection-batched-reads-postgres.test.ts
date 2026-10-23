import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { sql } from "drizzle-orm";
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
  getWorkspaceConnectionModelRestrictions,
  listConnectionsMetadata,
  loadWorkspaceModelCatalogInputs,
  getOrganizationModelProviderCatalogForWorkspace,
  listWorkspaceProviderCustomModelsByKind,
  listOrganizationModelProviderCustomModelsForWorkspace,
  listWorkspaceProviderCustomModels,
  organizationModelProviderConnectionActiveForWorkspace,
  withDatabaseTimingObserver,
  withWorkspaceSubjectRls,
  workspaceProviderApiKeyConnectionSpec,
  type DbClient,
  type WorkspaceCustomModelProviderKind,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
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
const directQueries: string[] = [];
let capturedStatements: string[] | null = null;
let directModelIds: string[];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("model-selection-batched-reads");
  if (!shared) throw new Error("model selection batched reads require PostgreSQL");
  client = createDb(shared.appUrl);
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  driver.options.debug = (_id, query) => {
    capturedStatements?.push(query);
    if (query.includes('from "connections"') && query.includes("direct_azure_openai")) {
      directQueries.push(query);
    }
  };
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
  const direct = async (
    target: typeof scope,
    overrides: Partial<Parameters<typeof createConnection>[1]> = {},
  ) =>
    await createConnection(client.db, {
      ...target,
      subjectId: null,
      providerDomain: "api.openai.com",
      kind: "api_key",
      credentialEncrypted: "fixture-ciphertext-not-a-key",
      metadata: {
        credentialRole: "direct_openai",
        directModelProvider: { provider: "openai", model: "fixture-openai" },
      },
      createdBySubjectId: actor,
      ...overrides,
    });
  const openai = await direct(scope);
  const azure = await direct(scope, {
    providerDomain: "fixture.openai.azure.com",
    metadata: {
      credentialRole: "direct_azure_openai",
      directModelProvider: {
        provider: "azure_openai",
        model: "fixture-azure",
        endpoint: "https://fixture.openai.azure.com",
      },
    },
  });
  directModelIds = [
    `workspace-openai-${openai.id}/${openai.version}/fixture-openai`,
    `workspace-azure-openai-${azure.id}/${azure.version}/fixture-azure`,
  ].sort();
  await direct(otherScope);
  await direct(scope, { subjectId: actor });
  await direct(scope, { status: "revoked" });
  await direct(scope, { kind: "oauth2" });
  await direct(scope, { providerDomain: "wrong.example" });
  await direct(scope, {
    metadata: {
      credentialRole: "openrouter",
      directModelProvider: { provider: "openai", model: "wrong-role" },
    },
  });
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

test("the loader reads the catalog families in one transaction instead of fourteen", async () => {
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
  // 13 non-catalog reads (restrictions, readiness, policy, Codex), one Claude
  // route receipt read, and one public catalog read. Claude shares one
  // readiness projection with the restriction loader rather than rereading
  // its route there. The per-provider loader took 13 + 14 = 27.
  expect(batched).toBeLessThanOrEqual(15);
});

test("the public catalog keeps existing readers and filters in one scope with no credentials", async () => {
  const input = {
    ...scope,
    providerKinds,
    organizationProviderKinds: [...providerKinds, "openai", "azure_openai"] as const,
  };
  const [original, originalTransactions] = await transactionsDuring(async () => ({
    workspaceConnections: await listConnectionsMetadata(client.db, scope.workspaceId, null),
    workspaceCustomModels: await listWorkspaceProviderCustomModelsByKind(client.db, input),
    organizationProviders: await getOrganizationModelProviderCatalogForWorkspace(client.db, {
      ...input,
      providerKinds: [...providerKinds, "openai", "azure_openai"],
    }),
  }));
  const [batched, batchedTransactions] = await transactionsDuring(() =>
    loadWorkspaceModelCatalogInputs(client.db, input),
  );
  expect(originalTransactions).toBe(3);
  expect(batchedTransactions).toBe(1);
  expect(batched).toEqual(original);
  expect(JSON.stringify(batched)).not.toContain("fixture-ciphertext-not-a-key");
  expect(batched.workspaceConnections.every((row) => row.subjectId === null)).toBe(true);
  expect(batched.workspaceConnections.every((row) => row.workspaceId === scope.workspaceId)).toBe(
    true,
  );

  // A later request reads the committed change: this is scoped batching, not a cache.
  await shared!.admin`
    update organization_model_provider_custom_models set label = 'Fresh batch label'
    where account_id = ${scope.accountId} and provider_kind = 'openrouter'
      and upstream_model_id = 'fixture/openrouter-org'`;
  const fresh = await loadWorkspaceModelCatalogInputs(client.db, input);
  expect(fresh.organizationProviders.openrouter.models[0]!.label).toBe("Fresh batch label");
  expect(batched.organizationProviders.openrouter.models[0]!.label).not.toBe("Fresh batch label");
});

test("a later catalog invocation observes provider revocation and model retirement", async () => {
  const input = {
    ...scope,
    providerKinds,
    organizationProviderKinds: [...providerKinds, "openai", "azure_openai"] as const,
  };
  const previous = await loadWorkspaceModelCatalogInputs(client.db, input);
  expect(previous.organizationProviders.openrouter.active).toBe(true);
  expect(previous.organizationProviders.openrouter.models).toHaveLength(1);
  try {
    await shared!.admin`
      update organization_model_provider_connections set status = 'revoked'
      where account_id = ${scope.accountId} and provider_kind = 'openrouter'`;
    await shared!.admin`
      update organization_model_provider_custom_models set retired_at = now()
      where account_id = ${scope.accountId} and provider_kind = 'openrouter'
        and upstream_model_id = 'fixture/openrouter-org'`;
    const next = await loadWorkspaceModelCatalogInputs(client.db, input);
    expect(next.organizationProviders.openrouter.active).toBe(false);
    expect(next.organizationProviders.openrouter.models).toEqual([]);
    expect(previous.organizationProviders.openrouter.active).toBe(true);
    expect(previous.organizationProviders.openrouter.models).toHaveLength(1);
  } finally {
    await shared!.admin`
      update organization_model_provider_connections set status = 'active'
      where account_id = ${scope.accountId} and provider_kind = 'openrouter'`;
    await shared!.admin`
      update organization_model_provider_custom_models set retired_at = null
      where account_id = ${scope.accountId} and provider_kind = 'openrouter'
        and upstream_model_id = 'fixture/openrouter-org'`;
  }
});

test("nested catalog reads restore the enclosing account, workspace and subject", async () => {
  await withWorkspaceSubjectRls(client.db, otherScope.workspaceId, actor, async (tx) => {
    const readScopeSettings = () =>
      tx.execute(sql`select
      current_setting('opengeni.account_id', true) as account_id,
      current_setting('opengeni.workspace_id', true) as workspace_id,
      current_setting('opengeni.subject_id', true) as subject_id`);
    const before = await readScopeSettings();
    const catalog = await loadWorkspaceModelCatalogInputs(tx, {
      ...scope,
      providerKinds,
      organizationProviderKinds: [...providerKinds, "openai", "azure_openai"],
    });
    expect(catalog.workspaceConnections.length).toBeGreaterThan(0);
    expect(
      catalog.workspaceConnections.every(
        (row) =>
          row.accountId === scope.accountId &&
          row.workspaceId === scope.workspaceId &&
          row.subjectId === null,
      ),
    ).toBe(true);
    expect(await readScopeSettings()).toEqual(before);
    expect(before[0]).toEqual({
      account_id: otherScope.accountId,
      workspace_id: otherScope.workspaceId,
      subject_id: actor,
    });
  });
});

test("public catalog scope cost compared with the previous parallel family reads", async () => {
  if (process.env.OPENGENI_BENCH_CATALOG_SCOPE !== "1") return;
  const input = {
    ...scope,
    providerKinds,
    organizationProviderKinds: [...providerKinds, "openai", "azure_openai"] as const,
  };
  const original = async () => {
    const [workspaceConnections, workspaceCustomModels, organizationProviders] = await Promise.all([
      listConnectionsMetadata(client.db, scope.workspaceId, null),
      listWorkspaceProviderCustomModelsByKind(client.db, input),
      getOrganizationModelProviderCatalogForWorkspace(client.db, {
        ...input,
        providerKinds: [...providerKinds, "openai", "azure_openai"],
      }),
    ]);
    return { workspaceConnections, workspaceCustomModels, organizationProviders };
  };
  const readers = { original, batched: () => loadWorkspaceModelCatalogInputs(client.db, input) };
  const samples: Record<string, { ms: number; cpuMs: number; statements: number }[]> = {
    original: [],
    batched: [],
  };
  const expected = await original();
  for (let round = -5; round < 40; round++) {
    const order =
      round % 2 === 0 ? (["original", "batched"] as const) : (["batched", "original"] as const);
    for (const kind of order) {
      capturedStatements = [];
      const cpu = process.cpuUsage();
      const started = performance.now();
      const value = await readers[kind]();
      const ms = performance.now() - started;
      const used = process.cpuUsage(cpu);
      const statements = capturedStatements.length;
      capturedStatements = null;
      expect(value).toEqual(expected);
      if (round >= 0)
        samples[kind]!.push({ ms, cpuMs: (used.user + used.system) / 1000, statements });
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log(
    JSON.stringify({
      catalogScopeBenchmark: Object.fromEntries(
        Object.entries(samples).map(([kind, rows]) => [
          kind,
          {
            samples: rows.length,
            medianMs: median(rows.map((row) => row.ms)),
            medianCpuMs: median(rows.map((row) => row.cpuMs)),
            statements: [...new Set(rows.map((row) => row.statements))],
          },
        ]),
      ),
    }),
  );
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
  // Deployment-default (code) catalog: all three public metadata families
  // share one scope, independent of provider discovery.
  expect(activeTransactions).toBe(1);

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

test("repeated session models read each retained Claude model only once per response", async () => {
  const models = CLAUDE_CONNECTION_KINDS.flatMap((kind) => [
    `${claudeProviderId(kind)}/fixture/${kind}-org-retired`,
    `${claudeProviderId(kind, "workspace")}/fixture/${kind}-retired`,
  ]);
  const [single, singleTransactions] = await transactionsDuring(() =>
    resolveWorkspaceCatalogSettings(client.db, settings, {
      ...scope,
      retainedProductModelIds: models,
    }),
  );
  const started = performance.now();
  capturedStatements = [];
  const [repeated, repeatedTransactions] = await transactionsDuring(() =>
    resolveWorkspaceCatalogSettings(client.db, settings, {
      ...scope,
      // A response page can contain many sessions using the same model.
      // The singular compatibility field must not add another read either.
      retainedProductModelIds: Array.from(
        { length: 50 },
        (_, index) => models[index % models.length],
      ),
      retainedProductModelId: models[0],
    }),
  );
  const statements = capturedStatements;
  capturedStatements = null;
  const retainedReads = statements.filter(
    (query) =>
      /from "(?:organization_model_provider_custom_models|workspace_gateway_custom_models)"/.test(
        query,
      ) &&
      query.includes('"upstream_model_id" =') &&
      query.includes("limit"),
  );
  console.log(
    JSON.stringify({
      retainedModelBudget: {
        singleTransactions,
        repeatedTransactions,
        statements: statements.length,
        retainedReads: retainedReads.length,
        elapsedMs: performance.now() - started,
      },
    }),
  );
  expect(JSON.stringify(repeated)).toBe(JSON.stringify(single));
  expect(singleTransactions).toBe(1 + models.length);
  expect(repeatedTransactions).toBe(singleTransactions);
  expect(retainedReads).toHaveLength(models.length);

  // This is input normalization, not a catalog cache. A later request must
  // observe a retained model's updated metadata through the ordinary read.
  await shared!.admin`
    update organization_model_provider_custom_models set label = 'Updated retained model'
    where account_id = ${scope.accountId} and provider_kind = 'anthropic'
      and upstream_model_id = 'fixture/anthropic-org-retired'`;
  const updated = await resolveWorkspaceCatalogSettings(client.db, settings, {
    ...scope,
    retainedProductModelIds: [models[0], models[0]],
  });
  expect(configuredModels(updated.settings).find((model) => model.id === models[0])?.label).toBe(
    "Updated retained model",
  );
});

const directRestrictions = (restrictions: Record<string, string[] | null>) =>
  Object.entries(restrictions)
    .filter(([prefix]) => /^workspace-(?:openai|azure-openai)-/.test(prefix))
    .flatMap(([, models]) => models ?? [])
    .sort();

test("model selection reuses public metadata instead of reading the direct-provider subset again", async () => {
  directQueries.length = 0;
  const loaded = await loadWorkspaceModelSelectionInput(
    client.db,
    settings,
    {
      ...scope,
      subjectId: actor,
    },
    { observeAvailability: false },
  );
  expect(directRestrictions(loaded.connectionModelRestrictions!)).toEqual(directModelIds);
  expect(directQueries).toHaveLength(0);
});

test("request-local metadata equals the scoped direct read and never includes personal or foreign connections", async () => {
  directQueries.length = 0;
  const [original, originalTransactions] = await transactionsDuring(() =>
    getWorkspaceConnectionModelRestrictions(client.db, scope.workspaceId, actor),
  );
  expect(directQueries).toHaveLength(1);
  expect(directRestrictions(original)).toEqual(directModelIds);
  // The production caller passes public rows only. Deliberately include own
  // private metadata and another workspace here to pin the projection fence.
  const metadata = [
    ...(await listConnectionsMetadata(client.db, scope.workspaceId, actor)),
    ...(await listConnectionsMetadata(client.db, otherScope.workspaceId, null)),
  ];
  directQueries.length = 0;
  const [reused, reusedTransactions] = await transactionsDuring(() =>
    getWorkspaceConnectionModelRestrictions(
      client.db,
      scope.workspaceId,
      actor,
      undefined,
      undefined,
      Promise.resolve(metadata),
    ),
  );
  expect(originalTransactions - reusedTransactions).toBe(1);
  expect(reused).toEqual(original);
  expect(directQueries).toHaveLength(0);
});

test("an empty snapshot is authoritative while an unavailable snapshot retains the standalone read", async () => {
  directQueries.length = 0;
  const empty = await getWorkspaceConnectionModelRestrictions(
    client.db,
    scope.workspaceId,
    actor,
    undefined,
    undefined,
    Promise.resolve([]),
  );
  expect(directRestrictions(empty)).toEqual([]);
  expect(directQueries).toHaveLength(0);
  const fallback = await getWorkspaceConnectionModelRestrictions(
    client.db,
    scope.workspaceId,
    actor,
    undefined,
    undefined,
    Promise.reject(new Error("metadata read unavailable")),
  );
  expect(directRestrictions(fallback)).toEqual(directModelIds);
  expect(directQueries).toHaveLength(1);
});
