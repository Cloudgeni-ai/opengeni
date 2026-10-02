import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import * as opengeniCore from "@opengeni/core";
import { testSettings } from "@opengeni/testing";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import { metadataWithTurnExecutionPolicyV1 } from "@opengeni/contracts";
import { agentRunAdmissionDenial } from "../src/activities/agent-run-admission";
import { createGoalActivities, goalRunBudgetBlocked } from "../src/activities/goals";
import type { ControlActivityServices } from "../src/activities/types";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";

function mockZeroBalance(): () => void {
  const spy = spyOn(opengeniDb, "getBillingBalance").mockResolvedValue({
    accountId: ACCOUNT,
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
  return () => spy.mockRestore();
}

function mockCodexBilled(active: boolean): () => void {
  const spy = spyOn(opengeniDb, "isCodexBilledTurn").mockResolvedValue(active);
  return () => spy.mockRestore();
}

describe("worker agent-run admission funding", () => {
  let allowance: ReturnType<typeof spyOn<typeof opengeniDb, "checkWorkspaceAllowance">>;
  beforeEach(() => {
    allowance = spyOn(opengeniDb, "checkWorkspaceAllowance").mockResolvedValue(null);
  });
  afterEach(() => allowance.mockRestore());

  test("admits SuperGrok subscription runs with zero OpenGeni credits", async () => {
    const restoreBalance = mockZeroBalance();
    const restoreCodex = mockCodexBilled(false);
    try {
      expect(
        await agentRunAdmissionDenial(
          {
            db: {} as opengeniDb.Database,
            entitlements: null,
            settings: testSettings({
              billingMode: "stripe",
              usageLimitsMode: "managed",
              supergrokSubscriptionEnabled: true,
            }),
          },
          {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: "supergrok/grok-4.7",
            requestedAgentRuns: 1,
          },
        ),
      ).toBeNull();
    } finally {
      restoreCodex();
      restoreBalance();
    }
  });

  test("keeps an unconnected Codex model behind the credit gate", async () => {
    const restoreBalance = mockZeroBalance();
    const restoreCodex = mockCodexBilled(false);
    try {
      expect(
        await agentRunAdmissionDenial(
          {
            db: {} as opengeniDb.Database,
            entitlements: null,
            settings: testSettings({
              billingMode: "stripe",
              usageLimitsMode: "managed",
              codexSubscriptionEnabled: true,
            }),
          },
          {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: "codex/gpt-5.6-sol",
            requestedAgentRuns: 1,
          },
        ),
      ).toBe("insufficient_credits");
    } finally {
      restoreCodex();
      restoreBalance();
    }
  });

  test.each([null, "user:schedule-creator"])(
    "checks allowance for service-authored credit work with frozen human %s",
    async (initiatingHumanSubjectId) => {
      const restoreCodex = mockCodexBilled(false);
      const services = {
        db: {} as opengeniDb.Database,
        entitlements: null,
        settings: testSettings({ billingMode: "disabled", usageLimitsMode: "none" }),
      };
      allowance.mockResolvedValue({
        code: "allowance_exhausted",
        scope: initiatingHumanSubjectId ? "member" : "workspace",
        resetsAt: null,
        ...(initiatingHumanSubjectId ? { subjectId: initiatingHumanSubjectId } : {}),
        message: "Exhausted",
      });
      try {
        expect(
          await agentRunAdmissionDenial(services, {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: "scripted-model",
            requestedAgentRuns: 0,
            initiatingHumanSubjectId,
          }),
        ).toBe("allowance_exhausted");
        expect(allowance).toHaveBeenCalledWith(services.db, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: initiatingHumanSubjectId,
        });
      } finally {
        restoreCodex();
      }
    },
  );

  test("checks allowances even after credit entitlements admit a run", async () => {
    const restoreCodex = mockCodexBilled(false);
    const services = {
      db: {} as opengeniDb.Database,
      entitlements: {
        admitRun: async () => ({ allowed: true }),
      } as unknown as Parameters<typeof agentRunAdmissionDenial>[0]["entitlements"],
      settings: testSettings({ billingMode: "stripe", usageLimitsMode: "managed" }),
    };
    allowance.mockResolvedValue({
      code: "allowance_exhausted",
      scope: "workspace",
      resetsAt: "2026-10-01T00:00:00.000Z",
      message: "Exhausted",
    });
    try {
      expect(
        await agentRunAdmissionDenial(services, {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          model: "scripted-model",
          requestedAgentRuns: 1,
        }),
      ).toBe("allowance_exhausted");
    } finally {
      restoreCodex();
    }
  });

  test.each([
    { model: "codex/gpt-5.6-sol", active: true, codexSubscriptionEnabled: true },
    { model: "supergrok/grok-4.7", active: false, supergrokSubscriptionEnabled: true },
  ])(
    "exempts externally funded $model from exhausted allowances",
    async ({ model, active, ...overrides }) => {
      const restoreCodex = mockCodexBilled(active);
      allowance.mockResolvedValue({
        code: "allowance_exhausted",
        scope: "workspace",
        resetsAt: null,
        message: "Exhausted",
      });
      try {
        expect(
          await agentRunAdmissionDenial(
            {
              db: {} as opengeniDb.Database,
              entitlements: null,
              settings: testSettings({
                billingMode: "stripe",
                usageLimitsMode: "managed",
                ...overrides,
              }),
            },
            {
              accountId: ACCOUNT,
              workspaceId: WORKSPACE,
              model,
              requestedAgentRuns: 1,
              initiatingHumanSubjectId: "user:schedule-creator",
            },
          ),
        ).toBeNull();
        expect(allowance).not.toHaveBeenCalled();
      } finally {
        restoreCodex();
      }
    },
  );

  test("goal allowance refusal uses the allowance pause reason", async () => {
    const restoreCodex = mockCodexBilled(false);
    allowance.mockResolvedValue({
      code: "allowance_exhausted",
      scope: "member",
      resetsAt: null,
      subjectId: "user:goal-human",
      message: "Exhausted",
    });
    try {
      expect(
        await goalRunBudgetBlocked(
          {
            db: {} as opengeniDb.Database,
            entitlements: null,
            settings: testSettings({ billingMode: "disabled", usageLimitsMode: "none" }),
          },
          {
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            model: "scripted-model",
            initiatingHumanSubjectId: "user:goal-human",
          },
        ),
      ).toEqual({
        pausedReason: "allowance",
        message: "OpenGeni usage allowance exhausted",
      });
      expect(allowance).toHaveBeenCalledWith(expect.anything(), {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: "user:goal-human",
      });
    } finally {
      restoreCodex();
    }
  });

  test("goal activity publishes an allowance pause using locked causal admission", async () => {
    const restoreCodex = mockCodexBilled(false);
    const settings = testSettings({ billingMode: "disabled", usageLimitsMode: "none" });
    const sessionId = "00000000-0000-4000-8000-000000000004";
    const causalTurnId = "00000000-0000-4000-8000-000000000005";
    const sourcePolicy = {
      ...resolveTurnExecutionPolicyV1(settings, {
        modelId: "scripted-model",
        requestedModelId: null,
        modelSource: "session",
        reasoningEffort: "medium",
        reasoningSource: "session",
      }),
      credentialRestriction: "developer_setup" as const,
    };
    const source = spyOn(opengeniDb, "getSessionTurn").mockResolvedValue({
      id: causalTurnId,
      sessionId,
      metadata: metadataWithTurnExecutionPolicyV1({}, sourcePolicy),
    } as Awaited<ReturnType<typeof opengeniDb.getSessionTurn>>);
    const catalog = spyOn(opengeniCore, "resolveCatalogSettings").mockResolvedValue({
      settings,
    } as Awaited<ReturnType<typeof opengeniCore.resolveCatalogSettings>>);
    const goal = spyOn(opengeniDb, "getSessionGoal").mockResolvedValue({
      status: "active",
    } as Awaited<ReturnType<typeof opengeniDb.getSessionGoal>>);
    const session = spyOn(opengeniDb, "requireSession").mockResolvedValue({
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      tools: [],
      firstPartyMcpTools: [],
      sandboxBackend: "none",
    } as Awaited<ReturnType<typeof opengeniDb.requireSession>>);
    const previous = spyOn(opengeniDb, "getLatestStartedSessionTurn").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000003",
      model: "scripted-model",
      initiator: { kind: "service", subjectId: "scheduler" },
    } as Awaited<ReturnType<typeof opengeniDb.getLatestStartedSessionTurn>>);
    const policy = spyOn(opengeniDb, "getWorkspaceModelPolicy").mockResolvedValue(null);
    const event = { type: "goal.paused" };
    const lockedDb = {} as opengeniDb.Database;
    const materialize = spyOn(opengeniDb, "materializeGoalContinuation").mockImplementation(
      async (_db, input) => {
        expect(
          await input.admission!(lockedDb, {
            id: causalTurnId,
            initiatingHumanSubjectId: "user:original-goal-human",
          }),
        ).toEqual({
          budgetBlocked: "OpenGeni usage allowance exhausted",
          budgetPausedReason: "allowance",
        });
        expect(source).toHaveBeenCalledWith(lockedDb, WORKSPACE, causalTurnId);
        expect(input.policy.turnExecutionPolicy?.credentialRestriction).toBe("developer_setup");
        return {
          action: "paused",
          events: [event],
        } as Awaited<ReturnType<typeof opengeniDb.materializeGoalContinuation>>;
      },
    );
    const published: unknown[][] = [];
    const services = {
      db: {} as opengeniDb.Database,
      entitlements: null,
      settings,
      bus: {
        publish: async (...args: unknown[]) => {
          published.push(args);
        },
      },
    } as unknown as ControlActivityServices;
    allowance.mockResolvedValue({
      code: "allowance_exhausted",
      scope: "member",
      resetsAt: null,
      subjectId: "user:original-goal-human",
      message: "Exhausted",
    });
    try {
      expect(
        await createGoalActivities(async () => services).maybeContinueGoal({
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          sessionId,
          workflowId: "goal-workflow",
        }),
      ).toEqual({ action: "paused" });
      expect(allowance).toHaveBeenCalledWith(lockedDb, {
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: "user:original-goal-human",
      });
      expect(materialize).toHaveBeenCalledWith(
        services.db,
        expect.objectContaining({
          admission: expect.any(Function),
        }),
      );
      expect(published).toEqual([[WORKSPACE, sessionId, [event]]]);
    } finally {
      catalog.mockRestore();
      goal.mockRestore();
      session.mockRestore();
      previous.mockRestore();
      policy.mockRestore();
      materialize.mockRestore();
      source.mockRestore();
      restoreCodex();
    }
  });
});
