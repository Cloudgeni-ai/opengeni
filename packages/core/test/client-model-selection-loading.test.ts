import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { configuredModels, withCodexCatalogProvider } from "@opengeni/config";
import { EMPTY_ORGANIZATION_MODEL_DEFAULTS } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { requireLimit } from "../src/billing/limits";
import * as codexAvailability from "../src/codex-model-availability";
import {
  admissibleWorkspaceModel,
  loadWorkspaceModelSelectionInput,
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
  let availability: ReturnType<typeof mock<() => Promise<Record<string, any>>>>;
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
    availability = mock(async () => ({}));
    balance = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
      accountId: context.accountId,
      balanceMicros: 0,
      currency: "usd",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    // The real check admits credit-free work unless the allowance opts into
    // counting unbilled usage.
    allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockImplementation(
      async (_db, check) =>
        check.fundedWithoutCredits
          ? null
          : {
              code: "allowance_exhausted",
              scope: "workspace",
              resetsAt: "2026-11-01T00:00:00.000Z",
              message: "The workspace usage allowance is exhausted.",
            },
    );
    mocks = [
      restrictions,
      policy,
      // No organization-wide model defaults: the live selections decide.
      spyOn(opengeniDb, "getOrganizationModelDefaults").mockResolvedValue(
        EMPTY_ORGANIZATION_MODEL_DEFAULTS,
      ),
      spyOn(codexAvailability, "loadWorkspaceCodexCatalogReadiness").mockImplementation(
        async (_db, _settings, _context, options) => ({
          active,
          observations: options?.observeAvailability === false ? {} : await availability(),
        }),
      ),
      balance,
      allowance,
      spyOn(opengeniDb, "workspaceXaiSubscriptionActive").mockResolvedValue(false),
      spyOn(opengeniDb, "listConnectionsMetadata").mockResolvedValue([]),
      spyOn(opengeniDb, "listWorkspaceProviderCustomModelsByKind").mockResolvedValue({
        vercel_gateway: [],
        openrouter: [],
        anthropic: [],
        claude_subscription: [],
      }),
      spyOn(opengeniDb, "getOrganizationModelProviderCatalogForWorkspace").mockResolvedValue({
        vercel_gateway: { active: false, models: [] },
        openrouter: { active: false, models: [] },
        anthropic: { active: false, models: [] },
        claude_subscription: { active: false, models: [] },
      }),
      spyOn(opengeniDb, "isCodexBilledTurn").mockImplementation(async () => active),
      // No provider has a cutover receipt here: Claude is not ready (its legacy
      // runtime is deleted, M4 C4), SuperGrok keeps its legacy answer.
      spyOn(opengeniDb, "readSubscriptionCoreRouteReadiness").mockResolvedValue({
        route: "legacy",
      }),
    ];
  });

  afterEach(() => {
    for (const mocked of mocks) mocked.mockRestore();
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
    expect(allowance).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ fundedWithoutCredits: true }),
    );
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
  test("Claude readiness comes only from the shared core answer, never a legacy connection", async () => {
    const core = spyOn(opengeniDb, "readSubscriptionCoreRouteReadiness").mockImplementation(
      async (_db, input) =>
        input.provider === "claude"
          ? { route: "core", value: { ready: true, allowedModelIds: ["claude-opus-5-5"] } }
          : { route: "legacy" },
    );
    const legacy = spyOn(opengeniDb, "workspaceProviderApiKeyConnectionMetadataFromConnections");
    mocks.push(core, legacy);
    const loaded = await loadWorkspaceModelSelectionInput(
      db,
      { ...settings, claudeSubscriptionEnabled: true },
      context,
      { observeAvailability: false },
    );
    // On the core every Claude connection belongs to the organization.
    expect(loaded.workspaceClaudeConnections?.claude_subscription?.active).toBe(false);
    expect(loaded.claudeConnections?.claude_subscription?.active).toBe(true);
    expect(loaded.connectionModelRestrictions?.["organization-claude-subscription/"]).toEqual([
      "claude-opus-5-5",
    ]);
    expect(loaded.connectionModelRestrictions?.["workspace-claude-subscription/"]).toEqual([]);
    const claudeCall = core.mock.calls.find((call) => call[1].provider === "claude");
    expect(claudeCall?.[1]).toMatchObject({
      accountId: context.accountId,
      workspaceId: context.workspaceId,
      subjectId: context.subjectId,
    });
    expect(legacy.mock.calls.some((call) => call[1] === "claude_subscription")).toBe(false);
    expect(availability).not.toHaveBeenCalled();
  });

  test("without the Claude cutover receipt nothing is ready, whatever authority is accepted", async () => {
    const snapshot = { version: 1, scope: "user", authorityGeneration: 1 } as const;
    const loaded = await loadWorkspaceModelSelectionInput(
      db,
      { ...settings, claudeSubscriptionEnabled: true },
      { ...context, claudeAuthoritySnapshot: snapshot },
    );
    expect(loaded.workspaceClaudeConnections?.claude_subscription?.active).toBe(false);
    expect(loaded.claudeConnections?.claude_subscription?.active).toBe(false);
    expect(loaded.connectionModelRestrictions?.["organization-claude-subscription/"]).toBe(
      undefined,
    );
  });
});
