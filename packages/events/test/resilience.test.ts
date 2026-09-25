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
  NATS_SUBSCRIPTION_TERMINATIONS_METRIC,
  natsResubscribeDelayMs,
  natsSubscriptionTerminationCounter,
  publishDurableSessionEvents,
  requireSessionEventDurableFanoutCapability,
  SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
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
  // A broker/auth-callout restart briefly rejects auth; nats.js must keep retrying.
  expect(opts.ignoreAuthErrorAbort).toBe(true);
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

type FakeMsg = {
  data: Uint8Array;
  subject: string;
  reply?: string;
  respond?: (data: Uint8Array) => boolean;
};

/** An async-iterable subscription fed by a script; `fail` ends it like nats.js
 *  does for a subscription permissions violation, and `unsubscribe` ends it
 *  normally like nats.js does for a requested unsubscribe. */
function scriptedSubscription(subject: string) {
  const queued: Array<{ message?: FakeMsg; error?: unknown; end?: true }> = [];
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  let unsubscribed = false;
  const iterable = {
    unsubscribe() {
      unsubscribed = true;
      queued.push({ end: true });
      wake();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift();
        if (!next) {
          await new Promise<void>((resolve) => waiters.push(resolve));
          continue;
        }
        if (next.end) return;
        if (next.error !== undefined) throw next.error;
        yield next.message!;
      }
    },
  };
  return {
    iterable,
    subject,
    isUnsubscribed: () => unsubscribed,
    push: (data: Uint8Array, extra: Partial<FakeMsg> = {}) => {
      queued.push({ message: { data, subject, ...extra } });
      wake();
    },
    fail: (error: unknown) => {
      queued.push({ error });
      wake();
    },
  };
}

function permissionsViolation(): Error {
  return Object.assign(new Error('Permissions Violation for Subscription to "x"'), {
    name: "NatsError",
    code: "PERMISSIONS_VIOLATION",
  });
}

async function withUnhandledRejectionProbe<T>(
  run: (rejections: unknown[]) => Promise<T>,
): Promise<T> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    return await run(rejections);
  } finally {
    process.off("unhandledRejection", listener);
  }
}

describe("detached NATS subscription loops never reject the process", () => {
  test("session subscriptions isolate poison messages and survive a subscription error", async () => {
    await withUnhandledRejectionProbe(async (rejections) => {
      const scripted = scriptedSubscription("session");
      const warnings: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
      const bus = await createNatsEventBus("nats://subscription.test:4222", undefined, {
        logger: { warn: (message, attributes) => warnings.push({ message, attributes }) },
        connect: async () =>
          ({
            ...(fakeNatsConnection() as Record<string, unknown>),
            subscribe: () => scripted.iterable,
          }) as never,
      });
      const delivered: number[] = [];
      let throwOnce = true;
      await bus.subscribe(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", (events) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("consumer failed");
        }
        delivered.push(...events.map((event) => event.sequence));
      });
      const event = (sequence: number) =>
        new TextEncoder().encode(
          JSON.stringify({
            workspaceId: SENTINEL_WS,
            sessionId: "00000000-0000-4000-8000-000000000001",
            events: [
              {
                id: `00000000-0000-4000-8000-00000000010${sequence}`,
                workspaceId: SENTINEL_WS,
                sessionId: "00000000-0000-4000-8000-000000000001",
                sequence,
                type: "session.title_set",
                payload: { title: "t", source: "agent" },
                occurredAt: "2026-09-25T00:00:00.000Z",
                clientEventId: null,
                turnId: null,
              },
            ],
          }),
        );
      scripted.push(new TextEncoder().encode("{not json"));
      scripted.push(event(1));
      scripted.push(event(2));
      await waitFor(() => delivered.length === 1);
      expect(delivered).toEqual([2]);
      scripted.fail(permissionsViolation());
      await waitFor(() =>
        warnings.some((warning) => warning.message === "NATS subscription ended with an error"),
      );
      await Bun.sleep(5);
      expect(rejections).toEqual([]);
      expect(warnings.map((warning) => warning.message)).toEqual([
        "NATS subscription message dropped",
        "NATS subscription message dropped",
        "NATS subscription ended with an error",
      ]);
      expect(warnings[2]!.attributes).toMatchObject({
        label: "session-events",
        errorName: "NatsError",
        errorCode: "PERMISSIONS_VIOLATION",
      });
      // Logs never carry the payload bytes.
      expect(JSON.stringify(warnings)).not.toContain("not json");
      await bus.close();
    });
  });

  test("workspace-control, request, agent-event and auth-callout loops survive subscription errors", async () => {
    await withUnhandledRejectionProbe(async (rejections) => {
      const subscriptions: Array<ReturnType<typeof scriptedSubscription>> = [];
      const connectWithScriptedSubscriptions = async () =>
        ({
          ...(fakeNatsConnection() as Record<string, unknown>),
          subscribe: (subject: string) => {
            const scripted = scriptedSubscription(subject);
            subscriptions.push(scripted);
            return scripted.iterable;
          },
        }) as never;
      const warnings: string[] = [];
      const logger = { warn: (message: string) => warnings.push(message) };
      const bus = await createNatsEventBus("nats://subscription.test:4222", undefined, {
        logger,
        connect: connectWithScriptedSubscriptions,
      });
      await bus.subscribeWorkspaceControl(SENTINEL_WS, () => undefined);
      bus.subscribeRequests("agent.*.*.connection.*.rpc", () => new Uint8Array());
      bus.subscribeAgentEvents("agent.*.*.connection.*.events", () => undefined);
      const responder = await createResponderConnection(
        SENTINEL_URL,
        { kind: "anonymous" },
        "$SYS.REQ.USER.AUTH",
        () => new Uint8Array(),
        { logger, connect: connectWithScriptedSubscriptions },
      );
      expect(subscriptions).toHaveLength(4);
      subscriptions[0]!.push(new TextEncoder().encode("{not json"));
      for (const scripted of subscriptions) scripted.fail(permissionsViolation());
      await waitFor(
        () =>
          warnings.filter((message) => message === "NATS subscription ended with an error")
            .length === 4,
      );
      await Bun.sleep(5);
      expect(rejections).toEqual([]);
      expect(warnings).toContain("NATS subscription message dropped");
      await responder.close();
      await bus.close();
    });
  });
});

function scriptedConnection(state: { draining?: boolean } = {}) {
  const subscriptions: Array<ReturnType<typeof scriptedSubscription>> = [];
  const connect = async () =>
    ({
      ...(fakeNatsConnection() as Record<string, unknown>),
      subscribe: (subject: string) => {
        const scripted = scriptedSubscription(subject);
        subscriptions.push(scripted);
        return scripted.iterable;
      },
      isDraining: () => state.draining === true,
    }) as never;
  return { subscriptions, connect };
}

describe("a subscription that ends while still held is surfaced, never silent", () => {
  test("session and workspace-control consumers are told once and counted", async () => {
    await withUnhandledRejectionProbe(async (rejections) => {
      const { subscriptions, connect } = scriptedConnection();
      const terminations: unknown[] = [];
      const warnings: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
      const bus = await createNatsEventBus("nats://termination.test:4222", undefined, {
        connect,
        logger: { warn: (message, attributes) => warnings.push({ message, attributes }) },
        onSubscriptionTerminated: (termination) => terminations.push(termination),
      });
      const sessionEnds: unknown[] = [];
      const controlEnds: unknown[] = [];
      await bus.subscribe(SENTINEL_WS, "00000000-0000-4000-8000-000000000001", () => undefined, {
        onTerminated: (error) => sessionEnds.push(error),
      });
      await bus.subscribeWorkspaceControl(SENTINEL_WS, () => undefined, {
        onTerminated: (error) => controlEnds.push(error),
      });
      // A consumer without a hook is still logged and counted.
      await bus.subscribe(SENTINEL_WS, "00000000-0000-4000-8000-000000000002", () => undefined);
      const violation = permissionsViolation();
      for (const scripted of subscriptions) scripted.fail(violation);
      await waitFor(() => terminations.length === 3);
      await Bun.sleep(5);
      expect(sessionEnds).toEqual([violation]);
      expect(controlEnds).toEqual([violation]);
      expect(terminations).toEqual([
        { kind: "session_events", recovery: "consumer_reconnect" },
        { kind: "workspace_control", recovery: "consumer_reconnect" },
        { kind: "session_events", recovery: "none" },
      ]);
      expect(warnings.map((warning) => warning.attributes?.recovery)).toEqual([
        "consumer_reconnect",
        "consumer_reconnect",
        "none",
      ]);
      expect(subscriptions).toHaveLength(3);
      expect(rejections).toEqual([]);
      await bus.close();
    });
  });

  test("a requested unsubscribe or a closing bus is not a termination", async () => {
    const state = { draining: false };
    const { subscriptions, connect } = scriptedConnection(state);
    const terminations: unknown[] = [];
    const ends: unknown[] = [];
    const bus = await createNatsEventBus("nats://termination.test:4222", undefined, {
      connect,
      onSubscriptionTerminated: (termination) => terminations.push(termination),
    });
    const release = await bus.subscribe(
      SENTINEL_WS,
      "00000000-0000-4000-8000-000000000001",
      () => undefined,
      {
        onTerminated: (error) => ends.push(error),
      },
    );
    release();
    subscriptions[0]!.fail(permissionsViolation());
    await bus.subscribeWorkspaceControl(SENTINEL_WS, () => undefined, {
      onTerminated: (error) => ends.push(error),
    });
    bus.subscribeRequests("agent.*.*.connection.*.rpc", () => new Uint8Array());
    state.draining = true;
    subscriptions[1]!.fail(new Error("closed by drain"));
    subscriptions[2]!.fail(new Error("closed by drain"));
    await Bun.sleep(20);
    expect(ends).toEqual([]);
    expect(terminations).toEqual([]);
    expect(subscriptions).toHaveLength(3);
    await bus.close();
  });

  test("process-lifetime responders resubscribe with bounded backoff and keep answering", async () => {
    await withUnhandledRejectionProbe(async (rejections) => {
      const { subscriptions, connect } = scriptedConnection();
      const terminations: unknown[] = [];
      const delays: number[] = [];
      const resubscribeDelayMs = (attempt: number) => {
        delays.push(attempt);
        return 0;
      };
      const bus = await createNatsEventBus("nats://termination.test:4222", undefined, {
        connect,
        onSubscriptionTerminated: (termination) => terminations.push(termination),
        resubscribeDelayMs,
      });
      const handled: string[] = [];
      const unsubscribeRequests = bus.subscribeRequests("agent.*.*.connection.*.rpc", (request) => {
        handled.push(`request:${new TextDecoder().decode(request)}`);
        return new TextEncoder().encode("pong");
      });
      bus.subscribeAgentEvents("agent.*.*.connection.*.events", (payload) => {
        handled.push(`event:${new TextDecoder().decode(payload)}`);
      });
      const responder = await createResponderConnection(
        SENTINEL_URL,
        { kind: "anonymous" },
        "$SYS.REQ.USER.AUTH",
        (request) => {
          handled.push(`auth:${new TextDecoder().decode(request)}`);
          return new TextEncoder().encode("granted");
        },
        {
          connect,
          onSubscriptionTerminated: (termination) => terminations.push(termination),
          resubscribeDelayMs,
        },
      );
      expect(subscriptions.map((scripted) => scripted.subject)).toEqual([
        "agent.*.*.connection.*.rpc",
        "agent.*.*.connection.*.events",
        "$SYS.REQ.USER.AUTH",
      ]);
      // Two consecutive failures back off with a growing attempt count.
      subscriptions[0]!.fail(permissionsViolation());
      await waitFor(() => subscriptions.length === 4);
      subscriptions[3]!.fail(permissionsViolation());
      await waitFor(() => subscriptions.length === 5);
      subscriptions[1]!.fail(permissionsViolation());
      subscriptions[2]!.fail(permissionsViolation());
      await waitFor(() => subscriptions.length === 7);
      expect(subscriptions.slice(4).map((scripted) => scripted.subject)).toEqual([
        "agent.*.*.connection.*.rpc",
        "agent.*.*.connection.*.events",
        "$SYS.REQ.USER.AUTH",
      ]);
      expect(delays).toEqual([1, 2, 1, 1]);

      const replies: string[] = [];
      const respond = (data: Uint8Array) => {
        replies.push(new TextDecoder().decode(data));
        return true;
      };
      const encode = (text: string) => new TextEncoder().encode(text);
      subscriptions[4]!.push(encode("ping"), { reply: "_INBOX.1", respond });
      subscriptions[5]!.push(encode("heartbeat"));
      subscriptions[6]!.push(encode("authorize"), { reply: "_INBOX.2", respond });
      await waitFor(() => handled.length === 3 && replies.length === 2);
      expect(handled.sort()).toEqual(["auth:authorize", "event:heartbeat", "request:ping"]);
      expect(replies.sort()).toEqual(["granted", "pong"]);
      expect(terminations).toEqual([
        { kind: "request_responder", recovery: "resubscribe" },
        { kind: "request_responder", recovery: "resubscribe" },
        { kind: "agent_events", recovery: "resubscribe" },
        { kind: "auth_callout", recovery: "resubscribe" },
      ]);

      // A delivered message resets the backoff for the next failure.
      subscriptions[4]!.fail(permissionsViolation());
      await waitFor(() => subscriptions.length === 8);
      expect(delays.at(-1)).toBe(1);

      // After the owner unsubscribes, a late end never resubscribes.
      unsubscribeRequests();
      expect(subscriptions[7]!.isUnsubscribed()).toBe(true);
      await responder.close();
      expect(subscriptions[6]!.isUnsubscribed()).toBe(true);
      await Bun.sleep(20);
      expect(subscriptions).toHaveLength(8);
      expect(rejections).toEqual([]);
      await bus.close();
    });
  });

  test("the resubscribe backoff is bounded and jittered", () => {
    expect(natsResubscribeDelayMs(1, () => 0)).toBe(1_000);
    expect(natsResubscribeDelayMs(2, () => 0)).toBe(2_000);
    expect(natsResubscribeDelayMs(5, () => 0)).toBe(16_000);
    expect(natsResubscribeDelayMs(6, () => 0)).toBe(30_000);
    expect(natsResubscribeDelayMs(1_000, () => 0.5)).toBe(30_500);
    for (const hostile of [Number.NaN, -1, 2, Number.POSITIVE_INFINITY]) {
      const delay = natsResubscribeDelayMs(3, () => hostile);
      expect(delay).toBeGreaterThanOrEqual(4_000);
      expect(delay).toBeLessThan(5_000);
    }
    for (const attempt of [0, -3, Number.NaN]) {
      expect(natsResubscribeDelayMs(attempt, () => 0)).toBe(1_000);
    }
  });

  test("the counter adapter uses the closed kind and recovery labels", () => {
    const counted: unknown[] = [];
    natsSubscriptionTerminationCounter({ incrementCounter: (input) => counted.push(input) })({
      kind: "auth_callout",
      recovery: "resubscribe",
    });
    expect(counted).toEqual([
      {
        name: NATS_SUBSCRIPTION_TERMINATIONS_METRIC,
        help: expect.any(String),
        labels: { kind: "auth_callout", recovery: "resubscribe" },
      },
    ]);
    expect(NATS_SUBSCRIPTION_TERMINATIONS_METRIC).toBe(
      "opengeni_nats_subscription_terminations_total",
    );
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
