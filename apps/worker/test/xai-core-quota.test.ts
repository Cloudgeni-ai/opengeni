/**
 * SuperGrok core placement re-reads billing for exhausted shared
 * connections before it trusts a stored exhaustion (design 5.3, EP-N22):
 * the probe runs as the core's service subject in the turn's workspace, and
 * a recovery wakes the organization's SuperGrok core waiters.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";

let probes: Array<{ provider: string; scope: unknown }>;
let wakes: Array<{ provider: string; wake: unknown }>;
let recovered: string[] | Error;
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
  deliverSubscriptionCoreProviderWake: async (_db: unknown, provider: string, wake: unknown) => {
    wakes.push({ provider, wake });
  },
}));

const { XAI_CORE_TURN_PROVIDER } = await import("../src/activities/agent-turn/xai-core");

const identity = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  initiatingHumanSubjectId: "user:someone",
} as unknown as realDb.SubscriptionCoreTurnIdentity;

const before = () =>
  XAI_CORE_TURN_PROVIDER.beforePlacement!({ db: {}, settings: testSettings() } as never, identity);

beforeEach(() => {
  probes = [];
  wakes = [];
  recovered = [];
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
  unregistered = true;
  await before();
  expect(wakes).toEqual([]);
});
