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
  createNatsEventBus,
  createResponderConnection,
  publishDurableSessionEvents,
} from "../src/index";

const SENTINEL_URL = "nats://test-sentinel:4222";
const SENTINEL_WS = "00000000-0000-4000-8000-0000000000ff";

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
});

// NOTE: the append/publish TIMING observer wired into `appendAndPublishEvents` is
// exercised via `observeSince` in observe-timing.test.ts, NOT here — in the full
// suite another test file installs a process-global `mock.module("@opengeni/events")`
// that stubs `appendAndPublishEvents` (ignoring the observer arg), so an
// observer assertion made THROUGH `appendAndPublishEvents` is defeated. `observeSince`
// survives that mock because the stub spreads the real module for every other export.
