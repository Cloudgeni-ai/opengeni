import { afterEach, expect, spyOn, test } from "bun:test";
import * as db from "@opengeni/db";
import * as events from "@opengeni/events";
import { configuredModels, getSettings, withCodexCatalogProvider } from "@opengeni/config";
import {
  claimServingAttempt,
  servingPolicyForSelection,
} from "../src/activities/agent-turn/subscription-serving-claim";
import { selectServingTurnCapacity } from "../src/activities/agent-turn/subscription-serving-capacity";
import * as registry from "../src/activities/agent-turn/subscription-serving-providers";
import type { CapacityPhaseDeps } from "../src/activities/agent-turn/codex-capacity";
import type { CoreTurnPlacementProvider } from "../src/activities/agent-turn/subscription-core-capacity";
import { acceptedPolicy } from "../../../packages/contracts/test/fixtures/turn-serving-policy";

const settings = withCodexCatalogProvider(
  getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true",
    OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED: "true",
  }),
);
const models = configuredModels(settings).filter(
  (model) => model.credentialSource.kind === "connected_subscription",
);
const policy = servingPolicyForSelection(settings, acceptedPolicy, models[0]!.id, "high");
const targetPolicy = servingPolicyForSelection(settings, policy, models[1]!.id, "high");
const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
};
const base = {
  ...scope,
  db: {} as db.Database,
  settings,
  attemptId: crypto.randomUUID(),
  executionGeneration: 1,
  compactionMode: "portable",
  source: "user",
  acceptedPolicy: policy,
  providerIds: ["codex"],
};
const connectionId = crypto.randomUUID();
const identity = { ...scope } as db.SubscriptionCoreTurnIdentity;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
});
function setup(metadata: Record<string, unknown> = {}) {
  spies.push(spyOn(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity));
  spies.push(
    spyOn(db, "withSubscriptionCoreAcceptedTurn").mockImplementation(
      async (_db, _scope, operation) => ({
        status: "completed",
        value: await operation({} as db.Database),
      }),
    ),
  );
  spies.push(
    spyOn(db, "readSubscriptionCoreFailoverProvider").mockResolvedValue(
      db.subscriptionCoreProvider("codex"),
    ),
  );
  spies.push(
    spyOn(db, "getSessionTurn").mockResolvedValue({
      sessionId: scope.sessionId,
      metadata,
    } as never),
  );
  const evaluate = spyOn(db, "evaluateSubscriptionCorePlacementWithFailover").mockResolvedValue({
    kind: "run",
    connectionId,
    modelId: targetPolicy.productModelId,
    reasoningLevel: "high",
    switch: "failover_same_provider",
  });
  const record = spyOn(db, "recordSubscriptionCoreServingPolicyForTurnAttempt").mockImplementation(
    async (_db, input) => ({
      accepted: true,
      installed: true,
      modelChangeCount: 0,
      revision: {
        schemaVersion: 1,
        executionGeneration: input.executionGeneration,
        historyPosition: 7,
        policy: input.policy,
        connectionId: input.connectionId,
        reason: input.reason,
      },
    }),
  );
  spies.push(evaluate, record);
  return { evaluate, record };
}

test("SUB-FAIL-01 default OFF, remote history, maintenance and restricted work never read failover state", async () => {
  const read = spyOn(db, "readSubscriptionCoreTurnIdentity").mockRejectedValue(
    new Error("must not read"),
  );
  spies.push(read);
  for (const patch of [
    { settings: { ...settings, subscriptionCrossProviderFailoverEnabled: false } },
    { compactionMode: "remote_v2" },
    { source: "compaction" },
    { acceptedPolicy: { ...policy, credentialRestriction: "developer_setup" as const } },
  ])
    expect(await claimServingAttempt({ ...base, ...patch })).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

test("SUB-FAIL-03 claim configures exact selected model while preserving accepted policy", async () => {
  const { record } = setup();
  const before = structuredClone(policy);
  const result = await claimServingAttempt(base);
  expect(result?.revision?.policy).toEqual(targetPolicy);
  expect(result?.acceptedPolicy).toEqual(before);
  expect(policy).toEqual(before);
  expect(record).toHaveBeenCalledTimes(1);
});

test("SUB-FAIL-03 retries consume pending target or retain revision without reevaluating", async () => {
  const revision = {
    schemaVersion: 1,
    policy,
    executionGeneration: 1,
    connectionId,
    reason: "initial",
    historyPosition: 0,
  };
  const pending = {
    schemaVersion: 1,
    policy: targetPolicy,
    sourceAttemptId: base.attemptId,
    sourceExecutionGeneration: 1,
    connectionId,
    reason: "failover_same_provider",
  };
  const { evaluate } = setup({
    turnServingPolicyV1: [revision],
    turnPendingServingPolicyV1: pending,
  });
  const result = await claimServingAttempt({ ...base, executionGeneration: 2 });
  expect(result?.revision?.policy).toEqual(targetPolicy);
  expect(evaluate).not.toHaveBeenCalled();
});

test("SUB-FAIL-03 no mapping is actionable and never recorded as serving provenance", async () => {
  const { evaluate, record } = setup();
  evaluate.mockResolvedValue({
    kind: "wait",
    reason: "failover_no_model_mapping",
    earliestResetAt: null,
    healthRetryAt: null,
    explicitConnectionId: null,
  });
  await expect(claimServingAttempt(base)).rejects.toMatchObject({
    payload: {
      code: "subscription_core_unsupported",
      retryable: false,
      detail: "failover_no_model_mapping",
    },
  });
  expect(record).not.toHaveBeenCalled();
});

test("SUB-FAIL-03 a retained serving revision is not reselected on a later generation", async () => {
  const { evaluate } = setup({
    turnServingPolicyV1: [
      {
        schemaVersion: 1,
        policy: targetPolicy,
        executionGeneration: 1,
        connectionId,
        reason: "initial",
        historyPosition: 0,
      },
    ],
  });
  const result = await claimServingAttempt({ ...base, executionGeneration: 2 });
  expect(result?.revision?.policy).toEqual(targetPolicy);
  expect(evaluate).not.toHaveBeenCalled();
});

test("SUB-FAIL-03 pinned and frozen-authority waits do not invent a baseline or target", async () => {
  const { evaluate, record } = setup();
  for (const reason of [
    "pinned_account_ineligible",
    "pinned_account_unavailable",
    "accepted_authority_unavailable",
  ] as const) {
    evaluate.mockResolvedValue({
      kind: "wait",
      reason,
      earliestResetAt: null,
      healthRetryAt: null,
      explicitConnectionId: null,
    });
    expect((await claimServingAttempt(base))?.revision).toBeNull();
  }
  expect(record).not.toHaveBeenCalled();
});

test("SUB-FAIL-03 absent home readiness never enables the worker hook", async () => {
  const { evaluate, record } = setup();
  spies.push(spyOn(db, "readSubscriptionCoreFailoverProvider").mockResolvedValue(null));
  expect(await claimServingAttempt(base)).toBeNull();
  expect(evaluate).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test.each(["holder", null, "at-limit"])(
  "SUB-FAIL-03 changed placement initializes or preserves holder %s, releases before recovery and never adopts credentials",
  async (holderId) => {
    setup();
    const order: string[] = [];
    const lease = { holderId };
    const workflowId = "serving-fixture";
    const expectedHolder =
      holderId ?? `codex-turn:${workflowId}:${identity.turnId}:${base.attemptId}`;
    const provider = {
      id: "codex",
      displayName: "fixture",
      leaseTtlMs: 60000,
      lease: () => lease,
      recoverHealth: async () => {},
      adopt: () => {
        throw new Error("must not adopt proposed target");
      },
    } as unknown as CoreTurnPlacementProvider;
    spies.push(spyOn(registry, "servingTurnProviders").mockReturnValue([provider]));
    spies.push(
      spyOn(db, "placeSubscriptionCoreTurnWithFailover").mockImplementation(
        async (_db, _provider, input) => {
          expect(input.holderId).toBe(expectedHolder);
          expect(lease.holderId).toBe(expectedHolder);
          order.push("placement committed");
          return {
            kind: "run",
            provider: "codex",
            modelId: targetPolicy.productModelId,
            connectionId,
            reasoningLevel: "high",
            switch: "failover_same_provider",
          } as never;
        },
      ),
    );
    spies.push(
      spyOn(db, "releaseSubscriptionTurnLease").mockImplementation(async () => {
        order.push("lease released");
      }),
    );
    const recovery = spyOn(db, "requestSessionTurnRecovery").mockImplementation(async () => {
      if (holderId === "at-limit") throw new db.SubscriptionCoreServingFailoverLimitError(4);
      order.push("recovery committed");
      return { action: "recovering", events: [] };
    });
    spies.push(recovery, spyOn(events, "publishDurableSessionEvents").mockResolvedValue(undefined));
    const deps = {
      input: { ...scope, workflowId, attemptId: base.attemptId },
      settings,
      db: base.db,
      bus: {},
      turnExecutionPolicy: policy,
      attempt: { executionGeneration: 1 },
      turn: { triggerEventId: crypto.randomUUID() },
      control: {},
      acknowledgeRecoveryQuiescence: () => order.push("quiescence"),
      claimedResult: (value: unknown) => value,
    } as unknown as CapacityPhaseDeps;
    const result = selectServingTurnCapacity(deps, {
      identity,
      acceptedPolicy: policy,
      homeProviderId: "codex",
      models: models.map((model) => ({
        id: model.id,
        provider: "codex",
        upstreamModelId: model.upstreamModelId,
        reasoningLevels: ["high"],
      })),
      revision: {
        schemaVersion: 1,
        policy,
        executionGeneration: 1,
        connectionId,
        reason: "initial",
        historyPosition: 0,
      },
    });
    if (holderId === "at-limit") {
      await expect(result).rejects.toMatchObject({
        payload: {
          code: "subscription_failover_exhausted",
          retryable: false,
          failoverSteps: 4,
          maxFailoverSteps: 4,
        },
      });
      expect(order).toEqual(["placement committed", "lease released"]);
      return;
    }
    expect(await result).toEqual({ exit: { status: "recovering" } });
    expect(order).toEqual([
      "placement committed",
      "lease released",
      "recovery committed",
      "quiescence",
    ]);
    expect(recovery.mock.calls[0]![2].subscriptionServingTarget?.policy).toEqual(targetPolicy);
  },
);
