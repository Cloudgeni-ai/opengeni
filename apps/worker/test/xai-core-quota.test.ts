/**
 * SuperGrok core placement re-reads billing for exhausted shared
 * connections before it trusts a stored exhaustion (design 5.3, EP-N22):
 * the probe runs as the core's service subject in the turn's workspace, and
 * a recovery wakes the organization's SuperGrok core waiters. The exact
 * turn is also handed to the personal re-read, which reads only what
 * placement's personal authorization admits for that turn (proven on real PostgreSQL in
 * apps/api/test/xai-core-personal-status-postgres.test.ts).
 */
import { beforeEach, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

let probes: Array<{ provider: string; scope: unknown }>;
let personalProbes: Array<{ provider: string; turn: unknown }>;
let wakes: Array<{ provider: string; wake: unknown }>;
let recovered: string[] | Error;
let personalRecovered: string[] | Error;
let unregistered: boolean;
let parkedIdentity: realDb.SubscriptionCoreTurnIdentity | null;
let billingUsedPercent: number | null;
let personalExhausted: boolean;
let wakeRevision: number;

mock.module("@opengeni/db", () => ({
  ...realDb,
  readSubscriptionCoreTurnIdentity: async () => parkedIdentity,
  subscriptionCoreOperationConnections: (provider: { adapter: { provider: string } }) => {
    if (unregistered) throw new Error("No subscription-core provider is registered for this id");
    return {
      refreshExhaustedSubscriptionCoreQuota: async (
        _db: unknown,
        _settings: unknown,
        scope: unknown,
      ) => {
        probes.push({ provider: provider.adapter.provider, scope });
        if (recovered instanceof Error) throw recovered;
        return recovered;
      },
    };
  },
  subscriptionCorePersonalConnections: (provider: { adapter: { provider: string } }) => {
    if (unregistered) throw new Error("No subscription-core provider is registered for this id");
    return {
      refreshExhaustedSubscriptionCoreTurnPersonalQuota: async (
        _db: unknown,
        _settings: unknown,
        turn: unknown,
      ) => {
        personalProbes.push({ provider: provider.adapter.provider, turn });
        if (personalRecovered instanceof Error) throw personalRecovered;
        // Script the billing reader for the worker orchestration case below.
        // The real owner-scoped SQL/read path is covered by the PG suite.
        if (billingUsedPercent !== null && personalExhausted && billingUsedPercent < 100) {
          personalExhausted = false;
          return ["personal-connection"];
        }
        return personalRecovered;
      },
    };
  },
  deliverSubscriptionCoreProviderWake: async (_db: unknown, provider: string, wake: unknown) => {
    wakes.push({ provider, wake });
    wakeRevision += 1;
  },
}));

const { XAI_CORE_TURN_PROVIDER } = await import("../src/activities/agent-turn/xai-core");
const { XAI_CORE_WAIT_BINDING } = await import("../src/activities/subscription-core-xai-waits");
const { reconcileCoreCapacityWait } =
  await import("../src/activities/subscription-core-codex-waits");

const OWNER_MEMBERSHIP = "66666666-6666-4666-8666-666666666666";
const identity = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  initiatingHumanSubjectId: "user:owner",
  sessionOwnerSubjectId: "user:owner",
  sessionOwnerMembershipId: OWNER_MEMBERSHIP,
  acceptedAuthorityV2: { version: 2, personal: [] },
} as unknown as realDb.SubscriptionCoreTurnIdentity;

const personalAuthority = (provider: string, ownerMembershipId = OWNER_MEMBERSHIP) =>
  ({
    ...identity,
    acceptedAuthorityV2: {
      version: 2,
      personal: [{ provider, ownerMembershipId, authorityGeneration: 1 }],
    },
  }) as unknown as realDb.SubscriptionCoreTurnIdentity;

const before = (turn = identity) =>
  XAI_CORE_TURN_PROVIDER.beforePlacement!({ db: {}, settings: testSettings() } as never, turn);

beforeEach(() => {
  probes = [];
  personalProbes = [];
  wakes = [];
  recovered = [];
  personalRecovered = [];
  unregistered = false;
  parkedIdentity = null;
  billingUsedPercent = null;
  personalExhausted = true;
  wakeRevision = 1;
});

test("placement probes exhausted shared connections as the core's service subject", async () => {
  await before();
  expect(probes).toEqual([
    {
      provider: "xai",
      scope: {
        kind: "workspace",
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        subjectId: "service:subscription-core",
      },
    },
  ]);
  expect(personalProbes).toEqual([{ provider: "xai", turn: identity }]);
  expect(wakes).toEqual([]);
});

test("a recovery wakes the organization's SuperGrok core waiters", async () => {
  recovered = ["55555555-5555-4555-8555-555555555555"];
  await before();
  expect(wakes).toEqual([
    { provider: "xai", wake: { accountId: identity.accountId, reason: "usage_recovered" } },
  ]);
});

test("a failed probe never blocks placement", async () => {
  recovered = new Error("billing unavailable");
  await before();
  personalRecovered = new Error("billing unavailable");
  await before(personalAuthority("xai"));
  unregistered = true;
  await before(personalAuthority("xai"));
  expect(wakes).toEqual([]);
});

test("the personal re-read gets the exact turn, and its recovery wakes the waiters", async () => {
  const turn = personalAuthority("xai");
  await before(turn);
  // The turn itself, never a subject: the re-read authorizes it as placement does.
  expect(personalProbes).toEqual([{ provider: "xai", turn }]);
  expect(personalProbes[0]!.turn).toBe(turn);
  expect(probes).toHaveLength(1);
  expect(wakes).toEqual([]);
  // A personal recovery wakes the organization's SuperGrok core waiters, also
  // when the shared probe failed.
  recovered = new Error("billing unavailable");
  personalRecovered = ["77777777-7777-4777-8777-777777777777"];
  await before(turn);
  expect(wakes).toEqual([
    { provider: "xai", wake: { accountId: identity.accountId, reason: "usage_recovered" } },
  ]);
});

test("a parked personal turn resumes when its billing re-read recovers before the stored reset", async () => {
  const turn = personalAuthority("xai");
  parkedIdentity = turn;
  billingUsedPercent = 100;
  const reset = new Date(Date.now() + 86_400_000);
  const waiter = (): realDb.SubscriptionCoreCodexCapacityWait => ({
    waiterId: "waiter-1",
    provider: "xai",
    accountId: turn.accountId,
    workspaceId: turn.workspaceId,
    sessionId: turn.sessionId,
    blockedTurnId: turn.turnId,
    blockedTurnGeneration: 1,
    generation: 1,
    wakeRevision,
    observedWakeRevision: 1,
    waitReason: "no_eligible_capacity",
    resetKind: "bounded_refresh",
    refreshAttempt: 0,
    earliestResetAt: reset,
    nextCheckAt: reset,
    goalId: null,
    goalVersion: null,
    lastWakeReason: null,
  });
  const evaluated: unknown[] = [];
  const binding: typeof XAI_CORE_WAIT_BINDING = {
    ...XAI_CORE_WAIT_BINDING,
    getWaiterById: async () => waiter(),
    readTurnModel: async () => ({ productModelId: "supergrok/grok-4.7", reasoningLevel: "medium" }),
    recoverHealth: async () => 0,
    evaluatePlacement: async (_db, request) => {
      expect(request.identity).toBe(turn);
      return personalExhausted
        ? {
            kind: "wait",
            reason: "no_eligible_capacity",
            earliestResetAt: reset,
            healthRetryAt: null,
          }
        : { kind: "run" };
    },
    reconcileWaiter: async (_db, input) => {
      evaluated.push({ revision: input.evaluatedWakeRevision, evaluation: input.evaluation });
      return input.evaluation.kind === "run"
        ? { action: "resumed", events: [] }
        : { action: "waiting", waiter: waiter(), events: [] };
    },
  };
  const reconcile = () =>
    reconcileCoreCapacityWait(
      {
        db: {} as realDb.Database,
        settings: testSettings(),
        bus: { publish: async () => undefined } as never,
      },
      binding,
      {
        accountId: turn.accountId,
        workspaceId: turn.workspaceId,
        sessionId: turn.sessionId,
        waiterId: "waiter-1",
        generation: 1,
      },
    );

  expect(await reconcile()).toMatchObject({ action: "waiting" });
  expect(personalExhausted).toBe(true);
  expect(wakes).toEqual([]);
  personalRecovered = new Error("billing unavailable");
  expect(await reconcile()).toMatchObject({ action: "waiting" });
  expect(personalExhausted).toBe(true);
  personalRecovered = [];
  billingUsedPercent = 40;
  expect(await reconcile()).toEqual({ action: "resumed" });
  expect(personalExhausted).toBe(false);
  expect(evaluated.at(-1)).toEqual({ revision: 2, evaluation: { kind: "run" } });
  expect(personalProbes).toHaveLength(3);
  for (const probe of personalProbes) expect(probe.turn).toBe(turn);
  expect(wakes).toEqual([
    { provider: "xai", wake: { accountId: turn.accountId, reason: "usage_recovered" } },
  ]);
});
