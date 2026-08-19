import { afterAll, expect, mock, test } from "bun:test";
import type { SessionEvent, WorkspaceControlEvent } from "@opengeni/contracts";
import type { EventBus } from "@opengeni/events";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const fakeDb = {};
let durableEvents: SessionEvent[] = [];
const durableReads: Array<{ after: number; limit: number }> = [];
let durableControlEvents: WorkspaceControlEvent[] = [];
const durableControlReads: Array<{ after: number; limit: number }> = [];
let interactionRevisionState = { revision: 0, updatedAt: null as Date | null };
let interactionRevisionReads = 0;

function event(sequence: number): SessionEvent {
  return {
    id: `event-${sequence}`,
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
  sseSessionStream,
  sseWorkspaceControlStream,
  sseWorkspaceInteractionRevisionStream,
  sseWorkspaceLiveStream,
} = await import("../src/http/sse");

afterAll(() => {
  mock.restore();
});

test("workspace interaction SSE projects only the newest durable revision", async () => {
  interactionRevisionReads = 0;
  interactionRevisionState = { revision: 3, updatedAt: new Date("2026-08-10T00:00:03.000Z") };
  const controller = new AbortController();
  const response = await sseWorkspaceInteractionRevisionStream(
    fakeDb as never,
    "00000000-0000-4000-8000-000000000010",
    WORKSPACE_ID,
    1,
    controller.signal,
    { pollIntervalMs: 100, heartbeatIntervalMs: 1_000 },
  );
  const reader = response.body!.getReader();
  expect(await readSequences(reader, 1)).toEqual([3]);

  // Intermediate revisions are cursor noise; the stream may deliver 7 directly.
  interactionRevisionState = { revision: 7, updatedAt: new Date("2026-08-10T00:00:07.000Z") };
  expect(await readSequences(reader, 1)).toEqual([7]);
  expect(interactionRevisionReads).toBeGreaterThanOrEqual(2);

  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test("workspace live SSE carries both durable domains over one response", async () => {
  durableControlEvents = [controlEvent(2)];
  durableControlReads.length = 0;
  interactionRevisionState = { revision: 7, updatedAt: new Date("2026-08-10T00:00:07.000Z") };
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
  const bus = {
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
  } as EventBus;
  const stalledObservations: Array<{
    reason: string;
    desiredSize: number | null;
    queuedFrames: number;
    queuedBytes: number;
  }> = [];
  const counters: Array<{ name: string; labels?: Record<string, unknown> }> = [];
  const gauges: Array<{ name: string; labels?: Record<string, unknown>; value: number }> = [];
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
  const fastSequences = await readSequences(fastReader, 2);

  // The non-reading connection cannot hold up a sibling subscription.
  expect(fastSequences).toEqual([1, 2]);
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
  // causes one single-row gap read per connection, and the stalled connection
  // performs no further row fetch while waiting for a consumer pull.
  expect(durableReads).toEqual([
    { after: 0, limit: 100 },
    { after: 0, limit: 100 },
    { after: 0, limit: 1 },
    { after: 0, limit: 1 },
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
  expect(await readSequences(resumedReader, 2)).toEqual([1, 2]);

  await resumedReader.cancel();
  await fastReader.cancel();
  expect(released).toHaveLength(3);
  expect(gauges.at(-1)).toMatchObject({
    name: "opengeni_sse_connections_active",
    labels: { stream: "session" },
    value: 0,
  });
});

test("a session stream fails closed before its first frame when host authorization is revoked", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let released = 0;
  let reauthorizations = 0;
  const bus = {
    subscribe: async () => () => {
      released += 1;
    },
  } as unknown as EventBus;
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
  await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  expect(reauthorizations).toBe(1);
  expect(released).toBe(1);
});

test("rechecks current authority and suppresses a live event after revocation", async () => {
  durableEvents = [];
  durableReads.length = 0;
  let allowed = true;
  let publish: ((events: SessionEvent[]) => void) | null = null;
  const bus = {
    subscribe: async (
      _workspaceId: string,
      _sessionId: string,
      listener: (events: SessionEvent[]) => void,
    ) => {
      publish = listener;
      return () => {};
    },
  } as unknown as EventBus;
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
  publish?.([event(1)]);
  await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
});

test("every long-lived SSE surface closes when its current workspace authority is revoked", async () => {
  durableEvents = [];
  durableControlEvents = [];
  interactionRevisionState = { revision: 0, updatedAt: null };
  const bus = {
    subscribe: async () => () => {},
    subscribeWorkspaceControl: async () => () => {},
  } as unknown as EventBus;
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
  const readers = responses.map((response) => response.body!.getReader());
  await Promise.all(
    readers.map(async (reader) => {
      await expect(reader.read()).rejects.toBeInstanceOf(Error);
    }),
  );
});

test("workspace-control SSE uses the same one-frame stall bound", async () => {
  durableControlEvents = [controlEvent(1), controlEvent(2)];
  durableControlReads.length = 0;
  let released = 0;
  const observations: Array<{ reason: string; queuedFrames: number; queuedBytes: number }> = [];
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
