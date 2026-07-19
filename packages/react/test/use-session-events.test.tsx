import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { actRun, registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import {
  SESSION_EVENT_BROWSER_MAX_BYTES,
  SESSION_EVENT_BROWSER_MAX_COUNT,
  SESSION_EVENT_BROWSER_PENDING_MAX_BYTES,
  SESSION_EVENT_BROWSER_PENDING_MAX_COUNT,
  SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
  boundBrowserSessionEventWindow,
  type UseSessionEventsResult,
  useSessionEvents,
} from "../src/hooks/use-session-events";
import { buildTimeline, type TimelineItem } from "../src/timeline";

registerDom();

const SECOND_SESSION_ID = "33333333-3333-4333-8333-333333333333";

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

type ListOptions = {
  after?: number;
  before?: number;
  limit?: number;
  compact?: boolean;
};

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
      const after = options.after ?? 0;
      streamCalls.push(after);
      const streamed = input.streamEvents ?? [];
      return (async function* () {
        for (const item of streamed) {
          if (options.signal?.aborted) {
            return;
          }
          if (item.sequence > after) yield item;
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
      const result = useSessionEvents(SESSION_ID, {
        client,
        workspaceId: WORKSPACE_ID,
      });
      lengths.push(result.events.length);
      return result;
    }, undefined);
    await flush(20);

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true }]);
    expect(hook.result.current.events).toHaveLength(1000);
    expect(hook.result.current.events[0]?.sequence).toBe(201);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(streamCalls).toEqual([1200]);
    expect(lengths.filter((length) => length === 1000)).toHaveLength(1);

    await hook.unmount();
  });

  test("a session switch never exposes the previous session's event log during render", async () => {
    let resolveSecond!: (events: SessionEvent[]) => void;
    const secondPage = new Promise<SessionEvent[]>((resolve) => {
      resolveSecond = resolve;
    });
    const firstEvent = event(1);
    const secondEvent: SessionEvent = {
      ...event(1),
      id: "evt-second-1",
      sessionId: SECOND_SESSION_ID,
    };
    const client = fakeClient({
      listEvents: async (_workspaceId, sessionId) =>
        sessionId === SESSION_ID ? [firstEvent] : await secondPage,
      streamEvents: () =>
        (async function* () {
          // Keep the stream contract without yielding additional events.
        })(),
    });
    const observed: Array<{ sessionId: string; eventSessionIds: string[] }> = [];
    const hook = await renderHook(
      (props: { sessionId: string }) => {
        const result = useSessionEvents(props.sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
        });
        observed.push({
          sessionId: props.sessionId,
          eventSessionIds: result.events.map((item) => item.sessionId),
        });
        return result;
      },
      { sessionId: SESSION_ID },
    );
    await flush(20);
    expect(hook.result.current.events.map((item) => item.sessionId)).toEqual([SESSION_ID]);

    observed.length = 0;
    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    expect(
      observed
        .filter(({ sessionId }) => sessionId === SECOND_SESSION_ID)
        .flatMap(({ eventSessionIds }) => eventSessionIds),
    ).not.toContain(SESSION_ID);
    expect(hook.result.current.events).toEqual([]);
    expect(hook.result.current.lastSequence).toBe(0);

    resolveSecond([secondEvent]);
    await flush(20);
    expect(hook.result.current.events.map((item) => item.sessionId)).toEqual([SECOND_SESSION_ID]);
    await hook.unmount();
  });

  test("an abort-insensitive old iterator cannot commit after a session switch", async () => {
    let releaseOld!: () => void;
    const oldReady = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldEvent = event(1);
    const newEvent: SessionEvent = {
      ...event(1),
      id: "evt-new-stream",
      sessionId: SECOND_SESSION_ID,
    };
    const client = fakeClient({
      streamEvents: (_workspaceId, sessionId) =>
        (async function* () {
          if (sessionId === SESSION_ID) {
            // Deliberately ignore AbortSignal and yield after the old effect's cleanup.
            await oldReady;
            yield oldEvent;
            return;
          }
          yield newEvent;
        })(),
    });
    const hook = await renderHook(
      (props: { sessionId: string }) =>
        useSessionEvents(props.sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          replay: "full",
        }),
      { sessionId: SESSION_ID },
    );

    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    await flush(20);
    expect(hook.result.current.events.map((item) => item.id)).toEqual(["evt-new-stream"]);

    releaseOld();
    await flush(20);
    expect(hook.result.current.events.map((item) => item.id)).toEqual(["evt-new-stream"]);
    expect(hook.result.current.events.map((item) => item.sessionId)).toEqual([SECOND_SESSION_ID]);

    await hook.unmount();
  });

  test("an abort-insensitive old backward fetch cannot replace the new session window", async () => {
    let releaseOlder!: (events: SessionEvent[]) => void;
    const olderPage = new Promise<SessionEvent[]>((resolve) => {
      releaseOlder = resolve;
    });
    const firstTail = event(101);
    const secondEvent: SessionEvent = {
      ...event(1, "session.created", {}),
      id: "evt-second-session",
      sessionId: SECOND_SESSION_ID,
    };
    const client = fakeClient({
      listEvents: async (_workspaceId, sessionId, options = {}) => {
        if (sessionId === SECOND_SESSION_ID) return [secondEvent];
        if (options.before === Number.MAX_SAFE_INTEGER) return [firstTail];
        if (options.before === 101) return await olderPage;
        return [];
      },
      streamEvents: () =>
        (async function* () {
          // Keep the stream open contract without yielding.
        })(),
    });
    const hook = await renderHook(
      (props: { sessionId: string }) =>
        useSessionEvents(props.sessionId, { client, workspaceId: WORKSPACE_ID }),
      { sessionId: SESSION_ID },
    );
    await flush(20);
    expect(hook.result.current.hasOlder).toBeTrue();

    let oldLoad!: Promise<boolean>;
    await actRun(() => {
      oldLoad = hook.result.current.loadOlder();
    });
    expect(hook.result.current.loadingOlder).toBeTrue();

    await hook.rerender({ sessionId: SECOND_SESSION_ID });
    await flush(20);
    expect(hook.result.current.loadingOlder).toBeFalse();
    expect(hook.result.current.events.map((item) => item.id)).toEqual(["evt-second-session"]);

    releaseOlder([
      event(1, "session.created", {}),
      ...Array.from({ length: 99 }, (_, index) => event(index + 2)),
    ]);
    expect(await actRun(async () => await oldLoad)).toBeFalse();
    await flush(20);
    expect(hook.result.current.loadingOlder).toBeFalse();
    expect(hook.result.current.events.map((item) => item.id)).toEqual(["evt-second-session"]);
    expect(hook.result.current.events.map((item) => item.sessionId)).toEqual([SECOND_SESSION_ID]);

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
    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true }]);
    expect(hook.result.current.events[0]?.type).toBe("user.message");
    expect(hook.result.current.events[0]?.sequence).toBe(6103);
    expect(hook.result.current.hasOlder).toBe(true);

    const more = await actRun(() => hook.result.current.loadOlder());
    await flush(20);
    // The older window starts exactly below the kept window and reaches the log
    // start within the older two-fetch cap.
    expect(more).toBe(false);
    expect(listCalls[1]).toEqual({ before: 6103, limit: 5000, compact: true });
    expect(listCalls[2]).toEqual({ before: 1103, limit: 5000, compact: true });
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
        if (options.before === 5001) {
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

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await actRun(() => {
      first = hook.result.current.loadOlder();
      second = hook.result.current.loadOlder();
    });
    await flush();
    expect(listCalls.filter((call) => call.before === 5001)).toHaveLength(1);
    const [firstResult, secondResult] = await actRun(async () => {
      releaseOlder();
      return await Promise.all([first, second]);
    });
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
    const full = scriptedClient({
      store: [],
      streamEvents: [event(1), event(2)],
    });
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
    expect(hook.result.current.events).toHaveLength(1000);
    expect(hook.result.current.events[0]?.sequence).toBe(39_001);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true }]);

    await hook.unmount();
  });

  test("coalesced tail opens the stream after coalescedUntil", async () => {
    const coalescedTail = [
      event(1, "session.created", {}),
      event(10, "agent.message.delta", {
        text: "streamed",
        coalescedUntil: 99,
      }),
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

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true }]);
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

    const first = await actRun(() => hook.result.current.loadOlder());
    await flush(20);
    expect(first).toBe(true);
    expect(hook.result.current.events.map((item) => item.sequence)).toEqual([4, 6, 8]);

    const more = await actRun(() => hook.result.current.loadOlder());
    await flush(20);

    expect(more).toBe(false);
    expect(calls).toEqual([
      { before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true },
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

    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true }]);
    expect(hook.result.current.events).toHaveLength(1000);
    expect(hook.result.current.events[0]?.sequence).toBe(19_001);
    expect(hook.result.current.hasOlder).toBe(true);

    await hook.unmount();
  });

  test("keeps a bounded live suffix, advances resume, and preserves status after its event is evicted", async () => {
    const streamed = [
      event(1, "session.status.changed", { status: "running" }),
      ...Array.from({ length: SESSION_EVENT_BROWSER_MAX_COUNT + 50 }, (_, index) =>
        event(index + 2, "machine.op.recovered", { attempt: index + 1 }),
      ),
    ];
    const { client, listCalls, streamCalls } = scriptedClient({
      store: streamed,
      streamEvents: streamed,
    });
    const hook = await renderHook(
      () =>
        useSessionEvents(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          replay: "full",
        }),
      undefined,
    );
    await flush(80);

    expect(hook.result.current.events).toHaveLength(SESSION_EVENT_BROWSER_MAX_COUNT);
    expect(hook.result.current.events[0]?.sequence).toBe(52);
    expect(hook.result.current.events.at(-1)?.sequence).toBe(streamed.length);
    expect(hook.result.current.lastSequence).toBe(streamed.length);
    expect(hook.result.current.windowTruncated).toBeTrue();
    expect(hook.result.current.windowBytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_MAX_BYTES);
    expect(hook.result.current.hasOlder).toBeTrue();
    expect(hook.result.current.sessionStatus).toBe("running");

    const oldFirst = hook.result.current.events[0]!.sequence;
    const more = await actRun(() => hook.result.current.loadOlder());
    await flush(20);
    expect(more).toBeFalse();
    expect(listCalls).toEqual([{ before: oldFirst, limit: 5000, compact: true }]);
    // The loaded prefix temporarily retained 1..10000. Reconnecting from
    // 10000 then replayed 10001..10051, restoring one contiguous newest suffix
    // instead of appending live rows across a historical gap.
    expect(streamCalls).toEqual([0, 10_000]);
    expect(hook.result.current.events[0]?.sequence).toBe(oldFirst);
    expect(hook.result.current.events.at(-1)?.sequence).toBe(streamed.length);
    expect(hook.result.current.hasOlder).toBeTrue();
    const recoveredSequences = hook.result.current.events.map((item) => item.sequence);
    expect(
      recoveredSequences.every(
        (sequence, index) => index === 0 || sequence === recoveredSequences[index - 1]! + 1,
      ),
    ).toBeTrue();

    await hook.unmount();
  });

  test("flushes a synchronously yielded pending batch at its count high-water mark", async () => {
    let releaseStream!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const heldTimers = new Map<number, () => void>();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nextTimer = 1_000_000;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 16 && typeof callback === "function") {
        const timer = nextTimer++;
        heldTimers.set(timer, () => callback(...args));
        return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      if (typeof timer === "number" && heldTimers.delete(timer)) return;
      originalClearTimeout(timer);
    }) as typeof clearTimeout;

    let hook: Awaited<ReturnType<typeof renderHook<UseSessionEventsResult, undefined>>> | null =
      null;
    try {
      const client = fakeClient({
        streamEvents: () =>
          (async function* () {
            for (let index = 0; index < SESSION_EVENT_BROWSER_PENDING_MAX_COUNT + 1; index += 1) {
              yield event(index + 1, "machine.op.recovered", { attempt: index + 1 });
            }
            await blocked;
          })(),
      });
      hook = await renderHook(
        () =>
          useSessionEvents(SESSION_ID, {
            client,
            workspaceId: WORKSPACE_ID,
            replay: "full",
          }),
        undefined,
      );
      await flush(1);

      expect(heldTimers.size).toBeGreaterThan(0);
      expect(hook.result.current.events).toHaveLength(SESSION_EVENT_BROWSER_PENDING_MAX_COUNT);
      expect(hook.result.current.lastSequence).toBe(SESSION_EVENT_BROWSER_PENDING_MAX_COUNT);

      releaseStream();
      await flush(1);
      expect(hook.result.current.events).toHaveLength(SESSION_EVENT_BROWSER_PENDING_MAX_COUNT + 1);
    } finally {
      releaseStream();
      if (hook) await hook.unmount();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("projects oversized events and flushes pending bytes before the timer can run", async () => {
    let releaseStream!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const heldTimers = new Map<number, () => void>();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let nextTimer = 2_000_000;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 16 && typeof callback === "function") {
        const timer = nextTimer++;
        heldTimers.set(timer, () => callback(...args));
        return timer;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      if (typeof timer === "number" && heldTimers.delete(timer)) return;
      originalClearTimeout(timer);
    }) as typeof clearTimeout;

    let hook: Awaited<ReturnType<typeof renderHook<UseSessionEventsResult, undefined>>> | null =
      null;
    try {
      const streamed = [
        event(1, "agent.toolCall.output", {
          id: "multi-megabyte",
          output: `HEAD-${"界".repeat(1024 * 1024)}-TAIL`,
        }),
        ...Array.from({ length: 20 }, (_, index) =>
          event(index + 2, "agent.message.completed", { text: "x".repeat(80 * 1024) }),
        ),
      ];
      const client = fakeClient({
        streamEvents: () =>
          (async function* () {
            yield* streamed;
            await blocked;
          })(),
      });
      hook = await renderHook(
        () =>
          useSessionEvents(SESSION_ID, {
            client,
            workspaceId: WORKSPACE_ID,
            replay: "full",
          }),
        undefined,
      );
      await flush(1);

      expect(heldTimers.size).toBeGreaterThan(0);
      expect(hook.result.current.events.length).toBeGreaterThan(0);
      expect(hook.result.current.events.length).toBeLessThan(
        SESSION_EVENT_BROWSER_PENDING_MAX_COUNT,
      );
      expect(hook.result.current.lastSequence).toBeLessThan(streamed.length);
      expect(hook.result.current.windowBytes).toBeLessThanOrEqual(
        SESSION_EVENT_BROWSER_PENDING_MAX_BYTES,
      );
      const firstPayload = hook.result.current.events[0]!.payload as Record<string, unknown>;
      expect(firstPayload.truncation).toMatchObject({
        truncated: true,
        surface: "browser_legacy_guard",
        fullEvidence: { available: false, reason: "not_retained" },
      });

      releaseStream();
      await flush(1);
      expect(hook.result.current.lastSequence).toBe(streamed.length);
      expect(hook.result.current.windowBytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_MAX_BYTES);
    } finally {
      releaseStream();
      if (hook) await hook.unmount();
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("backward paging reconnects from the retained tail before appending live events", async () => {
    const historical = Array.from({ length: SESSION_EVENT_BROWSER_MAX_COUNT + 51 }, (_, index) =>
      event(index + 1),
    );
    const throughLive = [...historical, event(SESSION_EVENT_BROWSER_MAX_COUNT + 52)];
    const listCalls: ListOptions[] = [];
    const streamCalls: number[] = [];
    let connection = 0;
    const client = fakeClient({
      listEvents: async (_workspaceId, _sessionId, options = {}) => {
        listCalls.push(options);
        return listPage(historical, options);
      },
      streamEvents: (_workspaceId, _sessionId, options = {}) => {
        const after = options.after ?? 0;
        streamCalls.push(after);
        connection += 1;
        const source = connection === 1 ? historical : throughLive;
        return (async function* () {
          for (const item of source) {
            if (options.signal?.aborted) return;
            if (item.sequence > after) yield item;
          }
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
              return;
            }
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      },
    });
    const hook = await renderHook(
      () =>
        useSessionEvents(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          replay: "full",
        }),
      undefined,
    );
    await flush(100);

    expect(hook.result.current.events[0]?.sequence).toBe(52);
    expect(hook.result.current.events.at(-1)?.sequence).toBe(10_051);
    expect(hook.result.current.lastSequence).toBe(10_051);

    const more = await actRun(() => hook.result.current.loadOlder());
    await flush(100);

    expect(more).toBeFalse();
    expect(listCalls).toEqual([{ before: 52, limit: 5000, compact: true }]);
    // loadOlder retained 1..10000, then the restarted stream replayed the
    // evicted 10001..10051 tail before delivering the new live row 10052.
    expect(streamCalls).toEqual([0, 10_000]);
    expect(hook.result.current.events[0]?.sequence).toBe(53);
    expect(hook.result.current.events.at(-1)?.sequence).toBe(10_052);
    expect(hook.result.current.lastSequence).toBe(10_052);
    const sequences = hook.result.current.events.map((item) => item.sequence);
    expect(
      sequences.every((sequence, index) => index === 0 || sequence === sequences[index - 1]! + 1),
    ).toBeTrue();
    expect(sequences).toContain(10_001);
    expect(sequences).toContain(10_051);

    await hook.unmount();
  });
});

describe("boundBrowserSessionEventWindow", () => {
  test("defensively replaces a multi-megabyte legacy event before rendering", () => {
    const legacy = event(1, "agent.toolCall.output", {
      id: "call-1",
      output: `HEAD-${"x".repeat(3 * 1024 * 1024)}-TAIL`,
    });
    const window = boundBrowserSessionEventWindow([legacy]);
    const retained = window.events[0]!;
    const payload = retained.payload as Record<string, unknown>;
    const truncation = payload.truncation as Record<string, unknown>;

    expect(window.truncated).toBeFalse();
    expect(window.bytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES);
    expect(payload.id).toBe("call-1");
    expect(truncation.surface).toBe("browser_legacy_guard");
    expect(truncation.fullEvidence).toEqual({
      available: false,
      reason: "not_retained",
    });
    expect(JSON.stringify(retained)).toContain("HEAD-");
    expect(JSON.stringify(retained)).toContain("-TAIL");
  });

  test("canonically bounds oversized multibyte envelope fields before rendering", () => {
    const legacy = {
      ...event(7, "agent.toolCall.output", {
        id: "call-envelope",
        output: "ok",
      }),
      type: `bad\r\ntype-${"界".repeat(100_000)}`,
      clientEventId: "🙂".repeat(100_000),
      duplicateReason: "界".repeat(100_000),
    } as SessionEvent;

    const window = boundBrowserSessionEventWindow([legacy]);
    const retained = window.events[0]!;
    expect(retained.type).toBe("session.event.envelope_omitted");
    expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
    );
    expect(String(retained.clientEventId)).toEndWith("…[truncated]");
    expect(String(retained.duplicateReason)).toEndWith("…[truncated]");
  });

  test("replaces an unserializable legacy payload with explicit bounded non-retention", () => {
    const circular: Record<string, unknown> = { id: "call-circular" };
    circular.self = circular;
    const legacy = event(8, "agent.toolCall.output", circular);

    const window = boundBrowserSessionEventWindow([legacy]);
    const retained = window.events[0]!;
    const payload = retained.payload as Record<string, unknown>;
    const truncation = payload.truncation as Record<string, unknown>;

    expect(window.bytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES);
    expect(payload.id).toBe("call-circular");
    expect(truncation.reason).toBe("event_not_serializable");
    expect(truncation.originalBytes).toBeNull();
    expect(truncation.omittedBytes).toBeNull();
    expect(truncation.estimatedOriginalTokens).toBeNull();
    expect(truncation.deliveredBytes).toBe(
      new TextEncoder().encode(JSON.stringify(retained)).byteLength,
    );
    expect(truncation.fullEvidence).toEqual({
      available: false,
      reason: "not_retained",
    });
  });

  test("preserves compact cursor progress when a legacy compact event is oversized", () => {
    const legacy = event(9, "agent.message.delta", {
      coalescedUntil: 40_000,
      coalescedCount: 39_992,
      text: `HEAD-${"界".repeat(2 * 1024 * 1024)}-TAIL`,
    });

    const window = boundBrowserSessionEventWindow([legacy]);
    const retained = window.events[0]!;
    const payload = retained.payload as Record<string, unknown>;

    expect(payload.coalescedUntil).toBe(40_000);
    expect(payload.coalescedCount).toBe(39_992);
    expect(window.bytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES);
  });

  test("retains the newest exact byte-bounded suffix independently of the count cap", () => {
    const events = Array.from({ length: 3_000 }, (_, index) =>
      event(index + 1, "agent.message.completed", { text: "x".repeat(4_000) }),
    );
    const window = boundBrowserSessionEventWindow(events);

    expect(window.truncated).toBeTrue();
    expect(window.events.length).toBeLessThan(events.length);
    expect(window.events.at(-1)?.sequence).toBe(3_000);
    expect(window.events[0]!.sequence).toBe(3_001 - window.events.length);
    expect(window.bytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_MAX_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(window.events)).byteLength).toBe(window.bytes);
  });

  test("retains the oldest exact byte-bounded prefix for backward paging", () => {
    const events = Array.from({ length: 3_000 }, (_, index) =>
      event(index + 1, "agent.message.completed", { text: "x".repeat(4_000) }),
    );
    const window = boundBrowserSessionEventWindow(events, {
      direction: "oldest",
    });

    expect(window.truncated).toBeTrue();
    expect(window.events.length).toBeLessThan(events.length);
    expect(window.events[0]?.sequence).toBe(1);
    expect(window.events.at(-1)?.sequence).toBe(window.events.length);
    expect(window.bytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_MAX_BYTES);
  });
});
