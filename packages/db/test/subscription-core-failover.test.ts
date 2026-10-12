import { expect, test } from "bun:test";
import type { Database } from "../src/database";
import { subscriptionCoreBindingsPermitCrossing } from "../src/subscription-core/failover-readiness";
import {
  withSubscriptionCoreFailoverPlacementWorld,
  type SubscriptionCoreFailoverWorldRequest,
} from "../src/subscription-core/failover-world";
import type { SubscriptionCoreProvider } from "../src/subscription-core/provider";
import { readAttemptFence } from "../src/subscription-core/failover";
import type { SubscriptionCorePlacementRequest } from "../src/subscription-core/turns";

test("D-46 catalog uncertainty and failed reads cannot prove rolling-index removal", async () => {
  for (const rows of [
    [],
    [{ known: false, blocked: false }],
    [{ known: true }],
    [{ known: true, blocked: true }],
    [{ known: "true", blocked: false }],
    [
      { known: true, blocked: false },
      { known: true, blocked: false },
    ],
  ]) {
    const tx = {
      transaction: async (fn: (inner: unknown) => unknown) => fn({ execute: async () => rows }),
    } as unknown as Database;
    expect(await subscriptionCoreBindingsPermitCrossing(tx)).toBe(false);
  }
  const failed = {
    transaction: async () => {
      throw new Error("catalog denied");
    },
  } as unknown as Database;
  expect(await subscriptionCoreBindingsPermitCrossing(failed)).toBe(false);
  const proven = {
    transaction: async (fn: (inner: unknown) => unknown) =>
      fn({ execute: async () => [{ known: true, blocked: false }] }),
  } as unknown as Database;
  expect(await subscriptionCoreBindingsPermitCrossing(proven)).toBe(true);
});

test("D-43 disabled failover world performs no SQL, registry read or callback", async () => {
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error("disabled failover touched dependency");
      },
    },
  );
  for (const flag of [undefined, false]) {
    const request = {
      ...(flag === undefined ? {} : { crossProviderFailoverEnabled: flag }),
    } as SubscriptionCoreFailoverWorldRequest;
    expect(
      await withSubscriptionCoreFailoverPlacementWorld(
        untouched as Database,
        untouched as SubscriptionCoreProvider,
        request,
        true,
        async () => {
          throw new Error("disabled callback");
        },
      ),
    ).toEqual({ status: "home_only" });
  }
});

test("D-33 attempt-fence parity requires running session, exact turn, attempt and generation", async () => {
  const request = {
    identity: { turnId: "turn" },
    attemptId: "attempt",
    executionGeneration: 2,
  } as SubscriptionCorePlacementRequest;
  const row = {
    status: "running",
    session_status: "running",
    active_turn_id: "turn",
    active_attempt_id: "attempt",
    execution_generation: 2,
  };
  const read = (value: unknown) =>
    readAttemptFence(
      { execute: async () => (value === null ? [] : [value]) } as unknown as Database,
      request,
    );
  expect(await read(row)).toBe(true);
  for (const changed of [
    null,
    { ...row, status: "recovering" },
    { ...row, session_status: "paused" },
    { ...row, active_turn_id: "different" },
    { ...row, active_attempt_id: "old" },
    { ...row, execution_generation: 1 },
  ])
    expect(await read(changed)).toBe(false);
});
