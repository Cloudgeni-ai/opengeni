import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as catalog from "../src/model-catalog";
import * as runAdmission from "../src/billing/agent-run-admission";
import { testSettings } from "@opengeni/testing";
import { withClaudeConnectionCatalog } from "@opengeni/config";
import {
  assertGoalResumeAllowed,
  GoalResumeBlockedError,
  goalRunBudgetBlocked,
} from "../src/goal-admission";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const database = {} as db.Database;
const restores: Array<() => void> = [];
afterEach(() =>
  restores
    .splice(0)
    .reverse()
    .forEach((restore) => restore()),
);

function fixture(model: string, settings = testSettings()) {
  const scoped = spyOn(catalog, "resolveWorkspaceCatalogSettings").mockResolvedValue({
    settings,
  } as never);
  const policy = spyOn(db, "getWorkspaceModelPolicy").mockResolvedValue(null);
  const admission = spyOn(runAdmission, "agentRunAdmissionDenial").mockResolvedValue(null);
  restores.push(...[scoped, policy, admission].map((spy) => () => spy.mockRestore()));
  return {
    scoped,
    policy,
    admission,
    resume: (human: string | null = null) =>
      assertGoalResumeAllowed(
        { db: database, settings },
        { accountId, workspaceId, model, codexCompactionMode: "portable" },
        human === null ? null : { initiatingHumanSubjectId: human },
      ),
  };
}

test("Resume uses scoped models and the original causal human for admission", async () => {
  const settings = withClaudeConnectionCatalog(testSettings({ claudeSubscriptionEnabled: true }), {
    claude_subscription: { models: [{ upstreamModelId: "claude-fixture" }] },
  });
  const model = "organization-claude-subscription/claude-fixture";
  const value = fixture(model, settings);
  await value.resume("user:fixture-origin");
  expect(value.scoped).toHaveBeenCalledWith(database, settings, {
    accountId,
    workspaceId,
    retainedProductModelId: model,
  });
  expect(value.admission).toHaveBeenCalledWith(
    { db: database, settings },
    {
      accountId,
      workspaceId,
      model,
      requestedAgentRuns: 1,
      initiatingHumanSubjectId: "user:fixture-origin",
    },
  );
});

test("Resume rejects unavailable models before funding admission", async () => {
  const value = fixture("removed/fixture-model");
  await expect(value.resume()).rejects.toBeInstanceOf(GoalResumeBlockedError);
  await expect(value.resume()).rejects.toThrow("Choose an available model");
  expect(value.admission).not.toHaveBeenCalled();
});

test("Resume preserves policy denials instead of choosing a fallback model", async () => {
  const value = fixture(testSettings().openaiModel);
  value.policy.mockResolvedValue({ allowedProviders: null, allowedModels: [] } as never);
  await expect(value.resume()).rejects.toThrow("Workspace policy blocks");
  expect(value.admission).not.toHaveBeenCalled();
});

for (const [denial, pausedReason, message] of [
  ["insufficient_credits", "credits", "Insufficient OpenGeni credits"],
  ["allowance_exhausted", "allowance", "usage allowance exhausted"],
  ["monthly_model_cost_limit", "budget", "spending limit reached"],
  ["monthly_agent_run_limit", "usage_limit", "agent run limit reached"],
] as const) {
  test(`${denial} keeps its distinct reason and blocks Resume`, async () => {
    const settings = testSettings();
    const value = fixture(settings.openaiModel, settings);
    value.admission.mockResolvedValue(denial);
    expect(
      await goalRunBudgetBlocked(
        { db: database, settings },
        { accountId, workspaceId, model: settings.openaiModel },
      ),
    ).toMatchObject({ pausedReason, message: expect.stringContaining(message) });
    try {
      await value.resume();
      throw new Error("Resume unexpectedly allowed");
    } catch (error) {
      expect(error).toBeInstanceOf(GoalResumeBlockedError);
      expect((error as GoalResumeBlockedError).pausedReason).toBe(pausedReason);
    }
  });
}
