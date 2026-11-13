import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  configuredModelListPricingSchedules,
  defaultModelPricing,
  environmentsEncryptionKeyBytes,
  ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX,
  type Settings,
} from "@opengeni/config";
import {
  bootstrapWorkspace,
  checkWorkspaceAllowance,
  createConnection,
  createDb,
  createSession,
  encryptEnvironmentValue,
  getWorkspaceUsage,
  initializeSessionStartAtomically,
  listOrganizationModelProviderCustomModels,
  recordModelCallFact,
  setOrganizationModelProviderCustomModelListPrice,
  setWorkspaceAllowance,
  setWorkspaceModelKeyListPrice,
  upsertOrganizationModelProviderConnection,
  type DbClient,
} from "@opengeni/db";
import { directModelConnectionSpec } from "@opengeni/contracts";
import { normalizeModelCallUsage } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";

import { settleModelUsage } from "../src/billing/model-usage-settlement";
import { settingsWithModelProviderCredentials } from "../src/model-provider-credentials";

// An organization's Azure OpenAI deployment reports no cost of its own. Its
// stored price (the base model Azure reported, or the administrator's own
// rate) prices every call it serves, so the call is recorded with a cost
// estimate and a workspace spend limit counting usage paid outside Opengeni
// credits trips on it. Without a price the cost stays unknown, never $0.

setDefaultTimeout(60_000);
const settings = testSettings({
  billingMode: "stripe",
  usageLimitsMode: "none",
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
}) as Settings;
const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
const BASE_RATE = defaultModelPricing["gpt-6-astra"]!.default;

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("connected-model-list-pricing");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

/** A workspace whose organization connects Azure OpenAI with one deployment. */
async function organizationWithDeployment(
  deployment: string,
  detected: { basis: "model"; modelId: string } | null,
) {
  const subjectId = `user:connected-pricing:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Connected pricing",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Connected pricing",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal') returning id`;
  await shared!.admin`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${grant.accountId}, ${subjectId}, 'owner', 'active', ${personal!.id})`;
  const actor = { organizationId: grant.accountId, actorSubjectId: subjectId };
  await upsertOrganizationModelProviderConnection(client.db, {
    ...actor,
    providerKind: "azure_openai",
    credentialEncrypted: encryptEnvironmentValue(
      environmentsEncryptionKeyBytes(settings)!,
      "azure-org-key",
    ),
    credentialDigest: `digest:${crypto.randomUUID()}`,
    endpoint: ENDPOINT,
    models: [deployment],
    ...(detected ? { modelListPrices: { [deployment]: detected } } : {}),
    operationId: crypto.randomUUID(),
  });
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "test",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    createdByContext: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const [turn] = await shared!.admin`
    select id from session_turns where session_id=${session.id} order by created_at limit 1`;
  return {
    actor,
    scope: { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId },
    sessionId: session.id,
    turnId: String(turn!.id),
    model: `${ORGANIZATION_AZURE_OPENAI_MODEL_ID_PREFIX}${deployment}`,
  };
}

/** Serve and record one 100k-input, 10k-output call, as a turn does. */
async function serveCall(
  fixture: Pick<
    Awaited<ReturnType<typeof organizationWithDeployment>>,
    "scope" | "sessionId" | "turnId" | "model"
  >,
) {
  const execution = await settingsWithModelProviderCredentials(client.db, {
    accountId: fixture.scope.accountId,
    workspaceId: fixture.scope.workspaceId,
    settings,
    productModelId: fixture.model,
    codexSubscriptionActive: false,
  });
  const sourceKey = `response-${crypto.randomUUID()}`;
  const billing = await settleModelUsage(execution, client.db, {
    accountId: fixture.scope.accountId,
    workspaceId: fixture.scope.workspaceId,
    model: fixture.model,
    chargesOpenGeniCredits: false,
    countsTowardTokenCap: false,
    normalizedUsage: normalizeModelCallUsage({
      inputTokens: 100_000,
      outputTokens: 10_000,
      totalTokens: 110_000,
    }),
    sourceId: sourceKey,
  });
  await recordModelCallFact(client.db, {
    accountId: fixture.scope.accountId,
    workspaceId: fixture.scope.workspaceId,
    sessionId: fixture.sessionId,
    turnId: fixture.turnId,
    sourceKey,
    provider: fixture.model.startsWith("workspace-")
      ? "workspace-azure-openai"
      : "organization-azure-openai",
    providerApi: "responses",
    model: fixture.model,
    billingPath: billing.billingPath,
    pricedCostMicros: billing.pricedCostMicros,
    estimatedProviderCostMicros: billing.estimatedProviderCostMicros,
    pricingSource: billing.pricingSource,
    inputTokens: 100_000,
    outputTokens: 10_000,
    totalTokens: 110_000,
  });
  return { billing, execution };
}

async function listPriceAllowance(
  fixture: Pick<Awaited<ReturnType<typeof organizationWithDeployment>>, "scope">,
  includedCredits: number,
) {
  await setWorkspaceAllowance(client.db, {
    ...fixture.scope,
    actorSubjectId: fixture.scope.subjectId,
    includedCredits,
    period: "monthly",
    unbilledUsage: "list_price",
    expectedVersion: 0,
  });
}

const exhausted = (
  fixture: Pick<Awaited<ReturnType<typeof organizationWithDeployment>>, "scope">,
) =>
  checkWorkspaceAllowance(client.db, {
    ...fixture.scope,
    fundedWithoutCredits: true,
  });

test("a deployment priced from its base model records its cost and trips the spend limit", async () => {
  if (!shared) return;
  const fixture = await organizationWithDeployment("prod-reasoning", {
    basis: "model",
    modelId: "gpt-6-astra",
  });
  const expected =
    BASE_RATE.inputMicrosPerMillionTokens / 10 + BASE_RATE.outputMicrosPerMillionTokens / 100;
  await listPriceAllowance(fixture, expected - 1);
  expect(await exhausted(fixture)).toBeNull();

  const { billing } = await serveCall(fixture);
  expect(billing).toMatchObject({
    billingPath: "external",
    pricedCostMicros: 0,
    pricingSource: "configured_list_price",
    estimatedProviderCostMicros: expected,
  });
  expect((await getWorkspaceUsage(client.db, fixture.scope)).workspace.used).toBe(expected);
  expect(await exhausted(fixture)).toMatchObject({
    code: "allowance_exhausted",
    scope: "workspace",
  });
});

test("an administrator's own price overrides the base model on the next call", async () => {
  if (!shared) return;
  const fixture = await organizationWithDeployment("prod-custom", {
    basis: "model",
    modelId: "gpt-6-astra",
  });
  const [deployment] = await listOrganizationModelProviderCustomModels(client.db, {
    ...fixture.actor,
    providerKind: "azure_openai",
  });
  expect(deployment).toMatchObject({ listPricingModelId: "gpt-6-astra", listPricing: null });
  const updated = await setOrganizationModelProviderCustomModelListPrice(client.db, {
    ...fixture.actor,
    providerKind: "azure_openai",
    customModelId: deployment!.id,
    expectedVersion: deployment!.version,
    price: {
      basis: "custom",
      pricing: { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 },
    },
  });
  expect(updated).toMatchObject({ listPricingModelId: null, version: deployment!.version + 1 });
  await listPriceAllowance(fixture, 280_000);
  const { billing } = await serveCall(fixture);
  expect(billing.estimatedProviderCostMicros).toBe(200_000 + 80_000);
  expect(await exhausted(fixture)).toMatchObject({ code: "allowance_exhausted" });
});

test("a deployment without a price is recorded as unknown, never $0, and can be priced later", async () => {
  if (!shared) return;
  const fixture = await organizationWithDeployment("prod-unknown", null);
  await listPriceAllowance(fixture, 1);
  const { billing, execution } = await serveCall(fixture);
  expect(configuredModelListPricingSchedules(execution)[fixture.model]).toBeUndefined();
  expect(billing).toMatchObject({ estimatedProviderCostMicros: null, pricingSource: null });
  const [fact] = await shared!.admin`
    select estimated_provider_cost_micros, pricing_source from model_call_facts
    where account_id = ${fixture.scope.accountId}::uuid`;
  expect(fact).toMatchObject({ estimated_provider_cost_micros: null, pricing_source: null });

  // Pricing it from its base model applies to the calls after it.
  const [deployment] = await listOrganizationModelProviderCustomModels(client.db, {
    ...fixture.actor,
    providerKind: "azure_openai",
  });
  await setOrganizationModelProviderCustomModelListPrice(client.db, {
    ...fixture.actor,
    providerKind: "azure_openai",
    customModelId: deployment!.id,
    expectedVersion: deployment!.version,
    price: { basis: "model", modelId: "gpt-6-astra" },
  });
  expect((await serveCall(fixture)).billing.pricingSource).toBe("configured_list_price");
  expect(await exhausted(fixture)).toMatchObject({ code: "allowance_exhausted" });
});

/** The same workspace with its own Azure OpenAI key for one deployment. */
async function workspaceWithModelKey(deployment: string) {
  const fixture = await organizationWithDeployment(`org-${deployment}`, null);
  const connection = await createConnection(client.db, {
    accountId: fixture.scope.accountId,
    workspaceId: fixture.scope.workspaceId,
    subjectId: null,
    providerDomain: "contoso.openai.azure.com",
    kind: "api_key",
    createdBySubjectId: fixture.scope.subjectId,
    credentialEncrypted: encryptEnvironmentValue(
      environmentsEncryptionKeyBytes(settings)!,
      JSON.stringify({ apiKey: "azure-workspace-key" }),
    ),
    metadata: {
      credentialRole: "direct_azure_openai",
      directModelProvider: { provider: "azure_openai", model: deployment, endpoint: ENDPOINT },
    },
  });
  const model = directModelConnectionSpec(connection)!.modelId;
  const setPrice = (price: Parameters<typeof setWorkspaceModelKeyListPrice>[1]["price"]) =>
    setWorkspaceModelKeyListPrice(client.db, {
      accountId: fixture.scope.accountId,
      workspaceId: fixture.scope.workspaceId,
      connectionId: connection.id,
      actorSubjectId: fixture.scope.subjectId,
      price,
    });
  return { ...fixture, model, connection, setPrice };
}

test("a workspace's own Azure key is priced the same way, without changing its model's id", async () => {
  if (!shared) return;
  const fixture = await workspaceWithModelKey("team-reasoning");
  await listPriceAllowance(fixture, 1);
  const unknown = await serveCall(fixture);
  expect(unknown.billing).toMatchObject({ estimatedProviderCostMicros: null, pricingSource: null });
  expect(await exhausted(fixture)).toBeNull();

  const priced = await fixture.setPrice({ basis: "model", modelId: "gpt-6-astra" });
  expect(priced).toMatchObject({
    version: fixture.connection.version,
    listPrice: { basis: "model", modelId: "gpt-6-astra" },
  });
  expect(directModelConnectionSpec(priced!)!.modelId).toBe(fixture.model);
  const expected =
    BASE_RATE.inputMicrosPerMillionTokens / 10 + BASE_RATE.outputMicrosPerMillionTokens / 100;
  const { billing } = await serveCall(fixture);
  expect(billing).toMatchObject({
    billingPath: "external",
    pricingSource: "configured_list_price",
    estimatedProviderCostMicros: expected,
  });
  expect(await exhausted(fixture)).toMatchObject({ code: "allowance_exhausted" });

  // An explicit rate overrides the base model; clearing it is unknown again.
  await fixture.setPrice({
    basis: "custom",
    pricing: { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 },
  });
  expect((await serveCall(fixture)).billing.estimatedProviderCostMicros).toBe(280_000);
  expect(await fixture.setPrice(null)).toMatchObject({ listPrice: null });
  expect((await serveCall(fixture)).billing.estimatedProviderCostMicros).toBeNull();
});

test("only a workspace's own model key can carry a price", async () => {
  if (!shared) return;
  const fixture = await workspaceWithModelKey("team-other");
  const other = await createConnection(client.db, {
    accountId: fixture.scope.accountId,
    workspaceId: fixture.scope.workspaceId,
    subjectId: null,
    providerDomain: "api.example.com",
    kind: "api_key",
    createdBySubjectId: fixture.scope.subjectId,
    credentialEncrypted: "fixture-ciphertext-not-a-key",
    metadata: {},
  });
  expect(
    await setWorkspaceModelKeyListPrice(client.db, {
      accountId: fixture.scope.accountId,
      workspaceId: fixture.scope.workspaceId,
      connectionId: other.id,
      actorSubjectId: fixture.scope.subjectId,
      price: { basis: "model", modelId: "gpt-6-astra" },
    }),
  ).toBeNull();
  await expect(
    shared!
      .admin`update connections set price_basis_model_id = 'gpt-6-astra' where id = ${other.id}::uuid`,
  ).rejects.toThrow(/connections_list_price_chk/);
});
