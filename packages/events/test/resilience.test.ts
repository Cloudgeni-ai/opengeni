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

  test("detached fenced fanout returns after the durable append and preserves sequence order", async () => {
    const appended: unknown[] = [];
    const pendingPublishes: Array<() => void> = [];
    const published: number[][] = [];
    const outcomes: string[] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => pendingPublishes.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    let durableCommitted = false;
    const appendSessionEventsForTurnAttempt = async () => {
      durableCommitted = true;
      const event = {
        id: "00000000-0000-4000-8000-000000000011",
        workspaceId: SENTINEL_WS,
        sessionId: "00000000-0000-4000-8000-000000000001",
        sequence: 11,
        type: "sandbox.operation.completed",
        payload: { name: "sandbox.provision" },
        occurredAt: "2026-07-10T00:00:00.000Z",
        clientEventId: null,
        turnId: "00000000-0000-4000-8000-000000000020",
      };
      appended.push(event);
      return { events: [event], accepted: true };
    };

    const first = await appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "sandbox.operation.completed", payload: { name: "sandbox.provision" } }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: appendSessionEventsForTurnAttempt as never,
      },
    );

    expect(first.accepted).toBe(true);
    expect(durableCommitted).toBe(true);
    expect(appended).toHaveLength(1);
    expect(published).toEqual([[11]]);
    expect(outcomes).toEqual([]);

    // A second durable append can complete while the first live publish is slow.
    const secondEvent = { ...appended[0], sequence: 12 };
    const second = await appendAndPublishTurnEventsFenced(
      {} as never,
      bus,
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000020",
      1,
      "00000000-0000-4000-8000-000000000021",
      [{ type: "sandbox.operation.completed", payload: { name: "sandbox.provision" } }] as never,
      {
        fanout: "detached",
        detachedFanout: fanout,
        appendSessionEventsForTurnAttempt: (async () => ({
          events: [secondEvent],
          accepted: true,
        })) as never,
      },
    );
    expect(second.accepted).toBe(true);
    expect(published).toEqual([[11]]);

    pendingPublishes.shift()!();
    await settleMicrotasks();
    pendingPublishes.shift()!();
    await fanout.drain();
    expect(published).toEqual([[11], [12]]);
    expect(outcomes).toEqual(["published", "published"]);
  });

  test("detached fanout drops a bounded overflow without changing durable ordering", async () => {
    const release: Array<() => void> = [];
    const published: number[][] = [];
    const outcomes: string[] = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => release.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: () => () => {},
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const eventFor = (sequence: number) => ({
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      workspaceId: SENTINEL_WS,
      sessionId: "00000000-0000-4000-8000-000000000001",
      sequence,
      type: "sandbox.box.created",
      payload: { sandboxId: `sandbox-${sequence}` },
      occurredAt: "2026-07-10T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    });
    const enqueue = (sequence: number) =>
      fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(sequence)]);

    enqueue(1);
    enqueue(2);
    enqueue(3);
    await settleMicrotasks();
    expect(published).toEqual([[1]]);
    expect(outcomes).toContain("dropped");

    release.shift()!();
    await settleMicrotasks();
    release.shift()!();
    await fanout.drain();
    expect(published).toEqual([[1], [2]]);
    expect(outcomes).toEqual(["dropped", "published", "published"]);
  });

  test("a detached publish failure is observed and the queue continues with the next batch", async () => {
    const published: number[][] = [];
    const outcomes: string[] = [];
    let publishCalls = 0;
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        publishCalls += 1;
        published.push(events.map((event) => event.sequence));
        if (publishCalls === 1) throw new Error("simulated live transport failure");
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const eventFor = (sequence: number) => ({
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      workspaceId: SENTINEL_WS,
      sessionId: "00000000-0000-4000-8000-000000000001",
      sequence,
      type: "sandbox.box.created",
      payload: { sandboxId: `sandbox-${sequence}` },
      occurredAt: "2026-07-10T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    });

    fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(1)]);
    fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(2)]);
    await fanout.drain();

    expect(published).toEqual([[1], [2]]);
    expect(outcomes).toEqual(["failed", "published"]);
  });

  test("a hung detached publish keeps one active provider operation and never starts a second", async () => {
    let publishCalls = 0;
    const outcomes: string[] = [];
    const timeoutCallbacks: Array<() => void> = [];
    const bus = {
      publish: async () => {
        publishCalls += 1;
        return await new Promise<void>(() => {});
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: (callback) => {
        timeoutCallbacks.push(callback);
        return () => {};
      },
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const eventFor = (sequence: number) => ({
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      workspaceId: SENTINEL_WS,
      sessionId: "00000000-0000-4000-8000-000000000001",
      sequence,
      type: "sandbox.box.created",
      payload: { sandboxId: `sandbox-${sequence}` },
      occurredAt: "2026-07-10T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    });
    fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(1)]);
    fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(2)]);
    fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(3)]);
    timeoutCallbacks.shift()!();
    await settleMicrotasks();
    expect(publishCalls).toBe(1);
    expect(outcomes).toEqual(["dropped", "timed_out"]);
  });

  test("late settlement resumes the retained FIFO batch and accepts later fanout", async () => {
    const release: Array<() => void> = [];
    const published: number[][] = [];
    const outcomes: string[] = [];
    const timeoutCallbacks: Array<() => void> = [];
    const bus = {
      publish: async (
        _workspaceId: string,
        _sessionId: string,
        events: Array<{ sequence: number }>,
      ) => {
        published.push(events.map((event) => event.sequence));
        await new Promise<void>((resolve) => release.push(resolve));
      },
    } as never;
    const fanout = createDetachedSessionEventFanout(bus, {
      timeoutScheduler: (callback) => {
        timeoutCallbacks.push(callback);
        return () => {};
      },
      onPublishOutcome: ({ outcome }) => outcomes.push(outcome),
    });
    const eventFor = (sequence: number) => ({
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      workspaceId: SENTINEL_WS,
      sessionId: "00000000-0000-4000-8000-000000000001",
      sequence,
      type: "sandbox.box.created",
      payload: { sandboxId: `sandbox-${sequence}` },
      occurredAt: "2026-07-10T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    });
    const enqueue = (sequence: number) =>
      fanout.enqueue(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", [eventFor(sequence)]);

    enqueue(1);
    enqueue(2);
    enqueue(3);
    timeoutCallbacks.shift()!();
    await settleMicrotasks();
    expect(published).toEqual([[1]]);
    expect(outcomes).toEqual(["dropped", "timed_out"]);

    release.shift()!();
    await settleMicrotasks();
    expect(published).toEqual([[1], [2]]);
    release.shift()!();
    await fanout.drain();

    enqueue(4);
    await settleMicrotasks();
    expect(published).toEqual([[1], [2], [4]]);
    release.shift()!();
    await fanout.drain();
    expect(outcomes).toEqual(["dropped", "timed_out", "published", "published"]);
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
