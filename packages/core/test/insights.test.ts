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
    return { machines };
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
});
