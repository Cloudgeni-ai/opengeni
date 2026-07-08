import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { useSessionEvents } from "../src/hooks/use-session-events";
import { buildTimeline, type TimelineItem } from "../src/timeline";

registerDom();

function event(
  sequence: number,
  type: SessionEvent["type"] = "user.message",
  payload: unknown = { text: `m-${sequence}` },
): SessionEvent {
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

type ListOptions = { after?: number; before?: number; limit?: number; compact?: boolean };

function listPage(store: SessionEvent[], options: ListOptions = {}): SessionEvent[] {
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
  listEvents?: (options: ListOptions) => Promise<SessionEvent[]>;
}) {
  const listCalls: ListOptions[] = [];
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
  test("initial windowed load uses compact tail pages and opens the stream after the newest event", async () => {
    const store = Array.from({ length: 1200 }, (_, index) => event(index + 1));
    const { client, listCalls, streamCalls } = scriptedClient({ store });
    const lengths: number[] = [];
    const hook = await renderHook(() => {
      const result = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
      lengths.push(result.events.length);
      return result;
    }, undefined);
    await flush(20);

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 5000, compact: true }]);
    expect(hook.result.current.events).toHaveLength(1200);
    expect(hook.result.current.events[0]?.sequence).toBe(1);
    expect(hook.result.current.hasOlder).toBe(false);
    expect(streamCalls).toEqual([1200]);
    expect(lengths.filter((length) => length === 1200)).toHaveLength(1);

    await hook.unmount();
  });

  test("boundary snap trims a mid-turn window top to the oldest user message in the buffer", async () => {
    const store = [
      event(1, "session.created", {}),
      event(2),
      ...Array.from({ length: 5099 }, (_, index) =>
        event(index + 3, "agent.message.delta", { text: "older" }),
      ),
      event(5102),
      ...Array.from({ length: 1000 }, (_, index) =>
        event(index + 5103, "agent.message.delta", { text: "middle" }),
      ),
      ...Array.from({ length: 1000 }, (_, index) => event(index + 6103)),
    ];
    const { client, listCalls } = scriptedClient({ store });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);

    // One fetch: the tail page already contains a boundary, so the head is
    // TRIMMED to the oldest user message rather than fetching further down.
    // loadOlder's `before` cursor is the trimmed top, so the fragment is
    // refetched with its own turn.
    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 5000, compact: true }]);
    expect(hook.result.current.events[0]?.type).toBe("user.message");
    expect(hook.result.current.events[0]?.sequence).toBe(5102);
    expect(hook.result.current.hasOlder).toBe(true);

    const more = await hook.result.current.loadOlder();
    await flush(20);
    // The older window starts exactly below the kept window (before: 5102 —
    // no overlap, no gap), recovers the trimmed fragment, and runs to the log
    // start within the older fetch cap, so nothing older remains.
    expect(more).toBe(false);
    expect(listCalls[1]).toEqual({ before: 5102, limit: 5000, compact: true });
    expect(listCalls[2]).toEqual({ before: 102, limit: 5000, compact: true });
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
      ...Array.from({ length: 5999 }, (_, index) => event(index + 2)),
    ];
    let releaseOlder: () => void = () => {
      throw new Error("older page was not requested");
    };
    const { client, listCalls } = scriptedClient({
      store,
      listEvents: async (options) => {
        if (options.before === 1001) {
          await new Promise<void>((resolve) => {
            releaseOlder = resolve;
          });
        }
        return listPage(store, options);
      },
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);

    const first = hook.result.current.loadOlder();
    const second = hook.result.current.loadOlder();
    await flush();
    expect(listCalls.filter((call) => call.before === 1001)).toHaveLength(1);
    releaseOlder();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await flush(20);

    expect(firstResult).toBe(false);
    expect(secondResult).toBe(false);
    expect(hook.result.current.events.map((item) => item.sequence)).toEqual(
      store.map((item) => item.sequence),
    );
    expect(new Set(hook.result.current.events.map((item) => item.sequence)).size).toBe(
      store.length,
    );
    expect(hook.result.current.hasOlder).toBe(false);

    await hook.unmount();
  });

  test("full replay and nonzero after keep the stream-only behavior", async () => {
    const full = scriptedClient({ store: [], streamEvents: [event(1), event(2)] });
    const fullHook = await renderHook(
      () =>
        useSessionEvents(SESSION_ID, {
          client: full.client,
          workspaceId: WORKSPACE_ID,
          replay: "full",
        }),
      undefined,
    );
    await flush(20);
    expect(full.listCalls).toHaveLength(0);
    expect(full.streamCalls).toEqual([0]);
    expect(fullHook.result.current.events.map((item) => item.sequence)).toEqual([1, 2]);
    expect(fullHook.result.current.hasOlder).toBe(false);
    await fullHook.unmount();

    const resumed = scriptedClient({ store: [], streamEvents: [event(6)] });
    const resumedHook = await renderHook(
      () =>
        useSessionEvents(SESSION_ID, {
          client: resumed.client,
          workspaceId: WORKSPACE_ID,
          after: 5,
        }),
      undefined,
    );
    await flush(20);
    expect(resumed.listCalls).toHaveLength(0);
    expect(resumed.streamCalls).toEqual([5]);
    expect(resumedHook.result.current.events.map((item) => item.sequence)).toEqual([6]);
    expect(resumedHook.result.current.hasOlder).toBe(false);
    await resumedHook.unmount();
  });

  test("the initial window is a single fetch regardless of log size", async () => {
    const store = Array.from({ length: 40_000 }, (_, index) =>
      event(index + 1, "agent.message.delta", { text: "x" }),
    );
    const { client, listCalls } = scriptedClient({ store });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);

    // First paint is exactly ONE fetch — deeper history is the sentinel's job.
    expect(hook.result.current.events).toHaveLength(5000);
    expect(hook.result.current.events[0]?.sequence).toBe(35_001);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 5000, compact: true }]);

    await hook.unmount();
  });

  test("coalesced tail opens the stream after coalescedUntil", async () => {
    const coalescedTail = [
      event(1, "session.created", {}),
      event(10, "agent.message.delta", { text: "streamed", coalescedUntil: 99 }),
    ];
    const { client, listCalls, streamCalls } = scriptedClient({
      store: [],
      listEvents: async () => coalescedTail,
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 5000, compact: true }]);
    expect(hook.result.current.events.map((item) => item.sequence)).toEqual([1, 10]);
    expect(streamCalls).toEqual([99]);

    await hook.unmount();
  });

  test("loadOlder before an oldest synthetic sequence does not duplicate projected text", async () => {
    const calls: ListOptions[] = [];
    const { client } = scriptedClient({
      store: [],
      listEvents: async (options) => {
        calls.push(options);
        if (options.before === Number.MAX_SAFE_INTEGER) {
          return [event(8, "agent.message.delta", { text: "ghi", coalescedUntil: 9 })];
        }
        if (options.before === 8) {
          return [event(6, "agent.message.delta", { text: "ef", coalescedUntil: 7 })];
        }
        if (options.before === 6) {
          return [event(4, "agent.message.delta", { text: "cd", coalescedUntil: 5 })];
        }
        if (options.before === 4) {
          return [
            event(1, "session.created", {}),
            event(2, "agent.message.delta", { text: "ab", coalescedUntil: 3 }),
          ];
        }
        return [];
      },
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);

    expect(hook.result.current.events.map((item) => item.sequence)).toEqual([8]);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(hook.result.current.lastSequence).toBe(9);

    const first = await hook.result.current.loadOlder();
    await flush(20);
    expect(first).toBe(true);
    expect(hook.result.current.events.map((item) => item.sequence)).toEqual([4, 6, 8]);

    const more = await hook.result.current.loadOlder();
    await flush(20);

    expect(more).toBe(false);
    expect(calls).toEqual([
      { before: Number.MAX_SAFE_INTEGER, limit: 5000, compact: true },
      { before: 8, limit: 5000, compact: true },
      { before: 6, limit: 5000, compact: true },
      { before: 4, limit: 5000, compact: true },
    ]);
    const agentText = hook.result.current.timeline
      .filter(
        (item): item is Extract<TimelineItem, { kind: "agent-message" }> =>
          item.kind === "agent-message",
      )
      .map((item) => item.text);
    expect(agentText).toEqual(["abcdefghi"]);
    const rawEquivalent = [
      event(1, "session.created", {}),
      ...Array.from("abcdefghi", (text, index) =>
        event(index + 2, "agent.message.delta", { text }),
      ),
    ];
    const rawText = buildTimeline(rawEquivalent)
      .filter(
        (item): item is Extract<TimelineItem, { kind: "agent-message" }> =>
          item.kind === "agent-message",
      )
      .map((item) => item.text);
    expect(agentText).toEqual(rawText);

    await hook.unmount();
  });

  test("group early-stop still works on many-turn logs", async () => {
    const store = Array.from({ length: 20_000 }, (_, index) =>
      event(index + 1, "user.message", { text: `m-${index + 1}` }),
    );
    const { client, listCalls } = scriptedClient({ store });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(20);

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 5000, compact: true }]);
    expect(hook.result.current.events).toHaveLength(5000);
    expect(hook.result.current.events[0]?.sequence).toBe(15_001);
    expect(hook.result.current.hasOlder).toBe(true);

    await hook.unmount();
  });
});
