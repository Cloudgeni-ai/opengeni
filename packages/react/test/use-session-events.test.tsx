import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { useSessionEvents } from "../src/hooks/use-session-events";

registerDom();

function event(sequence: number, type: SessionEvent["type"] = "user.message", payload: unknown = { text: `m-${sequence}` }): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
    clientEventId: null,
    turnId: null,
  };
}

function listPage(store: SessionEvent[], options: { after?: number; before?: number; limit?: number } = {}): SessionEvent[] {
  const after = options.after ?? 0;
  const limit = options.limit ?? 500;
  let candidates = store.filter((item) => item.sequence > after);
  if (options.before !== undefined) {
    const before = options.before;
    candidates = candidates.filter((item) => item.sequence < before);
    return candidates.slice(-limit);
  }
  return candidates.slice(0, limit);
}

function scriptedClient(input: {
  store: SessionEvent[];
  streamEvents?: SessionEvent[];
  listEvents?: (options: { after?: number; before?: number; limit?: number }) => Promise<SessionEvent[]>;
}) {
  const listCalls: Array<{ after?: number; before?: number; limit?: number }> = [];
  const streamCalls: number[] = [];
  const client = fakeClient({
    listEvents: async (_workspaceId, _sessionId, options = {}) => {
      listCalls.push(options);
      return input.listEvents ? await input.listEvents(options) : listPage(input.store, options);
    },
    streamEvents: (_workspaceId, _sessionId, options = {}) => {
      streamCalls.push(options.after ?? 0);
      const streamed = input.streamEvents ?? [];
      return (async function* () {
        for (const item of streamed) {
          if (options.signal?.aborted) {
            return;
          }
          yield item;
        }
      })();
    },
  });
  return { client, listCalls, streamCalls };
}

describe("useSessionEvents", () => {
  test("initial windowed load stops at density target and opens the stream after the newest event", async () => {
    const store = Array.from({ length: 1200 }, (_, index) => event(index + 1));
    const { client, listCalls, streamCalls } = scriptedClient({ store });
    const lengths: number[] = [];
    const hook = await renderHook(() => {
      const result = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
      lengths.push(result.events.length);
      return result;
    }, undefined);
    await flush(20);

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000 }]);
    expect(hook.result.current.events).toHaveLength(1000);
    expect(hook.result.current.events[0]?.sequence).toBe(201);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(streamCalls).toEqual([1200]);
    expect(lengths.filter((length) => length === 1000)).toHaveLength(1);

    await hook.unmount();
  });

  test("boundary snap trims a mid-turn window top to the oldest user message in the buffer", async () => {
    const store = [
      event(1, "session.created", {}),
      event(2),
      ...Array.from({ length: 498 }, (_, index) => event(index + 3, "agent.message.delta", { text: "older" })),
      event(501),
      ...Array.from({ length: 1000 }, (_, index) => event(index + 502, "agent.message.delta", { text: "middle" })),
      ...Array.from({ length: 999 }, (_, index) => event(index + 1502)),
    ];
    const { client, listCalls } = scriptedClient({ store });
    const hook = await renderHook(() => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }), undefined);
    await flush(20);

    // One fetch: the tail page already contains boundaries, so the head is
    // TRIMMED to the oldest user message (the mid-turn fragment at seq 1501 is
    // dropped) rather than fetching further down. loadOlder's `before` cursor
    // is the trimmed top, so the fragment is refetched with its own turn.
    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000 }]);
    expect(hook.result.current.events[0]?.type).toBe("user.message");
    expect(hook.result.current.events[0]?.sequence).toBe(1502);
    expect(hook.result.current.hasOlder).toBe(true);

    const more = await hook.result.current.loadOlder();
    await flush(20);
    // The older window starts exactly below the kept window (before: 1502 —
    // no overlap, no gap), recovers the trimmed fragment, and runs all the way
    // to the log start, so nothing older remains.
    expect(more).toBe(false);
    expect(listCalls[1]).toEqual({ before: 1502, limit: 1000 });
    expect(hook.result.current.events[0]?.type).toBe("session.created");
    expect(hook.result.current.events[0]?.sequence).toBe(1);
    expect(hook.result.current.hasOlder).toBe(false);
    const sequences = hook.result.current.events.map((entry) => entry.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toHaveLength(store.length);

    await hook.unmount();
  });

  test("loadOlder prepends one older window, preserves order, and guards concurrent calls", async () => {
    const store = [
      event(1, "session.created", {}),
      ...Array.from({ length: 1199 }, (_, index) => event(index + 2)),
    ];
    let releaseOlder: () => void = () => {
      throw new Error("older page was not requested");
    };
    const { client, listCalls } = scriptedClient({
      store,
      listEvents: async (options) => {
        if (options.before === 201) {
          await new Promise<void>((resolve) => {
            releaseOlder = resolve;
          });
        }
        return listPage(store, options);
      },
    });
    const hook = await renderHook(() => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }), undefined);
    await flush(20);

    const first = hook.result.current.loadOlder();
    const second = hook.result.current.loadOlder();
    await flush();
    expect(listCalls.filter((call) => call.before === 201)).toHaveLength(1);
    releaseOlder();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await flush(20);

    expect(firstResult).toBe(false);
    expect(secondResult).toBe(false);
    expect(hook.result.current.events.map((item) => item.sequence)).toEqual(store.map((item) => item.sequence));
    expect(new Set(hook.result.current.events.map((item) => item.sequence)).size).toBe(store.length);
    expect(hook.result.current.hasOlder).toBe(false);

    await hook.unmount();
  });

  test("full replay and nonzero after keep the stream-only behavior", async () => {
    const full = scriptedClient({ store: [], streamEvents: [event(1), event(2)] });
    const fullHook = await renderHook(() => useSessionEvents(SESSION_ID, {
      client: full.client,
      workspaceId: WORKSPACE_ID,
      replay: "full",
    }), undefined);
    await flush(20);
    expect(full.listCalls).toHaveLength(0);
    expect(full.streamCalls).toEqual([0]);
    expect(fullHook.result.current.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(fullHook.result.current.hasOlder).toBe(false);
    await fullHook.unmount();

    const resumed = scriptedClient({ store: [], streamEvents: [event(6)] });
    const resumedHook = await renderHook(() => useSessionEvents(SESSION_ID, {
      client: resumed.client,
      workspaceId: WORKSPACE_ID,
      after: 5,
    }), undefined);
    await flush(20);
    expect(resumed.listCalls).toHaveLength(0);
    expect(resumed.streamCalls).toEqual([5]);
    expect(resumedHook.result.current.events.map((item) => item.sequence)).toEqual([6]);
    expect(resumedHook.result.current.hasOlder).toBe(false);
    await resumedHook.unmount();
  });

  test("event budget cap stops a boundary-less monster turn at the cap", async () => {
    const store = Array.from({ length: 12_000 }, (_, index) => event(index + 1, "agent.message.delta", { text: "x" }));
    const { client, listCalls } = scriptedClient({ store });
    const hook = await renderHook(() => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }), undefined);
    await flush(20);

    expect(hook.result.current.events).toHaveLength(10_000);
    expect(hook.result.current.events[0]?.sequence).toBe(2001);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(listCalls).toHaveLength(10);

    await hook.unmount();
  });
});
