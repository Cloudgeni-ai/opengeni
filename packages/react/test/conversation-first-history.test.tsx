import { describe, expect, test } from "bun:test";
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
import { readableWorkHasDetails } from "../src/timeline/work-presentation";
import { createOpenGeniText } from "../src/messages/runtime";

registerDom();

const t = createOpenGeniText();
const STEP_TYPES = new Set<string>(SESSION_EVENT_STEP_TYPES);

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
          listEventPage: async (_workspaceId: string, _sessionId: string, options = {}) => {
            reads.push(options);
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

  test("no marker without a step state", () => {
    expect(stepMarkers(buildTimeline(t, conversation))).toEqual([]);
  });
});
