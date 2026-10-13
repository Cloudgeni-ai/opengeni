import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import * as db from "@opengeni/db";
import { acceptedPolicy } from "../../../packages/contracts/test/fixtures/turn-serving-policy";
import {
  CODEX_CORE_WAIT_BINDING,
  evaluateCoreCodexBlockedTurn,
} from "../src/activities/subscription-core-codex-waits";
import * as registry from "../src/activities/subscription-core-wait-bindings";
import * as catalog from "../src/activities/agent-turn/subscription-serving-catalog";

const settings = getSettings({
  OPENGENI_ENV: "test",
  OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED: "true",
});
const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
};
const identity: db.SubscriptionCoreTurnIdentity = {
  ...scope,
  sessionOwnerSubjectId: "user:owner",
  sessionOwnerMembershipId: crypto.randomUUID(),
  initiatingHumanSubjectId: "user:owner",
  acceptedAuthorityV2: { version: 2, personal: [] },
};
const services = { db: {} as db.Database, settings };
const restores: Array<{ mockRestore(): void }> = [];
function spy<T extends object, K extends keyof T>(object: T, key: K) {
  const handle = spyOn(object, key);
  restores.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of restores.splice(0).reverse()) handle.mockRestore();
});
const wait = {
  kind: "wait",
  reason: "no_eligible_capacity",
  earliestResetAt: null,
  healthRetryAt: null,
  explicitConnectionId: null,
  candidateProviders: ["codex", "claude"],
} as const;
function setup() {
  spy(db, "readSubscriptionCoreTurnIdentity").mockResolvedValue(identity);
  spy(db, "readSubscriptionCoreCodexTurnModel").mockResolvedValue({
    productModelId: acceptedPolicy.productModelId,
    reasoningLevel: acceptedPolicy.reasoningEffort,
  });
  spy(db, "recoverSubscriptionCoreCodexConnectionHealth").mockResolvedValue(0);
  const home = spy(db, "evaluateSubscriptionCoreCodexPlacement").mockResolvedValue({
    ...wait,
    candidateProviders: undefined,
  } as never);
  spy(db, "withSubscriptionCoreAcceptedTurn").mockImplementation(
    async (_db, _identity, operation) => ({
      status: "completed",
      value: await operation({} as db.Database),
    }),
  );
  const session = spy(db, "getSession").mockResolvedValue({
    codexCompactionMode: "portable",
  } as never);
  const turn = spy(db, "getSessionTurn").mockResolvedValue({
    sessionId: scope.sessionId,
    source: "user",
    metadata: { turnExecutionPolicyV1: acceptedPolicy },
  } as never);
  spy(catalog, "servingCatalogForBlockedTurn").mockResolvedValue([
    {
      id: acceptedPolicy.productModelId,
      provider: "codex",
      upstreamModelId: "source",
      reasoningLevels: ["high"],
    },
  ]);
  const recover = mock(async () => 0);
  const refresh = mock(async () => {});
  spy(registry, "subscriptionCoreWaitBindings").mockReturnValue([
    CODEX_CORE_WAIT_BINDING,
    {
      ...CODEX_CORE_WAIT_BINDING,
      provider: "claude",
      recoverHealth: recover,
      refreshBeforeReconcile: refresh,
    },
  ]);
  const evaluate = spy(db, "evaluateSubscriptionCorePlacementWithFailover").mockResolvedValue({
    ...wait,
    candidateProviders: [...wait.candidateProviders],
  });
  return { home, session, turn, evaluate, recover, refresh };
}

test("alternative-provider availability resumes under the exact frozen identity", async () => {
  const { evaluate, home, refresh, recover } = setup();
  evaluate.mockResolvedValueOnce({ ...wait, candidateProviders: [...wait.candidateProviders] });
  evaluate.mockResolvedValueOnce({
    kind: "run",
    connectionId: "eligible",
    switch: "failover_cross_provider",
    candidateProviders: ["codex", "claude"],
  });
  expect(await evaluateCoreCodexBlockedTurn(services, scope)).toEqual({
    kind: "run",
    candidateProviders: ["codex", "claude"],
  });
  expect(home).not.toHaveBeenCalled();
  expect(recover).toHaveBeenCalledWith(services.db, identity);
  expect(refresh).toHaveBeenCalledWith(services, identity);
  expect(evaluate.mock.calls[0]![2].identity).toBe(identity);
});

test("fresh policy replaces hints and a withdrawn candidate cannot retain a wake grant", async () => {
  const { evaluate, refresh } = setup();
  evaluate.mockResolvedValueOnce({ ...wait, candidateProviders: [...wait.candidateProviders] });
  evaluate.mockResolvedValueOnce({ ...wait, candidateProviders: [] });
  expect(await evaluateCoreCodexBlockedTurn(services, scope)).toEqual({
    kind: "wait",
    waitReason: wait.reason,
    earliestResetAt: null,
    healthRetryAt: null,
    candidateProviders: [],
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

test.each(["pinned_account_unavailable", "accepted_authority_unavailable"] as const)(
  "%s stays parked without refreshing another provider",
  async (reason) => {
    const { evaluate, refresh } = setup();
    evaluate.mockResolvedValue({ ...wait, reason, candidateProviders: [] });
    expect(await evaluateCoreCodexBlockedTurn(services, scope)).toMatchObject({
      kind: "wait",
      waitReason: reason,
      candidateProviders: [],
    });
    expect(refresh).not.toHaveBeenCalled();
  },
);

test("missing mapping leaves capacity wait for claim's one actionable failure, never a synthetic target", async () => {
  const { evaluate, refresh } = setup();
  evaluate.mockResolvedValue({
    ...wait,
    reason: "failover_no_model_mapping",
    candidateProviders: [],
  });
  expect(await evaluateCoreCodexBlockedTurn(services, scope)).toEqual({
    kind: "run",
    candidateProviders: [],
  });
  expect(refresh).not.toHaveBeenCalled();
});

test.each(["not_visible", "cutover_not_enabled"] as const)("%s never resumes", async (kind) => {
  const { evaluate, refresh } = setup();
  evaluate.mockResolvedValue({ kind });
  expect(await evaluateCoreCodexBlockedTurn(services, scope)).toEqual({
    kind: kind === "not_visible" ? "revoked" : "paused",
  });
  expect(refresh).not.toHaveBeenCalled();
});

test("deployment-disabled work uses only home evaluation without reading serving state", async () => {
  const { evaluate, session, home } = setup();
  await evaluateCoreCodexBlockedTurn(
    { ...services, settings: { ...settings, subscriptionCrossProviderFailoverEnabled: false } },
    scope,
  );
  expect(home).toHaveBeenCalledTimes(1);
  expect(session).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
});

test.each(["remote", "maintenance", "restricted"])(
  "%s work cannot gain cross-provider capacity from wake hints",
  async (mode) => {
    const { evaluate, session, turn, home } = setup();
    if (mode === "remote") session.mockResolvedValue({ codexCompactionMode: "remote_v2" } as never);
    else
      turn.mockResolvedValue({
        sessionId: scope.sessionId,
        source: mode === "maintenance" ? "compaction" : "user",
        metadata: {
          turnExecutionPolicyV1:
            mode === "restricted"
              ? { ...acceptedPolicy, credentialRestriction: "developer_setup" }
              : acceptedPolicy,
        },
      } as never);
    await evaluateCoreCodexBlockedTurn(services, scope);
    expect(evaluate).not.toHaveBeenCalled();
    expect(home).toHaveBeenCalledTimes(1);
  },
);

test("vanished or foreign turn revokes before capacity evaluation", async () => {
  const { evaluate, turn, home } = setup();
  turn.mockResolvedValue({ sessionId: crypto.randomUUID(), metadata: {} } as never);
  expect(await evaluateCoreCodexBlockedTurn(services, scope)).toEqual({ kind: "revoked" });
  expect(home).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
});
