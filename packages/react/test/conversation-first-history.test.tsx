import { describe, expect, jest, test } from "bun:test";
import {
  SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES,
  SESSION_EVENT_CONTENT_STEP_TYPES,
  SESSION_EVENT_STEP_TYPES,
  streamSessionEvents,
  type SessionEvent,
  type SessionEventListOptions,
  type SessionEventStreamTransport,
} from "@opengeni/sdk";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import {
  SESSION_TURN_LIVE_STEP_TAIL,
  SESSION_TURN_STEP_PAGE_SIZE,
  activeConversationTurn,
  conversationFilterMode,
  conversationTurnBounds,
  isConversationHistoryEvent,
  useSessionEvents,
} from "../src/hooks/use-session-events";
import { useSession } from "../src/hooks/use-session";
import { PAGE_WAKE_GAP_MS } from "../src/hooks/page-wake";
import { useTurnlessOutputGap } from "../src/hooks/turnless-output-gaps";
import { useSandboxTerminal } from "../src/hooks/use-sandbox-terminal";
import {
  buildTimeline,
  groupTimeline,
  type TimelineItem,
  type TurnStepsItem,
} from "../src/timeline";
import { TurnStepsAction, TurnStepsLoader } from "../src/timeline/turn-steps";
import {
  isPreparingWork,
  readableWorkDefaultOpen,
  readableWorkHasDetails,
} from "../src/timeline/work-presentation";
import { MessageTimeline } from "../src/components/message-timeline";
import { createOpenGeniText } from "../src/messages/runtime";

registerDom();

const t = createOpenGeniText();
const STEP_TYPES = new Set<string>(SESSION_EVENT_STEP_TYPES);
// A turn's step reads skip PTY output, which never belongs to a turn.
const TURN_STEP_READ_TYPES = SESSION_EVENT_STEP_TYPES.filter(
  (type) => type !== "terminal.pty.output.delta",
);
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

/**
 * A conversation row a turn can write per call that draws nothing (a
 * successful per-file download receipt), so a long turn's window can start
 * mid-turn.
 */
function receipt(sequence: number, turnId: string) {
  return at(
    sequence,
    "sandbox.operation.completed",
    { name: "file-resource-download", status: "completed" },
    turnId,
  );
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

/**
 * Which server answers: the current one (announces conversation filter 2 and
 * keeps the bookkeeping rows the conversation draws), one that applies
 * `presentedToolCalls` without announcing it (#5237), or an older one that
 * ignores `presentedToolCalls`.
 */
type ServerVersion = "current" | "presented" | "ignores" | "unfiltered";

const CONTENT_TYPES = new Set<string>(SESSION_EVENT_CONTENT_STEP_TYPES);

/** The bookkeeping rows a current server keeps in a conversation read. */
function keptBookkeeping(store: readonly SessionEvent[]): Set<string> {
  const kept = new Set<string>();
  const content = new Set<string>();
  for (const event of store) {
    if (event.turnId && CONTENT_TYPES.has(event.type)) content.add(event.turnId);
  }
  const started = new Set<string>();
  const responded = new Set<string>();
  for (const event of store) {
    const turnId = event.turnId;
    if (!turnId) continue;
    if (event.type === "turn.started") started.add(turnId);
    if (event.type !== "agent.model.request" && event.type !== "agent.model.usage") continue;
    if (!content.has(turnId)) {
      kept.add(event.id);
    } else if (
      event.type === "agent.model.request" &&
      started.has(turnId) &&
      !responded.has(turnId)
    ) {
      kept.add(event.id);
      const phase = (event.payload as { phase?: unknown }).phase;
      if (phase === "first_byte" || phase === "first_event") responded.add(turnId);
    }
  }
  return kept;
}

/** The server's filters: type include/exclude, presented calls, bounds, direction. */
function serverRead(
  store: readonly SessionEvent[],
  options: SessionEventListOptions = {},
  server: ServerVersion = "current",
) {
  const after = options.after ?? 0;
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const limit = options.limit ?? 500;
  // An "unfiltered" server (or proxy) drops every type filter.
  const filters = server !== "unfiltered";
  const include = filters && options.includeTypes ? new Set<string>(options.includeTypes) : null;
  const exclude = new Set<string>(filters ? (options.excludeTypes ?? []) : []);
  const presented = filters && server !== "ignores" && options.presentedToolCalls === "include";
  const keptRows =
    server === "current" && presented && exclude.has("agent.toolCall.created")
      ? keptBookkeeping(store)
      : null;
  const rows = store.filter((event) => {
    if (event.sequence <= after || event.sequence >= before) return false;
    if (include && !include.has(event.type)) return false;
    if (!exclude.has(event.type)) return true;
    // A #5237 server kept turnless rows (PTY output); the current one leaves
    // them to the sandbox dock.
    const retains = presented && server === "presented" && exclude.has("agent.toolCall.created");
    if (retains && !event.turnId) return true;
    if (keptRows?.has(event.id)) return true;
    const name = (event.payload as { name?: unknown }).name;
    return (
      presented &&
      exclude.has("agent.toolCall.created") &&
      event.type === "agent.toolCall.created" &&
      name === "sandbox_file_publish"
    );
  });
  const page =
    options.direction === "before" ||
    (options.before !== undefined && options.direction !== "after")
      ? rows.slice(-limit)
      : rows.slice(0, limit);
  return {
    events: page,
    hasMore: rows.length > page.length,
    conversationFilter: server === "current" && presented ? 2 : null,
  };
}

function historyClient(input: {
  store: () => readonly SessionEvent[];
  server?: () => ServerVersion;
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
  /** Serve the live stream with the SDK's own reconnecting stream instead. */
  sdkTransport?: SessionEventStreamTransport;
  /** A head read throws this, when given. */
  failHead?: () => Error | undefined;
}) {
  const reads: SessionEventListOptions[] = [];
  const streamCalls: number[] = [];
  let headReads = 0;
  const client = fakeClient({
    getSession: async () => {
      headReads += 1;
      const failure = input.failHead?.();
      if (failure) throw failure;
      const store = input.store();
      return (input.head?.() ?? {
        lastSequence: store[store.length - 1]?.sequence ?? 0,
        activeTurnId: null,
      }) as never;
    },
    listEvents: async (_workspaceId, _sessionId, options = {}) => {
      reads.push(options);
      if (options.includeTypes && input.failSteps?.()) throw new Error("offline");
      return serverRead(input.store(), options, input.server?.()).events;
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
            return serverRead(input.store(), options, input.server?.()) as never;
          },
        }
      : {}),
    streamEvents: (_workspaceId, _sessionId, options = {}) => {
      const after = options.after ?? 0;
      streamCalls.push(after);
      if (input.sdkTransport) {
        return streamSessionEvents(input.sdkTransport, {
          ...options,
          reconnectDelayMs: 1,
          maxReconnectDelayMs: 2,
          reconnectJitterRatio: 0,
        });
      }
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

const ptyRow = (sequence: number) =>
  at(
    sequence,
    "terminal.pty.output.delta",
    { ptyId: "p1", stream: "stdout", chunk: `line ${sequence}\r\n`, seq: sequence },
    null,
  );

/** The chat and its sandbox terminal, as the dock wires them. */
function chatWithTerminal(client: ReturnType<typeof historyClient>["client"]) {
  const session = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
  const terminal = useSandboxTerminal(SESSION_ID, {
    client,
    workspaceId: WORKSPACE_ID,
    events: session.events,
  });
  return { session, terminal };
}

/** Wait until `done` holds, in real time (terminal re-reads are throttled). */
async function settleUntil(done: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await flush(50);
}

describe("conversation-first session history", () => {
  test("the first load reads only the conversation and offers each turn's steps", async () => {
    const store = [
      ...longTurn({ start: 1, turnId: "T1", steps: 1000, presentedAt: 7 }),
      ...longTurn({ start: 3000, turnId: "T2", steps: 3 }),
    ];
    const { client, reads } = historyClient({ store: () => store, withPages: true });
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
          includeTypes: [...TURN_STEP_READ_TYPES],
          after: 1,
          // Bounded by the turn's settlement.
          before: 605,
          direction: "before",
          limit: SESSION_TURN_STEP_PAGE_SIZE,
          compact: true,
          payloadMode: "full",
          // Large tool outputs arrive as bounded previews.
          toolOutputs: "preview",
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
      withPages: true,
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
        [...TURN_STEP_READ_TYPES],
      ]);
      expect(reads[1]).toMatchObject({ after: 4003, before: 4053 });
      expect(reads[2]).toMatchObject({ includeTypes: [...TURN_STEP_READ_TYPES], before: 4053 });
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
        store.push(receipt(sequence, "T1"));
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
        store.push(receipt(sequence, "T1"));
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
          store.push(receipt(sequence + 1, "T1"));
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
          if (turnless === "session.queue.changed") {
            expect(window[0]!.turnId).toBeNull();
            expect(window.filter((event) => event.type === turnless).length).toBeGreaterThan(100);
          } else {
            // PTY output is no conversation: only the sandbox dock reads it.
            expect(window.some((event) => event.type === turnless)).toBe(false);
          }
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
        store.push(receipt(sequence, "T1"));
        store.push(at(sequence + 1, "agent.toolCall.created", { id, name: "exec_command" }, "T1"));
        store.push(at(sequence + 2, "agent.toolCall.output", { id, output: "ok" }, "T1"));
        sequence += 3;
      };
      for (let index = 0; index < 2500; index += 1) call(index);
      const late = sequence;
      store.push(receipt(sequence++, "T0"));
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

  test(
    "thousands of PTY rows stay out of the conversation window, read and live",
    async () => {
      // Three turns, then an interactive terminal that wrote 6,000 rows
      // between and after them: more than the 1,000-row first page.
      const pty = (sequence: number) =>
        at(
          sequence,
          "terminal.pty.output.delta",
          { ptyId: "p1", stream: "stdout", chunk: `line ${sequence}\r\n`, seq: sequence },
          null,
        );
      const store: SessionEvent[] = [];
      let sequence = 1;
      for (const turnId of ["T1", "T2", "T3"]) {
        const turn = longTurn({ start: sequence, turnId, steps: 3 });
        store.push(...turn);
        sequence = turn.at(-1)!.sequence + 1;
        for (let index = 0; index < 2000; index += 1) store.push(pty(sequence++));
      }
      // A live text-only turn while the terminal keeps writing.
      const live: SessionEvent[] = [
        at(sequence, "user.message", { text: "status?", routing: "accepted_for_execution" }, null),
        at(sequence + 1, "turn.started", { turnId: "T4" }, "T4"),
      ];
      let liveSequence = sequence + 2;
      for (let index = 0; index < 600; index += 1) live.push(pty(liveSequence++));
      live.push(at(liveSequence, "agent.message.completed", { text: "all good" }, "T4"));
      live.push(at(liveSequence + 1, "turn.completed", { turnId: "T4" }, "T4"));
      const { client, reads } = historyClient({
        store: () => store,
        live: () => live,
        withPages: true,
      });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle(60);
        const historyReads = reads.filter((read) => read.excludeTypes);
        expect(historyReads.length).toBeGreaterThan(0);
        for (const read of historyReads) {
          expect(read.excludeTypes).toContain("terminal.pty.output.delta");
        }
        const result = hook.result.current;
        // Every question and answer is in the window; no PTY row is.
        const questions = result.events.filter((event) => event.type === "user.message");
        expect(questions.map((event) => (event.payload as { text: string }).text)).toEqual([
          "question T1",
          "question T2",
          "question T3",
          "status?",
        ]);
        expect(
          result.events.filter((event) => event.type === "agent.message.completed"),
        ).toHaveLength(4);
        expect(result.hasOlder).toBe(false);
        // Live PTY rows reach `events` (the sandbox dock's live feed) as a
        // bounded tail outside the window; none was read with the conversation.
        const ptyRows = result.events.filter((event) => event.type === "terminal.pty.output.delta");
        expect(ptyRows).toHaveLength(600);
        expect(ptyRows.every((event) => event.sequence > sequence)).toBe(true);
        expect(result.windowBytes).toBeLessThan(64 * 1024);
        // The text-only live turn has no hidden steps: PTY rows are not its.
        expect(stepMarkers(result.timeline).find((item) => item.turnId === "T4")).toBeUndefined();
      } finally {
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("terminal output written after the last turn is not replayed when the chat opens", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 3 });
    const settled = store.at(-1)!.sequence;
    for (let sequence = settled + 1; sequence <= settled + 3000; sequence += 1) {
      store.push(
        at(
          sequence,
          "terminal.pty.output.delta",
          { ptyId: "p1", stream: "stdout", chunk: `line ${sequence}\r\n`, seq: sequence },
          null,
        ),
      );
    }
    const head = store.at(-1)!.sequence;
    const { client, reads, streamCalls } = historyClient({ store: () => store });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      // The conversation is caught up to the head, and the live stream joins
      // there: the 3,000 PTY rows are left to the sandbox dock's own read.
      expect(reads.at(-1)).toMatchObject({ after: settled, before: head + 1 });
      expect(streamCalls).toEqual([head]);
      expect(
        hook.result.current.events.some((event) => event.type === "terminal.pty.output.delta"),
      ).toBe(false);
    } finally {
      await hook.unmount();
    }
  });

  test("beside the session's detail read, the chat joins the head without reading the session again", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 3 });
    const settled = store.at(-1)!.sequence;
    for (let sequence = settled + 1; sequence <= settled + 3000; sequence += 1) {
      store.push(ptyRow(sequence));
    }
    const head = store.at(-1)!.sequence;
    const { client, reads, streamCalls, headReads } = historyClient({ store: () => store });
    // As the session views wire them: the feed, then the detail watching it.
    const hook = await renderHook(() => {
      const feed = useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID });
      const detail = useSession(SESSION_ID, {
        client,
        workspaceId: WORKSPACE_ID,
        events: feed.events,
      });
      return { feed, detail };
    }, undefined);
    try {
      await settle(60);
      expect(hook.result.current.detail.session?.lastSequence).toBe(head);
      // The detail read is the head read: the stream still joins at the head.
      expect(headReads()).toBe(1);
      expect(reads.at(-1)).toMatchObject({ after: settled, before: head + 1 });
      expect(streamCalls).toEqual([head]);
    } finally {
      await hook.unmount();
    }
  });

  test(
    "a live burst of terminal output reaches the terminal without holes",
    async () => {
      const store = longTurn({ start: 1, turnId: "T1", steps: 1 });
      const start = store.at(-1)!.sequence + 1;
      // Far more than one flush or the live tail holds, streamed at once.
      const live: SessionEvent[] = [];
      for (let sequence = start; sequence < start + 2500; sequence += 1) {
        live.push(ptyRow(sequence));
      }
      const written = [...store];
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const { client } = historyClient({
        store: () => written,
        live: () => live,
        withPages: true,
        liveGate: { after: 0, open: gate },
      });
      const hook = await renderHook(() => chatWithTerminal(client), undefined);
      try {
        await settle(60);
        expect(hook.result.current.terminal.chunks).toEqual([]);
        // The rows are durable as they stream, all at once.
        written.push(...live);
        await actRun(() => open());
        const last = live.at(-1)!.sequence;
        const seqs = () => hook.result.current.terminal.chunks.map((chunk) => chunk.seq);
        const contiguous = (values: number[]) =>
          values.every((seq, index) => index === 0 || seq === values[index - 1]! + 1);
        // Rows the live tail dropped before any render showed them are read
        // again (at most once a second), so the transcript ends up whole.
        await settleUntil(() => seqs().at(-1) === last && contiguous(seqs()));
        await settle(60);
        expect(seqs().at(-1)).toBe(last);
        expect(contiguous(seqs())).toBe(true);
        // At least the newest page (the terminal's scrollback) is there.
        expect(seqs().length).toBeGreaterThanOrEqual(1000);
        // The conversation never took them.
        expect(hook.result.current.session.windowBytes).toBeLessThan(64 * 1024);
      } finally {
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test(
    "terminal output written while the tab was hidden is read again on return",
    async () => {
      let visibility: DocumentVisibilityState = "visible";
      const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      const store: SessionEvent[] = longTurn({ start: 1, turnId: "T1", steps: 1 });
      const first = store.at(-1)!.sequence + 1;
      for (let sequence = first; sequence < first + 10; sequence += 1) store.push(ptyRow(sequence));
      const live: SessionEvent[] = [];
      const { client, reads } = historyClient({
        store: () => store,
        live: () => live,
        withPages: true,
      });
      const hook = await renderHook(() => chatWithTerminal(client), undefined);
      try {
        await settle(60);
        expect(hook.result.current.terminal.chunks).toHaveLength(10);

        jest.useFakeTimers();
        visibility = "hidden";
        await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
        await actRun(() => jest.advanceTimersByTime(2_000));
        expect(hook.result.current.session.connectionState).toBe("idle");
        // A hundred rows while away: more than the stream replays, so it
        // rejoins at the head and the terminal reads them itself.
        for (let sequence = first + 10; sequence < first + 110; sequence += 1) {
          const row = ptyRow(sequence);
          store.push(row);
          live.push(row);
        }
        visibility = "visible";
        await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
        await actRun(async () => {
          for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
          jest.advanceTimersByTime(20);
          for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
        });
        jest.useRealTimers();
        await settleUntil(() => hook.result.current.terminal.chunks.length === 110);
        expect(hook.result.current.terminal.chunks.map((chunk) => chunk.seq)).toEqual(
          Array.from({ length: 110 }, (_, index) => first + index),
        );
        const terminalReads = reads.filter((read) =>
          read.includeTypes?.includes("terminal.pty.output.delta"),
        );
        expect(terminalReads).toHaveLength(2);
      } finally {
        jest.useRealTimers();
        await hook.unmount();
        if (visibilityDescriptor) {
          Object.defineProperty(document, "visibilityState", visibilityDescriptor);
        } else {
          delete (document as { visibilityState?: unknown }).visibilityState;
        }
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  for (const route of ["jumpToLatest", "loadNewer"] as const) {
    test(
      `terminal output written while browsing history is read again after ${route}`,
      async () => {
        // Enough conversation that jumping to the start leaves the latest page.
        const store: SessionEvent[] = [];
        let sequence = 1;
        for (let index = 0; index < 40; index += 1) {
          const turn = longTurn({ start: sequence, turnId: `T${index}`, steps: 0 });
          store.push(...turn);
          sequence = turn.at(-1)!.sequence + 1;
        }
        const first = sequence;
        for (; sequence < first + 10; sequence += 1) store.push(ptyRow(sequence));
        const live: SessionEvent[] = [];
        const { client } = historyClient({
          store: () => store,
          live: () => live,
          withPages: true,
        });
        const hook = await renderHook(() => chatWithTerminal(client), undefined);
        try {
          await settle(60);
          expect(hook.result.current.terminal.chunks).toHaveLength(10);
          await actRun(async () => {
            await hook.result.current.session.jumpToSequence(1);
          });
          await settle(60);
          // While the reader browses, the terminal writes 50 rows and a turn runs.
          const written: SessionEvent[] = [];
          for (; sequence < first + 60; sequence += 1) written.push(ptyRow(sequence));
          written.push(...longTurn({ start: sequence, turnId: "Tlate", steps: 0 }));
          store.push(...written);
          live.push(...written);
          if (route === "jumpToLatest") {
            await actRun(async () => {
              await hook.result.current.session.jumpToLatest();
            });
          } else {
            for (let page = 0; page < 20 && hook.result.current.session.hasNewer; page += 1) {
              await actRun(async () => {
                await hook.result.current.session.loadNewer();
              });
              await settle(30);
            }
          }
          await settleUntil(() => hook.result.current.terminal.chunks.length === 60);
          expect(hook.result.current.terminal.chunks.map((chunk) => chunk.seq)).toEqual(
            Array.from({ length: 60 }, (_, index) => first + index),
          );
        } finally {
          await hook.unmount();
        }
      },
      HEAVY_TEST_TIMEOUT_MS,
    );
  }

  test("terminal output between a live turn's start and its first step is not hidden steps", async () => {
    const store = [at(1, "user.message", { text: "go", routing: "accepted_for_execution" }, null)];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const live = [
      at(2, "turn.started", { turnId: "T1" }, "T1"),
      ptyRow(3),
      ptyRow(4),
      at(5, "agent.toolCall.created", { id: "c", name: "exec_command" }, "T1"),
      at(6, "agent.toolCall.output", { id: "c", output: "ok" }, "T1"),
    ];
    const { client, reads } = historyClient({
      store: () => store,
      live: () => live,
      liveGate: { after: 3, open: gate },
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      await actRun(() => open());
      await settle(60);
      expect(stepEvents(hook.result.current.events).map((event) => event.sequence)).toEqual([
        3, 4, 5, 6,
      ]);
      expect(stepMarkers(hook.result.current.timeline)[0]?.state).toBe("complete");
      expect(reads.filter((read) => read.includeTypes)).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("a text-only turn with terminal output in its span opens in one step read", async () => {
    const store: SessionEvent[] = [
      at(1, "user.message", { text: "status?", routing: "accepted_for_execution" }, null),
      at(2, "turn.started", { turnId: "T1" }, "T1"),
    ];
    for (let sequence = 3; sequence < 1003; sequence += 1) store.push(ptyRow(sequence));
    store.push(at(1003, "agent.message.completed", { text: "all good" }, "T1"));
    store.push(at(1004, "turn.completed", { turnId: "T1" }, "T1"));
    const { client, reads } = historyClient({ store: () => store, withPages: true });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      const marker = stepMarkers(hook.result.current.timeline)[0];
      if (marker) {
        reads.length = 0;
        await actRun(() => marker.load());
        await settle(60);
        expect(reads).toHaveLength(1);
        expect(reads[0]!.includeTypes).not.toContain("terminal.pty.output.delta");
        // Read whole and nothing in it to open: the marker goes.
        expect(stepMarkers(hook.result.current.timeline)).toEqual([]);
      }
      expect(stepEvents(hook.result.current.events)).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

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
    // Steps outside a turn (PTY and background command output) are no
    // conversation: the sandbox dock reads them itself.
    expect(isConversationHistoryEvent(at(7, "agent.reasoning.delta", {}, null), presented)).toBe(
      false,
    );
    expect(
      isConversationHistoryEvent(
        at(8, "terminal.pty.output.delta", { ptyId: "p", chunk: "$ ls" }, null),
        presented,
      ),
    ).toBe(false);

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

const COMPAT_READ = {
  excludeTypes: [...SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES],
  presentedToolCalls: "include",
};
const V2_READ = { excludeTypes: [...SESSION_EVENT_STEP_TYPES], presentedToolCalls: "include" };

function conversationReads(reads: readonly SessionEventListOptions[]) {
  return reads.filter((read) => read.presentedToolCalls === "include");
}

async function loadAllOlder(hook: {
  result: { current: { hasOlder: boolean; loadOlder: () => unknown } };
}) {
  for (let page = 0; page < 10 && hook.result.current.hasOlder; page += 1) {
    await actRun(() => {
      hook.result.current.loadOlder();
    });
    await settle(5);
  }
}

describe("conversation reads across server versions", () => {
  for (const server of ["ignores", "presented"] as const) {
    test(`a server that does not announce its filter (${server}) loses no presented call`, async () => {
      const store = [
        ...longTurn({ start: 1, turnId: "T1", steps: 1000, presentedAt: 7 }),
        ...longTurn({ start: 3000, turnId: "T2", steps: 3 }),
      ];
      const { client, reads } = historyClient({
        store: () => store,
        withPages: true,
        server: () => server,
      });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle();
        await loadAllOlder(hook);
        const conversation = conversationReads(reads);
        // The announced read is tried once; without the announcement the page
        // is read again with tool calls in, and every later read stays so.
        expect(conversation[0]).toMatchObject({ ...V2_READ, before: Number.MAX_SAFE_INTEGER });
        expect(conversation[1]).toMatchObject({ ...COMPAT_READ, before: Number.MAX_SAFE_INTEGER });
        expect(conversation.slice(1).every((read) => read.excludeTypes?.length === 4)).toBe(true);
        // Bounded: a few 1,000-row pages, never an unfiltered read.
        expect(conversation.length).toBeLessThanOrEqual(6);
        expect(reads.every((read) => (read.limit ?? 0) <= 1000)).toBe(true);
        expect(reads.every((read) => read.excludeTypes || read.includeTypes)).toBe(true);
        const events = hook.result.current.events;
        // The published file and its result, and no other tool call.
        expect(stepEvents(events)).toEqual([]);
        expect(events.map((event) => event.sequence)).toEqual([
          1, 2, 17, 18, 2003, 2004, 3000, 3001, 3008, 3009,
        ]);
        expect(stepMarkers(hook.result.current.timeline).map((marker) => marker.turnId)).toEqual([
          "T1",
          "T2",
        ]);
        // Steps read bookkeeping too; rows the window already holds merge once.
        reads.length = 0;
        await actRun(() => stepMarkers(hook.result.current.timeline)[1]!.load());
        await settle();
        expect(reads).toEqual([
          expect.objectContaining({ includeTypes: [...TURN_STEP_READ_TYPES] }),
        ]);
        expect(stepEvents(hook.result.current.events)).toHaveLength(6);
      } finally {
        await hook.unmount();
      }
    });
  }

  test("pages of only dropped tool calls do not hide earlier history", async () => {
    // Review regression: pages of nothing but dropped tool calls once used up
    // the read caps and hid everything below them.
    const store = longTurn({ start: 1, turnId: "T1", steps: 4500 });
    const { client, reads } = historyClient({
      store: () => store,
      withPages: true,
      server: () => "ignores",
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      await loadAllOlder(hook);
      const events = hook.result.current.events;
      // The prompt and the turn start are reached, with no step in the window.
      expect(events.slice(0, 2).map((event) => event.type)).toEqual([
        "user.message",
        "turn.started",
      ]);
      expect(stepEvents(events)).toEqual([]);
      expect(hook.result.current.hasOlder).toBe(false);
      // Bounded: page-sized reads, each moving below the last.
      expect(reads.every((read) => (read.limit ?? 0) <= 1000)).toBe(true);
      expect(conversationReads(reads).length).toBeLessThanOrEqual(8);
    } finally {
      await hook.unmount();
    }
  });

  test("a first window that kept nothing still resumes the live stream where it read", async () => {
    // Review regression: a working turn of only dropped tool calls, longer
    // than the filtered-page cap, once resumed the stream from sequence 0.
    const store = longTurn({ start: 1, turnId: "T1", steps: 35_000, settled: false });
    const head = store.at(-1)!.sequence;
    const { client, reads, streamCalls } = historyClient({
      store: () => store,
      head: () => ({ lastSequence: head, activeTurnId: "T1" }),
      withPages: true,
      server: () => "ignores",
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      expect(streamCalls.length).toBeGreaterThan(0);
      expect(streamCalls.every((after) => after >= head - 1000)).toBe(true);
      expect(reads.length).toBeLessThanOrEqual(40);
      expect(reads.every((read) => (read.limit ?? 0) <= 1000)).toBe(true);
      // Nothing below is lost: the window stays pageable.
      expect(hook.result.current.hasOlder).toBe(true);
    } finally {
      await hook.unmount();
    }
  }, 60_000);

  for (const arrived of ["nothing", "a turnless row", "the running call's output"] as const) {
    test(`history below an empty first window still reaches the working turn's steps (live: ${arrived})`, async () => {
      // Review regressions: loading older history revealed a working turn whose
      // tool calls lay below the resumed stream, with no marker and no step read;
      // a turnless row streamed in before the reader scrolled up hid it too.
      const turn = longTurn({ start: 2, turnId: "T1", steps: 4500, settled: false });
      const store = [
        at(1, "user.message", { text: "question", routing: "accepted_for_execution" }, null),
        at(2, "turn.started", { turnId: "T1" }, "T1"),
        at(3, "agent.model.request", { phase: "started" }, "T1"),
        at(4, "agent.model.request", { phase: "first_byte" }, "T1"),
        // The tool calls, the last one still running.
        ...turn.slice(2, -1).map((event) => ({ ...event, sequence: event.sequence + 1 })),
      ];
      const head = store.at(-1)!.sequence;
      expect(store.at(-1)!.type).toBe("agent.toolCall.created");
      const runningCall = (store.at(-1)!.payload as { id: string }).id;
      const extra =
        arrived === "a turnless row"
          ? [at(head + 1, "session.command.finished", { commandId: "c1" }, null)]
          : arrived === "the running call's output"
            ? [at(head + 1, "agent.toolCall.output", { id: runningCall, output: "done" }, "T1")]
            : [];
      const { client, reads, streamCalls } = historyClient({
        store: () => store,
        live: () => [...store, ...extra],
        head: () => ({ lastSequence: head, activeTurnId: "T1" }),
        withPages: true,
        server: () => "ignores",
      });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle(60);
        expect(hook.result.current.events.map((event) => event.sequence)).toEqual(
          arrived === "a turnless row" ? [head + 1] : [],
        );
        expect(streamCalls.every((after) => after >= head - 1000)).toBe(true);
        await loadAllOlder(hook);
        await settle(30);
        const events = hook.result.current.events;
        expect(
          events.filter((event) => event.sequence <= 4).map((event) => event.sequence),
        ).toEqual([1, 2, 3, 4]);
        // The turn's newest steps are read up to where the stream resumed...
        expect(reads).toContainEqual(
          expect.objectContaining({
            includeTypes: [...TURN_STEP_READ_TYPES],
            before: head + 1,
          }),
        );
        // ...so its running tool call shows, under a marker for the rest.
        expect(events.find((event) => event.sequence === head)).toMatchObject({
          type: "agent.toolCall.created",
        });
        expect(events.filter((event) => event.sequence > head)).toEqual(extra);
        expect(stepMarkers(hook.result.current.timeline)).toEqual([
          expect.objectContaining({ turnId: "T1", state: "partial" }),
        ]);
      } finally {
        await hook.unmount();
      }
    }, 60_000);
  }

  for (const away of ["turnless rows", "dropped tool calls"] as const) {
    test(`a foreground catch-up after an empty first window keeps the skipped steps reachable (away: ${away})`, async () => {
      // Review regression: the catch-up forgot the skipped range before the
      // working turn was visible, and an all-dropped catch-up lost the raw
      // cursor below the window, so older history read nothing.
      let visibility: DocumentVisibilityState = "visible";
      const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      const turn = longTurn({ start: 2, turnId: "T1", steps: 4500, settled: false });
      const store = [
        at(1, "user.message", { text: "question", routing: "accepted_for_execution" }, null),
        at(2, "turn.started", { turnId: "T1" }, "T1"),
        at(3, "agent.model.request", { phase: "started" }, "T1"),
        at(4, "agent.model.request", { phase: "first_byte" }, "T1"),
        ...turn.slice(2, -1).map((event) => ({ ...event, sequence: event.sequence + 1 })),
      ];
      const firstHead = store.at(-1)!.sequence;
      const { client, reads } = historyClient({
        store: () => store,
        live: () => store,
        head: () => ({ lastSequence: store.at(-1)!.sequence, activeTurnId: "T1" }),
        withPages: true,
        server: () => "ignores",
      });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle(60);
        expect(hook.result.current.events).toEqual([]);

        jest.useFakeTimers();
        visibility = "hidden";
        await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
        await actRun(() => jest.advanceTimersByTime(2_000));
        // Twenty rows while away: too many to replay, so the return catches up.
        for (let index = 0; index < 10; index += 1) {
          const sequence = firstHead + 1 + index * 2;
          const id = `T1-late-${index}`;
          if (away === "turnless rows") {
            store.push(
              at(sequence, "session.command.finished", { commandId: `c${index}` }, null),
              at(sequence + 1, "session.command.finished", { commandId: `d${index}` }, null),
            );
          } else {
            store.push(
              at(sequence, "agent.toolCall.created", { id, name: "exec_command" }, "T1"),
              at(sequence + 1, "agent.toolCall.output", { id, output: "ok" }, "T1"),
            );
          }
        }
        const head = store.at(-1)!.sequence;
        visibility = "visible";
        await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
        await actRun(async () => {
          for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
          jest.advanceTimersByTime(20);
          for (let tick = 0; tick < 200; tick += 1) await Promise.resolve();
        });
        jest.useRealTimers();
        await settle(30);
        expect(hook.result.current.hasOlder).toBe(true);

        await loadAllOlder(hook);
        await settle(30);
        const events = hook.result.current.events;
        expect(
          events.filter((event) => event.sequence <= 4).map((event) => event.sequence),
        ).toEqual([1, 2, 3, 4]);
        expect(hook.result.current.hasOlder).toBe(false);
        // The working turn's newest steps are read through the catch-up head.
        expect(reads).toContainEqual(
          expect.objectContaining({
            includeTypes: [...TURN_STEP_READ_TYPES],
            before: head + 1,
          }),
        );
        expect(events.at(-1)!.sequence).toBe(head);
        expect(stepMarkers(hook.result.current.timeline)).toEqual([
          expect.objectContaining({ turnId: "T1", state: "partial" }),
        ]);
      } finally {
        jest.useRealTimers();
        await hook.unmount();
        if (visibilityDescriptor) {
          Object.defineProperty(document, "visibilityState", visibilityDescriptor);
        } else {
          delete (document as { visibilityState?: unknown }).visibilityState;
        }
      }
    }, 60_000);
  }

  test("a working turn's newest dropped tool call still reaches its steps", async () => {
    // Review regression: resuming the stream above dropped rows hid a running
    // tool call that had no other row in the window above it.
    const store = [
      at(1, "user.message", { text: "question", routing: "accepted_for_execution" }, null),
      at(2, "turn.started", { turnId: "T1" }, "T1"),
      at(3, "agent.model.request", { phase: "started" }, "T1"),
      at(4, "agent.model.request", { phase: "first_byte" }, "T1"),
      at(5, "agent.toolCall.created", { id: "T1-call-0", name: "exec_command" }, "T1"),
    ];
    const { client, streamCalls } = historyClient({
      store: () => store,
      live: () => store,
      head: () => ({ lastSequence: 5, activeTurnId: "T1" }),
      withPages: true,
      server: () => "ignores",
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      expect(streamCalls).toEqual([4]);
      expect(hook.result.current.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(stepMarkers(hook.result.current.timeline).map((marker) => marker.turnId)).toEqual([
        "T1",
      ]);
    } finally {
      await hook.unmount();
    }
  });

  test("steps opened after another view saw an older server still include bookkeeping", async () => {
    // Review regression: the step read followed the client's latest mode, not
    // the read that built this window, and left this turn's usage rows out.
    const store = modelTurn({ start: 1, turnId: "T1", calls: 3 });
    let server: ServerVersion = "current";
    const { client, reads } = historyClient({
      store: () => store,
      withPages: true,
      server: () => server,
    });
    const open = async () =>
      await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
    const first = await open();
    try {
      await settle();
      expect(bookkeeping(first.result.current.events, "T1").some(isUsage)).toBe(false);
      // A rollback (or an older replica) answers a second view of the same client.
      server = "ignores";
      const second = await open();
      await settle();
      await second.unmount();
      expect(conversationFilterMode(client)).toBe("compat");
      reads.length = 0;
      await actRun(() => stepMarkers(first.result.current.timeline)[0]!.load());
      await settle();
      expect(reads).toEqual([expect.objectContaining({ includeTypes: [...TURN_STEP_READ_TYPES] })]);
      expect(bookkeeping(first.result.current.events, "T1").filter(isUsage)).toHaveLength(
        bookkeeping(store, "T1").filter(isUsage).length,
      );
    } finally {
      await first.unmount();
    }
  });

  test("a server that applies no type filter still yields only the conversation", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 20, presentedAt: 3 });
    // A server or proxy that applies no filter at all: the reader keeps only
    // the conversation, with the presented call and none of the steps.
    const { client } = historyClient({
      store: () => store,
      withPages: true,
      server: () => "unfiltered",
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      const events = hook.result.current.events;
      expect(stepEvents(events)).toEqual([]);
      expect(
        events.some(
          (event) =>
            event.type === "agent.toolCall.created" &&
            (event.payload as { name?: unknown }).name === "sandbox_file_publish",
        ),
      ).toBe(true);
      // Only the presented call's result, read on its own.
      expect(
        events
          .filter((event) => event.type === "agent.toolCall.output")
          .map((event) => (event.payload as { id?: unknown }).id),
      ).toEqual(["T1-publish-3"]);
    } finally {
      await hook.unmount();
    }
  });

  test("a client without page reads cannot see the announcement and reads tool calls", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 20, presentedAt: 3 });
    const { client, reads } = historyClient({ store: () => store, server: () => "ignores" });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle();
      expect(conversationReads(reads)).toEqual([
        expect.objectContaining({ ...COMPAT_READ, before: Number.MAX_SAFE_INTEGER }),
      ]);
      const events = hook.result.current.events;
      expect(events.some((event) => event.sequence === 9)).toBe(true);
      expect(stepEvents(events)).toEqual([]);
    } finally {
      await hook.unmount();
    }
  });

  test("once the server announces its filter, reads exclude every step again", async () => {
    const store = longTurn({ start: 1, turnId: "T1", steps: 20, presentedAt: 3 });
    let server: ServerVersion = "ignores";
    const { client, reads } = historyClient({
      store: () => store,
      withPages: true,
      server: () => server,
    });
    const open = async () =>
      await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
    const first = await open();
    await settle();
    await first.unmount();
    expect(conversationReads(reads).map((read) => read.excludeTypes)).toEqual([
      V2_READ.excludeTypes,
      COMPAT_READ.excludeTypes,
    ]);
    // The server deploys: the next compact read sees its announcement.
    server = "current";
    reads.length = 0;
    const second = await open();
    try {
      await settle();
      expect(conversationReads(reads).map((read) => read.excludeTypes)).toEqual([
        COMPAT_READ.excludeTypes,
      ]);
      reads.length = 0;
      await actRun(() => stepMarkers(second.result.current.timeline)[0]!.load());
      await settle();
      expect(reads).toEqual([expect.objectContaining({ includeTypes: [...TURN_STEP_READ_TYPES] })]);
    } finally {
      await second.unmount();
    }
    reads.length = 0;
    const third = await open();
    try {
      await settle();
      expect(conversationReads(reads).map((read) => read.excludeTypes)).toEqual([
        V2_READ.excludeTypes,
      ]);
      expect(third.result.current.events.some((event) => event.sequence === 9)).toBe(true);
    } finally {
      await third.unmount();
    }
  });
});

const BOOKKEEPING_TYPES = new Set<string>(["agent.model.request", "agent.model.usage"]);

/**
 * A turn as a model writes it: every model call writes four request rows and
 * a usage row; each call but the last also runs a tool.
 */
function modelTurn(input: { start: number; turnId: string; calls: number }): SessionEvent[] {
  const { turnId } = input;
  let sequence = input.start;
  const events: SessionEvent[] = [];
  const add = (type: SessionEvent["type"], payload: unknown, turn: string | null = turnId) => {
    events.push(at(sequence, type, payload, turn));
    sequence += 1;
  };
  add("user.message", { text: `question ${turnId}`, routing: "accepted_for_execution" }, null);
  add("turn.started", { turnId });
  add("turn.startup.phase.started", { phase: "model_preparation" });
  add("turn.startup.phase.completed", { phase: "model_preparation", durationMs: 1200 });
  for (let index = 0; index <= input.calls; index += 1) {
    add("agent.model.request", { phase: "started", model: "gpt-test" });
    add("agent.model.request", { phase: "headers", model: "gpt-test" });
    add("agent.model.request", { phase: "first_byte", durationMs: 1500 + index });
    add("agent.model.request", { phase: "completed", model: "gpt-test" });
    add("agent.model.usage", { inputTokens: 100, outputTokens: 10, purpose: "main" });
    if (index === input.calls) break;
    const id = `${turnId}-call-${index}`;
    add("agent.toolCall.created", { id, name: "exec_command", arguments: { cmd: "ls" } });
    add("agent.toolCall.output", { id, output: `output ${index}` });
  }
  add("agent.message.completed", { text: `answer ${turnId}` });
  add("turn.completed", { turnId });
  return events;
}

/** A turn whose model never answered. */
function failedStartTurn(start: number, turnId: string): SessionEvent[] {
  return [
    at(
      start,
      "user.message",
      { text: `question ${turnId}`, routing: "accepted_for_execution" },
      null,
    ),
    at(start + 1, "turn.started", { turnId }, turnId),
    at(start + 2, "agent.model.request", { phase: "started" }, turnId),
    at(start + 3, "agent.model.request", { phase: "timed_out", durationMs: 30_000 }, turnId),
    at(
      start + 4,
      "turn.failed",
      { turnId, error: { message: "The model did not answer." } },
      turnId,
    ),
  ];
}

/** The conversation as #5237 read it: every row but content steps. */
function contentFilteredConversation(store: readonly SessionEvent[]): SessionEvent[] {
  const content = new Set<string>(SESSION_EVENT_CONTENT_STEP_TYPES);
  return store.filter(
    (event) =>
      !content.has(event.type) ||
      !event.turnId ||
      (event.type === "agent.toolCall.created" &&
        (event.payload as { name?: unknown }).name === "sandbox_file_publish"),
  );
}

const NO_STEPS = { load: () => {}, retain: () => () => {} };

function bookkeeping(events: readonly SessionEvent[], turnId: string) {
  return events.filter((event) => event.turnId === turnId && BOOKKEEPING_TYPES.has(event.type));
}

function isUsage(event: SessionEvent): boolean {
  return event.type === "agent.model.usage";
}

describe("turn bookkeeping in conversation history", () => {
  test(
    "a long turn's window holds only the bookkeeping its conversation draws",
    async () => {
      const store = [
        ...failedStartTurn(1, "T0"),
        ...modelTurn({ start: 10, turnId: "T1", calls: 1500 }),
      ];
      store.push(...modelTurn({ start: store.at(-1)!.sequence + 1, turnId: "T2", calls: 0 }));
      // 10,000 rows, 7,500 of them T1's request and usage rows.
      expect(bookkeeping(store, "T1")).toHaveLength(1501 * 5);
      const { client, reads } = historyClient({ store: () => store, withPages: true });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle();
        expect(reads).toEqual([
          expect.objectContaining({ ...V2_READ, before: Number.MAX_SAFE_INTEGER, limit: 1000 }),
        ]);
        const window = hook.result.current.events;
        expect(hook.result.current.hasOlder).toBe(false);
        expect(window.length).toBeLessThan(40);
        // T1 keeps its request rows up to the first model response; no usage.
        expect(bookkeeping(window, "T1").map((event) => event.sequence)).toEqual([14, 15, 16]);
        // A turn with no other steps keeps all of them, so it is not openable.
        expect(bookkeeping(window, "T0")).toHaveLength(2);
        expect(bookkeeping(window, "T2")).toHaveLength(5);
        const markers = stepMarkers(hook.result.current.timeline);
        expect(markers.map((marker) => [marker.turnId, marker.state])).toEqual([["T1", "idle"]]);

        // The conversation draws exactly what it drew with every bookkeeping row.
        const before = buildTimeline(t, contentFilteredConversation(store), {
          partialStart: false,
          turnSteps: new Map([["T1", { state: "idle", ...NO_STEPS }]]),
        });
        expect(JSON.stringify(hook.result.current.timeline)).toBe(JSON.stringify(before));
        const groups = groupTimeline(t, hook.result.current.timeline);
        type Work = Parameters<typeof readableWorkDefaultOpen>[0];
        const activities = (list: readonly unknown[]): Work[] =>
          list.flatMap((group) => {
            const entry = group as { kind: string; groups?: unknown[] };
            if (entry.kind === "activity") return [group as Work];
            return entry.groups ? activities(entry.groups) : [];
          });
        const work = (turnId: string) =>
          activities(groups).find((group) =>
            group.items.some((item) => "turnId" in item && item.turnId === turnId),
          )!;
        // The failed start still opens itself; the first response keeps its timing.
        expect(readableWorkDefaultOpen(work("T0"))).toBe(true);
        expect(
          work("T1").items.find(
            (item) => item.kind === "startup-phase" && item.phase === "provider_first_byte",
          ),
        ).toMatchObject({ status: "complete", durationMs: 1500 });

        const rendered = await renderComponent(
          <MessageTimeline items={hook.result.current.timeline} />,
        );
        try {
          const text = rendered.container.textContent ?? "";
          expect(text).toContain("answer T1");
          expect(text).toContain("answer T2");
          // The failed start reads as its timed-out model request.
          expect(text).toMatch(/Model didn.t respond30\.0s/);
        } finally {
          await rendered.unmount();
        }

        // Opening the turn reads its bookkeeping with its other steps.
        reads.length = 0;
        await actRun(() => markers[0]!.load());
        await settle();
        expect(reads).toEqual([
          expect.objectContaining({ includeTypes: [...TURN_STEP_READ_TYPES] }),
        ]);
        expect(
          bookkeeping(hook.result.current.events, "T1").some(
            (event) => event.type === "agent.model.usage",
          ),
        ).toBe(true);
      } finally {
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("live bookkeeping joins its turn's steps once the model responded", async () => {
    const history = modelTurn({ start: 1, turnId: "T0", calls: 0 });
    const live = [
      ...modelTurn({ start: 100, turnId: "T1", calls: 3 }),
      ...modelTurn({ start: 200, turnId: "T2", calls: 0 }),
    ];
    let store: SessionEvent[] = [...history];
    const { client } = historyClient({ store: () => store, live: () => live, withPages: true });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      store = [...history, ...live];
      // The window holds T1's and T2's request rows up to their first model
      // response; the rest are steps.
      const expected = [
        ...history,
        ...live.filter((event) => {
          if (!BOOKKEEPING_TYPES.has(event.type)) return !STEP_TYPES.has(event.type);
          if (event.type === "agent.model.usage") return false;
          const first = live.find(
            (row) =>
              row.turnId === event.turnId &&
              (row.payload as { phase?: unknown }).phase === "first_byte",
          )!;
          return event.sequence <= first.sequence;
        }),
      ];
      expect(hook.result.current.windowBytes).toBe(
        new TextEncoder().encode(JSON.stringify(expected)).byteLength,
      );
      // Every live row is still drawn: steps of turns in the window merge in.
      expect(hook.result.current.events.map((event) => event.sequence)).toEqual(
        store.map((event) => event.sequence),
      );
      // A turn whose only steps are its bookkeeping offers nothing to open.
      expect(
        stepMarkers(hook.result.current.timeline).map((marker) => [marker.turnId, marker.state]),
      ).toEqual([["T1", "complete"]]);
      expect(JSON.stringify(hook.result.current.timeline)).toBe(
        JSON.stringify(
          buildTimeline(t, store, {
            partialStart: false,
            turnSteps: new Map([["T1", { state: "complete", ...NO_STEPS }]]),
          }),
        ),
      );
    } finally {
      await hook.unmount();
    }
  });

  test("bookkeeping is a step once its turn's model responded", () => {
    const presented = new Set<string>();
    const request = (phase: string) => at(5, "agent.model.request", { phase }, "T");
    const usage = at(6, "agent.model.usage", {}, "T");
    // Without startup tracking (older callers), bookkeeping stays conversation.
    expect(isConversationHistoryEvent(request("completed"), presented)).toBe(true);
    expect(isConversationHistoryEvent(usage, presented)).toBe(true);
    expect(isConversationHistoryEvent(request("started"), presented, new Set(["T"]))).toBe(true);
    expect(isConversationHistoryEvent(request("first_byte"), presented, new Set(["T"]))).toBe(true);
    expect(isConversationHistoryEvent(request("started"), presented, new Set())).toBe(false);
    expect(isConversationHistoryEvent(usage, presented, new Set(["T"]))).toBe(false);
    // Turnless rows are conversation.
    expect(
      isConversationHistoryEvent(at(7, "agent.model.usage", {}, null), presented, new Set()),
    ).toBe(true);
  });
});

/**
 * A scripted SSE endpoint: each connection replays every durable row after
 * its cursor, then stays open for live rows until dropped or aborted.
 */
function sseServer(store: () => readonly SessionEvent[]) {
  const encoder = new TextEncoder();
  const frame = (event: SessionEvent) =>
    `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const opened: number[] = [];
  const replayed: number[] = [];
  const signals: AbortSignal[] = [];
  let current: ReadableStreamDefaultController<Uint8Array> | null = null;
  const transport: SessionEventStreamTransport = {
    openStream: async (after, signal) => {
      opened.push(after);
      if (signal) signals.push(signal);
      const backlog = store().filter((event) => event.sequence > after);
      replayed.push(backlog.length);
      return new ReadableStream<Uint8Array>({
        start: (controller) => {
          current = controller;
          if (backlog.length > 0) controller.enqueue(encoder.encode(backlog.map(frame).join("")));
          signal?.addEventListener(
            "abort",
            () => {
              try {
                controller.error(new DOMException("aborted", "AbortError"));
              } catch {
                // Already closed.
              }
            },
            { once: true },
          );
        },
      });
    },
    listEvents: async (after, limit) =>
      store()
        .filter((event) => event.sequence > after)
        .slice(0, limit),
  };
  return {
    transport,
    opened,
    replayed,
    signals,
    push(events: readonly SessionEvent[]) {
      current?.enqueue(encoder.encode(events.map(frame).join("")));
    },
    /** The network goes away under the open connection. */
    drop() {
      const controller = current;
      current = null;
      controller?.error(new TypeError("network connection lost"));
    },
  };
}

/** `count` more tool calls of a working turn, from `start`. */
function lateCalls(start: number, count: number, turnId = "T1"): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const sequence = start + index * 2;
    const id = `${turnId}-late-${index}`;
    events.push(
      at(sequence, "agent.toolCall.created", { id, name: "exec_command" }, turnId),
      at(sequence + 1, "agent.toolCall.output", { id, output: "ok" }, turnId),
    );
  }
  return events;
}

describe("rejoining the live tip after a reconnect or a sleep", () => {
  /** A chat on a working turn whose 100 calls are already written. */
  async function openWorkingChat(
    options: { replay?: "full"; failHead?: () => Error | undefined } = {},
  ) {
    const store: SessionEvent[] = longTurn({ start: 1, turnId: "T1", steps: 100, settled: false });
    const server = sseServer(() => store);
    const history = historyClient({
      store: () => store,
      withPages: true,
      head: () => ({ lastSequence: store.at(-1)!.sequence, activeTurnId: "T1" }),
      sdkTransport: server.transport,
      ...(options.failHead ? { failHead: options.failHead } : {}),
    });
    const hook = await renderHook(
      () =>
        useSessionEvents(SESSION_ID, {
          client: history.client,
          workspaceId: WORKSPACE_ID,
          ...(options.replay ? { replay: options.replay } : {}),
        }),
      undefined,
    );
    await settle(60);
    return { store, server, history, hook };
  }

  /** The laptop slept: the wall clock jumps, then the page is shown again. */
  async function wake(realNow: () => number) {
    const sleptFor = PAGE_WAKE_GAP_MS * 4;
    Date.now = () => realNow() + sleptFor;
    await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
  }

  /** Every step sequence the chat holds, checked for duplicates. */
  function uniqueStepSequences(events: readonly SessionEvent[]): number[] {
    const sequences = stepEvents([...events]).map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    return sequences;
  }

  test("an SDK reconnect after a long gap reads the newest steps instead of replaying them", async () => {
    const { store, server, history, hook } = await openWorkingChat();
    let unretain: (() => void) | undefined;
    try {
      expect(server.opened).toEqual([202]);
      expect(stepEvents(hook.result.current.events)).toHaveLength(200);
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      const headReads = history.headReads();

      // 2,000 calls are written while the connection is dead.
      store.push(...lateCalls(203, 2_000));
      server.drop();
      await settleUntil(() => server.opened.length === 2);
      await settle(60);

      // The reconnect asked the head, then resumed AT it: nothing replayed.
      expect(history.headReads()).toBe(headReads + 1);
      expect(server.opened).toEqual([202, 4_202]);
      expect(server.replayed).toEqual([0, 0]);
      // The open working turn shows its newest page of steps, re-read.
      expect(history.reads.at(-1)).toMatchObject({
        includeTypes: [...TURN_STEP_READ_TYPES],
        before: 4_203,
      });
      let steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(SESSION_TURN_STEP_PAGE_SIZE);
      expect(steps.at(-1)!.sequence).toBe(4_202);
      expect(hook.result.current.connectionState).toBe("live");

      // The stream keeps delivering live rows after the skip.
      const next = lateCalls(4_203, 1, "T1").map((event, index) => ({
        ...event,
        id: `evt-live-${index}`,
        payload: { ...(event.payload as object), id: "T1-live" },
      }));
      store.push(...next);
      await actRun(() => server.push(next));
      await settle(30);
      steps = stepEvents(hook.result.current.events);
      expect(steps.at(-1)!.sequence).toBe(4_204);
      expect(hook.result.current.lastSequence).toBe(4_204);
    } finally {
      unretain?.();
      await hook.unmount();
    }
  });

  test("an SDK reconnect after a short gap replays it once, without loss or duplicates", async () => {
    const { store, server, history, hook } = await openWorkingChat();
    let unretain: (() => void) | undefined;
    try {
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      const reads = history.reads.length;
      store.push(...lateCalls(203, 3));
      server.drop();
      await settleUntil(() => server.opened.length === 2);
      await settle(60);
      expect(server.opened).toEqual([202, 202]);
      expect(server.replayed).toEqual([0, 6]);
      // No history read: the short gap came over the stream.
      expect(history.reads).toHaveLength(reads);
      const steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(206);
      const sequences = steps.map((event) => event.sequence);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences.at(-1)).toBe(208);
      expect(stepMarkers(hook.result.current.timeline)[0]!.state).toBe("complete");
    } finally {
      unretain?.();
      await hook.unmount();
    }
  });

  test("a wake rejoins a silently dead stream at once, without the heartbeat or a replay", async () => {
    const realNow = Date.now;
    const { store, server, hook } = await openWorkingChat();
    let unretain: (() => void) | undefined;
    try {
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      // The lid closed: 2,000 calls were written and the connection died
      // without an error the page could see; no visibility change either.
      store.push(...lateCalls(203, 2_000));
      const sleptFor = PAGE_WAKE_GAP_MS * 4;
      Date.now = () => realNow() + sleptFor;
      // The page notices the clock jump as soon as it is shown again.
      await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
      await settleUntil(() => server.opened.length === 2);
      await settle(60);
      expect(server.signals[0]!.aborted).toBe(true);
      expect(server.opened).toEqual([202, 4_202]);
      expect(server.replayed).toEqual([0, 0]);
      const steps = stepEvents(hook.result.current.events);
      expect(steps).toHaveLength(SESSION_TURN_STEP_PAGE_SIZE);
      expect(steps.at(-1)!.sequence).toBe(4_202);
      expect(hook.result.current.connectionState).toBe("live");
    } finally {
      Date.now = realNow;
      unretain?.();
      await hook.unmount();
    }
  });

  test(
    "an SDK reconnect after a long conversation shows the newest window, keeping the old one until it is ready",
    async () => {
      // Ten finished exchanges, then 600 more (2,400 conversation rows) while
      // disconnected: too many to append, so the newest window is loaded.
      const store: SessionEvent[] = [];
      const exchange = (index: number) =>
        longTurn({ start: index * 4 + 1, turnId: `T${index}`, steps: 0 });
      for (let index = 0; index < 10; index += 1) store.push(...exchange(index));
      const server = sseServer(() => store);
      let gate: Promise<void> | undefined;
      let openGate = () => {};
      const history = historyClient({
        store: () => store,
        withPages: true,
        sdkTransport: server.transport,
        pageGate: (options) => (options.before === Number.MAX_SAFE_INTEGER ? gate : undefined),
      });
      const hook = await renderHook(
        () => useSessionEvents(SESSION_ID, { client: history.client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      try {
        await settle(60);
        expect(server.opened).toEqual([40]);
        expect(hook.result.current.events.at(-1)!.sequence).toBe(40);

        for (let index = 10; index < 610; index += 1) store.push(...exchange(index));
        gate = new Promise<void>((resolve) => {
          openGate = resolve;
        });
        server.drop();
        await settleUntil(() =>
          history.reads.some(
            (read) => read.before === Number.MAX_SAFE_INTEGER && history.reads.indexOf(read) > 0,
          ),
        );
        await settle(30);
        // The replacement is in flight: the reader still sees the old window.
        expect(hook.result.current.events[0]!.sequence).toBe(1);
        expect(hook.result.current.events.at(-1)!.sequence).toBe(40);
        expect(server.opened).toEqual([40]);

        openGate();
        await settleUntil(() => server.opened.length === 2);
        await settle(60);
        expect(server.opened).toEqual([40, 2_440]);
        expect(server.replayed).toEqual([0, 0]);
        const events = hook.result.current.events;
        expect(events.at(-1)!.sequence).toBe(2_440);
        expect(events[0]!.sequence).toBeGreaterThan(40);
        expect(hook.result.current.hasOlder).toBe(true);
        expect(hook.result.current.connectionState).toBe("live");
      } finally {
        openGate();
        await hook.unmount();
      }
    },
    HEAVY_TEST_TIMEOUT_MS,
  );

  test("full replay keeps the SDK's exactly-once reconnect", async () => {
    const { store, server, hook } = await openWorkingChat({ replay: "full" });
    try {
      expect(server.opened).toEqual([0]);
      expect(hook.result.current.events).toHaveLength(202);
      store.push(...lateCalls(203, 100));
      server.drop();
      await settleUntil(() => server.opened.length === 2);
      await settleUntil(() => hook.result.current.events.length === 402);
      expect(server.opened).toEqual([0, 202]);
      expect(server.replayed).toEqual([202, 200]);
      const sequences = hook.result.current.events.map((event) => event.sequence);
      expect(sequences).toEqual(Array.from({ length: 402 }, (_, index) => index + 1));
    } finally {
      await hook.unmount();
    }
  });

  test("a reconnect whose head read fails transiently backs off and still skips the backlog", async () => {
    let failures = 0;
    const { store, server, history, hook } = await openWorkingChat({
      failHead: () => {
        if (failures === 0) return undefined;
        failures -= 1;
        return new TypeError("network is still coming back");
      },
    });
    let unretain: (() => void) | undefined;
    try {
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      const headReads = history.headReads();
      store.push(...lateCalls(203, 2_000));
      failures = 2;
      server.drop();
      await settleUntil(() => server.opened.length === 2);
      await settle(60);
      // Two failed checks opened nothing; the third found the long gap.
      expect(history.headReads()).toBe(headReads + 3);
      expect(server.opened).toEqual([202, 4_202]);
      expect(server.replayed).toEqual([0, 0]);
      expect(uniqueStepSequences(hook.result.current.events).at(-1)).toBe(4_202);
      expect(hook.result.current.connectionState).toBe("live");
    } finally {
      unretain?.();
      await hook.unmount();
    }
  });

  for (const [name, failure, checks] of [
    ["cannot be read at all", () => new Error("forbidden"), 1],
    ["keeps failing transiently", () => new TypeError("still offline"), 6],
  ] as const) {
    test(`a reconnect whose head ${name} replays exactly instead of staying stuck`, async () => {
      let failing = false;
      const { store, server, history, hook } = await openWorkingChat({
        failHead: () => (failing ? failure() : undefined),
      });
      let unretain: (() => void) | undefined;
      try {
        unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
        const headReads = history.headReads();
        store.push(...lateCalls(203, 50));
        failing = true;
        server.drop();
        await settleUntil(() => server.opened.length === 2);
        await settle(60);
        expect(history.headReads()).toBe(headReads + checks);
        expect(server.opened).toEqual([202, 202]);
        expect(server.replayed).toEqual([0, 100]);
        const sequences = uniqueStepSequences(hook.result.current.events);
        expect(sequences).toHaveLength(300);
        expect(sequences.at(-1)).toBe(302);
        expect(hook.result.current.connectionState).toBe("live");
      } finally {
        unretain?.();
        await hook.unmount();
      }
    });
  }

  test("only a skipped gap makes the terminal re-read its output", async () => {
    const { store, server, hook } = await openWorkingChat();
    const gap = await renderHook(() => useTurnlessOutputGap(WORKSPACE_ID, SESSION_ID), undefined);
    let unretain: (() => void) | undefined;
    try {
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      const before = gap.result.current;
      // A short gap replays every row, terminal output included.
      store.push(...lateCalls(203, 3));
      server.drop();
      await settleUntil(() => server.opened.length === 2);
      await settle(60);
      expect(server.opened).toEqual([202, 202]);
      expect(gap.result.current).toBe(before);
      // A long one skips rows the terminal may need.
      store.push(...lateCalls(209, 2_000));
      server.drop();
      await settleUntil(() => server.opened.length === 3);
      await settle(60);
      expect(server.opened).toEqual([202, 202, 4_208]);
      expect(gap.result.current).toBeGreaterThan(before);
    } finally {
      unretain?.();
      await gap.unmount();
      await hook.unmount();
    }
  });

  test("rows the dead connection already delivered count before the gap is measured", async () => {
    const { store, server, hook } = await openWorkingChat();
    let unretain: (() => void) | undefined;
    try {
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      // Ten rows arrive and wait for the next render batch...
      const delivered = lateCalls(203, 5);
      store.push(...delivered);
      server.push(delivered);
      await new Promise((resolve) => setTimeout(resolve, 2));
      // ...when the connection dies with ten more written: a short gap.
      store.push(...lateCalls(213, 5));
      server.drop();
      await settleUntil(() => server.opened.length === 2);
      await settle(60);
      expect(server.opened).toEqual([202, 212]);
      expect(server.replayed).toEqual([0, 10]);
      const sequences = uniqueStepSequences(hook.result.current.events);
      expect(sequences).toHaveLength(220);
      expect(sequences.at(-1)).toBe(222);
    } finally {
      unretain?.();
      await hook.unmount();
    }
  });

  test("a wake whose head read fails transiently retries before rejoining the tip", async () => {
    const realNow = Date.now;
    let failures = 0;
    const { store, server, history, hook } = await openWorkingChat({
      failHead: () => {
        if (failures === 0) return undefined;
        failures -= 1;
        return new TypeError("network is still coming back");
      },
    });
    let unretain: (() => void) | undefined;
    try {
      unretain = stepMarkers(hook.result.current.timeline)[0]!.retain();
      const headReads = history.headReads();
      store.push(...lateCalls(203, 2_000));
      failures = 1;
      await wake(realNow);
      await settleUntil(() => server.opened.length === 2);
      await settle(60);
      expect(history.headReads()).toBe(headReads + 2);
      expect(server.opened).toEqual([202, 4_202]);
      expect(server.replayed).toEqual([0, 0]);
      expect(uniqueStepSequences(hook.result.current.events).at(-1)).toBe(4_202);
      expect(hook.result.current.connectionState).toBe("live");
    } finally {
      Date.now = realNow;
      unretain?.();
      await hook.unmount();
    }
  });

  test("a wake keeps full replay exact", async () => {
    const realNow = Date.now;
    const { store, server, hook } = await openWorkingChat({ replay: "full" });
    try {
      store.push(...lateCalls(203, 100));
      await wake(realNow);
      await settleUntil(() => hook.result.current.events.length === 402);
      expect(server.signals[0]!.aborted).toBe(true);
      expect(server.opened).toEqual([0, 202]);
      expect(server.replayed).toEqual([202, 200]);
      const sequences = hook.result.current.events.map((event) => event.sequence);
      expect(sequences).toEqual(Array.from({ length: 402 }, (_, index) => index + 1));
    } finally {
      Date.now = realNow;
      await hook.unmount();
    }
  });

  test("a wake while reading history opens no stream", async () => {
    const realNow = Date.now;
    const store: SessionEvent[] = [];
    for (let index = 0; index < 40; index += 1) {
      store.push(...longTurn({ start: index * 4 + 1, turnId: `T${index}`, steps: 0 }));
    }
    const server = sseServer(() => store);
    const history = historyClient({
      store: () => store,
      withPages: true,
      sdkTransport: server.transport,
    });
    const hook = await renderHook(
      () => useSessionEvents(SESSION_ID, { client: history.client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    try {
      await settle(60);
      expect(server.opened).toEqual([160]);
      await actRun(async () => {
        await hook.result.current.jumpToSequence(1);
      });
      await settle(60);
      expect(hook.result.current.hasNewer).toBe(true);
      await wake(realNow);
      await settle(60);
      expect(server.opened).toEqual([160]);
      expect(hook.result.current.hasNewer).toBe(true);
      expect(hook.result.current.connectionState).toBe("idle");
    } finally {
      Date.now = realNow;
      await hook.unmount();
    }
  });
});
