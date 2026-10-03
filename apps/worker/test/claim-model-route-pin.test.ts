import { describe, expect, spyOn, test } from "bun:test";
import {
  resolveModelProvider,
  resolveTurnExecutionPolicyV1,
  withModelFallbackRouteSelection,
  type Settings,
} from "@opengeni/config";
import { metadataWithTurnExecutionPolicyV1 } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { claimTurnAttempt, type ClaimTurnDeps } from "../src/activities/agent-turn/claim";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import * as capabilities from "../src/activities/capabilities";

const PRODUCT = "gpt-5.6-luna";
const declared = testSettings({
  sandboxBackend: "none",
  vercelAiGatewayApiKey: "vck_test",
  resolvedModelFallbackRoutesJson: JSON.stringify([
    {
      productId: PRODUCT,
      via: "opengeni-gateway",
      upstreamModelId: "openai/gpt-5.6-luna",
      providers: ["openai"],
    },
  ]),
});
const onFallback = withModelFallbackRouteSelection(declared, [PRODUCT]);
const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
};
const request = {
  modelId: PRODUCT,
  requestedModelId: null,
  modelSource: "session" as const,
  reasoningEffort: "low" as const,
  reasoningSource: "session" as const,
  latencyMode: "standard" as const,
  latencyModeSource: "session" as const,
};

async function claimedSettings(current: Settings, acceptedOn: Settings): Promise<Settings> {
  const policy = resolveTurnExecutionPolicyV1(acceptedOn, request);
  const context = createTurnContext({ settings: current, cancellationRequestedAt: null });
  const stop = new Error("fixture stopped at runtime configuration");
  let configured: Settings | null = null;
  const spies = [
    spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings: current } as Awaited<
      ReturnType<typeof core.resolveCatalogSettings>
    >),
    spyOn(db, "claimSessionWorkForAttempt").mockResolvedValue({
      action: "claimed",
      turn: {
        id: scope.turnId,
        sessionId: scope.sessionId,
        executionGeneration: 2,
        triggerEventId: "66666666-6666-4666-8666-666666666666",
        source: "user",
        initiator: { kind: "service", subjectId: "internal-update" },
        initiatorContext: {},
        metadata: metadataWithTurnExecutionPolicyV1({}, policy),
        model: PRODUCT,
        reasoningEffort: "low",
        latencyMode: "standard",
      },
    } as Awaited<ReturnType<typeof db.claimSessionWorkForAttempt>>),
    spyOn(db, "requireSession").mockResolvedValue({
      id: scope.sessionId,
      metadata: {},
    } as Awaited<ReturnType<typeof db.requireSession>>),
    spyOn(db, "workspaceCodexSubscriptionActive").mockResolvedValue(false),
    spyOn(capabilities, "settingsWithEnabledCapabilityMcpServers").mockResolvedValue(current),
    spyOn(capabilities, "settingsWithCodexCredential").mockResolvedValue(current),
    spyOn(capabilities, "settingsWithWorkspaceGatewayCredential").mockResolvedValue(current),
    spyOn(capabilities, "settingsWithWorkspaceOpenRouterCredential").mockResolvedValue(current),
    spyOn(capabilities, "settingsWithOrganizationProviderCredentials").mockResolvedValue(current),
    spyOn(db, "installOrReadTurnExecutionPolicyForAttempt").mockResolvedValue({
      accepted: true,
      policy,
    } as Awaited<ReturnType<typeof db.installOrReadTurnExecutionPolicyForAttempt>>),
  ];
  try {
    await expect(
      claimTurnAttempt({
        ...context,
        settings: current,
        catalogSourceSettings: current,
        db: {},
        runtime: {
          configure: (settings: Settings) => {
            configured = settings;
            throw stop;
          },
        },
        input: {
          ...scope,
          workflowId: "fixture-workflow",
          workflowRunId: "fixture-workflow-run",
          trigger: { kind: "next" },
        },
        dispatchId: "fixture-dispatch",
        leases: { codex: { holderId: null } },
      } as unknown as ClaimTurnDeps),
    ).rejects.toBe(stop);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  if (!configured) throw new Error("claim never configured the runtime");
  return configured;
}

describe("accepted turns keep their frozen credits route at claim", () => {
  test("a turn accepted on the primary route still runs there after the switch moves", async () => {
    const settings = await claimedSettings(onFallback, declared);
    expect(resolveModelProvider(settings, PRODUCT)?.provider.id).toBe("openai");
  });

  test("a turn accepted on the fallback route still runs there after the switch moves back", async () => {
    const settings = await claimedSettings(declared, onFallback);
    expect(resolveModelProvider(settings, PRODUCT)?.provider.id).toBe("opengeni-gateway");
  });
});
