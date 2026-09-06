import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import type { Database, WorkspaceInsightsModelBundle } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

import {
  getWorkspaceInsights,
  normalizeWorkspaceInsightsFilter,
  WorkspaceInsightsFilterValidationError,
} from "../src/domain/insights";

const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const db = {} as Database;

function emptyModelBundle(): WorkspaceInsightsModelBundle {
  return {
    modelRows: [],
    priorModelRows: [],
    factBuckets: new Map(),
    rootDrivers: [],
    priorRootDrivers: [],
    scheduleFacts: [],
    facets: [],
    recentCalls: [],
    promptContributions: {
      estimatedTokens: 0,
      utf8Bytes: 0,
      coveredCalls: 0,
      totalCalls: 0,
      sources: [],
    },
  };
}

function emptyUsageBundle(): opengeniDb.WorkspaceInsightsUsageBundle {
  return {
    workspaceCreditMicros: 0,
    priorWorkspaceCreditMicros: 0,
    warmSeconds: 0,
    priorWarmSeconds: 0,
    buckets: new Map(),
    warmGroups: [],
    billableTokensUsed: 0,
    agentRunsUsed: 0,
  };
}

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

    const modelBundle = spyOn(opengeniDb, "readWorkspaceInsightsModelBundle").mockResolvedValue(
      emptyModelBundle(),
    );
    restores.push(() => modelBundle.mockRestore());
    const usageBundle = spyOn(opengeniDb, "readWorkspaceInsightsUsageBundle").mockResolvedValue(
      emptyUsageBundle(),
    );
    restores.push(() => usageBundle.mockRestore());
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
    return {
      requireWorkspace,
      machines,
      modelBundle,
      usageBundle,
      usageDay,
      usageHour,
      depth,
      floor,
    };
  }

  test("normalizes empty and valid boundary filters before analytical reads", async () => {
    const { modelBundle } = stubEmptyWorkspace();
    const provider = "p".repeat(256);
    const model = "m".repeat(512);

    await getWorkspaceInsights(db, testSettings({ sandboxSelfhostedEnabled: false }), {
      workspaceId: WORKSPACE,
      range: "week",
      provider: ` ${provider} `,
      model: `\n${model}\t`,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(modelBundle.mock.calls[0]?.[1]).toMatchObject({ provider, model });

    await getWorkspaceInsights(db, testSettings({ sandboxSelfhostedEnabled: false }), {
      workspaceId: WORKSPACE,
      range: "week",
      provider: " \t\n ",
      model: " all ",
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(modelBundle.mock.calls[1]?.[1]).toMatchObject({ provider: null, model: null });
  });

  test("rejects provider and model UTF-8 overflow before storage", async () => {
    const { requireWorkspace } = stubEmptyWorkspace();

    await expect(
      getWorkspaceInsights(db, testSettings({ sandboxSelfhostedEnabled: false }), {
        workspaceId: WORKSPACE,
        range: "week",
        provider: "p".repeat(257),
      }),
    ).rejects.toBeInstanceOf(WorkspaceInsightsFilterValidationError);
    await expect(
      getWorkspaceInsights(db, testSettings({ sandboxSelfhostedEnabled: false }), {
        workspaceId: WORKSPACE,
        range: "week",
        model: "m".repeat(513),
      }),
    ).rejects.toBeInstanceOf(WorkspaceInsightsFilterValidationError);
    expect(requireWorkspace).not.toHaveBeenCalled();
  });

  test("uses UTC-month model.tokens and agent_run.created for caps", async () => {
    const { usageBundle } = stubEmptyWorkspace();
    usageBundle.mockResolvedValue({
      ...emptyUsageBundle(),
      billableTokensUsed: 1_234,
      agentRunsUsed: 7,
    });

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
    const monthSince = usageBundle.mock.calls[0]?.[1].monthSince;
    expect(monthSince?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  test("does not invent machines when selfhosted is disabled", async () => {
    const { machines } = stubEmptyWorkspace();
    const { snapshot } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-07-15T12:00:00.000Z") },
    );
    expect(machines).not.toHaveBeenCalled();
    expect(snapshot.machinesOnline).toBe(0);
  });

  test("uses elapsed UTC-hour buckets for today and daily buckets for longer ranges", async () => {
    const { modelBundle, usageBundle, usageDay, usageHour } = stubEmptyWorkspace();

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
    expect(modelBundle.mock.calls[0]?.[1].granularity).toBe("hour");
    expect(usageBundle.mock.calls[0]?.[1].granularity).toBe("hour");
    expect(usageHour).not.toHaveBeenCalled();
    expect(usageDay).not.toHaveBeenCalled();

    const { snapshot: week } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "week", now: new Date("2026-07-15T12:34:56.000Z") },
    );

    expect(week.series).toHaveLength(7);
    expect(week.series[0]?.label).toBe("07-09");
    expect(week.series.at(-1)?.label).toBe("07-15");
    expect(modelBundle.mock.calls[1]?.[1].granularity).toBe("day");
    expect(usageBundle.mock.calls[1]?.[1].granularity).toBe("day");
    expect(usageDay).not.toHaveBeenCalled();
  });

  test("returns an empty public snapshot at exact UTC today, month, and year boundaries", async () => {
    const { modelBundle, usageBundle, usageDay, usageHour } = stubEmptyWorkspace();

    const cases = [
      { range: "today" as const, now: new Date("2026-07-15T00:00:00.000Z") },
      { range: "month" as const, now: new Date("2026-07-01T00:00:00.000Z") },
      { range: "ytd" as const, now: new Date("2026-01-01T00:00:00.000Z") },
    ];
    for (const { range, now } of cases) {
      const { snapshot } = await getWorkspaceInsights(
        db,
        testSettings({ sandboxSelfhostedEnabled: false }),
        { workspaceId: WORKSPACE, range, now },
      );

      expect(snapshot.windowStart).toBe(now.toISOString());
      expect(snapshot.windowEnd).toBe(now.toISOString());
      expect(snapshot.series).toEqual([]);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.recentCalls).toEqual([]);
      expect(snapshot.workspaceCreditUsd).toBe(0);
      expect(snapshot.creditUsd).toBe(0);

      const bundleInput = modelBundle.mock.calls.at(-1)?.[1];
      expect(bundleInput?.since.toISOString()).toBe(now.toISOString());
      expect(bundleInput?.until.toISOString()).toBe(now.toISOString());
    }

    expect(usageBundle).toHaveBeenCalledTimes(3);
    expect(usageHour).not.toHaveBeenCalled();
    expect(usageDay).not.toHaveBeenCalled();
  });

  test("keeps token/cache coverage and hypothetical provider cost separate from credits", async () => {
    const { modelBundle } = stubEmptyWorkspace();
    modelBundle.mockResolvedValue({
      ...emptyModelBundle(),
      modelRows: [
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
          equivalentCreditCostMicros: 9,
          equivalentCreditCostKnownCalls: 1,
        },
      ],
      factBuckets: new Map([
        [
          "2026-07-15T11:00",
          {
            costMicros: 0,
            estimatedProviderCostMicros: 8,
            estimatedProviderCostKnownCalls: 1,
            equivalentCreditCostMicros: 9,
            equivalentCreditCostKnownCalls: 1,
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
      recentCalls: [
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
          equivalentCreditCostMicros: 9,
          pricingSource: "configured_list_price",
        },
      ],
    });

    const { snapshot } = await getWorkspaceInsights(
      db,
      testSettings({ sandboxSelfhostedEnabled: false }),
      { workspaceId: WORKSPACE, range: "today", now: new Date("2026-07-15T12:00:00.000Z") },
    );

    expect(snapshot.creditUsd).toBe(0);
    expect(snapshot.estimatedProviderUsd).toBe(0.000008);
    expect(snapshot.estimatedProviderCostKnownCalls).toBe(1);
    expect(snapshot.equivalentCreditUsd).toBe(0.000009);
    expect(snapshot.equivalentCreditCostKnownCalls).toBe(1);
    expect(snapshot.modelCalls).toBe(2);
    expect(snapshot.models[0]).toMatchObject({
      totalTokens: 150,
      cacheInputTokens: 20,
      creditUsd: 0,
      estimatedProviderUsd: 0.000008,
      equivalentCreditUsd: 0.000009,
    });
    expect(snapshot.series[11]).toMatchObject({
      label: "11:00",
      totalTokens: 150,
      cacheHitPct: 50,
      estimatedProviderUsd: 0.000008,
      equivalentCreditUsd: 0.000009,
    });
    expect(snapshot.recentCalls[0]).toMatchObject({
      occurredAt: "2026-07-15T11:00:00.000Z",
      billing: "external",
      creditUsd: 0,
      estimatedProviderUsd: 0.000008,
      equivalentCreditUsd: 0.000009,
      pricingSource: "configured_list_price",
    });
  });

  test("uses durable titles and factual identifiers for untitled historical sessions", async () => {
    const { modelBundle, depth, floor } = stubEmptyWorkspace();
    modelBundle.mockResolvedValue({
      ...emptyModelBundle(),
      rootDrivers: [
        {
          rootSessionId: "11111111-1111-4111-8111-111111111111",
          title: null,
          pricedCostMicros: 0,
          estimatedProviderCostMicros: 0,
          estimatedProviderCostKnownCalls: 0,
          equivalentCreditCostMicros: 0,
          equivalentCreditCostKnownCalls: 0,
          totalTokens: 10,
          cachedTokens: 0,
          cacheInputTokens: 0,
        },
      ],
      recentCalls: [
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
          equivalentCreditCostMicros: null,
          pricingSource: null,
        },
      ],
    });
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

describe("normalizeWorkspaceInsightsFilter", () => {
  const utf8 = new TextEncoder();
  const providerMultibyteAtLimit = `${"é".repeat(127)}aa`;
  const modelMultibyteAtLimit = `${"é".repeat(255)}aa`;

  test("uses the exact 256/512 UTF-8 byte envelopes", () => {
    expect(utf8.encode(providerMultibyteAtLimit).byteLength).toBe(256);
    expect(utf8.encode(modelMultibyteAtLimit).byteLength).toBe(512);
    expect(normalizeWorkspaceInsightsFilter("p".repeat(256), "provider")).toBe("p".repeat(256));
    expect(normalizeWorkspaceInsightsFilter("m".repeat(512), "model")).toBe("m".repeat(512));
    expect(normalizeWorkspaceInsightsFilter(providerMultibyteAtLimit, "provider")).toBe(
      providerMultibyteAtLimit,
    );
    expect(normalizeWorkspaceInsightsFilter(modelMultibyteAtLimit, "model")).toBe(
      modelMultibyteAtLimit,
    );
  });

  test("rejects the exact ASCII and multibyte overflow boundaries", () => {
    expect(() => normalizeWorkspaceInsightsFilter("p".repeat(257), "provider")).toThrow(
      WorkspaceInsightsFilterValidationError,
    );
    expect(() => normalizeWorkspaceInsightsFilter("m".repeat(513), "model")).toThrow(
      WorkspaceInsightsFilterValidationError,
    );
    expect(() =>
      normalizeWorkspaceInsightsFilter(`${providerMultibyteAtLimit}a`, "provider"),
    ).toThrow("provider must be at most 256 UTF-8 bytes");
    expect(() => normalizeWorkspaceInsightsFilter(`${modelMultibyteAtLimit}a`, "model")).toThrow(
      "model must be at most 512 UTF-8 bytes",
    );
  });
});
