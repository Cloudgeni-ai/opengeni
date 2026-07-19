import { afterAll, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import type { EventBus } from "@opengeni/events";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const fakeDb = {};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function event(sequence: number): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "agent.message.delta",
    payload: { text: String(sequence) },
    occurredAt: "2026-07-18T00:00:00.000Z",
    turnId: null,
    clientEventId: null,
  };
}

const initialReplay = deferred<SessionEvent[]>();
const bufferedGapFill = deferred<SessionEvent[]>();
const firstLiveGapFill = deferred<SessionEvent[]>();
let resolveBufferedGapRequested!: () => void;
const bufferedGapRequested = new Promise<void>((resolve) => {
  resolveBufferedGapRequested = resolve;
});
let firstLiveGapRequested = false;

const realDb = await import("@opengeni/db");
const realListSessionEvents = realDb.listSessionEvents;
mock.module("@opengeni/db", () => ({
  ...realDb,
  listSessionEvents: async (
    db: unknown,
    workspaceId: string,
    sessionId: string,
    after: number,
    limit: number,
  ) => {
    if (db !== fakeDb) {
      return realListSessionEvents(db as never, workspaceId, sessionId, after, limit);
    }
    if (after === 4 && limit === 1000) {
      return await initialReplay.promise;
    }
    if (after === 4 && limit === 2) {
      resolveBufferedGapRequested();
      return await bufferedGapFill.promise;
    }
    if (after === 4 && limit === 3) {
      firstLiveGapRequested = true;
      return await firstLiveGapFill.promise;
    }
    if (after === 7 && limit === 1) {
      return [event(8)];
    }
    if (after === 0 && limit === 1000) {
      return [event(1)];
    }
    if (after === 20 && limit === 1000) {
      return [];
    }
    if (after === 21 && limit === 1) {
      throw new Error("durable gap read unavailable");
    }
    if (after === 21 && limit === 1000) {
      return [event(22), event(23)];
    }
    if (after === 30 && limit === 1000) {
      throw new Error("initial replay unavailable");
    }
    if (after === 2_147_483_647 && limit === 1000) {
      return [];
    }
    throw new Error(`unexpected replay request after=${after} limit=${limit}`);
  },
}));

const { replaySessionEvents, sseSessionStream } = await import("../src/http/sse");

afterAll(() => {
  mock.restore();
});

test("session SSE serializes buffered replay catch-up with the first live batch", async () => {
  let onEvents: ((events: SessionEvent[]) => void | Promise<void>) | null = null;
  const subscriberReady = deferred<void>();
  const bus = {
    subscribe: async (
      _workspaceId: string,
      _sessionId: string,
      subscriber: (events: SessionEvent[]) => void | Promise<void>,
    ) => {
      onEvents = subscriber;
      subscriberReady.resolve();
      return () => {};
    },
  } as EventBus;

  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    4,
    new AbortController().signal,
  );
  await subscriberReady.promise;

  // Sequence 7 arrives while the initial durable replay is still open. Its
  // buffered drain must backfill 5..6. While that read is suspended, sequence
  // 8 is the first live batch and starts a wider 5..7 backfill.
  await onEvents([event(7)]);
  initialReplay.resolve([]);
  await bufferedGapRequested;
  const firstLive = Promise.resolve(onEvents([event(8)]));

  if (firstLiveGapRequested) {
    // Complete the newer read first. Without a single ordered send queue this
    // advances through 8, after which the older send emits 7 again and regresses
    // its cursor. Sequence 9 then backfills (and duplicates) 8.
    firstLiveGapFill.resolve([event(5), event(6), event(7)]);
    await firstLive;
    bufferedGapFill.resolve([event(5), event(6)]);
  } else {
    // The corrected stream has queued sequence 8 behind the buffered gap fill,
    // so there is only one durable read and no concurrent cursor mutation.
    bufferedGapFill.resolve([event(5), event(6)]);
    await firstLive;
  }

  await Bun.sleep(0);
  await onEvents([event(9)]);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const sequences: number[] = [];
  while (sequences.at(-1) !== 9) {
    const { value, done } = await reader.read();
    if (done) break;
    const frame = decoder.decode(value);
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data) {
      sequences.push((JSON.parse(data) as SessionEvent).sequence);
    }
  }

  expect(sequences).toEqual([5, 6, 7, 8, 9]);
});

test("session SSE clamps a negative resume cursor before durable replay", async () => {
  const bus = {
    subscribe: async () => () => {},
  } as unknown as EventBus;
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    -42,
    new AbortController().signal,
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const sequences: number[] = [];
  while (sequences.length === 0) {
    const { value, done } = await reader.read();
    if (done) break;
    const data = decoder
      .decode(value)
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data) sequences.push((JSON.parse(data) as SessionEvent).sequence);
  }
  await reader.cancel();
  expect(sequences).toEqual([1]);
});

test("replay helper never passes a negative cursor to its durable loader", async () => {
  const cursors: number[] = [];
  await replaySessionEvents(
    async (after) => {
      cursors.push(after);
      return [];
    },
    async () => undefined,
    -1,
  );
  expect(cursors).toEqual([0]);
});

test("replay helper clamps oversized finite cursors to PostgreSQL int4 max", async () => {
  for (const input of [Number.MAX_SAFE_INTEGER, 1e100, 2_147_483_647]) {
    const cursors: number[] = [];
    await replaySessionEvents(
      async (after) => {
        cursors.push(after);
        return [];
      },
      async () => undefined,
      input,
    );
    expect(cursors).toEqual([2_147_483_647]);
  }
});

test("a live gap-read failure errors, unsubscribes, and permits exact-cursor replay", async () => {
  let onEvents: ((events: SessionEvent[]) => void | Promise<void>) | null = null;
  let unsubscribeCount = 0;
  const bus = {
    subscribe: async (
      _workspaceId: string,
      _sessionId: string,
      subscriber: (events: SessionEvent[]) => void | Promise<void>,
    ) => {
      onEvents = subscriber;
      return () => {
        unsubscribeCount += 1;
      };
    },
  } as EventBus;
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    20,
    new AbortController().signal,
  );
  const reader = response.body!.getReader();
  const connected = await reader.read();
  expect(new TextDecoder().decode(connected.value)).toBe(": connected\n\n");

  await onEvents([event(21)]);
  const delivered = await reader.read();
  const deliveredData = new TextDecoder()
    .decode(delivered.value)
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  expect((JSON.parse(deliveredData!) as SessionEvent).sequence).toBe(21);

  await onEvents([event(23)]);

  await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  expect(unsubscribeCount).toBe(1);

  // The SDK reconnects with its last delivered sequence (21). A fresh server
  // connection must replay the durable 22..23 range exactly once.
  const resumed = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    21,
    new AbortController().signal,
  );
  const resumedReader = resumed.body!.getReader();
  const resumedSequences: number[] = [];
  while (resumedSequences.length < 2) {
    const { value, done } = await resumedReader.read();
    if (done) break;
    const data = new TextDecoder()
      .decode(value)
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data) resumedSequences.push((JSON.parse(data) as SessionEvent).sequence);
  }
  expect(resumedSequences).toEqual([22, 23]);
  await resumedReader.cancel();
  expect(unsubscribeCount).toBe(2);
});

test("an initial replay failure errors the SSE response and cleans up its subscription", async () => {
  let unsubscribeCount = 0;
  const bus = {
    subscribe: async () => () => {
      unsubscribeCount += 1;
    },
  } as unknown as EventBus;
  const response = await sseSessionStream(
    fakeDb as never,
    bus,
    WORKSPACE_ID,
    SESSION_ID,
    30,
    new AbortController().signal,
  );
  const reader = response.body!.getReader();

  await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  expect(unsubscribeCount).toBe(1);
});
