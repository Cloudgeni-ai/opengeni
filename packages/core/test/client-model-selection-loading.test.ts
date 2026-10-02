import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { requireLimit } from "../src/billing/limits";
import * as codexAvailability from "../src/codex-model-availability";
import {
  admissibleWorkspaceModel,
  resolveCallerWorkspaceModelSelections,
  resolveDefaultSessionModel,
  selectDefaultSessionModel,
} from "../src/default-session-model";

const context = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  subjectId: "user:model-admission",
};
const db = {} as opengeniDb.Database;
const settings = testSettings({
  codexSubscriptionEnabled: true,
  billingMode: "stripe",
  usageLimitsMode: "managed",
});

describe("fresh model admission versus live discovery", () => {
  let active: boolean;
  let mocks: { mockRestore(): void }[];
  let availability: ReturnType<
    typeof spyOn<typeof codexAvailability, "loadWorkspaceCodexModelAvailability">
  >;
  let restrictions: ReturnType<
    typeof spyOn<typeof opengeniDb, "getWorkspaceConnectionModelRestrictions">
  >;
  let policy: ReturnType<typeof spyOn<typeof opengeniDb, "getWorkspaceModelPolicy">>;
  let balance: ReturnType<typeof spyOn<typeof opengeniDb, "getBillingBalance">>;
  let allowance: ReturnType<typeof spyOn<typeof opengeniDb, "checkWorkspaceAllowance">>;

  beforeEach(() => {
    active = true;
    restrictions = spyOn(opengeniDb, "getWorkspaceConnectionModelRestrictions").mockResolvedValue(
      {},
    );
    policy = spyOn(opengeniDb, "getWorkspaceModelPolicy").mockResolvedValue(null);
    availability = spyOn(
      codexAvailability,
      "loadWorkspaceCodexModelAvailability",
    ).mockResolvedValue({});
    balance = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: context.accountId,
      balanceMicros: 0,
      currency: "usd",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue({
      code: "allowance_exhausted",
      scope: "workspace",
      resetsAt: "2026-11-01T00:00:00.000Z",
      message: "The workspace usage allowance is exhausted.",
    });
    mocks = [
      restrictions,
      policy,
      availability,
      balance,
      allowance,
      spyOn(opengeniDb, "workspaceCodexSubscriptionActive").mockImplementation(async () => active),
      spyOn(opengeniDb, "workspaceXaiSubscriptionActive").mockResolvedValue(false),
      spyOn(opengeniDb, "workspaceVercelAiGatewayConnectionActive").mockResolvedValue(false),
      spyOn(opengeniDb, "workspaceOpenRouterConnectionActive").mockResolvedValue(false),
      spyOn(opengeniDb, "organizationModelProviderConnectionActiveForWorkspace").mockResolvedValue(
        false,
      ),
      spyOn(opengeniDb, "listWorkspaceGatewayCustomModels").mockResolvedValue([]),
      spyOn(opengeniDb, "listWorkspaceOpenRouterCustomModels").mockResolvedValue([]),
      spyOn(opengeniDb, "listOrganizationModelProviderCustomModelsForWorkspace").mockResolvedValue(
        [],
      ),
      spyOn(opengeniDb, "getWorkspaceProviderApiKeyConnectionMetadata").mockResolvedValue(null),
      spyOn(opengeniDb, "listWorkspaceProviderCustomModels").mockResolvedValue([]),
      spyOn(opengeniDb, "isCodexBilledTurn").mockImplementation(async () => active),
    ];
  });

  afterEach(() => {
    for (const mock of mocks) mock.mockRestore();
  });

  test("stable admission cannot refresh a subscription onto the zero-credit billing rail", async () => {
    // A live probe may refresh a near-expiry token, commit needs_relogin and
    // swallow that failure as an unavailable health observation. It must never
    // run while admitting an explicit model, even when the credit gate follows.
    availability.mockImplementation(async () => {
      active = false;
      return {};
    });
    const selections = await resolveCallerWorkspaceModelSelections(db, settings, context);
    const selection = admissibleWorkspaceModel(selections, "codex/gpt-6-sol");
    expect(selection?.model.id).toBe("codex/gpt-6-sol");
    expect(selection?.availability.status).toBe("unknown");
    await requireLimit(
      { db, settings },
      { ...context, action: "agent_run:create", quantity: 1, model: selection!.model.id },
    );
    expect(active).toBe(true);
    expect(availability).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
    expect(allowance).not.toHaveBeenCalled();
  });

  test("catalog discovery and automatic defaults retain exact live support filtering", async () => {
    availability.mockResolvedValue(
      Object.fromEntries(
        configuredModels(withCodexCatalogProvider(settings))
          .filter((model) => model.id.startsWith("codex/"))
          .map((model) => [
            model.definitionVersion,
            {
              status: model.id === "codex/gpt-6-sol" ? "available" : "unavailable",
              reason: model.id === "codex/gpt-6-sol" ? null : "not_entitled",
              checkedAt: "2026-10-01T00:00:00.000Z",
            },
          ]),
      ),
    );
    const selections = await resolveCallerWorkspaceModelSelections(db, settings, context, {
      observeAvailability: true,
    });
    expect(
      selectDefaultSessionModel({
        settings,
        selections,
        workspaceDefaults: null,
        creditsAvailable: false,
      }),
    ).toMatchObject({ model: "codex/gpt-6-sol", source: "subscription" });
    expect(
      await resolveDefaultSessionModel(db, settings, { ...context, workspaceSettings: {} }),
    ).toMatchObject({ model: "codex/gpt-6-sol", source: "subscription" });
    expect(availability).toHaveBeenCalledTimes(2);
  });

  test.each(["disconnected", "connection restriction", "workspace policy"] as const)(
    "%s still rejects fresh Codex admission without a probe",
    async (blocker) => {
      if (blocker === "disconnected") active = false;
      if (blocker === "connection restriction") restrictions.mockResolvedValue({ "codex/": [] });
      if (blocker === "workspace policy") {
        policy.mockResolvedValue({ allowedProviders: ["openai"], allowedModels: null });
      }
      const selections = await resolveCallerWorkspaceModelSelections(db, settings, context);
      expect(admissibleWorkspaceModel(selections, "codex/gpt-6-sol")).toBeUndefined();
      expect(admissibleWorkspaceModel(selections, "codex/invented-model")).toBeUndefined();
      expect(availability).not.toHaveBeenCalled();
    },
  );
});
