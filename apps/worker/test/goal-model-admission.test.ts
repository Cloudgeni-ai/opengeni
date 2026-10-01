import { describe, expect, spyOn, test } from "bun:test";
import * as config from "@opengeni/config";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { createGoalActivities, goalContinuationModelDecision } from "../src/activities/goals";
import type { ControlActivityServices } from "../src/activities/types";

function catalog(retired: boolean) {
  const base = testSettings({ codexSubscriptionEnabled: true });
  const capabilities = config
    .configuredModels(config.withCodexCatalogProvider(base))
    .find((model) => model.id.startsWith("codex/"))!.capabilities;
  return config.applyModelCatalogDocument(base, {
    schemaVersion: 1,
    builtInModels: ["gpt-5.6-sol"],
    codexModels: [{ id: "codex/test-model", upstreamModelId: "test-model", capabilities, retired }],
  });
}

describe("goal model admission", () => {
  test("retired selection is blocked without substituting an available model", () => {
    expect(
      goalContinuationModelDecision({
        settings: catalog(true),
        workspaceModelPolicy: null,
        inheritedModel: "codex/test-model",
      }),
    ).toEqual({ model: "codex/test-model", blocked: expect.stringContaining("retired") });
  });

  for (const fixture of [
    { name: "retired", model: "codex/test-model", retired: true, blocked: "retired" },
    { name: "absent", model: "removed/provider-model", retired: false, blocked: "no longer" },
    { name: "available", model: "codex/test-model", retired: false, blocked: null },
    {
      name: "workspace policy",
      model: "codex/test-model",
      retired: false,
      blocked: "workspace model policy",
      policyBlocked: true,
    },
    {
      name: "remote compaction",
      model: "gpt-5.6-sol",
      retired: false,
      blocked: "locked to Codex",
      remote: true,
    },
  ]) {
    test(`${fixture.name} model reaches locked admission rather than retrying policy resolution`, async () => {
      const settings = catalog(fixture.retired);
      const spies: { mockRestore(): void }[] = [];
      const events = [{ type: "goal.paused" }];
      const publish = async (...args: unknown[]) => {
        published.push(args);
      };
      const published: unknown[][] = [];
      const service = { db: {}, settings, bus: { publish } } as unknown as ControlActivityServices;
      try {
        spies.push(
          spyOn(core, "resolveCatalogSettings").mockResolvedValue({ settings } as Awaited<
            ReturnType<typeof core.resolveCatalogSettings>
          >),
        );
        spies.push(
          spyOn(db, "getSessionGoal").mockResolvedValue({ status: "active" } as Awaited<
            ReturnType<typeof db.getSessionGoal>
          >),
        );
        spies.push(
          spyOn(db, "requireSession").mockResolvedValue({
            model: fixture.model,
            reasoningEffort: "medium",
            latencyMode: "standard",
            tools: [],
            firstPartyMcpTools: [],
            sandboxBackend: "none",
            codexCompactionMode: fixture.remote ? "remote_v2" : null,
          } as Awaited<ReturnType<typeof db.requireSession>>),
        );
        spies.push(
          spyOn(db, "getWorkspaceModelPolicy").mockResolvedValue(
            fixture.policyBlocked
              ? ({
                  allowedProviders: null,
                  allowedModels: [],
                } as Awaited<ReturnType<typeof db.getWorkspaceModelPolicy>>)
              : null,
          ),
        );
        const balance = spyOn(db, "getBillingBalance").mockRejectedValue(
          new Error("blocked model must not query funding"),
        );
        spies.push(balance);
        const materialize = spyOn(db, "materializeGoalContinuation").mockImplementation(
          async (_db, input) => {
            expect(input.policy.model).toBe(fixture.model);
            if (fixture.blocked) {
              expect(input.policy.turnExecutionPolicy).toBeUndefined();
              expect(await input.admission!({} as db.Database, null)).toEqual({
                budgetBlocked: expect.stringContaining(fixture.blocked),
                budgetPausedReason: "limits",
              });
            } else {
              expect(input.policy.turnExecutionPolicy).toEqual(
                config.resolveTurnExecutionPolicyV1(settings, {
                  modelId: fixture.model,
                  requestedModelId: null,
                  modelSource: "continuation",
                  reasoningEffort: "medium",
                  reasoningSource: "continuation",
                  latencyMode: "standard",
                  latencyModeSource: "continuation",
                }),
              );
            }
            return {
              action: fixture.blocked ? "paused" : "none",
              events: fixture.blocked ? events : [],
            } as Awaited<ReturnType<typeof db.materializeGoalContinuation>>;
          },
        );
        spies.push(materialize);
        expect(
          await createGoalActivities(async () => service).maybeContinueGoal({
            accountId: "account",
            workspaceId: "workspace",
            sessionId: "session",
            workflowId: "workflow",
          }),
        ).toEqual({ action: fixture.blocked ? "paused" : "none" });
        expect(materialize).toHaveBeenCalledTimes(1);
        expect(balance).not.toHaveBeenCalled();
        expect(published).toEqual(fixture.blocked ? [["workspace", "session", events]] : []);
      } finally {
        for (const spy of spies.reverse()) spy.mockRestore();
      }
    });
  }
});
