import { afterAll, expect, mock, test } from "bun:test";
import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/contracts";
import { SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION, type EventBus } from "@opengeni/events";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const fakeDb = {};
let durableEvents: SessionEvent[] = [];
const durableReads: Array<{ after: number; limit: number }> = [];
let durableControlEvents: WorkspaceControlEvent[] = [];
const durableControlReads: Array<{ after: number; limit: number }> = [];
let interactionRevisionState = { revision: 0, updatedAt: null as Date | null };
let interactionRevisionReads = 0;

function sessionEventBus(
  methods: Record<string, unknown>,
  subscribeRecovery: (listener: (generation: number) => void) => () => void = () => () => {},
): EventBus {
  return {
    sessionEventDurableFanout: {
      version: SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
      subscribeRecovery,
    },
    ...methods,
  } as unknown as EventBus;
}

function event(sequence: number): SessionEvent {
  return {
    id: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "agent.message.delta",
    payload: { text: String(sequence) },
    occurredAt: "2026-07-19T00:00:00.000Z",
    turnId: null,
    clientEventId: null,
  };
}

function titleEvent(sequence: number, title: string): SessionEvent {
  return {
    id: `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "session.title_set",
    payload: { title, source: "agent" },
    occurredAt: "2026-08-25T00:00:00.000Z",
    turnId: null,
    clientEventId: null,
  };
}

const realDb = await import("@opengeni/db");
const realListSessionEvents = realDb.listSessionEvents;
const realListWorkspaceControlEvents = realDb.listWorkspaceControlEvents;
const realGetWorkspaceInteractionRevisionState = realDb.getWorkspaceInteractionRevisionState;
mock.module("@opengeni/db", () => ({
  ...realDb,
  listSessionEvents: async (
    db: unknown,
    workspaceId: string,
    sessionId: string,
    afterOrOptions: number | { after?: number; limit?: number },
    legacyLimit?: number,
  ) => {
    if (db !== fakeDb) {
      return await realListSessionEvents(
        db as never,
        workspaceId,
        sessionId,
        afterOrOptions as never,
        legacyLimit,
      );
    }
    const after = typeof afterOrOptions === "number" ? afterOrOptions : (afterOrOptions.after ?? 0);
    const limit =
      typeof afterOrOptions === "number" ? (legacyLimit ?? 500) : (afterOrOptions.limit ?? 500);
    durableReads.push({ after, limit });
    return durableEvents.filter((candidate) => candidate.sequence > after).slice(0, limit);
  },
  listWorkspaceControlEvents: async (
    db: unknown,
    workspaceId: string,
    after: number,
    limit: number,
  ) => {
    if (db !== fakeDb) {
      return await realListWorkspaceControlEvents(db as never, workspaceId, after, limit);
    }
    durableControlReads.push({ after, limit });
    return durableControlEvents.filter((candidate) => candidate.sequence > after).slice(0, limit);
  },
  getWorkspaceInteractionRevisionState: async (
    db: unknown,
    input: { accountId: string; workspaceId: string },
  ) => {
    if (db !== fakeDb) {
      return await realGetWorkspaceInteractionRevisionState(db as never, input);
    }
    interactionRevisionReads += 1;
    return interactionRevisionState;
  },
}));

const {
  browserSseDeliveryOptions,
  createByteBoundedSseStream,
  HTTP1_BROWSER_SSE_BATCH_CONTENT_TYPE,
  sseSessionStream,
  sseWorkspaceControlStream,
  sseWorkspaceInteractionRevisionStream,
  sseWorkspaceLiveStream,
} = await import("../src/http/sse");

afterAll(() => {
  mock.restore();
});

test("HTTP/1 browser streams cycle cleanly while HTTP/2 streams remain long-lived", async () => {
  expect(browserSseDeliveryOptions("http1-bounded")).toEqual({
    connectionLifetimeMs: 1_000,
    finiteResponseMaxBytes: 512 * 1024,
  });
  expect(browserSseDeliveryOptions(undefined)).toEqual({});
  expect(browserSseDeliveryOptions("h2")).toEqual({});

  let stopped = 0;
  const channel = createByteBoundedSseStream({
    connectionLifetimeMs: 10,
    onStop: () => {
      stopped += 1;
    },
  });
  await expect(channel.stream.getReader().read()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  expect(stopped).toBe(1);
});

test("HTTP/1 browser fallback returns a fully framed finite SSE batch", async () => {
  interactionRevisionState = {
    revision: 3,
    updatedAt: new Date("2026-08-10T00:00:03.000Z"),
  };
  const response = await sseWorkspaceInteractionRevisionStream(
    fakeDb as never,
    "00000000-0000-4000-8000-000000000010",
    WORKSPACE_ID,
    1,
    new AbortController().signal,
    {
      connectionLifetimeMs: 10,
      finiteResponseMaxBytes: 96 * 1024,
      pollIntervalMs: 100,
      heartbeatIntervalMs: 1_000,
    },
  );
  const bytes = await response.arrayBuffer();
  expect(response.headers.get("content-type")).toBe(
    `${HTTP1_BROWSER_SSE_BATCH_CONTENT_TYPE}; charset=utf-8`,
  );
  expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
  expect(response.headers.get("connection")).toBe("close");
  expect(new TextDecoder().decode(bytes)).toContain('"sequence":3');
});

test("workspace interaction SSE projects only the newest durable revision", async () => {
  interactionRevisionReads = 0;
  interactionRevisionState = {
    revision: 3,
    updatedAt: new Date("2026-08-10T00:00:03.000Z"),
  };
  const controller = new AbortController();
  const response = await sseWorkspaceInteractionRevisionStream(
    fakeDb as never,
    "00000000-0000-4000-8000-000000000010",
    WORKSPACE_ID,
    1,
    controller.signal,
    { pollIntervalMs: 100, heartbeatIntervalMs: 1_000 },
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(response.headers.get("connection")).toBe("close");
  const reader = response.body!.getReader();
  expect(await readSequences(reader, 1)).toEqual([3]);

  // Intermediate revisions are cursor noise; the stream may deliver 7 directly.
  interactionRevisionState = {
    revision: 7,
    updatedAt: new Date("2026-08-10T00:00:07.000Z"),
  };
  expect(await readSequences(reader, 1)).toEqual([7]);
  expect(interactionRevisionReads).toBeGreaterThanOrEqual(2);

  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test("workspace live SSE carries both durable domains over one response", async () => {
  durableControlEvents = [controlEvent(2)];
  durableControlReads.length = 0;
  interactionRevisionState = {
    revision: 7,
    updatedAt: new Date("2026-08-10T00:00:07.000Z"),
  };
  const controller = new AbortController();
  const response = await sseWorkspaceLiveStream(
    fakeDb as never,
    {
      subscribeWorkspaceControl: async () => () => {},
    } as unknown as EventBus,
    "00000000-0000-4000-8000-000000000010",
    WORKSPACE_ID,
    0,
    0,
    controller.signal,
    { pollIntervalMs: 100, heartbeatIntervalMs: 1_000 },
  );
  const reader = response.body!.getReader();
  expect((await readSequences(reader, 2)).sort((a, b) => a - b)).toEqual([2, 7]);
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test("a stalled SSE client is isolated, stops replay, and reconnects without gaps", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let nextSubscriptionId = 0;
  const subscribers = new Map<number, (events: SessionEvent[]) => void | Promise<void>>();
  const released: number[] = [];
  const bus = sessionEventBus({
    subscribe: async (
      _workspaceId: string,
      _sessionId: string,
      subscriber: (events: SessionEvent[]) => void | Promise<void>,
    ) => {
      const id = ++nextSubscriptionId;
      subscribers.set(id, subscriber);
      return () => {
        if (!subscribers.delete(id)) return;
        released.push(id);
      };
    },
  });
  const stalledObservations: Array<{
    reason: string;
    desiredSize: number | null;
    queuedFrames: number;
    queuedBytes: number;
  }> = [];
  const counters: Array<{ name: string; labels?: Record<string, unknown> }> = [];
  const gauges: Array<{
    name: string;
    labels?: Record<string, unknown>;
    value: number;
  }> = [];
  const observability = {
    incrementCounter: (input: { name: string; labels?: Record<string, unknown> }) =>
      counters.push(input),
    setGauge: (input: { name: string; labels?: Record<string, unknown>; value: number }) =>
      gauges.push(input),
    warn: () => {},
  } as never;
  const stalled = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    {
      stallTimeoutMs: 50,
      onObservation: (observation) => stalledObservations.push(observation),
      observability,
    },
  );
  const fast = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 50, observability },
  );

  await waitFor(() => subscribers.size === 2 && durableReads.length === 2);
  const fastReader = fast.body!.getReader();
  expect(new TextDecoder().decode((await fastReader.read()).value)).toBe(": connected\n\n");

  durableEvents = [event(1), event(2)];
  for (const subscriber of subscribers.values()) {
    await subscriber(durableEvents);
  }
  const fastEvents = await readSessionEvents(fastReader, 1);

  // The non-reading connection cannot hold up a sibling subscription.
  expect(fastEvents.map((candidate) => candidate.sequence)).toEqual([1]);
  expect(fastEvents[0]?.payload).toMatchObject({
    text: "12",
    coalescedUntil: 2,
  });
  expect(released).toEqual([]);

  await waitFor(() => released.length === 1);
  expect(subscribers.size).toBe(1);
  expect(stalledObservations).toContainEqual({
    reason: "stall_timeout",
    desiredSize: 0,
    queuedFrames: 1,
    queuedBytes: expect.any(Number),
  });
  expect(counters.map((counter) => counter.labels)).toContainEqual({
    stream: "session",
    reason: "desired_size_non_positive",
  });
  expect(counters.map((counter) => counter.labels)).toContainEqual({
    stream: "session",
    reason: "stall_timeout",
  });
  expect(
    counters.filter((counter) => counter.name === "opengeni_sse_delivery_bound_events_total")
      .length,
  ).toBeGreaterThanOrEqual(2);
  expect(counters.map((counter) => counter.name)).toContain("opengeni_sse_connections_total");
  expect(gauges).toContainEqual(
    expect.objectContaining({
      name: "opengeni_sse_connections_active",
      labels: { stream: "session" },
      value: 2,
    }),
  );

  // Each initial connection reads one replay page. The two-event live cursor
  // causes one compact durable-range read per connection, and the stalled connection
  // performs no further row fetch while waiting for a consumer pull.
  expect(durableReads).toEqual([
    { after: 0, limit: 100 },
    { after: 0, limit: 100 },
    { after: 0, limit: 2 },
    { after: 0, limit: 2 },
  ]);
  const stalledReader = stalled.body!.getReader();
  await expect(stalledReader.read()).rejects.toBeInstanceOf(TypeError);

  // The stalled browser never advanced its durable cursor. A fresh connection
  // resumes after 0 and gets the complete durable range exactly once.
  const resumed = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 50 },
  );
  const resumedReader = resumed.body!.getReader();
  const resumedEvents = await readSessionEvents(resumedReader, 1);
  expect(resumedEvents.map((candidate) => candidate.sequence)).toEqual([1]);
  expect(resumedEvents[0]?.payload).toMatchObject({
    text: "12",
    coalescedUntil: 2,
  });

  await resumedReader.cancel();
  await fastReader.cancel();
  expect(released).toHaveLength(3);
  expect(gauges.at(-1)).toMatchObject({
    name: "opengeni_sse_connections_active",
    labels: { stream: "session" },
    value: 0,
  });
});

test("session SSE coalesces long durable delta runs before they reach the browser", async () => {
  durableEvents = Array.from({ length: 250 }, (_, index) => event(index + 1));
  durableReads.length = 0;
  const response = await sseSessionStream(
    fakeDb as never,
    sessionEventBus({ subscribe: async () => () => {} }),
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 100 },
  );
  const reader = response.body!.getReader();
  const replayed = await readSessionEvents(reader, 3);

  expect(replayed.map((candidate) => candidate.sequence)).toEqual([1, 101, 201]);
  expect(replayed.map((candidate) => (candidate.payload as any).coalescedUntil)).toEqual([
    100, 200, 250,
  ]);
  expect(durableReads).toEqual([
    { after: 0, limit: 100 },
    { after: 100, limit: 100 },
    { after: 200, limit: 100 },
  ]);
  await reader.cancel();
});

test("an open session stream reconciles a quarantine title event from durable fanout", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let subscriber: ((events: SessionEvent[]) => void | Promise<void>) | null = null;
  const response = await sseSessionStream(
    fakeDb as never,
    sessionEventBus({
      subscribe: async (
        _workspaceId: string,
        _sessionId: string,
        onEvents: (events: SessionEvent[]) => void | Promise<void>,
      ) => {
        subscriber = onEvents;
        return () => {};
      },
    }),
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    { heartbeatIntervalMs: 1_000, stallTimeoutMs: 100 },
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");

  durableEvents = [titleEvent(1, "New conversation")];
  await subscriber?.(durableEvents);
  const [quarantineEvent] = await readSessionEvents(reader, 1);
  expect(quarantineEvent).toMatchObject({
    sequence: 1,
    type: "session.title_set",
    payload: { title: "New conversation", source: "agent" },
  });
  expect(durableReads).toEqual([
    { after: 0, limit: 100 },
    { after: 0, limit: 1 },
  ]);
  await reader.cancel();
});

test("an open session stream catches up after an accepted embedding publish while its subscriber is offline", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let reconnect: ((generation: number) => void) | null = null;
  let reconnectReleased = 0;
  let subscriberConnected = true;
  let subscriber: ((events: SessionEvent[]) => void | Promise<void>) | null = null;
  const publish = mock(async (_workspaceId: string, _sessionId: string, events: SessionEvent[]) => {
    if (subscriberConnected) await subscriber?.(events);
  });
  const bus = sessionEventBus(
    {
      publish,
      subscribe: async (
        _workspaceId: string,
        _sessionId: string,
        listener: (events: SessionEvent[]) => void | Promise<void>,
      ) => {
        subscriber = listener;
        return () => {
          subscriber = null;
        };
      },
    },
    (listener) => {
      reconnect = listener;
      return () => {
        reconnectReleased += 1;
      };
    },
  );
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    { heartbeatIntervalMs: 1_000, stallTimeoutMs: 100 },
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");

  // Core NATS drops publications while this subscriber is disconnected. The
  // durable row exists, but no session-event notification reaches the stream.
  durableEvents = [titleEvent(1, "New conversation")];
  subscriberConnected = false;
  await bus.publish(WORKSPACE_ID, SESSION_ID, durableEvents);
  expect(publish).toHaveBeenCalledTimes(1);
  subscriberConnected = true;
  reconnect?.(1);
  const [quarantineEvent] = await readSessionEvents(reader, 1);
  expect(quarantineEvent).toMatchObject({
    sequence: 1,
    type: "session.title_set",
    payload: { title: "New conversation", source: "agent" },
  });
  expect(durableReads).toEqual([
    { after: 0, limit: 100 },
    { after: 0, limit: 100 },
  ]);

  // A duplicate notification for the same transport generation and the normal
  // heartbeat both remain read-free.
  reconnect?.(1);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
  expect(durableReads).toHaveLength(2);

  await reader.cancel();
  expect(reconnectReleased).toBe(1);
});

test("idle session stream count does not multiply durable reads on heartbeat", async () => {
  durableEvents = [];
  durableReads.length = 0;
  const streamCount = 24;
  const responses = await Promise.all(
    Array.from({ length: streamCount }, () =>
      sseSessionStream(
        fakeDb as never,
        sessionEventBus({ subscribe: async () => () => {} }),
        WORKSPACE_ID,
        SESSION_ID,
        0,
        new AbortController().signal,
        { heartbeatIntervalMs: 1_000, stallTimeoutMs: 100 },
      ),
    ),
  );
  const readers = responses.map((response) => response.body!.getReader());
  const connected = await Promise.all(readers.map(async (reader) => await reader.read()));
  expect(connected.map((frame) => new TextDecoder().decode(frame.value))).toEqual(
    Array.from({ length: streamCount }, () => ": connected\n\n"),
  );
  expect(durableReads).toHaveLength(streamCount);

  const heartbeats = await Promise.all(readers.map(async (reader) => await reader.read()));
  expect(heartbeats.map((frame) => new TextDecoder().decode(frame.value))).toEqual(
    Array.from({ length: streamCount }, () => ": heartbeat\n\n"),
  );
  expect(durableReads).toHaveLength(streamCount);

  await Promise.all(readers.map(async (reader) => await reader.cancel()));
});

test("a session stream closes cleanly before its first frame when host authorization is revoked", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let released = 0;
  let reauthorizations = 0;
  const bus = sessionEventBus({
    subscribe: async () => () => {
      released += 1;
    },
  });
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    {
      reauthorizeAfterMs: 1_000,
      reauthorize: async () => {
        reauthorizations += 1;
        throw new Error("host revoked the session");
      },
    },
  );
  const reader = response.body!.getReader();
  await expect(reader.read()).resolves.toEqual({
    done: true,
    value: undefined,
  });
  expect(reauthorizations).toBe(1);
  expect(released).toBe(1);
});

test("rechecks current authority and closes before a live event after revocation", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let allowed = true;
  let publish: ((events: SessionEvent[]) => void) | null = null;
  const bus = sessionEventBus({
    subscribe: async (
      _workspaceId: string,
      _sessionId: string,
      listener: (events: SessionEvent[]) => void,
    ) => {
      publish = listener;
      return () => {};
    },
  });
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    {
      reauthorize: async () => {
        if (!allowed) throw new Error("membership revoked");
      },
    },
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  allowed = false;
  durableEvents = [event(1)];
  publish?.([event(1)]);
  await expect(reader.read()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test("emits the selected actor epoch and closes before a cross-tab actor event", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let currentEpoch = "7";
  let publish: ((events: SessionEvent[]) => void) | null = null;
  const bus = sessionEventBus({
    subscribe: async (
      _workspaceId: string,
      _sessionId: string,
      listener: (events: SessionEvent[]) => void,
    ) => {
      publish = listener;
      return () => {};
    },
  });
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    {
      actorEpoch: "7",
      reauthorize: async () => {
        if (currentEpoch !== "7") throw new Error("selected actor changed in another tab");
      },
    },
  );
  expect(response.headers.get("x-opengeni-actor-epoch")).toBe("7");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  currentEpoch = "8";
  durableEvents = [event(1)];
  publish?.([event(1)]);
  await expect(reader.read()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test("every long-lived SSE surface closes when its current workspace authority is revoked", async () => {
  durableEvents = [];
  durableControlEvents = [];
  interactionRevisionState = { revision: 0, updatedAt: null };
  const bus = sessionEventBus({
    subscribe: async () => () => {},
    subscribeWorkspaceControl: async () => () => {},
  });
  const revoked = () => ({
    reauthorizeAfterMs: 1_000,
    reauthorize: async () => {
      throw new Error("workspace membership revoked");
    },
  });
  const signal = () => new AbortController().signal;
  const responses = await Promise.all([
    sseSessionStream(fakeDb as never, bus, WORKSPACE_ID, SESSION_ID, 0, signal(), revoked()),
    sseWorkspaceControlStream(fakeDb as never, bus, WORKSPACE_ID, 0, signal(), revoked()),
    sseWorkspaceInteractionRevisionStream(
      fakeDb as never,
      "00000000-0000-4000-8000-000000000010",
      WORKSPACE_ID,
      0,
      signal(),
      { ...revoked(), pollIntervalMs: 100 },
    ),
    sseWorkspaceLiveStream(
      fakeDb as never,
      bus,
      "00000000-0000-4000-8000-000000000010",
      WORKSPACE_ID,
      0,
      0,
      signal(),
      { ...revoked(), pollIntervalMs: 100 },
    ),
  ]);
  for (const response of responses) {
    expect(response.headers.get("connection")).toBe("close");
  }
  const readers = responses.map((response) => response.body!.getReader());
  await Promise.all(
    readers.map(async (reader) => {
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    }),
  );
});

test("workspace-control SSE uses the same one-frame stall bound", async () => {
  durableControlEvents = [controlEvent(1), controlEvent(2)];
  durableControlReads.length = 0;
  let released = 0;
  const observations: Array<{
    reason: string;
    queuedFrames: number;
    queuedBytes: number;
  }> = [];
  const bus = {
    subscribeWorkspaceControl: async () => () => {
      released += 1;
    },
  } as unknown as EventBus;
  const response = await sseWorkspaceControlStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    0,
    new AbortController().signal,
    {
      stallTimeoutMs: 20,
      onObservation: (observation) => observations.push(observation),
    },
  );

  await waitFor(() => released === 1);
  expect(durableControlReads).toEqual([{ after: 0, limit: 100 }]);
  expect(observations).toContainEqual({
    reason: "stall_timeout",
    desiredSize: 0,
    queuedFrames: 1,
    queuedBytes: expect.any(Number),
  });
  await expect(response.body!.getReader().read()).rejects.toBeInstanceOf(TypeError);
});

test("workspace-control replay bounds a poison row and reconnect advances past it", async () => {
  durableControlEvents = [
    {
      ...controlEvent(1),
      reason: `HEAD-${"🙂".repeat(600_000)}-TAIL`,
      actor: `actor-${"界".repeat(300_000)}`,
    },
    controlEvent(2),
  ];
  durableControlReads.length = 0;
  const bus = {
    subscribeWorkspaceControl: async () => () => {},
  } as unknown as EventBus;
  const response = await sseWorkspaceControlStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 100 },
  );
  const reader = response.body!.getReader();
  const replayed = await readControlEvents(reader, 2);

  expect(replayed.map((candidate) => candidate.sequence)).toEqual([1, 2]);
  expect(replayed[0]?.truncation).toMatchObject({
    surface: "sse_legacy_guard",
    fullEvidence: { available: false, reason: "not_retained" },
  });
  expect(replayed[1]?.truncation).toBeUndefined();
  expect(durableControlReads).toEqual([{ after: 0, limit: 100 }]);
  await reader.cancel();

  const resumed = await sseWorkspaceControlStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    1,
    new AbortController().signal,
    { stallTimeoutMs: 100 },
  );
  const resumedReader = resumed.body!.getReader();
  const resumedEvents = await readControlEvents(resumedReader, 1);
  expect(resumedEvents.map((candidate) => candidate.sequence)).toEqual([2]);
  expect(durableControlReads.at(-1)).toEqual({ after: 1, limit: 100 });
  await resumedReader.cancel();
});

test("workspace-control SSE accepts a migration-created sparse first revision", async () => {
  durableControlEvents = [controlEvent(7)];
  durableControlReads.length = 0;
  const bus = {
    subscribeWorkspaceControl: async () => () => {},
  } as unknown as EventBus;
  const response = await sseWorkspaceControlStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 100 },
  );
  const reader = response.body!.getReader();

  expect((await readControlEvents(reader, 1)).map((candidate) => candidate.sequence)).toEqual([7]);
  expect(durableControlReads).toEqual([
    { after: 0, limit: 100 },
    { after: 0, limit: 7 },
  ]);
  await reader.cancel();
});

test("workspace-control SSE reconnects across a legitimate sparse revision gap", async () => {
  durableControlEvents = [controlEvent(1), controlEvent(7)];
  durableControlReads.length = 0;
  const bus = {
    subscribeWorkspaceControl: async () => () => {},
  } as unknown as EventBus;
  const response = await sseWorkspaceControlStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 100 },
  );
  const reader = response.body!.getReader();

  expect((await readControlEvents(reader, 2)).map((candidate) => candidate.sequence)).toEqual([
    1, 7,
  ]);
  expect(durableControlReads).toEqual([
    { after: 0, limit: 100 },
    { after: 1, limit: 6 },
  ]);
  await reader.cancel();
});

async function readSequences(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<number[]> {
  const sequences: number[] = [];
  const decoder = new TextDecoder();
  while (sequences.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    const data = decoder
      .decode(value)
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data) sequences.push((JSON.parse(data) as SessionEvent).sequence);
  }
  return sequences;
}

async function readSessionEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const decoder = new TextDecoder();
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    const data = decoder
      .decode(value)
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data) events.push(JSON.parse(data) as SessionEvent);
  }
  return events;
}

async function readControlEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<WorkspaceControlEvent[]> {
  const events: WorkspaceControlEvent[] = [];
  const decoder = new TextDecoder();
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    const data = decoder
      .decode(value)
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data) events.push(JSON.parse(data) as WorkspaceControlEvent);
  }
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for SSE test condition");
    await Bun.sleep(1);
  }
}

function controlEvent(sequence: number): WorkspaceControlEvent {
  return {
    id: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sequence,
    revision: sequence,
    type: "workspace.control.changed",
    scope: "workspace",
    rootSessionId: null,
    action: sequence % 2 === 0 ? "resume" : "pause",
    automatic: false,
    reason: null,
    actor: "sse-bounds-test",
    occurredAt: "2026-07-19T00:00:00.000Z",
  };
}
