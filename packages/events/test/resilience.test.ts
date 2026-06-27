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
// `bun test` runs EVERY file in ONE shared process, and a top-level `mock.module`
// is process-global for the WHOLE run (see apps/api/test/auth-callout.test.ts).
// So both mocks are good citizens: they spread every REAL export and override
// only a gated slice (a sentinel URL / sentinel workspace), falling through to
// the real implementation for everyone else.

import { afterAll, describe, expect, mock, test } from "bun:test";

const SENTINEL_URL = "nats://test-sentinel:4222";
const SENTINEL_WS = "00000000-0000-4000-8000-0000000000ff";

// --- nats mock: capture connect options for the sentinel URL only ------------
const realNats = await import("nats");
const realConnect = realNats.connect;
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
  };
}

mock.module("nats", () => ({
  ...realNats,
  connect: async (opts: Record<string, unknown>) => {
    if (opts?.servers !== SENTINEL_URL) {
      return realConnect(opts as never);
    }
    captured.push(opts);
    return fakeNatsConnection() as never;
  },
}));

// --- db mock: synthesize durable events for the sentinel workspace only -------
const realDb = await import("@opengeni/db");
const realAppend = realDb.appendSessionEvents;
mock.module("@opengeni/db", () => ({
  ...realDb,
  appendSessionEvents: async (
    db: unknown,
    workspaceId: string,
    sessionId: string,
    events: Array<{ type: string; payload?: unknown }>,
  ) => {
    if (workspaceId !== SENTINEL_WS) {
      return realAppend(db as never, workspaceId, sessionId, events as never);
    }
    // Stand in for the durable append: assign contiguous sequences like the DB.
    return events.map((event, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      sessionId,
      sequence: index + 1,
      type: event.type,
      payload: event.payload ?? {},
      occurredAt: "2026-06-27T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    }));
  },
}));

// Imported AFTER both mocks are installed so it binds them.
const { createNatsEventBus, createResponderConnection, appendAndPublishEvents } = await import("../src/index");

afterAll(() => {
  mock.restore();
});

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
    await createNatsEventBus(SENTINEL_URL, { user: "ctrl", pass: "secret" });
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
      { name: "opengeni-auth-callout" },
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
    );

    // The durable append still succeeded and was returned; the rejected publish
    // was swallowed (consumers reconcile the missed live event from the DB).
    expect(appended).toHaveLength(1);
    expect(appended[0]!.sequence).toBe(1);
  });
});
