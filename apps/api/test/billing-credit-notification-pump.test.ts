import { expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import type { ManagedEmailTransport } from "@opengeni/core";
import { startBillingCreditNotificationDelivery } from "../src/billing-credit-notifications";

const transport: ManagedEmailTransport = {
  sender: "sender@example.test",
  idempotency: { scope: "pump-test", retentionSeconds: 86_400 },
  send: async () => {
    throw new Error("Empty discovery must not send");
  },
};

test("stopping before the first tick prevents discovery", async () => {
  let calls = 0;
  const db = {
    execute: async () => {
      calls++;
      return [];
    },
  } as unknown as Database;
  await startBillingCreditNotificationDelivery(db, transport, "https://app.test")();
  expect(calls).toBe(0);
});

test("one pump per database does not overlap and stop drains before allowing restart", async () => {
  let calls = 0;
  let release!: (rows: never[]) => void;
  const blocked = new Promise<never[]>((resolve) => {
    release = resolve;
  });
  const db = {
    execute: async () => {
      calls++;
      return blocked;
    },
  } as unknown as Database;
  const stop = startBillingCreditNotificationDelivery(db, transport, "https://app.test", 2);
  try {
    expect(startBillingCreditNotificationDelivery(db, transport, "https://app.test", 2)).toBe(stop);
    await Bun.sleep(20);
    expect(calls).toBe(1);
    let drained = false;
    const stopping = stop().then(() => {
      drained = true;
    });
    await Bun.sleep(10);
    expect(drained).toBe(false);
    expect(calls).toBe(1);
    release([]);
    await stopping;
    const restart = startBillingCreditNotificationDelivery(db, transport, "https://app.test");
    try {
      expect(restart).not.toBe(stop);
      await stop();
      expect(startBillingCreditNotificationDelivery(db, transport, "https://app.test")).toBe(
        restart,
      );
    } finally {
      await restart();
    }
  } finally {
    release([]);
    await stop();
  }
});

test("a failed discovery is retried on the next scheduled pass", async () => {
  let calls = 0;
  let observedRetry!: () => void;
  const retried = new Promise<void>((resolve) => {
    observedRetry = resolve;
  });
  const db = {
    execute: async () => {
      calls++;
      if (calls === 1) throw new Error("temporary database failure");
      observedRetry();
      return [];
    },
  } as unknown as Database;
  const stop = startBillingCreditNotificationDelivery(db, transport, "https://app.test", 2);
  try {
    await retried;
    expect(calls).toBe(2);
  } finally {
    await stop();
  }
});
