import { expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import {
  billingAutoTopUpMaintenance,
  startBillingAutoTopUpMaintenance,
} from "../src/billing-auto-top-up-maintenance";

test("keyset maintenance advances one bounded page and resets after the final page", async () => {
  const page = Array.from({ length: 50 }, (_, i) => String(i));
  const cursors: (string | null)[] = [],
    processed: string[] = [];
  const runner = billingAutoTopUpMaintenance({
    discover: async (after, limit) => {
      expect(limit).toBe(50);
      cursors.push(after);
      return after === null ? page : ["last"];
    },
    process: async (accountId) => {
      processed.push(accountId);
    },
    onError: () => {
      throw new Error("Unexpected error");
    },
  });
  await runner.run();
  expect(processed).toEqual(page);
  await runner.run();
  await runner.run();
  expect(cursors).toEqual([null, "49", null]);
  expect(processed).toHaveLength(101);
});

test("account and logger failures do not starve subsequent organizations", async () => {
  const processed: string[] = [],
    failed: (string | undefined)[] = [];
  const runner = billingAutoTopUpMaintenance({
    discover: async () => ["broken", "healthy"],
    process: async (id) => {
      processed.push(id);
      if (id === "broken") throw new Error("retry");
    },
    onError: (_error, id) => {
      failed.push(id);
      throw new Error("logger unavailable");
    },
  });
  await runner.run();
  await runner.run();
  expect(processed).toEqual(["broken", "healthy", "broken", "healthy"]);
  expect(failed).toEqual(["broken", "broken"]);
});

test("discovery failure retains the cursor for the next pass", async () => {
  let fail = true;
  const cursors: (string | null)[] = [],
    errors: unknown[] = [];
  const runner = billingAutoTopUpMaintenance({
    discover: async (after) => {
      cursors.push(after);
      if (after && fail) {
        fail = false;
        throw new Error("database unavailable");
      }
      return after ? [] : Array.from({ length: 50 }, (_, i) => String(i));
    },
    process: async () => {},
    onError: (error) => {
      errors.push(error);
    },
  });
  await runner.run();
  await runner.run();
  await runner.run();
  expect(cursors).toEqual([null, "49", "49"]);
  expect(errors).toHaveLength(1);
});

test("overlapping ticks share no concurrent pass and stop prevents subsequent accounts", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let discoveries = 0;
  const processed: string[] = [];
  const runner = billingAutoTopUpMaintenance({
    discover: async () => {
      discoveries++;
      return ["first", "second"];
    },
    process: async (id) => {
      processed.push(id);
      entered.resolve();
      await release.promise;
    },
    onError: () => {},
  });
  const running = runner.run();
  await entered.promise;
  await runner.run();
  expect(discoveries).toBe(1);
  runner.stop();
  release.resolve();
  await running;
  await runner.run();
  expect(processed).toEqual(["first"]);
  expect(discoveries).toBe(1);
});

function deps(overrides: Parameters<typeof testSettings>[0] = {}): ApiRouteDeps {
  return { db: {}, settings: testSettings(overrides) } as ApiRouteDeps;
}

test("startup requires Stripe configuration, not the fresh-charge activation flag", async () => {
  let starts = 0,
    runs = 0;
  const factory = () => {
    starts++;
    return {
      run: async () => {
        runs++;
      },
      stop: () => {},
    };
  };
  expect(startBillingAutoTopUpMaintenance(deps(), factory)).toBeNull();
  expect(startBillingAutoTopUpMaintenance(deps({ billingMode: "stripe" }), factory)).toBeNull();
  expect(
    startBillingAutoTopUpMaintenance(deps({ stripeSecretKey: "sk_test_fixture" }), factory),
  ).toBeNull();
  const handle = startBillingAutoTopUpMaintenance(
    deps({
      billingMode: "stripe",
      stripeSecretKey: "sk_test_fixture",
      billingAutoTopUpEnabled: false,
    }),
    factory,
  );
  try {
    expect(handle).not.toBeNull();
    expect(starts).toBe(1);
    expect(runs).toBe(1);
  } finally {
    handle?.stop();
  }
});

test("duplicate application startup shares a handle; stopping allows a clean restart", () => {
  const configured = deps({ billingMode: "stripe", stripeSecretKey: "sk_test_fixture" });
  let starts = 0,
    stops = 0;
  const factory = () => {
    starts++;
    return {
      run: async () => {},
      stop: () => {
        stops++;
      },
    };
  };
  const first = startBillingAutoTopUpMaintenance(configured, factory)!;
  expect(startBillingAutoTopUpMaintenance(configured, factory)).toBe(first);
  expect(starts).toBe(1);
  first.stop();
  const second = startBillingAutoTopUpMaintenance(configured, factory)!;
  try {
    expect(second).not.toBe(first);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
  } finally {
    second.stop();
  }
});
