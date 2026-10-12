/**
 * SuperGrok core placement re-reads billing for exhausted shared
 * connections before it trusts a stored exhaustion (design 5.3, EP-N22):
 * the probe runs as the core's service subject in the turn's workspace, and
 * a recovery wakes the organization's SuperGrok core waiters. A turn that
 * carries the session owner's SuperGrok personal authority also re-reads
 * that owner's own personal connections (as the owner); no other turn does.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

let probes: Array<{ provider: string; scope: unknown }>;
let personalProbes: Array<{ provider: string; input: unknown }>;
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
      refreshExhaustedSubscriptionCorePersonalQuota: async (
        _db: unknown,
        _settings: unknown,
        input: unknown,
      ) => {
        personalProbes.push({ provider: provider.adapter.provider, input });
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
  initiatingHumanSubjectId: "user:someone",
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
  expect(personalProbes).toEqual([]);
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

test("a turn with the owner's SuperGrok personal authority re-reads the owner's own exhausted connections", async () => {
  await before(personalAuthority("xai"));
  expect(personalProbes).toEqual([
    { provider: "xai", input: { accountId: identity.accountId, subjectId: "user:owner" } },
  ]);
  expect(probes).toHaveLength(1);
  expect(wakes).toEqual([]);
  // A personal recovery wakes the organization's SuperGrok core waiters, also
  // when the shared probe failed.
  recovered = new Error("billing unavailable");
  personalRecovered = ["77777777-7777-4777-8777-777777777777"];
  await before(personalAuthority("xai"));
  expect(wakes).toEqual([
    { provider: "xai", wake: { accountId: identity.accountId, reason: "usage_recovered" } },
  ]);
});

test("no personal re-read without the owner's SuperGrok personal authority", async () => {
  // Another provider's personal authority, another membership's, or an
  // ownerless session: shared capacity only.
  await before(personalAuthority("codex"));
  await before(personalAuthority("xai", "88888888-8888-4888-8888-888888888888"));
  await before({
    ...personalAuthority("xai"),
    sessionOwnerSubjectId: null,
    sessionOwnerMembershipId: null,
  } as unknown as realDb.SubscriptionCoreTurnIdentity);
  expect(personalProbes).toEqual([]);
  expect(probes).toHaveLength(3);
});
