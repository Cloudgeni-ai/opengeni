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
  createNatsEventBus,
  createDetachedSessionEventFanout,
  createResponderConnection,
  publishDurableSessionEvents,
} from "../src/index";

const SENTINEL_URL = "nats://test-sentinel:4222";
const SENTINEL_WS = "00000000-0000-4000-8000-0000000000ff";

async function settleMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
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
});

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

  const eventFor = (sequence: number, type = "sandbox.box.created") => ({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: SENTINEL_WS,
    sessionId: "00000000-0000-4000-8000-000000000001",
    sequence,
    type,
    payload: { sequence },
    occurredAt: "2026-07-10T00:00:00.000Z",
    clientEventId: null,
    turnId: "00000000-0000-4000-8000-000000000020",
  });

  test("managed NATS publish reports success, failure, and timeout while legacy publish stays no-throw", async () => {
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

    const timedOut = await createBus(
      {
        flush: async () => await new Promise<void>(() => {}),
      },
      1,
    );
    expect(await timedOut.publishWithOutcome!(SENTINEL_WS, "session", events)).toBe("timed_out");

    const synchronousFailure = await createBus({
      publish: () => {
        throw new Error("connection closed");
      },
    });
    expect(await synchronousFailure.publishWithOutcome!(SENTINEL_WS, "session", events)).toBe(
      "failed",
    );
    await expect(
      synchronousFailure.publish(SENTINEL_WS, "session", events),
    ).resolves.toBeUndefined();
  });

  test("the activity lane records the managed transport outcome instead of legacy publish success", async () => {
    const outcomes: string[] = [];
    const fanout = createDetachedSessionEventFanout(
      {
        publish: async () => {},
        publishWithOutcome: async () => "timed_out",
      } as never,
      { onPublishOutcome: ({ outcome }) => outcomes.push(outcome) },
    );

    fanout.enqueue(SENTINEL_WS, "session", [eventFor(1)] as never);
    await fanout.drain();
    expect(outcomes).toEqual(["timed_out"]);
  });

  test("a lower detached sequence is invoked before a higher awaited sequence", async () => {
    const releases: Array<() => void> = [];
    const published: number[][] = [];
    const outcomes: string[] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const append = (sequence: number) =>
      (async () => ({ events: [eventFor(sequence)], accepted: true })) as never;

    const detached = await appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "sandbox.box.created", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: append(11),
      },
    );
    expect(detached.accepted).toBe(true);
    expect(published).toEqual([[11]]);

    let awaitedCompleted = false;
    const awaited = appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "turn.completed", payload: {} }] as never,
      {
        fanout: "awaited",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: append(12),
      },
    ).then(() => {
      awaitedCompleted = true;
    });
    await settleMicrotasks();
    expect(published).toEqual([[11]]);
    expect(awaitedCompleted).toBe(false);

    releases.shift()!();
    await settleMicrotasks();
    expect(published).toEqual([[11], [12]]);
    expect(awaitedCompleted).toBe(false);
    releases.shift()!();
    await awaited;
    expect(outcomes).toEqual(["succeeded"]);
  });

  test("a slower lower append cannot publish after a faster higher append", async () => {
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
        return { events: [eventFor(sequence)], accepted: true };
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
    await fanout.drain();
  });

  test("an unresolved append does not stall an unrelated session", async () => {
    let releaseFirst!: () => void;
    const published: Array<[string, number[]]> = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push([sessionId, events.map((event) => event.sequence)]);
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
    });
    const sharedArgs = [
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
    ] as const;

    const first = appendAndPublishTurnEventsFenced(
      sharedArgs[0],
      sharedArgs[1],
      sharedArgs[2],
      "00000000-0000-4000-8000-000000000001",
      sharedArgs[3],
      sharedArgs[4],
      sharedArgs[5],
      [{ type: "sandbox.box.created", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () => {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { events: [eventFor(11)], accepted: true };
        }) as never,
      },
    );
    await settleMicrotasks();

    await appendAndPublishTurnEventsFenced(
      sharedArgs[0],
      sharedArgs[1],
      sharedArgs[2],
      "00000000-0000-4000-8000-000000000002",
      sharedArgs[3],
      sharedArgs[4],
      sharedArgs[5],
      [{ type: "turn.completed", payload: {} }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () => ({
          events: [eventFor(21)],
          accepted: true,
        })) as never,
      },
    );
    await settleMicrotasks();
    expect(published).toEqual([["00000000-0000-4000-8000-000000000002", [21]]]);

    releaseFirst();
    await first;
    await fanout.drain();
    expect(published).toEqual([
      ["00000000-0000-4000-8000-000000000002", [21]],
      ["00000000-0000-4000-8000-000000000001", [11]],
    ]);
  });

  test("an admitted awaited sequence cannot be overtaken by a later detached enqueue", async () => {
    const releases: Array<() => void> = [];
    const published: number[][] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
    });

    fanout.enqueue(SENTINEL_WS, "session", [eventFor(1)] as never);
    const awaited = fanout.publishAwaited(SENTINEL_WS, "session", [
      eventFor(2, "turn.completed"),
    ] as never);
    fanout.enqueue(SENTINEL_WS, "session", [eventFor(3)] as never);
    expect(published).toEqual([[1]]);

    releases.shift()!();
    await settleMicrotasks();
    expect(published).toEqual([[1], [2]]);
    releases.shift()!();
    await awaited;
    await settleMicrotasks();
    expect(published).toEqual([[1], [2], [3]]);
    releases.shift()!();
    await fanout.drain();
  });

  test("one active plus the oldest pending batch is retained and later overflow is dropped", async () => {
    const releases: Array<() => void> = [];
    const published: number[][] = [];
    const outcomes: string[] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });

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

  test("failure and timeout release the lane while late rejection stays handled", async () => {
    const outcomes: string[] = [];
    const published: number[][] = [];
    const timeoutCallbacks: Array<() => void> = [];
    let rejectFirst!: (error: Error) => void;
    let call = 0;
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        call += 1;
        published.push(events.map((event) => event.sequence));
        if (call === 1) {
          return await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        if (call === 2) throw new Error("simulated live transport failure");
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: (callback) => {
        timeoutCallbacks.push(callback);
        return () => {};
      },
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      fanout.enqueue(SENTINEL_WS, "session", [eventFor(1)] as never);
      fanout.enqueue(SENTINEL_WS, "session", [eventFor(2)] as never);
      timeoutCallbacks.shift()!();
      await fanout.drain();
      expect(published).toEqual([[1], [2]]);
      expect(outcomes).toEqual(["timed_out", "failed"]);

      rejectFirst(new Error("late provider rejection"));
      await settleMicrotasks();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("all activity exits close bounded ownership, drop pending work, and isolate worker reuse", async () => {
    const reasons = [
      "activity_completed",
      "activity_failed",
      "activity_cancelled",
      "worker_shutdown",
    ] as const;
    for (const reason of reasons) {
      const outcomes: string[] = [];
      const timeoutCallbacks: Array<() => void> = [];
      let rejectLate!: (error: Error) => void;
      const fanout = createDetachedSessionEventFanout(
        {
          publish: async () =>
            await new Promise<void>((_resolve, reject) => {
              rejectLate = reject;
            }),
        } as never,
        {
          timeoutScheduler: (callback) => {
            timeoutCallbacks.push(callback);
            return () => {};
          },
          onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
        },
      );
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      try {
        fanout.enqueue(SENTINEL_WS, "session", [eventFor(1)] as never);
        fanout.enqueue(SENTINEL_WS, "session", [eventFor(2)] as never);
        const closing = fanout.close(reason);
        timeoutCallbacks.at(-1)!();
        await closing;
        expect(outcomes).toEqual(["dropped", "timed_out"]);

        fanout.enqueue(SENTINEL_WS, "session", [eventFor(3)] as never);
        expect(outcomes).toEqual(["dropped", "timed_out", "dropped"]);
        rejectLate(new Error(`late settlement after ${reason}`));
        await settleMicrotasks();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      const reusedPublished: number[][] = [];
      const nextActivity = createDetachedSessionEventFanout({
        publish: async (_workspaceId, _sessionId, events: Array<{ sequence: number }>) => {
          reusedPublished.push(events.map((event) => event.sequence));
        },
      } as never);
      nextActivity.enqueue(SENTINEL_WS, "session", [eventFor(4)] as never);
      await nextActivity.drain();
      expect(reusedPublished).toEqual([[4]]);
    }
  });

  test("critical fenced publication still awaits a delayed live fanout", async () => {
    let release!: () => void;
    const bus = {
      publish: async () => await new Promise<void>((resolve) => (release = resolve)),
    } as never;
    let completed = false;
    const operation = appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "agent.toolCall.output", payload: { id: "call-1", output: "ok" } }] as never,
      {
        appendSessionEventsForTurnAttempt: (async () => ({
          events: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              workspaceId: SENTINEL_WS,
              sessionId: "00000000-0000-4000-8000-000000000001",
              sequence: 1,
              type: "agent.toolCall.output",
              payload: { id: "call-1", output: "ok" },
              occurredAt: "2026-07-10T00:00:00.000Z",
              clientEventId: null,
              turnId: "00000000-0000-4000-8000-000000000020",
            },
          ],
          accepted: true,
        })) as never,
      },
    ).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await operation;
    expect(completed).toBe(true);
  });
});

// NOTE: the append/publish TIMING observer wired into `appendAndPublishEvents` is
// exercised via `observeSince` in observe-timing.test.ts, NOT here — in the full
// suite another test file installs a process-global `mock.module("@opengeni/events")`
// that stubs `appendAndPublishEvents` (ignoring the observer arg), so an
// observer assertion made THROUGH `appendAndPublishEvents` is defeated. `observeSince`
// survives that mock because the stub spreads the real module for every other export.
