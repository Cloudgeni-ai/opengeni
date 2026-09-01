// Resiliency regression guards for the production-down NATS bug: an in-cluster
// broker pod restart used to take the whole control plane down permanently
// because the client connected with no reconnect policy (nats.js's weak default
// gives up after ~10 attempts / ~20s and goes CONNECTION_CLOSED forever).
//
// These tests assert the fix WITHOUT a real broker:
//  1. EVERY long-lived connection (`createNatsEventBus` + the auth-callout
//     `createResponderConnection`) connects with the shared infinite-reconnect
//     options.
//  2. `appendAndPublishEvents` never lets a failed/throwing publish kill the
//     in-flight turn — the events are already durable in the DB.
//
// The fakes are injected per call. This deliberately avoids Bun's process-global
// `mock.module`, so the combined `bun test` process cannot contaminate unrelated
// event or database tests.

import { describe, expect, test } from "bun:test";
import type { AppendEventInput } from "@opengeni/db";
import {
  appendAndPublishEvents,
  appendAndPublishTurnEventsFenced,
  createDetachedSessionEventFanout,
  createNatsEventBus,
  createResponderConnection,
  publishDurableSessionEvents,
  requireSessionEventDurableFanoutCapability,
  SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
} from "../src/index";

const SENTINEL_URL = "nats://test-sentinel:4222";
const SENTINEL_WS = "00000000-0000-4000-8000-0000000000ff";

async function settleMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

function eventFor(sequence: number, type = "sandbox.box.created") {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: SENTINEL_WS,
    sessionId: "00000000-0000-4000-8000-000000000001",
    sequence,
    type,
    payload: { sequence },
    occurredAt: "2026-08-31T00:00:00.000Z",
    clientEventId: null,
    turnId: "00000000-0000-4000-8000-000000000020",
  };
}

function appendResult(sequence: number, type = "sandbox.box.created") {
  return {
    events: [eventFor(sequence, type)],
    accepted: true,
    canonicalStartupMilestones: [],
  };
}

const captured: Array<{ servers?: unknown } & Record<string, unknown>> = [];

function fakeNatsConnection(): unknown {
  const emptyAsyncIterable = () => (async function* () {})();
  return {
    status: () => emptyAsyncIterable(),
    subscribe: () => Object.assign(emptyAsyncIterable(), { unsubscribe() {} }),
    publish() {},
    async flush() {},
    async drain() {},
    async request() {
      return { data: new Uint8Array() };
    },
    isClosed: () => false,
    isDraining: () => false,
  };
}

function controllableStatusFeed(): {
  iterable: AsyncIterable<{ type: string; data: string }>;
  push: (type: string) => void;
  close: () => void;
} {
  const queued: Array<{ type: string; data: string }> = [];
  const waiters: Array<
    (result: IteratorResult<{ type: string; data: string }, undefined>) => void
  > = [];
  let closed = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            const queuedStatus = queued.shift();
            if (queuedStatus) return { done: false, value: queuedStatus } as const;
            if (closed) return { done: true, value: undefined } as const;
            return await new Promise<IteratorResult<{ type: string; data: string }, undefined>>(
              (resolve) => waiters.push(resolve),
            );
          },
        };
      },
    },
    push: (type) => {
      const status = { type, data: type };
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: status });
      else queued.push(status);
    },
    close: () => {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
  };
}

const fakeConnect = async (opts: Record<string, unknown>) => {
  captured.push(opts);
  return fakeNatsConnection() as never;
};

let sentinelAppendCalls = 0;
const fakeAppendSessionEvents = async (
  _db: unknown,
  workspaceId: string,
  sessionId: string,
  events: AppendEventInput[],
) => {
  if (workspaceId !== SENTINEL_WS) {
    throw new Error(`unexpected workspace in sentinel append: ${workspaceId}`);
  }
  sentinelAppendCalls += 1;
  return events.map((event, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    workspaceId,
    sessionId,
    sequence: index + 1,
    type: event.type,
    payload: event.payload ?? {},
    occurredAt: "2026-06-27T00:00:00.000Z",
    clientEventId: event.clientEventId ?? null,
    turnId: event.turnId ?? null,
  }));
};

function expectInfiniteReconnect(opts: Record<string, unknown>): void {
  expect(opts.reconnect).toBe(true);
  expect(opts.maxReconnectAttempts).toBe(-1); // infinite — never give up
  expect(opts.reconnectTimeWait).toBe(2_000);
  expect(opts.reconnectJitter).toBe(1_000);
  expect(opts.reconnectJitterTLS).toBe(1_000);
  expect(opts.waitOnFirstConnect).toBe(true);
  expect(typeof opts.pingInterval).toBe("number");
}

describe("long-lived NATS connections survive an indefinite broker outage", () => {
  test("createNatsEventBus connects with infinite reconnect + preserved auth", async () => {
    captured.length = 0;
    await createNatsEventBus(
      SENTINEL_URL,
      { user: "ctrl", pass: "secret" },
      { connect: fakeConnect },
    );
    expect(captured).toHaveLength(1);
    const opts = captured[0]!;
    expect(opts.servers).toBe(SENTINEL_URL);
    expect(opts.user).toBe("ctrl");
    expect(opts.pass).toBe("secret");
    expectInfiniteReconnect(opts);
  });

  test("createResponderConnection (auth-callout) connects with infinite reconnect", async () => {
    captured.length = 0;
    await createResponderConnection(
      SENTINEL_URL,
      { kind: "token", token: "callout-token" },
      "$SYS.REQ.USER.AUTH",
      () => new Uint8Array(),
      { name: "opengeni-auth-callout", connect: fakeConnect },
    );
    expect(captured).toHaveLength(1);
    const opts = captured[0]!;
    expect(opts.servers).toBe(SENTINEL_URL);
    expect(opts.token).toBe("callout-token");
    expect(opts.name).toBe("opengeni-auth-callout");
    expectInfiniteReconnect(opts);
  });

  test("event-bus subscribers observe each successful transport reconnect once", async () => {
    const statuses = controllableStatusFeed();
    const bus = await createNatsEventBus("nats://reconnect-observer.test:4222", undefined, {
      connect: async () =>
        ({
          ...fakeNatsConnection(),
          status: () => statuses.iterable,
          async drain() {
            statuses.close();
          },
        }) as never,
    });
    const observed: number[] = [];
    const capability = requireSessionEventDurableFanoutCapability(bus);
    expect(capability.version).toBe(SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION);
    const unsubscribe = capability.subscribeRecovery((generation) => observed.push(generation));

    statuses.push("disconnect");
    await Bun.sleep(0);
    expect(observed).toEqual([]);

    statuses.push("reconnect");
    statuses.push("reconnect");
    await waitFor(() => observed.length === 2);
    expect(observed).toEqual([1, 2]);

    unsubscribe();
    statuses.push("reconnect");
    await Bun.sleep(0);
    expect(observed).toEqual([1, 2]);
    await bus.close();
  });

  test("legacy publish-only embedding buses fail the explicit recovery contract", () => {
    expect(() =>
      requireSessionEventDurableFanoutCapability({ publish: async () => undefined }),
    ).toThrow("sessionEventDurableFanout v1");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for NATS status observation");
    await Bun.sleep(1);
  }
}

describe("appendAndPublishEvents is best-effort on the live fan-out", () => {
  test("does not throw the turn to death when bus.publish rejects", async () => {
    const rejectingBus = {
      publish: async () => {
        throw new Error("CONNECTION_CLOSED");
      },
    } as never;

    const appended = await appendAndPublishEvents(
      {} as never,
      rejectingBus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      [{ type: "agent.message.delta", payload: { text: "hi" } }] as never,
      { appendSessionEvents: fakeAppendSessionEvents as never },
    );

    expect(appended).toHaveLength(1);
    expect(appended[0]!.sequence).toBe(1);
  });

  test("publishes an already-durable batch without appending it again", async () => {
    sentinelAppendCalls = 0;
    const published: unknown[][] = [];
    const bus = {
      publish: async (_workspaceId: string, _sessionId: string, events: unknown[]) => {
        published.push(events);
      },
    } as never;
    const events = [
      {
        id: "00000000-0000-4000-8000-000000000010",
        workspaceId: SENTINEL_WS,
        sessionId: "00000000-0000-4000-8000-000000000001",
        sequence: 10,
        type: "turn.preempted",
        payload: { reason: "worker_shutdown" },
        occurredAt: "2026-07-10T00:00:00.000Z",
        clientEventId: null,
        turnId: "00000000-0000-4000-8000-000000000020",
      },
    ];

    await publishDurableSessionEvents(
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      events as never,
    );

    expect(sentinelAppendCalls).toBe(0);
    expect(published).toEqual([events]);
  });

  test("an empty durable batch does not publish", async () => {
    let publishCalls = 0;
    await publishDurableSessionEvents(
      {
        publish: async () => {
          publishCalls += 1;
        },
      } as never,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      [],
    );
    expect(publishCalls).toBe(0);
  });
});

describe("bounded activity session-event fanout", () => {
  test("managed NATS reports live outcomes while ordinary publish remains no-throw", async () => {
    const createBus = async (
      overrides: Partial<ReturnType<typeof fakeNatsConnection>>,
      publishFlushTimeoutMs = 10,
    ) =>
      await createNatsEventBus(SENTINEL_URL, undefined, {
        connect: (async () => ({ ...fakeNatsConnection(), ...overrides }) as never) as never,
        publishFlushTimeoutMs,
      });
    const events = [eventFor(1)] as never;

    const succeeded = await createBus({});
    expect(await succeeded.publishWithOutcome!(SENTINEL_WS, "session", events)).toBe("succeeded");

    const rejectedFlush = await createBus({
      flush: async () => {
        throw new Error("flush failed");
      },
    });
    expect(await rejectedFlush.publishWithOutcome!(SENTINEL_WS, "session", events)).toBe("failed");
    await expect(rejectedFlush.publish(SENTINEL_WS, "session", events)).resolves.toBeUndefined();

    const timedOut = await createBus({ flush: async () => await new Promise<void>(() => {}) }, 1);
    expect(await timedOut.publishWithOutcome!(SENTINEL_WS, "session", events)).toBe("timed_out");

    const synchronousFailure = await createBus({
      publish: () => {
        throw new Error("connection closed");
      },
    });
    expect(await synchronousFailure.publishWithOutcome!(SENTINEL_WS, "session", events)).toBe(
      "failed",
    );
  });

  test("records the managed transport outcome instead of legacy publish success", async () => {
    const outcomes: string[] = [];
    const fanout = createDetachedSessionEventFanout(
      {
        publish: async () => {},
        publishWithOutcome: async () => "timed_out",
      },
      { onPublishOutcome: ({ outcome }) => outcomes.push(outcome) },
    );

    fanout.enqueue(SENTINEL_WS, "session", [eventFor(1)] as never);
    await fanout.drain();
    expect(outcomes).toEqual(["timed_out"]);
  });

  test("orders a delayed lower append before a faster higher awaited append", async () => {
    const appendReleases = new Map<number, () => void>();
    const publishReleases: Array<() => void> = [];
    const published: number[][] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => publishReleases.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
    });
    const delayedAppend = (sequence: number) =>
      (async () => {
        await new Promise<void>((resolve) => appendReleases.set(sequence, resolve));
        return appendResult(sequence);
      }) as never;
    const args = [
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
    ] as const;

    const lower = appendAndPublishTurnEventsFenced(
      ...args,
      [{ type: "sandbox.box.created", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: delayedAppend(11),
      },
    );
    const higher = appendAndPublishTurnEventsFenced(
      ...args,
      [{ type: "turn.completed", payload: {} }] as never,
      {
        fanout: "awaited",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: delayedAppend(12),
      },
    );
    await settleMicrotasks();

    appendReleases.get(12)!();
    await settleMicrotasks();
    expect(published).toEqual([]);

    appendReleases.get(11)!();
    await lower;
    await settleMicrotasks();
    expect(published).toEqual([[11]]);

    publishReleases.shift()!();
    await settleMicrotasks();
    expect(published).toEqual([[11], [12]]);
    publishReleases.shift()!();
    await higher;
  });

  test("an unresolved append does not stall an unrelated session", async () => {
    let releaseFirst!: () => void;
    const published: Array<[string, number[]]> = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        sessionId: string,
        events: Array<{ sequence: number }>,
      ) => published.push([sessionId, events.map((event) => event.sequence)]),
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
    });

    const first = appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "session-1",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "sandbox.box.created", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () => {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return appendResult(11);
        }) as never,
      },
    );
    await settleMicrotasks();

    await appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "session-2",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "sandbox.box.created", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () => appendResult(21)) as never,
      },
    );
    await settleMicrotasks();
    expect(published).toEqual([["session-2", [21]]]);

    releaseFirst();
    await first;
    await fanout.drain();
    expect(published).toEqual([
      ["session-2", [21]],
      ["session-1", [11]],
    ]);
  });

  test("an unresolved detached reservation times out and suppresses late lower live delivery", async () => {
    let releaseDetached!: () => void;
    const timeoutCallbacks: Array<() => void> = [];
    const outcomes: string[] = [];
    const published: number[][] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => published.push(events.map((event) => event.sequence)),
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: (callback) => {
        timeoutCallbacks.push(callback);
        return () => {};
      },
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const args = [
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
    ] as const;

    const detached = appendAndPublishTurnEventsFenced(
      ...args,
      [{ type: "sandbox.box.created", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () => {
          await new Promise<void>((resolve) => {
            releaseDetached = resolve;
          });
          return appendResult(11);
        }) as never,
      },
    );
    await settleMicrotasks();

    const awaited = appendAndPublishTurnEventsFenced(
      ...args,
      [{ type: "turn.completed", payload: {} }] as never,
      {
        fanout: "awaited",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () =>
          appendResult(12, "turn.completed")) as never,
      },
    );
    await settleMicrotasks();
    expect(published).toEqual([]);
    expect(timeoutCallbacks).toHaveLength(1);

    timeoutCallbacks.shift()!();
    await awaited;
    expect(published).toEqual([[12]]);
    expect(outcomes).toEqual(["timed_out"]);

    releaseDetached();
    await detached;
    await fanout.drain();
    expect(published).toEqual([[12]]);
  });

  test("retains one active plus the oldest pending detached batch", async () => {
    const releases: Array<() => void> = [];
    const published: number[][] = [];
    const outcomes: string[] = [];
    const fanout = createDetachedSessionEventFanout(
      {
        publish: async (_workspaceId, _sessionId, events) => {
          published.push(events.map((event) => event.sequence));
          await new Promise<void>((resolve) => releases.push(resolve));
        },
      },
      {
        timeoutScheduler: () => () => {},
        onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
      },
    );

    fanout.enqueue(SENTINEL_WS, "session", [eventFor(1)] as never);
    fanout.enqueue(SENTINEL_WS, "session", [eventFor(2)] as never);
    fanout.enqueue(SENTINEL_WS, "session", [eventFor(3)] as never);
    expect(published).toEqual([[1]]);
    expect(outcomes).toEqual(["dropped"]);

    releases.shift()!();
    await settleMicrotasks();
    expect(published).toEqual([[1], [2]]);
    releases.shift()!();
    await fanout.drain();
    expect(outcomes).toEqual(["dropped", "succeeded", "succeeded"]);
  });
});

describe("confirmed durable fan-out", () => {
  test("rejects a broker flush failure while ordinary live publish remains best-effort", async () => {
    const emptyAsyncIterable = () => (async function* () {})();
    const bus = await createNatsEventBus("nats://confirmed-publish.test:4222", undefined, {
      connect: async () =>
        ({
          status: emptyAsyncIterable,
          subscribe: () => Object.assign(emptyAsyncIterable(), { unsubscribe() {} }),
          publish() {},
          async flush() {
            throw new Error("CONNECTION_CLOSED");
          },
          async drain() {},
          async request() {
            return { data: new Uint8Array() };
          },
          isClosed: () => false,
          isDraining: () => false,
        }) as never,
    });
    const events = [
      {
        id: "00000000-0000-4000-8000-000000000011",
        workspaceId: SENTINEL_WS,
        sessionId: "00000000-0000-4000-8000-000000000001",
        sequence: 11,
        type: "session.title_set",
        payload: { title: "New conversation", source: "agent" },
        occurredAt: "2026-08-25T00:00:00.000Z",
        clientEventId: null,
        turnId: null,
      },
    ];

    await expect(
      bus.publish(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", events as never),
    ).resolves.toBeUndefined();
    await expect(
      bus.publishConfirmed!(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", events as never),
    ).rejects.toThrow("CONNECTION_CLOSED");
  });
});

// NOTE: the append/publish TIMING observer wired into `appendAndPublishEvents` is
// exercised via `observeSince` in observe-timing.test.ts, NOT here — in the full
// suite another test file installs a process-global `mock.module("@opengeni/events")`
// that stubs `appendAndPublishEvents` (ignoring the observer arg), so an
// observer assertion made THROUGH `appendAndPublishEvents` is defeated. `observeSince`
// survives that mock because the stub spreads the real module for every other export.
