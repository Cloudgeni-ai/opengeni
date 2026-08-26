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
    const emptyHours = spyOn(opengeniDb, "aggregateModelCallFactsByHour").mockResolvedValue(
      new Map(),
    );
    restores.push(() => emptyHours.mockRestore());
    const usage = spyOn(opengeniDb, "sumUsageQuantityInRange").mockResolvedValue(0);
    restores.push(() => usage.mockRestore());
    const usageDay = spyOn(opengeniDb, "sumUsageQuantityByDay").mockResolvedValue(new Map());
    restores.push(() => usageDay.mockRestore());
    const usageHour = spyOn(opengeniDb, "sumUsageQuantityByHour").mockResolvedValue(new Map());
    restores.push(() => usageHour.mockRestore());
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
      deepestSessionId: null,
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
    const promptContributions = spyOn(
      opengeniDb,
      "aggregateModelContextContributions",
    ).mockResolvedValue({
      estimatedTokens: 0,
      utf8Bytes: 0,
      coveredCalls: 0,
      totalCalls: 0,
      sources: [],
    });
    restores.push(() => promptContributions.mockRestore());
    return {
      machines,
      emptyAgg,
      emptyDays,
      emptyHours,
      usageDay,
      usageHour,
      recent,
      drivers,
      depth,
      floor,
    };
  }

  test("uses UTC-month model.tokens and agent_run.created for caps", async () => {
    stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantitySinceForInsights").mockImplementation(
      async (_db, input) => {
        if (input.eventType === "model.tokens") return 1_234;
        if (input.eventType === "agent_run.created") return 7;
        throw new Error(`unexpected cap meter ${input.eventType}`);
      },
    );
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
    const capSpy = spyOn(opengeniDb, "sumUsageQuantitySinceForInsights").mockResolvedValue(0);
    restores.push(() => capSpy.mockRestore());

    const { snapshot } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-07-15T12:00:00.000Z") },
    );
    expect(machines).not.toHaveBeenCalled();
    expect(snapshot.machinesOnline).toBe(0);
  });

  test("uses elapsed UTC-hour buckets for today and daily buckets for longer ranges", async () => {
    const { emptyDays, emptyHours, usageDay, usageHour } = stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantitySinceForInsights").mockResolvedValue(0);
    restores.push(() => capSpy.mockRestore());

    const { snapshot: today } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-07-15T12:34:56.000Z") },
    );

    expect(today.series).toHaveLength(13);
    expect(today.series.map((point) => point.label)).toEqual([
      "00:00",
      "01:00",
      "02:00",
      "03:00",
      "04:00",
      "05:00",
      "06:00",
      "07:00",
      "08:00",
      "09:00",
      "10:00",
      "11:00",
      "12:00",
    ]);
    expect(today.seriesLabel).toBe("Credit $ / UTC hour");
    expect(emptyHours).toHaveBeenCalledTimes(1);
    expect(usageHour).toHaveBeenCalledTimes(2);
    expect(emptyDays).not.toHaveBeenCalled();
    expect(usageDay).not.toHaveBeenCalled();

    const { snapshot: week } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "week", now: new Date("2026-07-15T12:34:56.000Z") },
    );

    expect(week.series).toHaveLength(7);
    expect(week.series[0]?.label).toBe("07-09");
    expect(week.series.at(-1)?.label).toBe("07-15");
    expect(emptyDays).toHaveBeenCalledTimes(1);
    expect(usageDay).toHaveBeenCalledTimes(2);
  });

  test("keeps token/cache coverage and hypothetical provider cost separate from credits", async () => {
    const { emptyAgg, emptyHours, recent } = stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantitySinceForInsights").mockResolvedValue(0);
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
    emptyHours.mockResolvedValue(
      new Map([
        [
          "2026-07-15T11:00",
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
        sessionDepth: 0,
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
    expect(snapshot.series[11]).toMatchObject({
      label: "11:00",
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

  test("uses durable titles and factual identifiers for untitled historical sessions", async () => {
    const { drivers, depth, floor, recent } = stubEmptyWorkspace();
    const capSpy = spyOn(opengeniDb, "sumUsageQuantitySinceForInsights").mockResolvedValue(0);
    restores.push(() => capSpy.mockRestore());
    drivers.mockResolvedValue([
      {
        rootSessionId: "11111111-1111-4111-8111-111111111111",
        title: null,
        pricedCostMicros: 0,
        estimatedProviderCostMicros: 0,
        estimatedProviderCostKnownCalls: 0,
        totalTokens: 10,
        cachedTokens: 0,
        cacheInputTokens: 0,
      },
    ]);
    floor.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: null,
        status: "running",
        directControlState: "active",
        nestedAgentDepth: 2,
        model: "gpt-5",
        sandboxBackend: "modal",
        updatedAt: new Date("2026-08-26T07:00:00.000Z"),
        createdAt: new Date("2026-08-26T06:00:00.000Z"),
      },
    ]);
    depth.mockResolvedValue({
      buckets: [{ depth: 2, sessions: 1 }],
      goalsActive: 0,
      goalsCompleted: 0,
      sessionsTouched: 1,
      rootSessions: 0,
      deepestDepth: 2,
      deepestSessionId: "22222222-2222-4222-8222-222222222222",
      deepestSessionTitle: "",
      avgDepth: 2,
    });
    recent.mockResolvedValue([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurredAt: new Date("2026-08-26T07:00:00.000Z"),
        recordedAt: new Date("2026-08-26T07:00:01.000Z"),
        sessionId: "22222222-2222-4222-8222-222222222222",
        sessionTitle: null,
        sessionDepth: 2,
        turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        provider: "openai",
        providerApi: "responses",
        model: "gpt-5",
        billingPath: "opengeni_credits",
        inputTokens: 5,
        outputTokens: 5,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 10,
        pricedCostMicros: 0,
        estimatedProviderCostMicros: null,
        pricingSource: null,
      },
    ]);

    const { snapshot } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-08-26T08:00:00.000Z") },
    );

    expect(snapshot.drivers[0]?.label).toBe("Session 11111111");
    expect(snapshot.floor[0]?.title).toBe("Agent 22222222");
    expect(snapshot.recentCalls[0]?.sessionTitle).toBe("Agent 22222222");
    expect(snapshot.deepestSessionTitle).toBe("Agent 22222222");
  });
});
