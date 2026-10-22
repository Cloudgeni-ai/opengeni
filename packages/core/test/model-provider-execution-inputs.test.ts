import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { claudeProviderId, withDirectModelProviders } from "@opengeni/config";
import { directModelConnectionSpec } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  encryptEnvironmentValue,
  loadDirectModelProviderConnection,
  loadModelProviderExecutionInputs,
  loadOrganizationModelProviderApiKey,
  workspaceProviderApiKeyConnectionSpec,
  withDatabaseTimingObserver,
  type DbClient,
  type WorkspaceCustomModelProviderKind,
} from "@opengeni/db";
import {
  settingsWithCodexCredential,
  settingsWithWorkspaceGatewayCredential,
  settingsWithWorkspaceOpenRouterCredential,
  settingsWithWorkspaceOpperCredential,
  settingsWithOrganizationProviderCredentials,
  settingsWithModelProviderCredentials,
  withXaiSubscriptionProvider,
} from "../src/model-provider-credentials";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
const key = new Uint8Array(32).fill(7);
const settings = testSettings({
  environmentsEncryptionKey: Buffer.from(key).toString("base64"),
  claudeSubscriptionEnabled: true,
});
const kinds: WorkspaceCustomModelProviderKind[] = [
  "vercel_gateway",
  "openrouter",
  "opper",
  "anthropic",
  "claude_subscription",
];
type Scope = { accountId: string; workspaceId: string };
const actor = "user:execution-input-fixture";
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("model-provider-execution-inputs");
  if (!shared) throw new Error("Execution input equivalence requires PostgreSQL");
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function world(): Promise<Scope> {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Execution fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Execution fixture",
    subjectId: actor,
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  return { accountId, workspaceId };
}

// The pre-batch execution path remains the oracle, using its individually scoped
// readers. Compare the complete Settings object, including catalog JSON order and
// synthetic fixture keys, rather than only the selected provider's model.
async function serial(scope: Scope, config = settings, productModelId: string | null = null) {
  let result = await settingsWithCodexCredential(client.db, scope.workspaceId, config, false);
  if (result.supergrokSubscriptionEnabled) result = withXaiSubscriptionProvider(result);
  result = await settingsWithWorkspaceGatewayCredential(
    client.db,
    scope.accountId,
    scope.workspaceId,
    result,
    productModelId,
  );
  result = await settingsWithWorkspaceOpenRouterCredential(
    client.db,
    scope.accountId,
    scope.workspaceId,
    result,
    productModelId,
  );
  result = await settingsWithWorkspaceOpperCredential(
    client.db,
    scope.accountId,
    scope.workspaceId,
    result,
    productModelId,
  );
  result = await settingsWithOrganizationProviderCredentials(
    client.db,
    scope.accountId,
    scope.workspaceId,
    result,
    productModelId,
  );
  const direct = await loadDirectModelProviderConnection(
    client.db,
    result,
    scope.workspaceId,
    productModelId ?? "",
  );
  return direct ? withDirectModelProviders(result, [direct]) : result;
}
const batched = (scope: Scope, config = settings, productModelId: string | null = null) =>
  settingsWithModelProviderCredentials(client.db, {
    ...scope,
    settings: config,
    productModelId,
    codexSubscriptionActive: false,
  });

async function connect(
  scope: Scope,
  kind: WorkspaceCustomModelProviderKind,
  organization: boolean,
) {
  if (kind === "claude_subscription") return;
  if (organization) {
    await shared!.admin`
      insert into organization_model_provider_connections
        (account_id, provider_kind, credential_encrypted, operation_id, request_hash,
         updated_by_subject_id, allowed_workspace_ids, allow_personal_workspaces)
      values (${scope.accountId}, ${kind}, ${encryptEnvironmentValue(key, `test-org-${kind}`)},
        ${crypto.randomUUID()}, ${"a".repeat(64)}, ${actor}, array[${scope.workspaceId}::uuid], false)`;
  } else {
    const spec = workspaceProviderApiKeyConnectionSpec(kind);
    await createConnection(client.db, {
      ...scope,
      subjectId: null,
      providerDomain: spec.providerDomain.toUpperCase(),
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ apiKey: `test-workspace-${kind}` }),
      ),
      metadata: { credentialRole: spec.credentialRole },
      createdBySubjectId: actor,
    });
  }
}
async function models(scope: Scope, kind: WorkspaceCustomModelProviderKind, organization: boolean) {
  for (const [upstream, retired] of [
    ["test-b", false],
    ["test-a", false],
    ["test-retired", true],
  ] as const) {
    if (organization) {
      await shared!.admin`
        insert into organization_model_provider_custom_models
          (account_id, provider_kind, upstream_model_id, create_operation_id, create_request_hash,
           created_by_subject_id, retired_at)
        values (${scope.accountId}, ${kind}, ${upstream}, ${crypto.randomUUID()}, ${"b".repeat(64)}, ${actor}, ${retired ? new Date() : null})`;
    } else {
      await shared!.admin`
        insert into workspace_gateway_custom_models
          (account_id, workspace_id, provider_kind, upstream_model_id, create_operation_id,
           create_request_hash, created_by_subject_id, retired_at)
        values (${scope.accountId}, ${scope.workspaceId}, ${kind}, ${upstream},
          ${crypto.randomUUID()}, ${"b".repeat(64)}, ${actor}, ${retired ? new Date() : null})`;
    }
  }
}

test("one scope replaces the serial provider reads without changing settings", async () => {
  const scope = await world();
  let before = 0;
  let after = 0;
  const expected = await withDatabaseTimingObserver(
    (e) => {
      if (e.stage === "transaction_admission") before++;
    },
    () => serial(scope),
  );
  const actual = await withDatabaseTimingObserver(
    (e) => {
      if (e.stage === "transaction_admission") after++;
    },
    () => batched(scope),
  );
  expect(actual).toEqual(expected);
  // The serial reference reads each organization provider kind twice (catalog, then
  // credential); #5359 added OpenAI and Azure OpenAI, so it grew from 18 to 22.
  expect(before).toBe(22);
  expect(after).toBe(1);
  for (const config of [
    { ...settings, environmentsEncryptionKey: undefined },
    { ...settings, claudeSubscriptionEnabled: false },
  ]) {
    expect(await batched(scope, config)).toEqual(await serial(scope, config));
  }
});

test.each(kinds)(
  "preserves %s workspace and organization catalogs, credentials and retired selections",
  async (kind) => {
    const scope = await world();
    for (const organization of [false, true]) {
      await connect(scope, kind, organization);
      expect(await batched(scope)).toEqual(await serial(scope));
      await models(scope, kind, organization);
      expect(await batched(scope)).toEqual(await serial(scope));
      const scopeName = organization ? "organization" : "workspace";
      const prefix =
        kind === "anthropic" || kind === "claude_subscription"
          ? claudeProviderId(kind, scopeName)
          : `${scopeName}-${kind === "vercel_gateway" ? "gateway" : kind}`;
      const selected = `${prefix}/test-retired`;
      expect(await batched(scope, settings, selected)).toEqual(
        await serial(scope, settings, selected),
      );
      const disabled = { ...settings, claudeSubscriptionEnabled: false };
      expect(await batched(scope, disabled)).toEqual(await serial(scope, disabled));
    }
  },
);

test("missing encryption keys keep the same workspace refusal and organization no-key behavior", async () => {
  const config = { ...settings, environmentsEncryptionKey: undefined };
  const organization = await world();
  await connect(organization, "openrouter", true);
  await models(organization, "openrouter", true);
  expect(await batched(organization, config)).toEqual(await serial(organization, config));
  const workspace = await world();
  await connect(workspace, "openrouter", false);
  await expect(serial(workspace, config)).rejects.toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  await expect(batched(workspace, config)).rejects.toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
});

test("snapshots do not reuse another workspace or a prior call's connections", async () => {
  const scope = await world();
  const other = await world();
  await connect(scope, "openrouter", false);
  const read = (target: Scope) =>
    loadModelProviderExecutionInputs(client.db, {
      ...target,
      claudeSubscriptionEnabled: true,
      loadOrganizationCredentials: true,
    });
  expect((await read(scope)).workspaceConnections).toHaveLength(1);
  expect((await read(other)).workspaceConnections).toHaveLength(0);
  await connect(other, "opper", false);
  expect((await read(other)).workspaceConnections[0]!.providerDomain.toLowerCase()).toBe(
    workspaceProviderApiKeyConnectionSpec("opper").providerDomain,
  );
  expect(await batched(other)).toEqual(await serial(other));
});

test("mixed provider catalogs retain the full overlay order and the selected direct model", async () => {
  const scope = await world();
  for (const kind of kinds)
    for (const organization of [false, true]) {
      await connect(scope, kind, organization);
      await models(scope, kind, organization);
    }
  expect(await batched(scope)).toEqual(await serial(scope));
  for (const provider of ["openai", "azure_openai"] as const) {
    const connection = await createConnection(client.db, {
      ...scope,
      subjectId: null,
      providerDomain: provider === "openai" ? "api.openai.com" : "fixture.openai.azure.com",
      kind: "api_key",
      createdBySubjectId: actor,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ apiKey: "test-direct-key" }),
      ),
      metadata: {
        credentialRole: `direct_${provider}`,
        directModelProvider: {
          provider,
          model: "fixture-model",
          ...(provider === "azure_openai" ? { endpoint: "https://fixture.openai.azure.com" } : {}),
        },
      },
    });
    const model = directModelConnectionSpec(connection)!.modelId;
    expect(await batched(scope, settings, model)).toEqual(await serial(scope, settings, model));
  }
});

test("prepared inputs cannot silently drop providers after execution flags change", async () => {
  const scope = await world();
  const prepared = await loadModelProviderExecutionInputs(client.db, {
    ...scope,
    claudeSubscriptionEnabled: false,
    loadOrganizationCredentials: false,
  });
  await expect(
    settingsWithOrganizationProviderCredentials(
      client.db,
      scope.accountId,
      scope.workspaceId,
      settings,
      null,
      prepared,
    ),
  ).rejects.toThrow("subscription settings");
  await expect(
    loadOrganizationModelProviderApiKey(
      client.db,
      settings,
      { ...scope, providerKind: "openrouter" },
      prepared,
    ),
  ).rejects.toThrow("encryption settings");
});

test("the shared listing preserves tie-breaks and the broker still checks revocation", async () => {
  const scope = await world();
  await models(scope, "openrouter", false);
  const spec = workspaceProviderApiKeyConnectionSpec("openrouter");
  const connections = [];
  for (const value of ["test-older", "test-newer"]) {
    const row = await createConnection(client.db, {
      ...scope,
      subjectId: null,
      providerDomain: spec.providerDomain,
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ apiKey: value })),
      metadata: { credentialRole: spec.credentialRole },
      createdBySubjectId: actor,
    });
    connections.push({ ...row, value });
  }
  await shared!
    .admin`update connections set created_at='2026-01-01' where workspace_id=${scope.workspaceId}`;
  const expected = [...connections].sort((a, b) => b.id.localeCompare(a.id))[0]!;
  const result = await batched(scope);
  expect(result).toEqual(await serial(scope));
  expect(
    JSON.parse(result.modelProvidersJson).find(
      (p: { id: string }) => p.id === "workspace-openrouter",
    ).apiKey,
  ).toBe(expected.value);
  const prepared = await loadModelProviderExecutionInputs(client.db, {
    ...scope,
    claudeSubscriptionEnabled: true,
    loadOrganizationCredentials: true,
  });
  await shared!
    .admin`update connections set status='revoked' where workspace_id=${scope.workspaceId}`;
  // Metadata alone never authorizes a cached credential: the broker observes the
  // revocation even when the connection was active in this execution's listing.
  expect(
    await settingsWithWorkspaceOpenRouterCredential(
      client.db,
      scope.accountId,
      scope.workspaceId,
      settings,
      null,
      prepared,
    ),
  ).toEqual(
    await settingsWithWorkspaceOpenRouterCredential(
      client.db,
      scope.accountId,
      scope.workspaceId,
      settings,
    ),
  );
});
