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
}));

const { sseSessionStream, sseWorkspaceControlStream } = await import("../src/http/sse");

afterAll(() => {
  mock.restore();
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
      observability: {
        incrementCounter: (input: { name: string; labels?: Record<string, unknown> }) =>
          counters.push(input),
        warn: () => {},
      } as never,
    },
  );
  const fast = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 50 },
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
    counters.every((counter) => counter.name === "opengeni_sse_delivery_bound_events_total"),
  ).toBeTrue();

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
