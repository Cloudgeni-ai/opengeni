import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CODEX_FALLBACK_MODEL_SLUGS, CODEX_MODEL_ID_PREFIX } from "@opengeni/codex/constants";
import { resolveTurnExecutionPolicyV1, withCodexCatalogProvider } from "@opengeni/config";
import { metadataWithTurnExecutionPolicyV1 } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { claimTurnAttempt, type ClaimTurnDeps } from "../src/activities/agent-turn/claim";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import * as capabilities from "../src/activities/capabilities";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
};
const baseSettings = testSettings({ sandboxBackend: "none" });
const settings = withCodexCatalogProvider({
  ...baseSettings,
  codexSubscriptionEnabled: true,
  codexConnectedAppsEnabled: true,
});
const ordinaryPolicy = resolveTurnExecutionPolicyV1(settings, {
  modelId: settings.openaiModel,
  requestedModelId: null,
  modelSource: "continuation",
  reasoningEffort: "low",
  reasoningSource: "continuation",
  latencyMode: "standard",
  latencyModeSource: "continuation",
});
const codexPolicy = resolveTurnExecutionPolicyV1(settings, {
  modelId: `${CODEX_MODEL_ID_PREFIX}${CODEX_FALLBACK_MODEL_SLUGS[0]}`,
  requestedModelId: null,
  modelSource: "continuation",
  reasoningEffort: "low",
  reasoningSource: "continuation",
  latencyMode: "standard",
  latencyModeSource: "continuation",
});

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!.mockRestore();
});

/**
 * Run the production claim until just after its Codex overlay and Apps
 * resolution, and report which legacy Codex reads it made.
 */
async function claimTurn(
  policy: typeof ordinaryPolicy,
  extraMetadata: Record<string, unknown> = {},
  options: { failover?: boolean; source?: string; omitPolicy?: boolean } = {},
) {
  const steps: string[] = [];
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  const stop = new Error("fixture stopped after the Codex claim overlay");
  const legacyActive = spyOn(db, "workspaceCodexSubscriptionActive").mockResolvedValue(true);
  const appsGrant = spyOn(db, "getWorkspaceGrant").mockResolvedValue({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: "user:owner",
    permissions: ["connections:write"],
  } as Awaited<ReturnType<typeof db.getWorkspaceGrant>>);
  // The claim knows its organization: the Apps resolver must not look it up again.
  const workspaceLookup = spyOn(db, "rlsContextForWorkspace");
  let overlayCodexApps: unknown;
  // Stop at the overlay, after all independent post-claim reads have joined.
  const overlay = spyOn(core, "settingsWithModelProviderCredentials").mockRejectedValue(stop);
  const coreApps = spyOn(db, "resolveSubscriptionCoreCodexAppsDesignation").mockResolvedValue({
    connectionId: "core-apps-connection",
    status: "active",
  });
  restores.push(
    legacyActive,
    appsGrant,
    workspaceLookup,
    coreApps,
    overlay,
    spyOn(db, "getSessionEvent").mockResolvedValue(null),
    spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as Awaited<
      ReturnType<typeof core.resolveCatalogSettings>
    >),
    spyOn(db, "claimSessionWorkForAttempt").mockResolvedValue({
      action: "claimed",
      turn: {
        id: scope.turnId,
        sessionId: scope.sessionId,
        executionGeneration: 1,
        triggerEventId: "66666666-6666-4666-8666-666666666666",
        source: options.source ?? "user",
        initiator: { kind: "subject", subjectId: "user:owner" },
        initiatorContext: {},
        metadata: options.omitPolicy
          ? extraMetadata
          : metadataWithTurnExecutionPolicyV1(extraMetadata, policy),
        model: policy.productModelId,
        reasoningEffort: "low",
        latencyMode: "standard",
      },
    } as Awaited<ReturnType<typeof db.claimSessionWorkForAttempt>>),
    spyOn(db, "requireSession").mockResolvedValue({ id: scope.sessionId, metadata: {} } as Awaited<
      ReturnType<typeof db.requireSession>
    >),
    spyOn(db, "withRlsContext").mockImplementation(
      async (_db: unknown, _context: unknown, callback: (scoped: never) => Promise<unknown>) =>
        await callback({} as never),
    ),
    spyOn(capabilities, "settingsWithEnabledCapabilityMcpServers").mockImplementation(
      async (
        _db: unknown,
        _workspaceId: unknown,
        _settings: unknown,
        capabilityOptions?: unknown,
      ) => {
        steps.push("capability-read");
        overlayCodexApps = (capabilityOptions as { codexApps?: unknown } | undefined)?.codexApps;
        return settings;
      },
    ),
    spyOn(db, "installOrReadTurnExecutionPolicyForAttempt").mockResolvedValue({
      accepted: true,
      installed: false,
      policy,
    } as Awaited<ReturnType<typeof db.installOrReadTurnExecutionPolicyForAttempt>>),
  );
  await expect(
    claimTurnAttempt({
      ...context,
      settings: {
        ...settings,
        subscriptionCrossProviderFailoverEnabled: options.failover ?? false,
      },
      catalogSourceSettings: settings,
      db: {},
      input: {
        ...scope,
        workflowId: "fixture-workflow",
        workflowRunId: "fixture-workflow-run",
        trigger: { kind: "next" },
      },
      dispatchId: "fixture-dispatch",
      leases: { codex: { holderId: null } },
      startCodexEntitlementPreparation: (turn) => {
        expect(context.attempt.turnId).toBe(turn.id);
        steps.push("entitlement-hint");
      },
    } as ClaimTurnDeps),
  ).rejects.toBe(stop);
  return {
    steps,
    legacyActiveCalls: legacyActive.mock.calls.length,
    coreAppsCalls: coreApps.mock.calls.length,
    workspaceLookups: workspaceLookup.mock.calls.length,
    overlayCodexApps,
    codexActive: overlay.mock.calls[0]?.[1].codexSubscriptionActive,
    subscriptionLeaseBusy: context.attempt.subscriptionLeaseBusy,
  };
}

describe("claim-time Codex", () => {
  test("a valid accepted Codex claim prepares before capability reads and later policy fences", async () => {
    const result = await claimTurn(codexPolicy);
    expect(result.steps).toEqual(["entitlement-hint", "capability-read"]);
  });

  test.each([
    ["ordinary model", ordinaryPolicy, {}],
    ["provider failover", codexPolicy, { failover: true }],
    ["compaction", codexPolicy, { source: "compaction" }],
    ["missing frozen policy", codexPolicy, { omitPolicy: true }],
  ] as const)(
    "%s keeps entitlement preparation on the ordinary capacity path",
    async (_label, policy, options) => {
      const result = await claimTurn(policy, {}, options);
      expect(result.steps).not.toContain("entitlement-hint");
    },
  );

  test("a claim resolves the Apps designation once and never looks up its organization", async () => {
    const result = await claimTurn(ordinaryPolicy);
    expect(result.workspaceLookups).toBe(0);
    // The capability overlay reuses the claim's one Apps designation read.
    expect(result.overlayCodexApps).toBeInstanceOf(Promise);
    expect(result.coreAppsCalls).toBe(1);
  });

  test.each([
    ["Codex", codexPolicy],
    ["non-Codex", ordinaryPolicy],
  ] as const)(
    "a %s turn installs the Codex overlay without legacy Codex reads",
    async (_label, policy) => {
      const result = await claimTurn(policy);
      expect(result.legacyActiveCalls).toBe(0);
      expect(result.codexActive).toBe(true);
    },
  );

  test("the claim carries the stored lease-busy chain onto the attempt", async () => {
    const startedAt = "2026-10-08T12:00:00.000Z";
    const result = await claimTurn(codexPolicy, {
      subscriptionLeaseBusy: { startedAt, executionGeneration: 1 },
    });
    expect(result.subscriptionLeaseBusy).toEqual({
      startedAt: Date.parse(startedAt),
      executionGeneration: 1,
    });
    const none = await claimTurn(codexPolicy);
    expect(none.subscriptionLeaseBusy).toBeUndefined();
  });
});
