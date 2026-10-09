import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CODEX_FALLBACK_MODEL_SLUGS, CODEX_MODEL_ID_PREFIX } from "@opengeni/codex/constants";
import { resolveTurnExecutionPolicyV1, withCodexCatalogProvider } from "@opengeni/config";
import { metadataWithTurnExecutionPolicyV1 } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
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
async function claimWithCutover(
  cutover: "not_configured" | "disabled" | "enabled",
  policy: typeof ordinaryPolicy,
  extraMetadata: Record<string, unknown> = {},
) {
  const context = createTurnContext({ settings, cancellationRequestedAt: null });
  const stop = new Error("fixture stopped after the Codex claim overlay");
  const legacyActive = spyOn(db, "workspaceCodexSubscriptionActive").mockResolvedValue(true);
  // The legacy Apps designation's own reads (behind the core resolver).
  const legacyApps = spyOn(db, "getCodexAppsCredentialAuthorizationForRun").mockResolvedValue({
    credentialId: "legacy-apps-credential",
    ownerSubjectId: "user:owner",
  } as Awaited<ReturnType<typeof db.getCodexAppsCredentialAuthorizationForRun>>);
  const legacyAppsGrant = spyOn(db, "getWorkspaceGrant").mockResolvedValue({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: "user:owner",
    permissions: ["connections:write"],
  } as Awaited<ReturnType<typeof db.getWorkspaceGrant>>);
  // The claim knows its organization and has read its cutover row: the Apps
  // resolver must not look either up again.
  const workspaceLookup = spyOn(db, "rlsContextForWorkspace");
  const dispositionRead = spyOn(db, "readCodexCutoverDisposition");
  const cutoverRead = spyOn(db, "readSubscriptionProviderCutoverState").mockResolvedValue(cutover);
  let overlayCodexApps: unknown;
  const overlay = spyOn(capabilities, "settingsWithCodexCredential").mockResolvedValue(settings);
  const coreApps = spyOn(db, "resolveSubscriptionCoreCodexAppsDesignation").mockResolvedValue({
    connectionId: "core-apps-connection",
    status: "active",
  });
  restores.push(
    legacyActive,
    legacyApps,
    legacyAppsGrant,
    workspaceLookup,
    dispositionRead,
    cutoverRead,
    coreApps,
    overlay,
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
        source: "user",
        initiator: { kind: "subject", subjectId: "user:owner" },
        initiatorContext: {},
        metadata: metadataWithTurnExecutionPolicyV1(extraMetadata, policy),
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
      async (_db: unknown, _workspaceId: unknown, _settings: unknown, options?: unknown) => {
        overlayCodexApps = (options as { codexApps?: unknown } | undefined)?.codexApps;
        return settings;
      },
    ),
    spyOn(capabilities, "settingsWithWorkspaceGatewayCredential").mockResolvedValue(settings),
    spyOn(capabilities, "settingsWithWorkspaceOpenRouterCredential").mockResolvedValue(settings),
    spyOn(capabilities, "settingsWithWorkspaceOpperCredential").mockResolvedValue(settings),
    spyOn(capabilities, "settingsWithOrganizationProviderCredentials").mockResolvedValue(settings),
    spyOn(db, "loadDirectModelProviderConnection").mockResolvedValue(null),
    spyOn(db, "installOrReadTurnExecutionPolicyForAttempt").mockImplementation(async () => {
      throw stop;
    }),
  );
  await expect(
    claimTurnAttempt({
      ...context,
      settings,
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
    } as ClaimTurnDeps),
  ).rejects.toBe(stop);
  return {
    legacyActiveCalls: legacyActive.mock.calls.length,
    legacyAppsCalls: legacyApps.mock.calls.length,
    coreAppsCalls: coreApps.mock.calls.length,
    cutoverReads: cutoverRead.mock.calls.length,
    workspaceLookups: workspaceLookup.mock.calls.length,
    dispositionReads: dispositionRead.mock.calls.length,
    overlayCodexApps,
    codexActive: overlay.mock.calls[0]?.[3],
    subscriptionLeaseBusy: context.attempt.subscriptionLeaseBusy,
  };
}

describe("claim-time Codex cutover", () => {
  test("without a cutover row the claim keeps both legacy Codex reads", async () => {
    const result = await claimWithCutover("not_configured", codexPolicy);
    expect(result.legacyActiveCalls).toBe(1);
    expect(result.legacyAppsCalls).toBe(1);
    expect(result.coreAppsCalls).toBe(0);
    expect(result.codexActive).toBe(true);
  });

  test.each(["not_configured", "enabled", "disabled"] as const)(
    "a claim with a %s cutover reads the cutover row once and never looks up its organization",
    async (cutover) => {
      const result = await claimWithCutover(cutover, ordinaryPolicy);
      expect(result.cutoverReads).toBe(1);
      expect(result.workspaceLookups).toBe(0);
      expect(result.dispositionReads).toBe(0);
      // The capability overlay reuses the claim's one Apps designation read.
      expect(result.overlayCodexApps).toBeInstanceOf(Promise);
      expect(result.legacyAppsCalls).toBe(cutover === "not_configured" ? 1 : 0);
      expect(result.coreAppsCalls).toBe(cutover === "enabled" ? 1 : 0);
    },
  );

  test.each(["enabled", "disabled"] as const)(
    "a %s cutover row stops every legacy Codex read for a Codex turn",
    async (cutover) => {
      const result = await claimWithCutover(cutover, codexPolicy);
      expect(result.legacyActiveCalls).toBe(0);
      expect(result.legacyAppsCalls).toBe(0);
      expect(result.codexActive).toBe(cutover === "enabled");
    },
  );

  test.each(["enabled", "disabled"] as const)(
    "a %s cutover row stops the legacy Apps designation for a non-Codex turn too",
    async (cutover) => {
      const result = await claimWithCutover(cutover, ordinaryPolicy);
      expect(result.legacyAppsCalls).toBe(0);
      // Only an enabled cutover resolves the core designation.
      expect(result.coreAppsCalls).toBe(cutover === "enabled" ? 1 : 0);
    },
  );

  test.each(["enabled", "disabled"] as const)(
    "a %s cutover row decides the Codex catalog overlay of a non-Codex turn without the frozen legacy pool",
    async (cutover) => {
      const result = await claimWithCutover(cutover, ordinaryPolicy);
      expect(result.legacyActiveCalls).toBe(0);
      expect(result.codexActive).toBe(cutover === "enabled");
    },
  );

  test("without a cutover row a non-Codex turn keeps the legacy overlay read", async () => {
    const result = await claimWithCutover("not_configured", ordinaryPolicy);
    expect(result.legacyActiveCalls).toBe(1);
    expect(result.codexActive).toBe(true);
  });

  test("the claim carries the stored lease-busy chain onto the attempt", async () => {
    const startedAt = "2026-10-08T12:00:00.000Z";
    const result = await claimWithCutover("enabled", codexPolicy, {
      subscriptionLeaseBusy: { startedAt, executionGeneration: 1 },
    });
    expect(result.subscriptionLeaseBusy).toEqual({
      startedAt: Date.parse(startedAt),
      executionGeneration: 1,
    });
    const none = await claimWithCutover("enabled", codexPolicy);
    expect(none.subscriptionLeaseBusy).toBeUndefined();
  });
});
