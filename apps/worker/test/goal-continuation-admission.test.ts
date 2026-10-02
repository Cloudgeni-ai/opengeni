import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as core from "@opengeni/core";
import { configuredModels, withCodexCatalogProvider, type Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { createGoalActivities } from "../src/activities/goals";
import type { ControlActivityServices } from "../src/activities/types";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const input = { accountId: workspaceId, workspaceId, sessionId, workflowId: "goal-test" };
const restores: Array<() => void> = [];
afterEach(() =>
  restores
    .splice(0)
    .reverse()
    .forEach((restore) => restore()),
);

function fixture(model: string, status: string, settings = testSettings()) {
  const goal = spyOn(db, "getSessionGoal").mockResolvedValue({ status: "active" } as never);
  const session = spyOn(db, "requireSession").mockResolvedValue({
    model,
    status,
    reasoningEffort: "xhigh",
    latencyMode: "standard",
    tools: [],
    firstPartyMcpTools: [],
    sandboxBackend: "none",
  } as never);
  const catalog = spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as never);
  const policy = spyOn(db, "getWorkspaceModelPolicy").mockResolvedValue(null);
  const materialize = spyOn(db, "materializeGoalContinuation");
  const publish = spyOn({ publish: async () => {} }, "publish");
  restores.push(
    ...[goal, session, catalog, policy, materialize].map((spy) => () => spy.mockRestore()),
  );
  const services = { db: {}, bus: { publish }, settings } as unknown as ControlActivityServices;
  return {
    catalog,
    policy,
    materialize,
    publish,
    activities: createGoalActivities(async () => services),
  };
}

function codexSettings(): Settings {
  const settings = withCodexCatalogProvider(testSettings({ codexSubscriptionEnabled: true }));
  const providers = JSON.parse(settings.modelProvidersJson);
  const provider = providers.find(
    (candidate: { id: string }) => candidate.id === "codex-subscription",
  );
  provider.models.push({
    ...provider.models[0],
    id: "codex/gpt-6.1-sol",
    upstreamModelId: "gpt-6.1-sol",
  });
  return { ...settings, modelProvidersJson: JSON.stringify(providers) };
}

test("a workspace policy denial reaches a visible pause without choosing another model", async () => {
  const value = fixture("codex/gpt-6.1-sol", "completed", codexSettings());
  value.policy.mockResolvedValue({ allowedProviders: null, allowedModels: [] } as never);
  value.materialize.mockImplementation(async (_db, candidate) => {
    expect(candidate.policy.turnExecutionPolicy).toBeUndefined();
    expect(candidate.policy.model).toBe("codex/gpt-6.1-sol");
    expect(await candidate.admission!({} as db.Database, null)).toEqual({
      budgetBlocked: expect.stringContaining("workspace model policy blocks"),
      budgetPausedReason: "limits",
    });
    return { action: "paused", events: [] } as never;
  });
  expect(await value.activities.maybeContinueGoal(input)).toEqual({ action: "paused" });
});

function retiredSettings(): Settings {
  const settings = codexSettings();
  const model = configuredModels(settings).find(
    (candidate) => candidate.id === "codex/gpt-6.1-sol",
  )!;
  return {
    ...settings,
    resolvedCodexModelsJson: JSON.stringify([
      {
        id: model.id,
        upstreamModelId: model.upstreamModelId,
        capabilities: model.capabilities,
        retired: true,
      },
    ]),
  };
}

test("terminal sessions with active goals never resolve obsolete catalogs or enqueue work", async () => {
  for (const status of ["failed", "cancelled"]) {
    const value = fixture("codex/gpt-5.6-sol", status, retiredSettings());
    value.catalog.mockRejectedValue(new Error("catalog must not be read for terminal work"));
    expect(await value.activities.maybeContinueGoal(input)).toEqual({ action: "none" });
    expect(value.catalog).not.toHaveBeenCalled();
    expect(value.materialize).not.toHaveBeenCalled();
    expect(value.publish).not.toHaveBeenCalled();
    restores
      .splice(0)
      .reverse()
      .forEach((restore) => restore());
  }
});

for (const [model, settings, reason] of [
  ["removed/model", testSettings(), "no longer in the deployment"],
  ["codex/gpt-6.1-sol", retiredSettings(), "retired from new selection"],
] as const) {
  test(`unavailable continuation model ${model} reaches a visible locked pause`, async () => {
    const value = fixture(model, "completed", settings);
    const event = { type: "goal.paused" };
    value.materialize.mockImplementation(async (_db, candidate) => {
      expect(candidate.policy.turnExecutionPolicy).toBeUndefined();
      expect(candidate.policy.model).toBe(model);
      expect(await candidate.admission!({} as db.Database, null)).toEqual({
        budgetBlocked: expect.stringContaining(reason),
        budgetPausedReason: "limits",
      });
      return { action: "paused", events: [event] } as never;
    });
    expect(await value.activities.maybeContinueGoal(input)).toEqual({ action: "paused" });
    expect(value.materialize).toHaveBeenCalledTimes(1);
    expect(value.publish).toHaveBeenCalledWith(workspaceId, sessionId, [event]);
  });
}

test("a continuation preserves the effective started model and effort", async () => {
  const value = fixture("codex/gpt-6.1-sol", "completed", codexSettings());
  value.materialize.mockImplementation(async (_db, candidate) => {
    expect(candidate.policy).toMatchObject({
      model: "codex/gpt-6.1-sol",
      reasoningEffort: "xhigh",
      latencyMode: "standard",
      turnExecutionPolicy: {
        productModelId: "codex/gpt-6.1-sol",
        modelSource: "continuation",
        reasoningSource: "continuation",
      },
    });
    return { action: "continue", events: [] };
  });
  expect(await value.activities.maybeContinueGoal(input)).toEqual({ action: "continue" });
});
