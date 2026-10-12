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

mock.module("@opengeni/db", () => ({
  ...realDb,
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
        return personalRecovered;
      },
    };
  },
  deliverSubscriptionCoreProviderWake: async (_db: unknown, provider: string, wake: unknown) => {
    wakes.push({ provider, wake });
  },
}));

const { XAI_CORE_TURN_PROVIDER } = await import("../src/activities/agent-turn/xai-core");

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
