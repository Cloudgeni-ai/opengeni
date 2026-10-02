import { expect, test } from "bun:test";
import {
  SubscriptionTurnLease,
  type SubscriptionLeaseDeps,
} from "../src/activities/agent-turn/subscription-lease";

function fixture(heartbeat: SubscriptionLeaseDeps["heartbeat"]) {
  let clock = 100;
  let turnId = "turn-fixture";
  const lost: string[] = [];
  const renewed: string[] = [];
  const errors: unknown[] = [];
  const lease = new SubscriptionTurnLease({
    ttlMs: 100,
    getTurnId: () => turnId,
    now: () => clock,
    heartbeat,
    onLost: (reason) => lost.push(reason),
    onRenewed: (reason) => renewed.push(reason),
    onError: (error) => errors.push(error),
    lostError: (reason) => new Error(reason),
  });
  Object.assign(lease, {
    held: true,
    holderId: "holder-fixture",
    generation: 2,
    confirmedUntilMs: 150,
  });
  return {
    lease,
    lost,
    renewed,
    errors,
    turn: (value: string) => {
      turnId = value;
    },
    time: (value: number) => {
      clock = value;
    },
  };
}

test("an on-time renewal uses request start plus TTL, not provider/DB wall time", async () => {
  let finish!: (value: Date) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.lease.renew("model_usage");
  f.time(120);
  finish(new Date("2099-01-01T00:00:00Z"));
  await pending;
  expect(f.lease.confirmedUntilMs).toBe(200);
  expect(f.renewed).toEqual(["model_usage"]);
  expect(f.lost).toEqual([]);
});

test.each([150, 151, 250])(
  "DB success at time %d cannot resurrect an expired holder",
  async (time) => {
    let finish!: (value: Date) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.lease.renew();
    f.time(time);
    finish(new Date());
    await pending;
    expect(f.lease.confirmedUntilMs).toBe(150);
    expect(f.lost).toEqual(["deadline"]);
    expect(() => f.lease.assertUsable()).toThrow("deadline");
    expect(f.renewed).toEqual([]);
  },
);

test("an absent database lease fails closed; loss is reported once", async () => {
  const f = fixture(async () => null);
  await f.lease.renew();
  await f.lease.renew();
  expect(f.lost).toEqual(["not_found"]);
  expect(() => f.lease.assertUsable()).toThrow("not_found");
});

test("transient DB failure retains only the previously confirmed deadline", async () => {
  const error = new Error("fixture outage");
  const f = fixture(async () => {
    throw error;
  });
  await f.lease.renew();
  expect(f.errors).toEqual([error]);
  expect(f.lease.confirmedUntilMs).toBe(150);
  f.lease.assertUsable();
  f.time(150);
  expect(() => f.lease.assertUsable()).toThrow("deadline");
});

test("concurrent renewals coalesce and stale replies cannot extend a replacement holder", async () => {
  let calls = 0;
  let finish!: (value: Date) => void;
  const f = fixture(() => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.lease.renew();
  await f.lease.renew();
  expect(calls).toBe(1);
  Object.assign(f.lease, { holderId: "replacement-fixture", generation: 3, confirmedUntilMs: 175 });
  finish(new Date());
  await pending;
  expect(f.lease.confirmedUntilMs).toBe(175);
  expect(f.renewed).toEqual([]);
  expect(f.lost).toEqual([]);
});

test("expired or unclaimed holders never contact the database", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return new Date();
  });
  f.lease.held = false;
  await f.lease.renew();
  f.lease.held = true;
  f.time(150);
  await f.lease.renew();
  expect(calls).toBe(0);
  expect(f.lost).toEqual(["deadline"]);
});

test.each(["released", "lost", "different_turn"] as const)(
  "an in-flight heartbeat cannot renew a %s lease",
  async (change) => {
    let finish!: (value: Date) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.lease.renew();
    if (change === "released") f.lease.held = false;
    if (change === "lost") f.lease.markLost("not_found");
    if (change === "different_turn") f.turn("other-turn-fixture");
    finish(new Date());
    await pending;
    expect(f.lease.confirmedUntilMs).toBe(150);
    expect(f.renewed).toEqual([]);
  },
);
