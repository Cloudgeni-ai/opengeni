import { describe, expect, jest, test } from "bun:test";
import {
  SESSION_EVENT_STEP_TYPES,
  type SessionEvent,
  type SessionEventListOptions,
} from "@opengeni/sdk";
import { actRun, flush, registerDom, renderHook } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import {
  SESSION_TURN_LIVE_STEP_TAIL,
  SESSION_TURN_STEP_PAGE_SIZE,
  activeConversationTurn,
  conversationTurnBounds,
  isConversationHistoryEvent,
  useSessionEvents,
} from "../src/hooks/use-session-events";
import {
  buildTimeline,
  groupTimeline,
  type TimelineItem,
  type TurnStepsItem,
} from "../src/timeline";
import { TurnStepsAction, TurnStepsLoader } from "../src/timeline/turn-steps";
import { isPreparingWork, readableWorkHasDetails } from "../src/timeline/work-presentation";
import { createOpenGeniText } from "../src/messages/runtime";

registerDom();

const t = createOpenGeniText();
const STEP_TYPES = new Set<string>(SESSION_EVENT_STEP_TYPES);
// Tests that page through thousands of steps take seconds on a busy machine.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

function at(sequence: number, type: SessionEvent["type"], payload: unknown, turnId: string | null) {
  return {
    id: `evt-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(1_750_000_000_000 + sequence * 1000).toISOString(),
    clientEventId: null,
    turnId,
  } satisfies SessionEvent;
}

/** A user prompt and one turn with `steps` tool calls (two events each). */
function longTurn(input: {
  start: number;
  turnId: string;
  steps: number;
  settled?: boolean;
  presentedAt?: number;
}): SessionEvent[] {
  const { start, turnId } = input;
  const events: SessionEvent[] = [
    at(
      start,
      "user.message",
      { text: `question ${turnId}`, routing: "accepted_for_execution" },
      null,
    ),
    at(start + 1, "turn.started", { turnId }, turnId),
  ];
  let sequence = start + 2;
  for (let index = 0; index < input.steps; index += 1) {
    const name = index === input.presentedAt ? "sandbox_file_publish" : "exec_command";
    const id = `${turnId}-${name === "exec_command" ? "call" : "publish"}-${index}`;
    events.push(
      at(
        sequence,
        "agent.toolCall.created",
        { id, name, arguments: { cmd: `echo ${index}` } },
        turnId,
      ),
    );
    events.push(
      at(
        sequence + 1,
        "agent.toolCall.output",
        {
          id,
          output: name === "exec_command" ? `output ${index}` : { artifactId: "a".repeat(32) },
        },
        turnId,
      ),
    );
    sequence += 2;
  }
  if (input.settled !== false) {
    events.push(at(sequence, "agent.message.completed", { text: `answer ${turnId}` }, turnId));
    events.push(at(sequence + 1, "turn.completed", { turnId }, turnId));
  }
  return events;
}

/** The server's filters: type include/exclude, presented calls, bounds, direction. */
function serverRead(store: readonly SessionEvent[], options: SessionEventListOptions = {}) {
  const after = options.after ?? 0;
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const limit = options.limit ?? 500;
  const include = options.includeTypes ? new Set<string>(options.includeTypes) : null;
  const exclude = new Set<string>(options.excludeTypes ?? []);
  const rows = store.filter((event) => {
    if (event.sequence <= after || event.sequence >= before) return false;
    if (include && !include.has(event.type)) return false;
    if (!exclude.has(event.type)) return true;
    const retains =
      options.presentedToolCalls === "include" && exclude.has("agent.toolCall.created");
    // Turnless rows (PTY output) belong to no turn's step read.
    if (retains && !event.turnId) return true;
    const name = (event.payload as { name?: unknown }).name;
    return (
      options.presentedToolCalls === "include" &&
      event.type === "agent.toolCall.created" &&
      name === "sandbox_file_publish"
    );
  });
  const page =
    options.direction === "before" ||
    (options.before !== undefined && options.direction !== "after")
      ? rows.slice(-limit)
      : rows.slice(0, limit);
  return { events: page, hasMore: rows.length > page.length };
}

function historyClient(input: {
  store: () => readonly SessionEvent[];
  live?: () => readonly SessionEvent[];
  head?: () => { lastSequence: number; activeTurnId: string | null };
  withPages?: boolean;
  failSteps?: () => boolean;
  /** Milliseconds before a page read answers. */
  pageDelay?: (options: SessionEventListOptions) => number;
  /** A page read waits for this, when given. */
  pageGate?: (options: SessionEventListOptions) => Promise<void> | undefined;
  /** Pause the live stream after this many events until `liveGate` resolves. */
  liveGate?: { after: number; open: Promise<void> };
}) {
  const reads: SessionEventListOptions[] = [];
  const streamCalls: number[] = [];
  let headReads = 0;
  const client = fakeClient({
    getSession: async () => {
      headReads += 1;
      const store = input.store();
      return (input.head?.() ?? {
        lastSequence: store[store.length - 1]?.sequence ?? 0,
        activeTurnId: null,
      }) as never;
    },
    listEvents: async (_workspaceId, _sessionId, options = {}) => {
      reads.push(options);
      if (options.includeTypes && input.failSteps?.()) throw new Error("offline");
      return serverRead(input.store(), options).events;
    },
    ...(input.withPages
      ? {
          listEventPage: async (
            _workspaceId: string,
            _sessionId: string,
            options: SessionEventListOptions = {},
          ) => {
            reads.push(options);
            const delay = input.pageDelay?.(options) ?? 0;
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            await input.pageGate?.(options);
            return serverRead(input.store(), options) as never;
          },
        }
      : {}),
    streamEvents: (_workspaceId, _sessionId, options = {}) => {
      const after = options.after ?? 0;
      streamCalls.push(after);
      return (async function* () {
        options.onOpen?.();
        let yielded = 0;
        for (const item of input.live?.() ?? []) {
          if (yielded === input.liveGate?.after) await input.liveGate.open;
          if (options.signal?.aborted) return;
          yielded += 1;
          if (item.sequence > after) yield item;
        }
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) return resolve();
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })();
    },
  });
  return { client, reads, streamCalls, headReads: () => headReads };
}

function stepMarkers(timeline: readonly TimelineItem[]): TurnStepsItem[] {
  return timeline.filter((item): item is TurnStepsItem => item.kind === "turn-steps");
}

function stepEvents(events: readonly SessionEvent[]) {
  return events.filter((event) => STEP_TYPES.has(event.type) && !isPresentedStep(event));
}

function isPresentedStep(event: SessionEvent) {
  const id = (event.payload as { id?: unknown }).id;
  return typeof id === "string" && id.includes("-publish-");
}

async function settle(ms = 30) {
  await flush(ms);
  await flush(ms);
}

describe("conversation-first session history", () => {
  test("the first load reads only the conversation and offers each turn's steps", async () => {
    const store = [
      ...longTurn({ start: 1, turnId: "T1", steps: 1000, presentedAt: 7 }),
      ...longTurn({ start: 3000, turnId: "T2", steps: 3 }),
    ];
    const { client, reads } = historyClient({ store: () => store });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      // One read, no steps: 2,006 durable events become 9 conversation rows
      // plus the presented publish call and its result.
      expect(reads).toHaveLength(2);
      expect(reads[0]).toMatchObject({
        excludeTypes: [...SESSION_EVENT_STEP_TYPES],
        presentedToolCalls: "include",
        before: Number.MAX_SAFE_INTEGER,
      });
      // The second read is the presented tool's result, after its call.
      expect(reads[1]).toMatchObject({ includeTypes: ["agent.toolCall.output"], after: 17 });
      const events = hook.result.current.events;
      expect(stepEvents(events)).toEqual([]);
      expect(events.map((event) => event.sequence)).toEqual([
        1, 2, 17, 18, 2003, 2004, 3000, 3001, 3008, 3009,
      ]);
      const markers = stepMarkers(hook.result.current.timeline);
      expect(markers.map((marker) => [marker.turnId, marker.state])).toEqual([
        ["T1", "idle"],
        ["T2", "idle"],
      ]);
    } finally {
      await hook.unmount();
    }
  });

  test("opening a turn reads its newest steps, then earlier pages on request", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 300 });
    const { client, reads } = historyClient({ store: () => store, withPages: true });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      reads.length = 0;
      await actRun(() => stepMarkers(hook.result.current.timeline)[0]!.load());
      await settle();
      expect(reads).toEqual([
        {
          includeTypes: [...SESSION_EVENT_STEP_TYPES],
          after: 1,
          // Bounded by the turn's settlement.
          before: 605,
          direction: "before",
          limit: SESSION_TURN_STEP_PAGE_SIZE,
          compact: true,
          payloadMode: "full",
        },
      ]);
      let steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(SESSION_TURN_STEP_PAGE_SIZE);
      expect(steps[0]!.sequence).toBe(403);
      expect(steps.at(-1)!.sequence).toBe(602);
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("partial");

      await actRun(() => stepMarkers(hook.result.current.timeline)[0]!.load());
      await settle();
      expect(reads[1]).toMatchObject({ after: 1, before: 403, direction: "before" });
      steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(400);
      expect(steps[0]!.sequence).toBe(203);

      await actRun(() => stepMarkers(hook.result.current.timeline)[0]!.load());
      await settle();
      expect(stepEvents(hook.result.current.events)).toHaveLength(600);
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("complete");
      // A complete turn does not read again.
      await actRun(() => stepMarkers(hook.result.current.timeline)[0]!.load());
      await settle();
      expect(reads).toHaveLength(3);
    } finally {
      await hook.unmount();
    }
  });

  test("a failed step read shows an error and retries", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 5 });
    let fail = true;
    const { client } = historyClient({ store: () => store, failSteps: () => fail });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      await actRun(() => stepMarkers(hook.result.current.timeline)[0]!.load());
      await settle();
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("error");
      fail = false;
      await actRun(() => stepMarkers(hook.result.current.timeline)[0]!.load());
      await settle();
      expect(stepEvents(hook.result.current.events)).toHaveLength(10);
    } finally {
      await hook.unmount();
    }
  });

  test("live steps never evict the conversation and a collapsed turn keeps a short tail", async () => {
    const history = longTurn({ start: 1, turnId: "T0", steps: 2 });
    // A working turn that streams 3,000 large steps after the first load.
    const working = [
      at(100, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
      at(101, "turn.started", { turnId: "T1" }, "T1"),
    ];
    const big = "x".repeat(8 * 1024);
    const live: SessionEvent[] = [];
    for (let index = 0; index < 1500; index += 1) {
      const id = `T1-live-${index}`;
      live.push(
        at(
          102 + index * 2,
          "agent.toolCall.created",
          { id, name: "exec_command", arguments: {} },
          "T1",
        ),
      );
      live.push(at(103 + index * 2, "agent.toolCall.output", { id, output: big }, "T1"));
    }
    let store: SessionEvent[] = [...history, ...working];
    const { client } = historyClient({
      store: () => store,
      live: () => live,
      head: () => ({ lastSequence: 101, activeTurnId: "T1" }),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      store = [...store, ...live];
      const events = hook.result.current.events;
      // Every conversation event survives 24 MB of live steps.
      expect(
        events.filter((event) => !STEP_TYPES.has(event.type)).map((event) => event.sequence),
      ).toEqual([
        ...history.filter((event) => !STEP_TYPES.has(event.type)).map((event) => event.sequence),
        100,
        101,
      ]);
      const steps = stepEvents(events);
      expect(steps.length).toBeLessThanOrEqual(SESSION_TURN_LIVE_STEP_TAIL);
      expect(steps.at(-1)!.sequence).toBe(3101);
      const marker = stepMarkers(hook.result.current.timeline).find(
        (item) => item.turnId === "T1",
      )!;
      expect(marker.state).toBe("partial");
    } finally {
      await hook.unmount();
    }
  });

  test("an opened live turn keeps every streamed step", async () => {
    const working = [
      at(1, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
      at(2, "turn.started", { turnId: "T1" }, "T1"),
    ];
    const live: SessionEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let index = 0; index < 400; index += 1) {
      const id = `T1-live-${index}`;
      live.push(
        at(
          3 + index * 2,
          "agent.toolCall.created",
          { id, name: "exec_command", arguments: {} },
          "T1",
        ),
      );
      live.push(at(4 + index * 2, "agent.toolCall.output", { id, output: "ok" }, "T1"));
    }
    const { client } = historyClient({
      store: () => working,
      live: () => live,
      liveGate: { after: 2, open: gate },
      head: () => ({ lastSequence: 2, activeTurnId: "T1" }),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    let unretain: (() => void) | undefined;
    try {
      await settle();
      // The reader opens the turn after its first live step.
      expect(stepEvents(hook.result.current.events)).toHaveLength(2);
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      release();
      await settle(60);
      expect(stepEvents(hook.result.current.events)).toHaveLength(800);
    } finally {
      unretain?.();
      await hook.unmount();
    }
  });

  test("opening a working session catches up the conversation and reads only the latest steps", async () => {
    // 4,000 steps, one progress message, then 49 streamed reasoning deltas.
    const store = [
      ...longTurn({ start: 1, turnId: "T1", steps: 2000, settled: false }),
      at(4003, "agent.message.delta", { text: "progress" }, "T1"),
    ];
    for (let sequence = 4004; sequence <= 4052; sequence += 1) {
      store.push(at(sequence, "agent.reasoning.delta", { text: "." }, "T1"));
    }
    const { client, reads, streamCalls, headReads } = historyClient({
      store: () => store,
      head: () => ({ lastSequence: 4052, activeTurnId: "T1" }),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      expect(headReads()).toBe(1);
      // Conversation window, conversation catch-up after it, then the
      // working turn's latest steps up to the head. No full step replay.
      expect(reads.map((read) => read.includeTypes ?? read.excludeTypes)).toEqual([
        [...SESSION_EVENT_STEP_TYPES],
        [...SESSION_EVENT_STEP_TYPES],
        [...SESSION_EVENT_STEP_TYPES],
      ]);
      expect(reads[1]).toMatchObject({ after: 4003, before: 4053 });
      expect(reads[2]).toMatchObject({ includeTypes: [...SESSION_EVENT_STEP_TYPES], before: 4053 });
      expect(streamCalls).toEqual([4052]);
      const steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(SESSION_TURN_STEP_PAGE_SIZE);
      expect(steps.at(-1)!.sequence).toBe(4052);
    } finally {
      await hook.unmount();
    }
  });

  test("returning from a hidden tab keeps an open working turn's steps and replays the gap", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    // A working turn with 100 calls already written when the chat opens.
    const store = longTurn({ start: 1, turnId: "T1", steps: 100, settled: false });
    const live: SessionEvent[] = [];
    const { client, streamCalls } = historyClient({
      store: () => store,
      live: () => live,
      withPages: true,
      head: () => ({ lastSequence: store.at(-1)!.sequence, activeTurnId: "T1" }),
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    let unretain: (() => void) | undefined;
    try {
      await settle(60);
      // Joining the working turn read its latest steps; the reader opens it.
      expect(stepEvents(hook.result.current.events)).toHaveLength(200);
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();

      jest.useFakeTimers();
      visibility = "hidden";
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
      await actRun(() => jest.advanceTimersByTime(2_000));
      expect(hook.result.current.connectionState).toBe("idle");
      // Three more calls while away: a short gap the stream replays.
      for (let index = 0; index < 3; index += 1) {
        const sequence = 203 + index * 2;
        const id = `T1-late-${index}`;
        const created = at(sequence, "agent.toolCall.created", { id, name: "exec_command" }, "T1");
        const output = at(sequence + 1, "agent.toolCall.output", { id, output: "ok" }, "T1");
        store.push(created, output);
        live.push(created, output);
      }
      visibility = "visible";
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
      await actRun(async () => {
        for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
        jest.advanceTimersByTime(20);
        for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
      });
      jest.useRealTimers();
      await settle(60);
      expect(streamCalls.at(-1)).toBe(202);
      const steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(206);
      expect(steps.at(-1)!.sequence).toBe(208);
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("complete");
    } finally {
      jest.useRealTimers();
      unretain?.();
      await hook.unmount();
      if (visibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      } else {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
    }
  });

  test("an open working turn keeps its steps on screen while a long-gap return re-reads them", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const store = longTurn({ start: 1, turnId: "T1", steps: 100, settled: false });
    const live: SessionEvent[] = [];
    let gate: Promise<void> | undefined;
    let openGate = () => {};
    const { client } = historyClient({
      store: () => store,
      live: () => live,
      withPages: true,
      head: () => ({ lastSequence: store.at(-1)!.sequence, activeTurnId: "T1" }),
      pageGate: (options) =>
        options.includeTypes && options.includeTypes.length > 1 ? gate : undefined,
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    let unretain: (() => void) | undefined;
    try {
      await settle(60);
      expect(stepEvents(hook.result.current.events)).toHaveLength(200);
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();

      jest.useFakeTimers();
      visibility = "hidden";
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
      await actRun(() => jest.advanceTimersByTime(2_000));
      // Twenty calls while away: too long to replay, so the tail is re-read.
      for (let index = 0; index < 20; index += 1) {
        const sequence = 203 + index * 2;
        const id = `T1-late-${index}`;
        store.push(
          at(sequence, "agent.toolCall.created", { id, name: "exec_command" }, "T1"),
          at(sequence + 1, "agent.toolCall.output", { id, output: "ok" }, "T1"),
        );
      }
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      visibility = "visible";
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
      await actRun(async () => {
        for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
        jest.advanceTimersByTime(20);
        for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
      });
      jest.useRealTimers();
      await settle(30);
      // The re-read is in flight: the open row still shows what it had.
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("loading");
      expect(stepEvents(hook.result.current.events)).toHaveLength(200);

      openGate();
      await settle(60);
      const steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(SESSION_TURN_STEP_PAGE_SIZE);
      expect(steps.at(-1)!.sequence).toBe(242);
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("partial");
    } finally {
      jest.useRealTimers();
      openGate();
      unretain?.();
      await hook.unmount();
      if (visibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      } else {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
    }
  });

  test(
    "a queued turn's row ahead of a running turn does not cut the running turn short",
    async () => {
      // T2 was queued while T1 ran; its turn.queued row is the window's oldest.
      const store = longTurn({ start: 1, turnId: "T0", steps: 10 });
      store.push(
        at(100, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
        at(101, "turn.started", { turnId: "T1" }, "T1"),
      );
      let sequence = 102;
      const call = (index: number) => {
        const id = `T1-call-${index}`;
        store.push(at(sequence, "agent.model.request", {}, "T1"));
        store.push(at(sequence + 1, "agent.toolCall.created", { id, name: "exec_command" }, "T1"));
        store.push(at(sequence + 2, "agent.toolCall.output", { id, output: "ok" }, "T1"));
        sequence += 3;
      };
      for (let index = 0; index < 2500; index += 1) call(index);
      const queued = sequence;
      store.push(at(sequence++, "turn.queued", { turnId: "T2" }, "T2"));
      for (let index = 2500; index < 4497; index += 1) call(index);
      store.push(at(sequence, "agent.message.completed", { text: "done" }, "T1"));
      store.push(at(sequence + 1, "turn.completed", { turnId: "T1" }, "T1"));
      const { client } = historyClient({ store: () => store, withPages: true });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      const marker = () =>
        stepMarkers(hook.result.current.timeline).find((item) => item.turnId === "T1")!;
      try {
        await settle();
        expect(hook.result.current.events[0]!.sequence).toBe(queued);
        for (let page = 0; page < 60 && marker().state !== "complete"; page += 1) {
          await actRun(() => marker().load());
          await settle(5);
        }
        expect(marker().state).toBe("complete");
        const steps = stepEvents(hook.result.current.events);
        expect(steps).toHaveLength(4497 * 2);
        expect(steps[0]!.sequence).toBe(103);
      } finally {
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test(
    "a turn whose start is before the window still loads every step",
    async () => {
      // T0's steps come first; T1 then has a conversation row per call, more
      // than the first window reads, so the window starts in the middle of T1.
      const store = longTurn({ start: 1, turnId: "T0", steps: 300 });
      store.push(
        at(700, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
        at(701, "turn.started", { turnId: "T1" }, "T1"),
      );
      let sequence = 702;
      for (let index = 0; index < 2500; index += 1) {
        const id = `T1-call-${index}`;
        store.push(at(sequence, "agent.model.request", {}, "T1"));
        store.push(at(sequence + 1, "agent.toolCall.created", { id, name: "exec_command" }, "T1"));
        store.push(at(sequence + 2, "agent.toolCall.output", { id, output: "ok" }, "T1"));
        sequence += 3;
      }
      store.push(at(sequence, "agent.message.completed", { text: "done" }, "T1"));
      store.push(at(sequence + 1, "turn.completed", { turnId: "T1" }, "T1"));
      const { client, reads } = historyClient({ store: () => store, withPages: true });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle();
        expect(hook.result.current.events.some((event) => event.type === "turn.started")).toBe(
          false,
        );
        reads.length = 0;
        for (let page = 0; page < 60; page += 1) {
          const marker = stepMarkers(hook.result.current.timeline).find(
            (item) => item.turnId === "T1",
          )!;
          if (marker.state === "complete") break;
          await actRun(() => marker.load());
          await settle(5);
        }
        const marker = stepMarkers(hook.result.current.timeline).find(
          (item) => item.turnId === "T1",
        );
        expect(marker?.state).toBe("complete");
        const steps = stepEvents(hook.result.current.events);
        expect(steps).toHaveLength(5000);
        expect(steps.every((event) => event.turnId === "T1")).toBe(true);
        expect(steps[0]!.sequence).toBe(703);
        // Each page continued below the last one, and reading stopped at T0.
        const bounds = reads.map((read) => read.before!);
        expect(bounds).toEqual([...bounds].sort((left, right) => right - left));
        expect(new Set(bounds).size).toBe(bounds.length);
      } finally {
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  for (const turnless of ["session.queue.changed", "terminal.pty.output.delta"] as const) {
    test(
      `a turn starting before the window loads every step past turnless ${turnless} rows`,
      async () => {
        // Each call of T1 has a turnless row (a queued prompt's queue change, or
        // interactive terminal output) ahead of it, so the window's oldest
        // event has no turn.
        const store = longTurn({ start: 1, turnId: "T0", steps: 300 });
        store.push(
          at(700, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
          at(701, "turn.started", { turnId: "T1" }, "T1"),
        );
        let sequence = 702;
        for (let index = 0; index < 2500; index += 1) {
          const id = `T1-call-${index}`;
          store.push(at(sequence, turnless, { data: `row ${index}` }, null));
          store.push(at(sequence + 1, "agent.model.request", {}, "T1"));
          store.push(
            at(sequence + 2, "agent.toolCall.created", { id, name: "exec_command" }, "T1"),
          );
          store.push(at(sequence + 3, "agent.toolCall.output", { id, output: "ok" }, "T1"));
          sequence += 4;
        }
        store.push(at(sequence, "agent.message.completed", { text: "done" }, "T1"));
        store.push(at(sequence + 1, "turn.completed", { turnId: "T1" }, "T1"));
        const { client } = historyClient({ store: () => store, withPages: true });
        const hook = await renderHook(
          () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
          undefined,
        );
        try {
          await settle();
          const window = hook.result.current.events;
          expect(window.some((event) => event.type === "turn.started")).toBe(false);
          expect(window[0]!.turnId).toBeNull();
          // Turnless rows are history too: PTY output shows after a reload.
          expect(window.filter((event) => event.type === turnless).length).toBeGreaterThan(100);
          for (let page = 0; page < 60; page += 1) {
            const marker = stepMarkers(hook.result.current.timeline).find(
              (item) => item.turnId === "T1",
            )!;
            if (marker.state === "complete") break;
            await actRun(() => marker.load());
            await settle(5);
          }
          expect(
            stepMarkers(hook.result.current.timeline).find((item) => item.turnId === "T1")?.state,
          ).toBe("complete");
          const steps = stepEvents(hook.result.current.events).filter((event) => event.turnId);
          expect(steps).toHaveLength(5000);
          expect(steps.every((event) => event.turnId === "T1")).toBe(true);
          expect(steps[0]!.sequence).toBe(704);
        } finally {
          await hook.unmount();
        }
      },
      HEAVY_TEST_TIMEOUT_MS,
    );
  }

  test(
    "a turn read to a guessed lower bound offers earlier steps once its start loads",
    async () => {
      // A late row of the previous turn sits inside T1 and is the window's
      // oldest event (the first read and its boundary page hold 2,000 rows): the
      // first reads stop at it, above T1's earliest steps.
      const store = longTurn({ start: 1, turnId: "T0", steps: 10 });
      store.push(
        at(100, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
        at(101, "turn.started", { turnId: "T1" }, "T1"),
      );
      let sequence = 102;
      const call = (index: number) => {
        const id = `T1-call-${index}`;
        store.push(at(sequence, "agent.model.request", {}, "T1"));
        store.push(at(sequence + 1, "agent.toolCall.created", { id, name: "exec_command" }, "T1"));
        store.push(at(sequence + 2, "agent.toolCall.output", { id, output: "ok" }, "T1"));
        sequence += 3;
      };
      for (let index = 0; index < 2500; index += 1) call(index);
      const late = sequence;
      store.push(at(sequence++, "agent.model.usage", {}, "T0"));
      for (let index = 2500; index < 4497; index += 1) call(index);
      store.push(at(sequence, "agent.message.completed", { text: "done" }, "T1"));
      store.push(at(sequence + 1, "turn.completed", { turnId: "T1" }, "T1"));
      const { client } = historyClient({ store: () => store, withPages: true });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      const marker = () =>
        stepMarkers(hook.result.current.timeline).find((item) => item.turnId === "T1")!;
      const loadAll = async () => {
        for (let page = 0; page < 60 && marker().state !== "complete"; page += 1) {
          await actRun(() => marker().load());
          await settle(5);
        }
      };
      try {
        await settle();
        expect(hook.result.current.events[0]!.sequence).toBe(late);
        await loadAll();
        expect(marker().state).toBe("complete");
        expect(stepEvents(hook.result.current.events)).toHaveLength(1997 * 2);

        for (let page = 0; page < 10; page += 1) {
          if (hook.result.current.events.some((event) => event.type === "turn.started")) break;
          await actRun(() => {
            hook.result.current.loadOlder();
          });
          await settle(5);
        }
        expect(hook.result.current.events.some((event) => event.type === "turn.started")).toBe(
          true,
        );
        // The turn's start is now known: the steps below the old bound are not.
        expect(marker().state).toBe("partial");
        await loadAll();
        expect(marker().state).toBe("complete");
        const steps = stepEvents(hook.result.current.events).filter(
          (event) => event.turnId === "T1",
        );
        expect(steps).toHaveLength(4497 * 2);
        expect(steps[0]!.sequence).toBe(103);
      } finally {
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("presented results are read at most eight at a time", async () => {
    const store: SessionEvent[] = [
      at(1, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
      at(2, "turn.started", { turnId: "T1" }, "T1"),
    ];
    let sequence = 3;
    for (let index = 0; index < 120; index += 1) {
      const id = `T1-publish-${index}`;
      store.push(
        at(sequence++, "agent.toolCall.created", { id, name: "sandbox_file_publish" }, "T1"),
      );
      store.push(at(sequence++, "agent.toolCall.output", { id, output: {} }, "T1"));
    }
    store.push(at(sequence, "turn.completed", { turnId: "T1" }, "T1"));
    let inFlight = 0;
    let peak = 0;
    let presentedReads = 0;
    const isPresentedRead = (options: SessionEventListOptions) =>
      options.includeTypes?.length === 1 && options.includeTypes[0] === "agent.toolCall.output";
    const { client } = historyClient({
      store: () => store,
      withPages: true,
      pageDelay: (options) => {
        if (!isPresentedRead(options)) return 0;
        presentedReads += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Some reads are slow while others settle: settled reads must not
        // start more than the free slots.
        const delay = presentedReads % 4 === 1 ? 80 : 3;
        setTimeout(() => {
          inFlight -= 1;
        }, delay);
        return delay;
      },
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    const outputs = () =>
      hook.result.current.events.filter((event) => event.type === "agent.toolCall.output");
    try {
      for (let round = 0; round < 60 && outputs().length < 120; round += 1) await settle(20);
      expect(outputs()).toHaveLength(120);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
    } finally {
      await hook.unmount();
    }
  });

  test("presented results far behind parallel calls are found, beyond the first pass", async () => {
    // Twelve publishes and eight other calls in parallel: every output lands
    // after all twenty calls, the publishes' last.
    const store: SessionEvent[] = [
      at(1, "user.message", { text: "go", routing: "accepted_for_execution" }, null),
      at(2, "turn.started", { turnId: "T1" }, "T1"),
    ];
    const calls: Array<{ id: string; name: string }> = [];
    for (let index = 0; index < 20; index += 1) {
      const name = index < 12 ? "sandbox_file_publish" : "exec_command";
      calls.push({ id: `T1-${name === "exec_command" ? "call" : "publish"}-${index}`, name });
    }
    let sequence = 3;
    for (const call of calls) {
      store.push(at(sequence++, "agent.toolCall.created", { id: call.id, name: call.name }, "T1"));
    }
    for (const call of [...calls].reverse()) {
      store.push(at(sequence++, "agent.toolCall.output", { id: call.id, output: "ok" }, "T1"));
    }
    for (let index = 0; index < 30; index += 1) {
      const id = `T1-call-later-${index}`;
      store.push(at(sequence++, "agent.toolCall.created", { id, name: "exec_command" }, "T1"));
      store.push(at(sequence++, "agent.toolCall.output", { id, output: "ok" }, "T1"));
    }
    store.push(at(sequence, "turn.completed", { turnId: "T1" }, "T1"));
    const { client } = historyClient({ store: () => store, withPages: true });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      const outputs = hook.result.current.events.filter(
        (event) => event.type === "agent.toolCall.output",
      );
      expect(outputs.map((event) => (event.payload as { id: string }).id).sort()).toEqual(
        calls
          .filter((call) => call.name === "sandbox_file_publish")
          .map((call) => call.id)
          .sort(),
      );
      expect(stepEvents(hook.result.current.events)).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("a turn started and stepping in one live batch is not offered earlier steps", async () => {
    const store = [at(1, "user.message", { text: "go", routing: "accepted_for_execution" }, null)];
    const live = [
      at(2, "turn.started", { turnId: "T1" }, "T1"),
      at(3, "agent.toolCall.created", { id: "c", name: "exec_command" }, "T1"),
      at(4, "agent.toolCall.output", { id: "c", output: "ok" }, "T1"),
    ];
    const { client, reads } = historyClient({ store: () => store, live: () => live });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      expect(stepEvents(hook.result.current.events)).toHaveLength(2);
      expect(stepMarkers(hook.result.current.timeline)[0]?.state).toBe("complete");
      expect(reads.filter((read) => read.includeTypes)).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("helpers classify steps, presented results and turn extents", () => {
    const presented = new Set(["pub"]);
    const created = (name: string) => at(5, "agent.toolCall.created", { id: "x", name }, "T");
    expect(isConversationHistoryEvent(created("exec_command"), presented)).toBe(false);
    expect(isConversationHistoryEvent(created("opengeni__sandbox_file_publish"), presented)).toBe(
      true,
    );
    expect(
      isConversationHistoryEvent(at(6, "agent.toolCall.output", { id: "pub" }, "T"), presented),
    ).toBe(true);
    expect(
      isConversationHistoryEvent(at(6, "agent.toolCall.output", { id: "x" }, "T"), presented),
    ).toBe(false);
    // Steps outside a turn are conversation: nothing could load them later.
    expect(isConversationHistoryEvent(at(7, "agent.reasoning.delta", {}, null), presented)).toBe(
      true,
    );

    const window = [
      at(1, "user.message", {}, null),
      at(2, "turn.started", {}, "T1"),
      at(9, "turn.completed", {}, "T1"),
      at(10, "turn.started", {}, "T2"),
      at(11, "agent.message.delta", {}, "T2"),
    ];
    const bounds = conversationTurnBounds(window);
    expect(bounds.get("T1")).toMatchObject({ first: 2, terminal: 9, hidden: true });
    expect(bounds.get("T2")).toMatchObject({ first: 10, terminal: null, hidden: false });
    expect(activeConversationTurn(window)).toBe("T2");
    expect(activeConversationTurn(window.slice(0, 3))).toBeNull();
  });
});

describe("turn steps projection", () => {
  const conversation = [
    at(1, "user.message", { text: "hi", routing: "accepted_for_execution" }, null),
    at(2, "turn.started", { turnId: "T1" }, "T1"),
    at(90, "agent.message.completed", { text: "done" }, "T1"),
    at(91, "turn.completed", { turnId: "T1" }, "T1"),
  ];
  const handle = { load: () => {}, retain: () => () => {} };

  test("a marker follows the turn start", () => {
    const timeline = buildTimeline(t, conversation, {
      turnSteps: new Map([["T1", { state: "idle", ...handle }]]),
    });
    const index = timeline.findIndex((item) => item.kind === "turn-steps");
    expect(index).toBeGreaterThan(-1);
    const marker = timeline[index] as TurnStepsItem;
    expect(marker).toMatchObject({ turnId: "T1", state: "idle" });
    const answer = timeline.findIndex((item) => item.kind === "agent-message");
    if (answer >= 0) expect(index).toBeLessThan(answer);
  });

  test("a turn whose steps are all unloaded still gets an openable work row", () => {
    const timeline = buildTimeline(t, conversation, {
      turnSteps: new Map([["T1", { state: "idle", ...handle }]]),
    });
    const groups = groupTimeline(t, timeline, { readableTurns: true });
    const work = groups.find((group) => group.kind === "activity" && group.work);
    if (work?.kind !== "activity") throw new Error("expected a work row");
    expect(work.work!.steps).toMatchObject({ turnId: "T1", state: "idle" });
    expect(readableWorkHasDetails(work as never, { startupDetails: false })).toBe(true);
    // Without readable turns the marker is a row inside the settled turn's fold.
    const legacy = groupTimeline(t, timeline);
    const fold = legacy.find((group) => group.kind === "turn");
    if (fold?.kind !== "turn") throw new Error("expected a settled turn fold");
    expect(fold.groups.map((group) => group.kind === "item" && group.item.kind)).toEqual([
      "turn-steps",
    ]);
  });

  test("an opened row loads once and keeps its steps; a partial row offers earlier steps", async () => {
    let loads = 0;
    let retained = 0;
    let released = 0;
    // Stable handles, as the hook provides per turn.
    const load = () => {
      loads += 1;
    };
    const retain = () => {
      retained += 1;
      return () => {
        released += 1;
      };
    };
    const steps = (state: TurnStepsItem["state"]): TurnStepsItem => ({
      kind: "turn-steps",
      id: "turn-steps-T1",
      turnId: "T1",
      occurredAt: new Date(0).toISOString(),
      state,
      load,
      retain,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    await actRun(() => root.render(<TurnStepsLoader steps={steps("idle")} />));
    expect(loads).toBe(1);
    expect(retained).toBe(1);
    await actRun(() => root.render(<TurnStepsLoader steps={steps("loading")} />));
    expect(container.querySelector('[data-og-turn-steps="loading"]')).not.toBeNull();
    await actRun(() => root.render(<TurnStepsLoader steps={steps("partial")} />));
    const earlier = container.querySelector("button")!;
    expect(earlier.textContent).toBe("Show earlier steps");
    await actRun(() => earlier.click());
    expect(loads).toBe(2);
    await actRun(() => root.render(<TurnStepsLoader steps={steps("complete")} />));
    expect(container.textContent).toBe("");
    await actRun(() => root.render(<TurnStepsAction steps={steps("idle")} />));
    expect(released).toBe(1);
    await actRun(() => container.querySelector("button")!.click());
    expect(loads).toBe(3);
    await actRun(() => root.unmount());
    expect(released).toBe(2);
    container.remove();
  });

  test("a working turn with unloaded steps is work, not preparation", () => {
    const phase = {
      kind: "startup-phase",
      id: "phase",
      status: "complete",
      occurredAt: new Date(0).toISOString(),
    };
    const group = (state: TurnStepsItem["state"] | null) =>
      ({
        kind: "activity",
        id: "work",
        items: [phase],
        work: {
          startedAt: new Date(0).toISOString(),
          details: [],
          ...(state ? { steps: { kind: "turn-steps", turnId: "T1", state, ...handle } } : {}),
        },
      }) as never;
    const options = { startupDetails: false, startupDismissed: false };
    expect(isPreparingWork(group(null), options)).toBe(true);
    expect(isPreparingWork(group("complete"), options)).toBe(true);
    for (const state of ["idle", "loading", "partial", "error"] as const) {
      expect(isPreparingWork(group(state), options)).toBe(false);
    }
  });

  test("a row that opens by itself waits for the reader before loading", async () => {
    let loads = 0;
    let retained = 0;
    const steps = (state: TurnStepsItem["state"]): TurnStepsItem => ({
      kind: "turn-steps",
      id: "turn-steps-T1",
      turnId: "T1",
      occurredAt: new Date(0).toISOString(),
      state,
      load: () => {
        loads += 1;
      },
      retain: () => {
        retained += 1;
        return () => {};
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    await actRun(() => root.render(<TurnStepsLoader steps={steps("idle")} autoLoad={false} />));
    expect(loads).toBe(0);
    // Open rows keep their (live) steps even before the reader asks.
    expect(retained).toBe(1);
    const show = container.querySelector("button")!;
    expect(show.textContent).toBe("Show steps");
    await actRun(() => show.click());
    expect(loads).toBe(1);
    expect(retained).toBe(1);
    await actRun(() => root.unmount());
    container.remove();
  });

  test("no marker without a step state", () => {
    expect(stepMarkers(buildTimeline(t, conversation))).toEqual([]);
  });
});
