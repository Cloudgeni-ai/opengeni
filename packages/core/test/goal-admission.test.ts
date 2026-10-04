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
    resume: (
      human: string | null = null,
      latencyMode: "standard" | "fast" | "priority" = "standard",
    ) =>
      assertGoalResumeAllowed(
        { db: database, settings },
        { accountId, workspaceId, model, latencyMode, codexCompactionMode: "portable" },
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

test("Resume uses only promotional credits eligible for the chosen model", async () => {
  const settings = testSettings({
    billingMode: "stripe",
    openaiModel: "gpt-6-luna",
    openaiAllowedModels: "gpt-6-luna,gpt-6-sol",
  });
  const scoped = spyOn(catalog, "resolveWorkspaceCatalogSettings").mockResolvedValue({
    settings,
  } as never);
  const policy = spyOn(db, "getWorkspaceModelPolicy").mockResolvedValue(null);
  const codex = spyOn(db, "isCodexBilledTurn").mockResolvedValue(false);
  const allowance = spyOn(db, "checkWorkspaceAllowance").mockResolvedValue(null);
  const balance = spyOn(db, "getBillingBalance").mockResolvedValue({
    accountId,
    balanceMicros: 100,
    generalBalanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
    promotionalCredits: [
      {
        grantId: crypto.randomUUID(),
        label: "Welcome credits",
        remainingMicros: 100,
        eligibleModelIds: ["gpt-6-luna"],
      },
    ],
  });
  restores.push(
    ...[scoped, policy, codex, allowance, balance].map((spy) => () => spy.mockRestore()),
  );
  for (const model of ["gpt-6-luna", "gpt-6-sol"]) {
    const resume = assertGoalResumeAllowed(
      { db: database, settings },
      { accountId, workspaceId, model, codexCompactionMode: "portable" },
      null,
    );
    if (model === "gpt-6-luna") await expect(resume).resolves.toBeUndefined();
    else await expect(resume).rejects.toMatchObject({ pausedReason: "credits" });
  }
});

test("Resume rejects an unsupported latency mode before funding admission", async () => {
  const value = fixture(testSettings().openaiModel);
  await expect(value.resume(null, "fast")).rejects.toThrow("latency mode");
  expect(value.admission).not.toHaveBeenCalled();
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

test("a host funding denial is neutral about the host's private balance and policy", async () => {
  const settings = testSettings();
  const value = fixture(settings.openaiModel, settings);
  value.admission.mockResolvedValue("insufficient_credits");
  const entitlements = {
    admitRun: async () => ({ allowed: false as const, reason: "fixture quota exhausted" }),
  };
  const services = { db: database, settings, entitlements };
  expect(
    await goalRunBudgetBlocked(services, { accountId, workspaceId, model: settings.openaiModel }),
  ).toEqual({
    pausedReason: "usage_policy",
    message: "The application's usage policy blocks another run. Resume when it allows.",
  });
  await expect(
    assertGoalResumeAllowed(
      services,
      { accountId, workspaceId, model: settings.openaiModel, codexCompactionMode: "portable" },
      null,
    ),
  ).rejects.toThrow("usage policy blocks");
});

for (const [denial, pausedReason, message] of [
  ["insufficient_credits", "credits", "Insufficient Opengeni credits"],
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
