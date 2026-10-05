import { expect, spyOn, test } from "bun:test";
import type { TurnCredentialLeaseDeps } from "../src/activities/agent-turn/credential-leases";
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

test("Claude participates in the shared serving lease with its exact scoped holder fence", async () => {
  const db = await import("@opengeni/db");
  const { createTurnCredentialLeases } =
    await import("../src/activities/agent-turn/credential-leases");
  const heartbeat = spyOn(db, "heartbeatClaudeCredentialLeaseUntil").mockResolvedValue(
    new Date(Date.now() + 300_000),
  );
  const xai = spyOn(db, "heartbeatXaiCredentialLeaseUntil");
  try {
    const dependencies = {
      db: {} as TurnCredentialLeaseDeps["db"],
      observability: {
        incrementCounter() {},
        warn() {},
      } as unknown as TurnCredentialLeaseDeps["observability"],
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      codexWorkspaceKey: "fixture",
      getTurnId: () => "fixture-turn",
    };
    const leases = createTurnCredentialLeases(dependencies);
    Object.assign(leases.claude, {
      held: true,
      subjectId: "user:fixture",
      holderId: "fixture-holder",
      generation: 3,
      confirmedUntilMs: performance.now() + 10_000,
    });
    await leases.renewServing("model_usage");
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat.mock.calls[0]?.[1]).toEqual({
      workspaceId: dependencies.workspaceId,
      subjectId: "user:fixture",
      turnId: "fixture-turn",
      holderId: "fixture-holder",
      generation: 3,
      leaseTtlMs: db.CLAUDE_CREDENTIAL_LEASE_TTL_MS,
    });
    expect(xai).not.toHaveBeenCalled();
    expect(leases.servingLost()).toBe(false);
    heartbeat.mockResolvedValue(null);
    leases.claude.confirmedUntilMs = performance.now() + 10_000;
    await leases.renewServing("runtime_event");
    expect(leases.servingLost()).toBe(true);
    expect(() => leases.claude.assertUsable()).toThrow(
      "Claude credential lease is not usable for provider dispatch",
    );
  } finally {
    heartbeat.mockRestore();
    xai.mockRestore();
  }
});

test("a runtime-event and model-usage burst reuses its fresh lease confirmation", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return new Date();
  });
  await f.lease.renew("runtime_event");
  const deadline = f.lease.confirmedUntilMs;
  for (let event = 0; event < 100; event++) {
    await f.lease.renew(event % 2 === 0 ? "runtime_event" : "model_usage");
    f.lease.assertUsable();
  }
  expect(calls).toBe(1);
  expect(f.lease.confirmedUntilMs).toBe(deadline);
  expect(f.renewed).toEqual(["runtime_event"]);
});

test("acquisition confirms a lease until the renewal cadence is due", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return new Date();
  });
  f.lease.confirmedUntilMs = 200;
  await f.lease.renew("runtime_event");
  f.time(119);
  await f.lease.renew("model_usage");
  expect(calls).toBe(0);
  expect(f.lease.confirmedUntilMs).toBe(200);
  f.time(120);
  await f.lease.renew("runtime_event");
  expect(calls).toBe(1);
  expect(f.lease.confirmedUntilMs).toBe(220);
});

test("failed renewal retries at the next checkpoint without moving its confirmation", async () => {
  const error = new Error("fixture outage");
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 2) throw error;
    return new Date();
  });
  await f.lease.renew("runtime_event");
  f.time(120);
  await f.lease.renew("timer");
  expect(f.errors).toEqual([error]);
  expect(f.lease.confirmedUntilMs).toBe(200);
  await f.lease.renew("model_usage");
  expect(calls).toBe(3);
  expect(f.lease.confirmedUntilMs).toBe(220);
  expect(f.renewed).toEqual(["runtime_event", "model_usage"]);
});

test("expiry is checked before coalescing or joining an in-flight renewal", async () => {
  let finish!: (value: Date) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.lease.renew("timer");
  f.time(150);
  await f.lease.renew("runtime_event");
  expect(f.lost).toEqual(["deadline"]);
  finish(new Date());
  await pending;
  expect(f.renewed).toEqual([]);
  expect(f.lease.confirmedUntilMs).toBe(150);
});

test("a replacement holder uses its own acquisition deadline and identity", async () => {
  const identities: unknown[] = [];
  const f = fixture(async (identity) => {
    identities.push(identity);
    return new Date();
  });
  await f.lease.renew("runtime_event");
  Object.assign(f.lease, { holderId: "replacement", generation: 3, confirmedUntilMs: 210 });
  f.turn("replacement-turn");
  f.time(120);
  await f.lease.renew("model_usage");
  expect(identities).toHaveLength(1);
  f.time(130);
  await f.lease.renew("model_usage");
  expect(identities[1]).toEqual({
    turnId: "replacement-turn",
    holderId: "replacement",
    generation: 3,
  });
});

test("the independent 60-second timer renews a quiet production-TTL lease", async () => {
  const timer = { unref() {} };
  const interval = spyOn(globalThis, "setInterval").mockReturnValue(
    timer as unknown as ReturnType<typeof setInterval>,
  );
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  let clock = 0;
  let calls = 0;
  const lease = new SubscriptionTurnLease({
    ttlMs: 300_000,
    getTurnId: () => "quiet-turn",
    now: () => clock,
    heartbeat: async () => {
      calls++;
      return new Date();
    },
    onLost: () => {
      throw new Error("unexpected lease loss");
    },
    onError: (error) => {
      throw error;
    },
    lostError: (reason) => new Error(reason),
  });
  Object.assign(lease, {
    held: true,
    holderId: "quiet-holder",
    generation: 1,
    confirmedUntilMs: 300_000,
  });
  try {
    lease.startHeartbeat();
    lease.startHeartbeat();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0]?.[1]).toBe(60_000);
    const tick = interval.mock.calls[0]?.[0] as () => void;
    clock = 60_000;
    tick();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(lease.confirmedUntilMs).toBe(360_000);
    clock = 120_000;
    tick();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(lease.confirmedUntilMs).toBe(420_000);
    lease.stopHeartbeat();
    lease.stopHeartbeat();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(timer);
  } finally {
    lease.stopHeartbeat();
    interval.mockRestore();
    clear.mockRestore();
  }
});
