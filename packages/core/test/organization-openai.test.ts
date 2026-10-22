import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  configuredProviders,
  ORGANIZATION_OPENAI_PROVIDER_ID,
  resolveModelProviderForTurn,
  withOrganizationDirectCatalogProvider,
} from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import { checkLimit } from "../src/billing/limits";
import { verifyOrganizationDirectModel } from "../src/domain/direct-model-provider";
import {
  resolveWorkspaceModelSelection,
  workspaceCustomModelReference,
} from "../src/model-catalog";
import { settingsWithOrganizationProviderCredentials } from "../src/model-provider-credentials";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const MODEL = "gpt-6-sol";
const MODEL_ID = `organization-openai/${MODEL}`;

function customModel(upstreamModelId: string): opengeniDb.OrganizationModelProviderCustomModel {
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT,
    providerKind: "openai",
    upstreamModelId,
    label: null,
    version: 1,
    retiredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("organization OpenAI selection", () => {
  const select = (input: Partial<Parameters<typeof resolveWorkspaceModelSelection>[0]>) =>
    resolveWorkspaceModelSelection({
      settings: testSettings({}),
      policy: null,
      codexSubscriptionActive: false,
      ...input,
    }).find((row) => row.model.id === MODEL_ID);

  test("models wait for the organization key, then are organization-billed", () => {
    const models = [{ upstreamModelId: MODEL }];
    expect(select({ organizationDirect: { openai: { active: false, models } } })).toMatchObject({
      credentialReadiness: { status: "not_ready", reason: "needs_reauth" },
      availability: { selectable: false },
    });
    expect(select({ organizationDirect: { openai: { active: true, models } } })).toMatchObject({
      model: {
        cost: "organization",
        providerId: ORGANIZATION_OPENAI_PROVIDER_ID,
        billing: { upstreamPayer: "organization", metering: "external" },
      },
      credentialReadiness: { status: "ready" },
      availability: { selectable: true },
    });
    // An active organization Azure key never readies the OpenAI one.
    expect(
      select({
        organizationDirect: {
          openai: { active: false, models },
          azure_openai: {
            active: true,
            endpoint: "https://contoso.openai.azure.com/openai/v1",
            models,
          },
        },
      })?.availability.selectable,
    ).toBe(false);
  });

  test("every organization OpenAI id is a mutable organization model reference", () => {
    expect(workspaceCustomModelReference(testSettings({}), MODEL_ID)).toEqual({
      scope: "organization",
      providerKind: "openai",
      upstreamModelId: MODEL,
    });
  });
});

describe("organization OpenAI admission", () => {
  test("checkLimit admits an organization OpenAI turn with a zero credit balance", async () => {
    const allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
    const codex = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(false);
    const spendable = spyOn(opengeniDb, "getSpendableCreditBalance").mockResolvedValue({
      balanceMicros: 0,
    } as never);
    try {
      const settings = withOrganizationDirectCatalogProvider(
        testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
        "openai",
        { models: [{ upstreamModelId: MODEL }] },
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
    } finally {
      allowance.mockRestore();
      codex.mockRestore();
      spendable.mockRestore();
    }
  });
});

describe("organization OpenAI execution overlay", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let credential: { apiKey: string; endpoint: string | null } | null;

  beforeEach(() => {
    credential = { apiKey: "openai-org-key", endpoint: null };
    spies.push(
      spyOn(opengeniDb, "listOrganizationModelProviderCustomModelsForWorkspace").mockImplementation(
        async (_db, input) => (input.providerKind === "openai" ? [customModel(MODEL)] : []),
      ),
      spyOn(opengeniDb, "getOrganizationModelProviderCustomModelForExecution").mockResolvedValue(
        null,
      ),
      spyOn(opengeniDb, "loadOrganizationModelProviderApiKey").mockResolvedValue(null),
      spyOn(opengeniDb, "loadOrganizationModelProviderCredential").mockImplementation(
        async (_db, _settings, input) => (input.providerKind === "openai" ? credential : null),
      ),
      spyOn(opengeniDb, "getOrganizationModelProviderCatalogForWorkspace").mockImplementation(
        async () => ({ azure_openai: { active: false, models: [], endpoint: null } }) as never,
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

  test("an active connection installs its decrypted key on the official OpenAI API", async () => {
    const resolved = resolveModelProviderForTurn(await overlay(), MODEL_ID);
    expect(resolved?.provider).toMatchObject({
      id: ORGANIZATION_OPENAI_PROVIDER_ID,
      kind: "direct-openai-organization",
      apiKey: "openai-org-key",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  test("a revoked connection keeps a key-free definition; never a deployment key", async () => {
    credential = null;
    const provider = configuredProviders(await overlay()).find(
      (candidate) => candidate.id === ORGANIZATION_OPENAI_PROVIDER_ID,
    );
    expect(provider).toMatchObject({ baseUrl: "https://api.openai.com/v1" });
    expect(provider?.apiKey).toBeUndefined();
  });
});

describe("organization OpenAI model check", () => {
  test("calls OpenAI's Responses route with the organization's bearer key", async () => {
    let url = "";
    let init: RequestInit = {};
    await verifyOrganizationDirectModel(
      { provider: "openai", model: MODEL },
      "openai-org-key",
      (async (requested: string, request: RequestInit) => {
        url = requested;
        init = request;
        return Response.json({ status: "completed" });
      }) as typeof fetch,
    );
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer openai-org-key");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: MODEL, store: false });
  });

  test("an invalid model ID never dispatches", async () => {
    let calls = 0;
    await expect(
      verifyOrganizationDirectModel(
        { provider: "openai", model: "../escape" },
        "openai-org-key",
        (async () => {
          calls++;
          return Response.json({ status: "completed" });
        }) as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 422, message: "Enter the exact OpenAI model ID." });
    expect(calls).toBe(0);
  });
});
