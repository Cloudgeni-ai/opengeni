import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  configuredProviders,
  ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
  resolveModelProviderForTurn,
  withOrganizationAzureOpenAICatalogProvider,
} from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import { checkLimit } from "../src/billing/limits";
import { verifyOrganizationAzureOpenAIDeployment } from "../src/domain/direct-model-provider";
import {
  resolveWorkspaceModelSelection,
  workspaceCustomModelReference,
} from "../src/model-catalog";
import { settingsWithOrganizationProviderCredentials } from "../src/model-provider-credentials";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const ENDPOINT = "https://contoso.openai.azure.com/openai/v1";
const DEPLOYMENT = "gpt-6.1-sol";
const MODEL_ID = `organization-azure-openai/${DEPLOYMENT}`;

function customModel(upstreamModelId: string): opengeniDb.OrganizationModelProviderCustomModel {
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT,
    providerKind: "azure_openai",
    upstreamModelId,
    label: null,
    version: 1,
    retiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("organization Azure OpenAI selection", () => {
  const select = (input: Partial<Parameters<typeof resolveWorkspaceModelSelection>[0]>) =>
    resolveWorkspaceModelSelection({
      settings: testSettings({}),
      policy: null,
      codexSubscriptionActive: false,
      ...input,
    }).find((row) => row.model.id === MODEL_ID);

  test("deployments wait for the organization connection, then are organization-billed", () => {
    const models = [{ upstreamModelId: DEPLOYMENT }];
    expect(
      select({
        organizationDirect: { azure_openai: { active: false, endpoint: ENDPOINT, models } },
      }),
    ).toMatchObject({
      credentialReadiness: { status: "not_ready", reason: "needs_reauth" },
      availability: { selectable: false },
    });
    expect(
      select({
        organizationDirect: { azure_openai: { active: true, endpoint: ENDPOINT, models } },
      }),
    ).toMatchObject({
      model: {
        cost: "organization",
        providerId: ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
        billing: { upstreamPayer: "organization", metering: "external" },
      },
      credentialReadiness: { status: "ready" },
      availability: { selectable: true },
    });
    // Another organization rail's readiness never readies Azure.
    expect(
      select({
        organizationOpperConnectionActive: true,
        organizationGatewayConnectionActive: true,
        organizationDirect: { azure_openai: { active: false, endpoint: ENDPOINT, models } },
      })?.availability.selectable,
    ).toBe(false);
    // Without an endpoint (never connected) there is no catalog entry at all.
    expect(
      select({ organizationDirect: { azure_openai: { active: true, endpoint: null, models } } }),
    ).toBe(undefined);
  });

  test("every organization Azure id is a mutable organization deployment reference", () => {
    expect(workspaceCustomModelReference(testSettings({}), MODEL_ID)).toEqual({
      scope: "organization",
      providerKind: "azure_openai",
      upstreamModelId: DEPLOYMENT,
    });
  });
});

describe("organization Azure OpenAI admission", () => {
  test("checkLimit admits an organization Azure turn with a zero credit balance", async () => {
    const allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
    const codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(false);
    const spendable = spyOn(opengeniDb, "getSpendableCreditBalance").mockResolvedValue({
      balanceMicros: 0,
    } as never);
    try {
      const settings = withOrganizationAzureOpenAICatalogProvider(
        testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
        { endpoint: ENDPOINT, models: [{ upstreamModelId: DEPLOYMENT }] },
      );
      const deps = { db: {} as opengeniDb.Database, settings };
      const input = {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        action: "agent_run:create" as const,
        quantity: 1,
        initiatingHumanSubjectId: null,
      };
      expect(await checkLimit(deps, { ...input, model: MODEL_ID })).toEqual({ allowed: true });
      expect(spendable).not.toHaveBeenCalled();
      expect(allowance.mock.calls.at(-1)?.[1]).toMatchObject({ fundedWithoutCredits: true });
      // The same zero balance still refuses a credit-billed deployment model.
      expect(await checkLimit(deps, { ...input, model: settings.openaiModel })).toMatchObject({
        allowed: false,
        code: "insufficient_credits",
      });
    } finally {
      allowance.mockRestore();
      codex.mockRestore();
      spendable.mockRestore();
    }
  });
});

describe("organization Azure OpenAI execution overlay", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let credential: { apiKey: string; endpoint: string | null } | null;
  let catalogEndpoint: string | null;

  beforeEach(() => {
    credential = { apiKey: "azure-org-key", endpoint: ENDPOINT };
    catalogEndpoint = ENDPOINT;
    spies.push(
      spyOn(opengeniDb, "listOrganizationModelProviderCustomModelsForWorkspace").mockImplementation(
        async (_db, input) =>
          input.providerKind === "azure_openai" ? [customModel(DEPLOYMENT)] : [],
      ),
      spyOn(opengeniDb, "getOrganizationModelProviderCustomModelForExecution").mockResolvedValue(
        null,
      ),
      spyOn(opengeniDb, "loadOrganizationModelProviderApiKey").mockResolvedValue(null),
      spyOn(opengeniDb, "loadOrganizationModelProviderCredential").mockImplementation(
        async (_db, _settings, input) =>
          input.providerKind === "azure_openai" ? credential : null,
      ),
      spyOn(opengeniDb, "getOrganizationModelProviderCatalogForWorkspace").mockImplementation(
        async () =>
          ({
            azure_openai: { active: false, models: [], endpoint: catalogEndpoint },
          }) as never,
      ),
      spyOn(opengeniDb, "listWorkspaceProviderCustomModels").mockResolvedValue([]),
      spyOn(opengeniDb, "getWorkspaceProviderCustomModelForExecution").mockResolvedValue(null),
      spyOn(opengeniDb, "loadWorkspaceProviderApiKey").mockResolvedValue(null),
    );
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  const overlay = async () =>
    await settingsWithOrganizationProviderCredentials(
      {} as opengeniDb.Database,
      ACCOUNT,
      WORKSPACE,
      testSettings({}),
      MODEL_ID,
    );

  test("an active connection installs its decrypted key on its own endpoint", async () => {
    const resolved = resolveModelProviderForTurn(await overlay(), MODEL_ID);
    expect(resolved?.provider).toMatchObject({
      id: ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
      kind: "direct-azure-organization",
      apiKey: "azure-org-key",
      baseUrl: ENDPOINT,
    });
  });

  test("a revoked connection keeps a key-free definition; never a deployment key", async () => {
    credential = null;
    const settings = await overlay();
    const provider = configuredProviders(settings).find(
      (candidate) => candidate.id === ORGANIZATION_AZURE_OPENAI_PROVIDER_ID,
    );
    expect(provider).toMatchObject({ baseUrl: ENDPOINT });
    expect(provider?.apiKey).toBeUndefined();
    // Never connected: no endpoint, so the model is not executable at all.
    catalogEndpoint = null;
    expect(resolveModelProviderForTurn(await overlay(), MODEL_ID)).toBeUndefined();
  });
});

describe("organization Azure OpenAI deployment check", () => {
  test("calls the organization endpoint's Responses route with the api-key header", async () => {
    let url = "";
    let init: RequestInit = {};
    await verifyOrganizationAzureOpenAIDeployment(
      { endpoint: ENDPOINT, deployment: DEPLOYMENT },
      "azure-org-key",
      (async (requested: string, request: RequestInit) => {
        url = requested;
        init = request;
        return Response.json({ status: "completed" });
      }) as typeof fetch,
    );
    expect(url).toBe(`${ENDPOINT}/responses`);
    expect(new Headers(init.headers).get("api-key")).toBe("azure-org-key");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(JSON.parse(init.body as string)).toMatchObject({ model: DEPLOYMENT, store: false });
  });

  test("a missing deployment is a safe 422 without upstream text", async () => {
    await expect(
      verifyOrganizationAzureOpenAIDeployment(
        { endpoint: ENDPOINT, deployment: DEPLOYMENT },
        "azure-org-key",
        (async () =>
          Response.json(
            { error: { code: "DeploymentNotFound", message: "azure-org-key secret detail" } },
            { status: 404 },
          )) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: "Azure couldn’t use this deployment. Check the endpoint and deployment name.",
    });
  });

  test("an invalid deployment name never dispatches", async () => {
    let calls = 0;
    await expect(
      verifyOrganizationAzureOpenAIDeployment(
        { endpoint: ENDPOINT, deployment: "../escape" },
        "azure-org-key",
        (async () => {
          calls++;
          return Response.json({ status: "completed" });
        }) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(calls).toBe(0);
  });
});
