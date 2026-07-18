import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { actRun, registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import {
  SESSION_EVENT_BROWSER_MAX_BYTES,
  SESSION_EVENT_BROWSER_MAX_COUNT,
  SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
  boundBrowserSessionEventWindow,
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
        const result = useSessionEvents(props.sessionId, { client, workspaceId: WORKSPACE_ID });
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
    expect(hook.result.current.events).toHaveLength(1000);
    expect(hook.result.current.events[0]?.sequence).toBe(39_001);
    expect(hook.result.current.hasOlder).toBe(true);
    expect(listCalls).toEqual([{ before: Number.MAX_SAFE_INTEGER, limit: 1000, compact: true }]);

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
    const { client } = scriptedClient({ store: [], streamEvents: streamed });
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
    expect(payload.preview).toContain("browser rendering boundary");
    expect(truncation.surface).toBe("browser_legacy_guard");
    expect(truncation.fullEvidence).toEqual({ available: false, reason: "not_retained" });
    expect(JSON.stringify(retained)).not.toContain("HEAD-");
  });

  test("retains the newest exact byte-bounded suffix independently of the count cap", () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      event(index + 1, "agent.message.completed", { text: "x".repeat(60_000) }),
    );
    const window = boundBrowserSessionEventWindow(events);

    expect(window.truncated).toBeTrue();
    expect(window.events.length).toBeLessThan(events.length);
    expect(window.events.at(-1)?.sequence).toBe(200);
    expect(window.events[0]!.sequence).toBe(201 - window.events.length);
    expect(window.bytes).toBeLessThanOrEqual(SESSION_EVENT_BROWSER_MAX_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(window.events)).byteLength).toBe(window.bytes);
  });
});
