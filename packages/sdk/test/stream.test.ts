import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, OpenGeniStreamError } from "../src/errors";
import {
  streamSessionEvents,
  type SessionEventStreamTransport,
  type StreamConnectionState,
} from "../src/stream";
import type { SessionEvent } from "../src/types";
import { bytesStream, collect, hangingBytesStream, makeEvent, sseBlock } from "./helpers";

type Connection = { events: SessionEvent[]; hang?: boolean; raw?: string } | { error: unknown };

/**
 * Scripted transport: each openStream call consumes the next connection
 * script. Records the `after` cursor of every connection and every
 * listEvents call.
 */
function scriptedTransport(
  connections: Connection[],
  replayStore: SessionEvent[] = [],
): SessionEventStreamTransport & {
  openedAfter: number[];
  listCalls: Array<{ after: number; limit: number }>;
} {
  let next = 0;
  const openedAfter: number[] = [];
  const listCalls: Array<{ after: number; limit: number }> = [];
  return {
    openedAfter,
    listCalls,
    openStream: async (after, signal) => {
      openedAfter.push(after);
      const connection = connections[next];
      if (!connection) {
        // Script exhausted: hang until aborted so tests must end via signal.
        return hangingBytesStream([], signal);
      }
      next += 1;
      if ("error" in connection) {
        throw connection.error;
      }
      const wire = (connection.raw ?? "") + connection.events.map(sseBlock).join("");
      return connection.hang ? hangingBytesStream([wire], signal) : bytesStream([wire]);
    },
    listEvents: async (after, limit) => {
      listCalls.push({ after, limit });
      return replayStore.filter((event) => event.sequence > after).slice(0, limit);
    },
  };
}

function sequences(events: SessionEvent[]): number[] {
  return events.map((event) => event.sequence);
}

const FAST = { reconnectDelayMs: 1, maxReconnectDelayMs: 2 };

describe("streamSessionEvents", () => {
  test("awaits authoritative reconciliation before reporting Live", async () => {
    let reconciled = false;
    const states: string[] = [];
    const events = collect(
      streamSessionEvents(scriptedTransport([{ events: [makeEvent(1)] }]), {
        reconnect: false,
        beforeLive: async () => {
          await Bun.sleep(1);
          reconciled = true;
        },
        onStateChange: (state) => states.push(state),
      }),
    );
    expect((await events).map((event) => event.sequence)).toEqual([1]);
    expect(reconciled).toBe(true);
    expect(states).toEqual(["connecting", "live"]);
  });
  test("yields ordered events from a single connection and ends when reconnect is off", async () => {
    const transport = scriptedTransport([{ events: [makeEvent(1), makeEvent(2), makeEvent(3)] }]);
    const events = await collect(streamSessionEvents(transport, { reconnect: false }));
    expect(sequences(events)).toEqual([1, 2, 3]);
    expect(transport.openedAfter).toEqual([0]);
  });

  test("starts from the requested after cursor", async () => {
    const transport = scriptedTransport([{ events: [makeEvent(5), makeEvent(6)] }]);
    const events = await collect(streamSessionEvents(transport, { after: 4, reconnect: false }));
    expect(sequences(events)).toEqual([5, 6]);
    expect(transport.openedAfter).toEqual([4]);
  });

  test("reconnects after a server close and resumes from the last seen sequence", async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([
      { events: [makeEvent(1), makeEvent(2)] },
      { events: [makeEvent(3), makeEvent(4)], hang: true },
    ]);
    const seen: SessionEvent[] = [];
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
    })) {
      seen.push(event);
      if (event.sequence === 4) {
        controller.abort();
      }
    }
    expect(sequences(seen)).toEqual([1, 2, 3, 4]);
    expect(transport.openedAfter).toEqual([0, 2]);
  });

  test("suppresses duplicates when the server replays already-seen events", async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([
      { events: [makeEvent(1), makeEvent(2)] },
      // Misbehaving server ignores `after` and replays from the start.
      { events: [makeEvent(1), makeEvent(2), makeEvent(3)], hang: true },
    ]);
    const seen: SessionEvent[] = [];
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
    })) {
      seen.push(event);
      if (event.sequence === 3) {
        controller.abort();
      }
    }
    expect(sequences(seen)).toEqual([1, 2, 3]);
  });

  test("backfills a gap inside one connection from the replay endpoint", async () => {
    const replayStore = [makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4), makeEvent(5)];
    const transport = scriptedTransport(
      [
        { events: [makeEvent(1), makeEvent(5)] }, // live stream skipped 2..4
      ],
      replayStore,
    );
    const events = await collect(streamSessionEvents(transport, { reconnect: false }));
    expect(sequences(events)).toEqual([1, 2, 3, 4, 5]);
    expect(transport.listCalls).toEqual([{ after: 1, limit: 3 }]);
  });

  test("fails loudly when the replay endpoint skips over a missing sequence", async () => {
    // The replay endpoint has 4 and 5 but not 2 and 3: skipping ahead would
    // silently violate the gap-free guarantee, so the stream must error.
    const transport = scriptedTransport(
      [{ events: [makeEvent(1), makeEvent(5)] }],
      [makeEvent(1), makeEvent(4), makeEvent(5)],
    );
    const iterator = streamSessionEvents(transport, { reconnect: false });
    await expect(collect(iterator)).rejects.toBeInstanceOf(OpenGeniStreamError);
  });

  test("fails loudly when a gap cannot be backfilled", async () => {
    const transport = scriptedTransport(
      [{ events: [makeEvent(1), makeEvent(5)] }],
      [] /* replay store is empty: the gap is unrecoverable */,
    );
    const iterator = streamSessionEvents(transport, { reconnect: false });
    await expect(collect(iterator)).rejects.toBeInstanceOf(OpenGeniStreamError);
  });

  test("retries transient connection errors and recovers", async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([
      { events: [makeEvent(1)] },
      { error: new OpenGeniApiError(503, "upstream restarting") },
      { error: new TypeError("fetch failed") },
      { events: [makeEvent(2)], hang: true },
    ]);
    const seen: SessionEvent[] = [];
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
    })) {
      seen.push(event);
      if (event.sequence === 2) {
        controller.abort();
      }
    }
    expect(sequences(seen)).toEqual([1, 2]);
    expect(transport.openedAfter).toEqual([0, 1, 1, 1]);
  });

  test("throws immediately on non-retryable errors", async () => {
    const transport = scriptedTransport([{ error: new OpenGeniApiError(401, "bad key") }]);
    const iterator = streamSessionEvents(transport, FAST);
    await expect(collect(iterator)).rejects.toMatchObject({ status: 401 });
  });

  test("gives up after maxReconnectAttempts consecutive failures", async () => {
    const transport = scriptedTransport([
      { error: new OpenGeniApiError(503, "down") },
      { error: new OpenGeniApiError(503, "down") },
      { error: new OpenGeniApiError(503, "down") },
    ]);
    const iterator = streamSessionEvents(transport, { ...FAST, maxReconnectAttempts: 2 });
    await expect(collect(iterator)).rejects.toBeInstanceOf(OpenGeniStreamError);
    expect(transport.openedAfter).toEqual([0, 0, 0]);
  });

  test("a successful connection resets the failure budget", async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([
      { error: new OpenGeniApiError(503, "down") },
      { events: [makeEvent(1)] },
      { error: new OpenGeniApiError(503, "down") },
      { events: [makeEvent(2)], hang: true },
    ]);
    const seen: SessionEvent[] = [];
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      maxReconnectAttempts: 1,
      signal: controller.signal,
    })) {
      seen.push(event);
      if (event.sequence === 2) {
        controller.abort();
      }
    }
    expect(sequences(seen)).toEqual([1, 2]);
  });

  test("ends gracefully when aborted mid-connection", async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([{ events: [makeEvent(1)], hang: true }]);
    const seen: SessionEvent[] = [];
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
    })) {
      seen.push(event);
      controller.abort();
    }
    expect(sequences(seen)).toEqual([1]);
  });

  test("stops yielding already-buffered events once aborted", async () => {
    const controller = new AbortController();
    // All three events arrive in one chunk, so 2 and 3 are buffered locally
    // when the consumer aborts after seeing 1.
    const transport = scriptedTransport([{ events: [makeEvent(1), makeEvent(2), makeEvent(3)] }]);
    const seen: SessionEvent[] = [];
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
    })) {
      seen.push(event);
      controller.abort();
    }
    expect(sequences(seen)).toEqual([1]);
  });

  test("ends immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = scriptedTransport([{ events: [makeEvent(1)] }]);
    const events = await collect(streamSessionEvents(transport, { signal: controller.signal }));
    expect(events).toEqual([]);
    expect(transport.openedAfter).toEqual([]);
  });

  test("ignores comments and non-event SSE payloads", async () => {
    const transport = scriptedTransport([
      { events: [makeEvent(1)], raw: ": connected\n\ndata: not-json\n\n" },
    ]);
    const events = await collect(streamSessionEvents(transport, { reconnect: false }));
    expect(sequences(events)).toEqual([1]);
  });

  test("reconnects immediately after a clean close that made progress", async () => {
    const controller = new AbortController();
    // A huge reconnect delay would stall the test if the productive clean
    // close were paced; immediate reconnect keeps it fast.
    const transport = scriptedTransport([
      { events: [makeEvent(1)] },
      { events: [makeEvent(2)], hang: true },
    ]);
    const seen: SessionEvent[] = [];
    const startedAt = Date.now();
    for await (const event of streamSessionEvents(transport, {
      reconnectDelayMs: 120_000,
      maxReconnectDelayMs: 120_000,
      signal: controller.signal,
    })) {
      seen.push(event);
      if (event.sequence === 2) {
        controller.abort();
      }
    }
    expect(sequences(seen)).toEqual([1, 2]);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });

  test("paces reconnects when clean closes deliver nothing", async () => {
    const controller = new AbortController();
    const transport = scriptedTransport([
      { events: [] }, // empty clean close: must sleep before reconnecting
      { events: [makeEvent(1)], hang: true },
    ]);
    const seen: SessionEvent[] = [];
    const startedAt = Date.now();
    for await (const event of streamSessionEvents(transport, {
      reconnectDelayMs: 100,
      signal: controller.signal,
    })) {
      seen.push(event);
      controller.abort();
    }
    expect(sequences(seen)).toEqual([1]);
    // The empty close must have been paced by ~reconnectDelayMs.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });

  test("reports reconnecting (not connecting) after a clean close", async () => {
    const controller = new AbortController();
    const states: StreamConnectionState[] = [];
    const transport = scriptedTransport([
      { events: [makeEvent(1)] },
      { events: [makeEvent(2)], hang: true },
    ]);
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
      onStateChange: (state) => states.push(state),
    })) {
      if (event.sequence === 2) {
        controller.abort();
      }
    }
    expect(states).toEqual(["connecting", "live", "reconnecting", "live"]);
  });

  test("reports connection state transitions", async () => {
    const controller = new AbortController();
    const states: StreamConnectionState[] = [];
    const transport = scriptedTransport([
      { error: new OpenGeniApiError(503, "down") },
      { events: [makeEvent(1)], hang: true },
    ]);
    for await (const event of streamSessionEvents(transport, {
      ...FAST,
      signal: controller.signal,
      onStateChange: (state) => states.push(state),
    })) {
      if (event.sequence === 1) {
        controller.abort();
      }
    }
    expect(states).toEqual(["connecting", "reconnecting", "live"]);
  });
});
