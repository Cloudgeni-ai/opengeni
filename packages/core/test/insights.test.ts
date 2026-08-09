import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import { getWorkspaceInsights } from "../src/domain/insights";

const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const db = {} as Database;

describe("getWorkspaceInsights", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()?.();
  });

  function stubEmptyWorkspace() {
    const requireWorkspace = spyOn(opengeniDb, "requireWorkspace").mockResolvedValue({
      id: WORKSPACE,
      accountId: "11111111-1111-4111-8111-111111111111",
      name: "Acme",
    } as never);
    restores.push(() => requireWorkspace.mockRestore());

    const emptyAgg = spyOn(opengeniDb, "aggregateModelCallFacts").mockResolvedValue([]);
    restores.push(() => emptyAgg.mockRestore());
    const emptyDays = spyOn(opengeniDb, "aggregateModelCallFactsByDay").mockResolvedValue(
      new Map(),
    );
    restores.push(() => emptyDays.mockRestore());
    const usage = spyOn(opengeniDb, "sumUsageQuantityInRange").mockResolvedValue(0);
    restores.push(() => usage.mockRestore());
    const usageDay = spyOn(opengeniDb, "sumUsageQuantityByDay").mockResolvedValue(new Map());
    restores.push(() => usageDay.mockRestore());
    const warmGroups = spyOn(opengeniDb, "aggregateWarmSecondsByGroup").mockResolvedValue([]);
    restores.push(() => warmGroups.mockRestore());
    const liveWarm = spyOn(opengeniDb, "listLiveWarmLeases").mockResolvedValue([]);
    restores.push(() => liveWarm.mockRestore());
    const drivers = spyOn(opengeniDb, "aggregateRootSessionDrivers").mockResolvedValue([]);
    restores.push(() => drivers.mockRestore());
    const scheduleFacts = spyOn(opengeniDb, "aggregateScheduleFacts").mockResolvedValue([]);
    restores.push(() => scheduleFacts.mockRestore());
    const tasks = spyOn(opengeniDb, "listScheduledTasks").mockResolvedValue([]);
    restores.push(() => tasks.mockRestore());
    const fires = spyOn(opengeniDb, "countScheduledTaskFires").mockResolvedValue(new Map());
    restores.push(() => fires.mockRestore());
    const depth = spyOn(opengeniDb, "aggregateSessionDepth").mockResolvedValue({
      buckets: [],
      goalsActive: 0,
      goalsCompleted: 0,
      sessionsTouched: 0,
      rootSessions: 0,
      deepestDepth: 0,
      deepestSessionTitle: "",
      avgDepth: 0,
    });
    restores.push(() => depth.mockRestore());
    const floor = spyOn(opengeniDb, "listFloorSessions").mockResolvedValue([]);
    restores.push(() => floor.mockRestore());
    const attached = spyOn(opengeniDb, "countSessionsAttachedToGroups").mockResolvedValue(
      new Map(),
    );
    restores.push(() => attached.mockRestore());
    const machines = spyOn(opengeniDb, "countOnlineMachines").mockResolvedValue(0);
    restores.push(() => machines.mockRestore());
    const facets = spyOn(opengeniDb, "listModelCallFacets").mockResolvedValue([]);
    restores.push(() => facets.mockRestore());
    const recent = spyOn(opengeniDb, "listRecentModelCalls").mockResolvedValue([]);
    restores.push(() => recent.mockRestore());
    return { machines, emptyAgg, emptyDays, recent };
  }

  test("uses UTC-month model.tokens and agent_run.created for caps", async () => {
    stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantity").mockImplementation(async (_db, input) => {
      if (input.eventType === "model.tokens") return 1_234;
      if (input.eventType === "agent_run.created") return 7;
      throw new Error(`unexpected cap meter ${input.eventType}`);
    });
    restores.push(() => capSpy.mockRestore());

    const now = new Date("2026-07-15T12:00:00.000Z");
    const settings = testSettings({
      usageLimitsMode: "static",
      staticUsageLimitsJson: JSON.stringify({
        maxMonthlyTokensPerWorkspace: 10_000,
        maxMonthlyAgentRunsPerWorkspace: 100,
      }),
      sandboxSelfhostedEnabled: false,
    });
    const { snapshot } = await getWorkspaceInsights(db, settings, {
      workspaceId: WORKSPACE,
      range: "week",
      now,
    });

    expect(snapshot.timezone).toBe("UTC");
    expect(snapshot.billableTokensUsed).toBe(1_234);
    expect(snapshot.agentRunsUsed).toBe(7);
    expect(snapshot.billableTokenCap).toBe(10_000);
    expect(snapshot.agentRunCap).toBe(100);
    expect(snapshot.selfhostedEnabled).toBe(false);
    expect(snapshot.machinesOnline).toBe(0);
    expect(
      capSpy.mock.calls.every(([, input]) => {
        const since = input.since as Date;
        return (
          since.getUTCFullYear() === 2026 &&
          since.getUTCMonth() === 6 &&
          since.getUTCDate() === 1 &&
          since.getUTCHours() === 0
        );
      }),
    ).toBe(true);
  });

  test("does not invent machines when selfhosted is disabled", async () => {
    const { machines } = stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(0);
    restores.push(() => capSpy.mockRestore());

    const { snapshot } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-07-15T12:00:00.000Z") },
    );
    expect(machines).not.toHaveBeenCalled();
    expect(snapshot.machinesOnline).toBe(0);
  });

  test("keeps token/cache coverage and hypothetical provider cost separate from credits", async () => {
    const { emptyAgg, emptyDays, recent } = stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantity").mockResolvedValue(0);
    restores.push(() => capSpy.mockRestore());
    emptyAgg
      .mockResolvedValueOnce([
        {
          provider: "codex-subscription",
          model: "codex/gpt-5.6-sol",
          billingPath: "external",
          calls: 2,
          inputTokens: 100,
          outputTokens: 50,
          cachedTokens: 10,
          cacheInputTokens: 20,
          cacheWriteTokens: 3,
          reasoningTokens: 7,
          totalTokens: 150,
          tokenKnownCalls: 2,
          cacheKnownCalls: 1,
          pricedCostMicros: 0,
          estimatedProviderCostMicros: 8,
          estimatedProviderCostKnownCalls: 1,
        },
      ])
      .mockResolvedValueOnce([]);
    emptyDays.mockResolvedValue(
      new Map([
        [
          "2026-07-15",
          {
            costMicros: 0,
            estimatedProviderCostMicros: 8,
            estimatedProviderCostKnownCalls: 1,
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 10,
            cacheInputTokens: 20,
            cacheWriteTokens: 3,
            reasoningTokens: 7,
            totalTokens: 150,
            tokenKnownCalls: 2,
            cacheKnownCalls: 1,
            calls: 2,
          },
        ],
      ]),
    );
    recent.mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurredAt: new Date("2026-07-15T11:00:00.000Z"),
        recordedAt: new Date("2026-07-15T11:00:01.000Z"),
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sessionTitle: "External session",
        turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        provider: "codex-subscription",
        providerApi: "responses",
        model: "codex/gpt-5.6-sol",
        billingPath: "external",
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 10,
        cacheWriteTokens: 3,
        reasoningTokens: 7,
        totalTokens: 150,
        pricedCostMicros: 0,
        estimatedProviderCostMicros: 8,
        pricingSource: "configured_list_price",
      },
    ]);

    const { snapshot } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-07-15T12:00:00.000Z") },
    );

    expect(snapshot.creditUsd).toBe(0);
    expect(snapshot.estimatedProviderUsd).toBe(0.000008);
    expect(snapshot.estimatedProviderCostKnownCalls).toBe(1);
    expect(snapshot.modelCalls).toBe(2);
    expect(snapshot.models[0]).toMatchObject({
      totalTokens: 150,
      cacheInputTokens: 20,
      creditUsd: 0,
      estimatedProviderUsd: 0.000008,
    });
    expect(snapshot.series[0]).toMatchObject({
      totalTokens: 150,
      cacheHitPct: 50,
      estimatedProviderUsd: 0.000008,
    });
    expect(snapshot.recentCalls[0]).toMatchObject({
      occurredAt: "2026-07-15T11:00:00.000Z",
      billing: "external",
      creditUsd: 0,
      estimatedProviderUsd: 0.000008,
      pricingSource: "configured_list_price",
    });
  });
});
