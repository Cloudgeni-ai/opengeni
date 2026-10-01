import { describe, expect, spyOn, test } from "bun:test";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import { metadataWithTurnExecutionPolicyV1, TurnExecutionPolicyV1 } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import * as admission from "../src/activities/agent-run-admission";
import { createGoalActivities } from "../src/activities/goals";
import type { ControlActivityServices } from "../src/activities/types";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  workflowId: "fixture-workflow",
};
const sourceTurnId = "44444444-4444-4444-8444-444444444444";
const settings = testSettings({ sandboxBackend: "none" });
const initialPolicy = resolveTurnExecutionPolicyV1(settings, {
  modelId: settings.openaiModel,
  requestedModelId: null,
  modelSource: "session",
  reasoningEffort: "low",
  reasoningSource: "session",
});
const restrictedMetadata = metadataWithTurnExecutionPolicyV1(
  {},
  {
    ...initialPolicy,
    credentialRestriction: "developer_setup",
  },
);

async function continuationFixture(
  options: {
    model?: string;
    sessionMetadata?: unknown;
    sourceMetadata?: unknown;
    noCausalTurn?: boolean;
    sourceMissing?: boolean;
    sourceSessionId?: string;
  },
  verify: (result: {
    run: () => ReturnType<ReturnType<typeof createGoalActivities>["maybeContinueGoal"]>;
    persistedPolicy: () => TurnExecutionPolicyV1 | null;
    sourceRead: ReturnType<typeof spyOn<typeof db, "getSessionTurn">>;
    admissionCall: ReturnType<typeof spyOn<typeof admission, "agentRunAdmissionDenial">>;
    transaction: db.Database;
  }) => Promise<void>,
) {
  const database = {} as db.Database;
  const transaction = {} as db.Database;
  let frozenPolicy: TurnExecutionPolicyV1 | null = null;
  const sourceRead = spyOn(db, "getSessionTurn").mockResolvedValue(
    options.sourceMissing
      ? null
      : ({
          id: sourceTurnId,
          sessionId: options.sourceSessionId ?? scope.sessionId,
          metadata: options.sourceMetadata ?? {},
        } as Awaited<ReturnType<typeof db.getSessionTurn>>),
  );
  const admissionCall = spyOn(admission, "agentRunAdmissionDenial").mockResolvedValue(null);
  const spies = [
    sourceRead,
    admissionCall,
    spyOn(db, "getSessionGoal").mockResolvedValue({ status: "active" } as Awaited<
      ReturnType<typeof db.getSessionGoal>
    >),
    spyOn(db, "requireSession").mockResolvedValue({
      id: scope.sessionId,
      model: options.model ?? settings.openaiModel,
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      tools: [],
      metadata: options.sessionMetadata ?? {},
    } as Awaited<ReturnType<typeof db.requireSession>>),
    spyOn(db, "getWorkspaceModelPolicy").mockResolvedValue(null),
    spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as Awaited<
      ReturnType<typeof core.resolveCatalogSettings>
    >),
    spyOn(db, "materializeGoalContinuation").mockImplementation(async (_db, input) => {
      // Mirror the production materializer's order: select the locked causal
      // id, await worker admission, then freeze its policy into the update.
      const admissionResult = await input.admission!(
        transaction,
        options.noCausalTurn ? null : { id: sourceTurnId, initiatingHumanSubjectId: null },
      );
      if (admissionResult.budgetBlocked) {
        expect(input.policy.turnExecutionPolicy).toBeUndefined();
        return { action: "paused", events: [] };
      }
      frozenPolicy = TurnExecutionPolicyV1.parse(input.policy.turnExecutionPolicy);
      return { action: "queue", events: [] };
    }),
  ];
  const activities = createGoalActivities(
    async () =>
      ({
        settings,
        db: database,
        bus: { publish: async () => {} },
      }) as ControlActivityServices,
  );
  try {
    await verify({
      run: async () => await activities.maybeContinueGoal(scope),
      persistedPolicy: () => frozenPolicy,
      sourceRead,
      admissionCall,
      transaction,
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("worker automatic goal continuation credential ceiling", () => {
  test("an unavailable setup continuation model pauses without creating an incomplete policy", async () => {
    await continuationFixture(
      {
        model: "removed/setup-model",
        sourceMetadata: restrictedMetadata,
        sessionMetadata: restrictedMetadata,
      },
      async ({ run, persistedPolicy, admissionCall }) => {
        expect(await run()).toEqual({ action: "paused" });
        expect(persistedPolicy()).toBeNull();
        expect(admissionCall).not.toHaveBeenCalled();
      },
    );
  });

  test.each([
    { name: "turn-only setup", sourceMetadata: restrictedMetadata, expected: "developer_setup" },
    { name: "initial setup", sessionMetadata: restrictedMetadata, expected: "developer_setup" },
    {
      name: "ordinary accepted turn",
      sourceMetadata: metadataWithTurnExecutionPolicyV1({}, initialPolicy),
      expected: undefined,
    },
    { name: "legacy absent policies", expected: undefined },
    {
      name: "untrusted metadata flags",
      sourceMetadata: { credentialRestriction: "developer_setup" },
      sessionMetadata: { credentialRestriction: "developer_setup" },
      expected: undefined,
    },
  ] as const)("preserves $name without changing model policy", async (fixture) => {
    await continuationFixture(
      fixture,
      async ({ run, persistedPolicy, sourceRead, transaction }) => {
        expect(await run()).toEqual({ action: "queue" });
        expect(sourceRead).toHaveBeenCalledWith(transaction, scope.workspaceId, sourceTurnId);
        const frozen = persistedPolicy()!;
        expect(frozen.credentialRestriction).toBe(fixture.expected);
        expect(Object.hasOwn(frozen, "credentialRestriction")).toBe(!!fixture.expected);
        const { credentialRestriction: _restriction, ...ordinary } = frozen;
        expect(ordinary).toEqual({
          ...initialPolicy,
          modelSource: "continuation",
          reasoningSource: "continuation",
          latencyModeSource: "continuation",
        });
      },
    );
  });

  test("a goal with no causal turn still inherits only the trusted initial ceiling", async () => {
    await continuationFixture(
      { noCausalTurn: true, sessionMetadata: restrictedMetadata },
      async ({ run, persistedPolicy, sourceRead }) => {
        await run();
        expect(sourceRead).not.toHaveBeenCalled();
        expect(persistedPolicy()!.credentialRestriction).toBe("developer_setup");
      },
    );
  });

  test.each([
    { name: "missing exact source", sourceMissing: true },
    {
      name: "source from another session",
      sourceSessionId: "55555555-5555-4555-8555-555555555555",
    },
    {
      name: "malformed frozen source",
      sourceMetadata: { turnExecutionPolicyV1: { credentialRestriction: "developer_setup" } },
    },
  ])("fails closed before admission for $name", async (fixture) => {
    await continuationFixture(fixture, async ({ run, persistedPolicy, admissionCall }) => {
      await expect(run()).rejects.toThrow();
      expect(persistedPolicy()).toBeNull();
      expect(admissionCall).not.toHaveBeenCalled();
    });
  });
});
