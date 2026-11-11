import { expect, test } from "bun:test";
import type { OpenGeniClient } from "../src/client";
import { createOpenGeniSiteAi } from "../src/site-ai";
import { streamSessionEvents, type StreamSessionEventsOptions } from "../src/stream";
import type {
  CreateSessionRequest,
  Session,
  SessionEvent,
  SessionEventListOptions,
  SessionEventPage,
} from "../src/types";

type SiteClient = Pick<
  OpenGeniClient,
  "createSession" | "getSession" | "listEventPage" | "streamEvents"
>;

function events(input: Array<Partial<SessionEvent>>): SessionEvent[] {
  return input.map((event, index) => ({
    id: `event-${index + 1}`,
    workspaceId: "site-host",
    sessionId: "session",
    sequence: index + 1,
    occurredAt: "2026-10-16T12:00:00Z",
    type: "session.event.envelope_omitted",
    payload: {},
    turnId: "turn",
    ...event,
  }));
}

function fixture(
  input: Array<Partial<SessionEvent>>,
  options: {
    snapshot?: Partial<Session> | ((read: number) => Partial<Session>);
    live?: Array<Partial<SessionEvent>>;
    pageSize?: number;
  } = {},
) {
  const log = events(input);
  const requests: CreateSessionRequest[] = [];
  const sessionReads: Parameters<OpenGeniClient["getSession"]>[] = [];
  const pageReads: SessionEventListOptions[] = [];
  const streamReads: StreamSessionEventsOptions[] = [];
  const client: SiteClient = {
    async createSession(_workspace, request) {
      requests.push(request);
      return { id: "session", initialTurnId: "turn" } as Awaited<
        ReturnType<SiteClient["createSession"]>
      >;
    },
    async getSession(...args) {
      sessionReads.push(args);
      const last = log.at(-1);
      const snapshot =
        typeof options.snapshot === "function"
          ? options.snapshot(sessionReads.length)
          : options.snapshot;
      return {
        id: "session",
        status: last?.type.startsWith("turn.")
          ? "idle"
          : last?.type === "session.requiresAction" || last?.type === "session.humanInput.requested"
            ? "requires_action"
            : "running",
        activeTurnId: "turn",
        lastSequence: last?.coveredThrough ?? last?.sequence ?? 0,
        ...snapshot,
      } as Session;
    },
    listEventPage: (async (
      _workspace: string,
      _session: string,
      query: SessionEventListOptions = {},
    ) => {
      pageReads.push(query);
      const remaining = log.filter(
        (event) =>
          event.sequence > (query.after ?? 0) && event.sequence < (query.before ?? Infinity),
      );
      const pageEvents = remaining.slice(
        0,
        Math.min(query.limit ?? 200, options.pageSize ?? Infinity),
      );
      const first = pageEvents[0]?.sequence;
      const last = pageEvents.at(-1);
      const through = last?.coveredThrough ?? last?.sequence ?? null;
      return {
        events: pageEvents,
        mode: "forensic",
        payloadMode: "full",
        direction: "after",
        bytes: 1,
        maxBytes: 1,
        truncated: remaining.length > pageEvents.length,
        hasMore: remaining.length > pageEvents.length,
        truncatedBy: remaining.length > pageEvents.length ? "bytes" : null,
        coveredSequence: first !== undefined && through !== null ? { first, last: through } : null,
        nextAfter: through,
        nextBefore: first ?? null,
        forensicExact: true,
      } satisfies SessionEventPage;
    }) as SiteClient["listEventPage"],
    async *streamEvents(_workspace, _session, query = {}) {
      streamReads.push(query);
      for (const event of events(options.live ?? [])) yield event;
    },
  };
  return {
    ai: createOpenGeniSiteAi(client, "site-host"),
    client,
    requests,
    sessionReads,
    pageReads,
    streamReads,
  };
}

test("inline input is unchanged and uses native create and event folding without UI", async () => {
  const { ai, requests } = fixture([
    { type: "agent.message.delta", payload: { text: '{"choice":', messageId: "a" } },
    { type: "agent.message.completed", payload: { text: '{"choice":2}', messageId: "a" } },
    { type: "turn.completed" },
  ]);
  const chunks: string[] = [];
  let handle: string | null = null;
  const input = JSON.stringify({ prompt: "Choose a route", context: { paths: ["a", "b"] } });
  const result = await ai.run(
    { initialMessage: input, idempotencyKey: "app-action-1" },
    {
      onSession: (id) => {
        handle = id;
      },
      onText: (text) => {
        chunks.push(text);
      },
    },
  );
  expect(requests).toEqual([{ initialMessage: input, idempotencyKey: "app-action-1" }]);
  expect(result).toEqual({
    sessionId: "session",
    turnId: "turn",
    text: '{"choice":2}',
    status: "completed",
    after: 3,
  });
  expect(chunks.join("")).toBe(result.text);
  expect(handle as string | null).toBe("session");
});

test("result replays without another create and ignores another turn's settlement", async () => {
  const { ai, requests } = fixture([
    { type: "turn.completed", turnId: "older" },
    { type: "agent.message.completed", payload: { text: "Answer" } },
    { type: "turn.completed" },
  ]);
  expect(await ai.result("session", { turnId: "turn" })).toMatchObject({
    text: "Answer",
    after: 3,
  });
  expect(requests).toHaveLength(0);
});

const waits = [
  {
    type: "session.requiresAction",
    payload: { approvals: [{ id: "approval", toolName: "tool", arguments: {} }] },
    decision: {
      type: "user.approvalDecision",
      payload: { approvalId: "approval", decision: "approve" },
    },
  },
  {
    type: "session.humanInput.requested",
    payload: {
      request: { id: "request", questions: [{ id: "q", kind: "text", prompt: "Input?" }] },
    },
    decision: {
      type: "user.humanInputResponse",
      payload: { requestId: "request", answers: { q: "yes" } },
    },
  },
] satisfies Array<Partial<SessionEvent> & { decision: Partial<SessionEvent> }>;

for (const wait of waits) {
  for (const redacted of [false, true]) {
    test(`resolved ${wait.type} replays through to the answer (${redacted ? "published" : "console"})`, async () => {
      const { ai, streamReads, pageReads } = fixture(
        [
          { type: "agent.message.completed", payload: { text: "Working", phase: "commentary" } },
          { type: wait.type, payload: redacted ? {} : wait.payload },
          redacted ? { type: "session.event.envelope_omitted", turnId: null } : wait.decision,
          { type: "agent.message.completed", payload: { text: "Answer", messageId: "answer" } },
          { type: "turn.completed" },
        ],
        { pageSize: 1 },
      );
      const chunks: string[] = [];
      expect(
        await ai.result("session", {
          onText: (text) => {
            chunks.push(text);
          },
        }),
      ).toMatchObject({
        status: "completed",
        text: "Answer",
        after: 5,
      });
      expect(chunks).toEqual(["Answer"]);
      expect(streamReads).toHaveLength(0);
      expect(pageReads).toHaveLength(5); // Short byte-bounded pages are not EOF.
    });
  }

  test(`genuinely pending redacted ${wait.type} uses fresh state, not payload details`, async () => {
    const { ai, sessionReads } = fixture([{ type: wait.type, payload: {} }]);
    expect(await ai.run({ initialMessage: "App-designed task" })).toMatchObject({
      status: "pending",
      turnId: "turn",
      text: "",
      after: 1,
    });
    expect(sessionReads).toHaveLength(2);
    expect(sessionReads.every(([, , options]) => options?.fresh && options.signal)).toBe(true);
  });
}

test("a wait resolving while replay is read does not settle early", async () => {
  const { ai, pageReads } = fixture(
    [
      { type: "session.requiresAction" },
      { type: "session.event.envelope_omitted", turnId: null },
      { type: "agent.message.completed", payload: { text: "Resolved" } },
      { type: "turn.completed" },
    ],
    {
      snapshot: (read) =>
        read === 1
          ? { status: "requires_action", lastSequence: 1 }
          : { status: "idle", lastSequence: 4 },
    },
  );
  expect(await ai.result("session")).toMatchObject({
    status: "completed",
    text: "Resolved",
    after: 4,
  });
  expect(pageReads.map((page) => page.after)).toEqual([0, 1]);
});

test("a genuine console wait retains commentary fallback through its status event", async () => {
  for (const wait of waits) {
    const { ai } = fixture(
      [
        {
          type: "agent.message.completed",
          payload: { text: "Need your input", phase: "commentary" },
        },
        { type: wait.type, payload: wait.payload },
        { type: "session.status.changed", payload: { status: "requires_action" } },
      ],
      { snapshot: { status: "requires_action" } },
    );
    const chunks: string[] = [];
    expect(
      await ai.result("session", {
        onText: (text) => {
          chunks.push(text);
        },
      }),
    ).toMatchObject({
      status: "pending",
      text: "Need your input",
      after: 3,
    });
    expect(chunks).toEqual(["Need your input"]);
  }
});

test("a stale requires-action status never overrides a durable terminal", async () => {
  const { ai } = fixture(
    [
      { type: "session.humanInput.requested" },
      { type: "agent.message.completed", payload: { text: "Done" } },
      { type: "turn.completed" },
    ],
    { snapshot: { status: "requires_action" } },
  );
  expect(await ai.result("session")).toMatchObject({ status: "completed", text: "Done" });
});

test("a resolved wait with a still-running turn continues through native streaming", async () => {
  const { ai, streamReads } = fixture(
    [{ type: "session.requiresAction" }, { type: "session.event.envelope_omitted", turnId: null }],
    {
      snapshot: { status: "running" },
      live: [
        { sequence: 3, type: "agent.message.completed", payload: { text: "Live answer" } },
        { sequence: 4, type: "turn.completed" },
      ],
    },
  );
  expect(await ai.result("session")).toMatchObject({ status: "completed", text: "Live answer" });
  expect(streamReads[0]?.after).toBe(2);
  expect(streamReads[0]?.signal?.aborted).toBe(true);
});

test("a historical live wait is reconciled against the durable replay before pending", async () => {
  const { ai, streamReads } = fixture(
    [
      { type: "session.requiresAction" },
      { type: "agent.message.completed", payload: { text: "Already answered" } },
      { type: "turn.completed" },
    ],
    {
      snapshot: (read) => ({
        status: read === 1 ? "running" : "idle",
        lastSequence: read === 1 ? 0 : 3,
      }),
      live: [{ type: "session.requiresAction" }],
    },
  );
  expect(await ai.result("session")).toMatchObject({
    status: "completed",
    text: "Already answered",
  });
  expect(streamReads).toHaveLength(1);
  expect(streamReads[0]?.signal?.aborted).toBe(true);
});

test("failures stay failures; cancellation and aborted observation are distinct", async () => {
  const failed = fixture([{ type: "turn.failed", payload: { code: "site_budget_exhausted" } }]);
  await expect(failed.ai.result("session")).rejects.toMatchObject({
    code: "site_budget_exhausted",
  });
  expect(await fixture([{ type: "turn.cancelled" }]).ai.result("session")).toMatchObject({
    status: "cancelled",
  });
  const stopped = fixture([]);
  await expect(
    stopped.ai.run({ initialMessage: "Never send" }, { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(stopped.requests).toHaveLength(0);
  expect(stopped.sessionReads).toHaveLength(0);
});

test("inline helper does not forward runtime authority or invent prompts", async () => {
  const { ai, requests } = fixture([{ type: "turn.completed" }]);
  await ai.run({
    initialMessage: "x",
    model: "viewer-model",
    tools: [{ id: "private" }],
  } as Parameters<typeof ai.run>[0]);
  expect(requests[0]).toMatchObject({ initialMessage: "x", model: "viewer-model" });
  expect(requests[0]).not.toHaveProperty("tools");
});

test("cursor resume primes the fold so a completed full snapshot emits only its suffix", async () => {
  for (const turnId of [undefined, "turn"]) {
    const { ai, pageReads } = fixture([
      { type: "agent.message.delta", payload: { text: "Earlier ", messageId: "answer" } },
      { type: "agent.message.completed", payload: { text: "Earlier later", messageId: "answer" } },
      { type: "turn.completed" },
    ]);
    const chunks: string[] = [];
    expect(
      await ai.result("session", {
        after: 1,
        ...(turnId ? { turnId } : {}),
        onText: (text) => {
          chunks.push(text);
        },
      }),
    ).toMatchObject({
      text: "later",
      after: 3,
      status: "completed",
    });
    expect(chunks).toEqual(["later"]);
    expect(pageReads).toEqual([
      {
        after: 0,
        before: 2,
        direction: "after",
        limit: 200,
        mode: "forensic",
        payloadMode: "full",
      },
      {
        after: 1,
        before: 4,
        direction: "after",
        limit: 200,
        mode: "forensic",
        payloadMode: "full",
      },
    ]);
  }
});

test("cursor replay retains message boundaries without replaying earlier callbacks", async () => {
  const { ai } = fixture(
    [
      { type: "agent.message.completed", payload: { text: "First", messageId: "one" } },
      { type: "agent.message.delta", payload: { text: "Sec", messageId: "two" } },
      { type: "agent.message.completed", payload: { text: "Second", messageId: "two" } },
      { type: "turn.completed" },
    ],
    { pageSize: 1 },
  );
  const chunks: string[] = [];
  expect(
    await ai.result("session", {
      after: 2,
      turnId: "turn",
      onText: (text) => {
        chunks.push(text);
      },
    }),
  ).toMatchObject({ text: "ond" });
  expect(chunks).toEqual(["ond"]);
});

test("resume skips covered envelopes and other turns but retains native coveredThrough", async () => {
  const { ai, streamReads } = fixture(
    [
      {
        sequence: 1,
        type: "agent.message.delta",
        payload: { text: "Earlier ", messageId: "answer" },
      },
      { sequence: 2, coveredThrough: 7, turnId: null },
    ],
    {
      snapshot: { status: "running" },
      live: [
        { sequence: 8, coveredThrough: 12, turnId: null },
        { sequence: 13, type: "turn.failed", turnId: "other" },
        {
          sequence: 14,
          type: "agent.message.completed",
          turnId: "other",
          payload: { text: "Not yours" },
        },
        {
          sequence: 15,
          type: "agent.message.completed",
          payload: { text: "Earlier later", messageId: "answer" },
        },
        { sequence: 16, coveredThrough: 18, type: "turn.completed" },
      ],
    },
  );
  const chunks: string[] = [];
  expect(
    await ai.result("retained", {
      after: 7,
      turnId: "turn",
      onText: (text) => {
        chunks.push(text);
      },
    }),
  ).toEqual({
    sessionId: "retained",
    turnId: "turn",
    text: "later",
    status: "completed",
    after: 18,
  });
  expect(chunks).toEqual(["later"]);
  expect(streamReads[0]?.after).toBe(7);
});

test("another turn's current wait cannot settle the retained turn", async () => {
  const { ai } = fixture([{ type: "session.requiresAction", turnId: "other" }], {
    snapshot: { status: "requires_action", activeTurnId: "other" },
    live: [{ sequence: 2, type: "turn.completed" }],
  });
  expect(await ai.result("session", { turnId: "turn" })).toMatchObject({
    status: "completed",
    turnId: "turn",
    after: 2,
  });
});

test("native SSE frame coverage is retained even without a coveredThrough payload field", async () => {
  const { ai, client } = fixture([]);
  const log = events([
    { sequence: 1, type: "agent.message.delta", payload: { text: "Answer" } },
    { sequence: 4, type: "turn.completed" },
  ]);
  client.streamEvents = (_workspace, _session, options) =>
    streamSessionEvents(
      {
        async openStream() {
          return new Response(
            log
              .map(
                (event, index) => `id: ${index === 0 ? 3 : 7}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
          ).body!;
        },
        async listEvents() {
          return [];
        },
      },
      { ...options, reconnect: false },
    );
  expect(await ai.result("session")).toMatchObject({
    text: "Answer",
    status: "completed",
    after: 7,
  });
});

test("a cursor before a new turn does not bind to an omitted envelope's turn", async () => {
  const { ai } = fixture([
    { type: "turn.completed", turnId: "old" },
    { type: "session.event.envelope_omitted", turnId: "old" },
    { type: "agent.message.completed", payload: { text: "New answer" } },
    { type: "turn.completed" },
  ]);
  expect(await ai.result("session", { after: 1 })).toMatchObject({
    status: "completed",
    text: "New answer",
    turnId: "turn",
  });
});

test("status-only pending projections retain the session's active turn identity", async () => {
  const { ai } = fixture([], { snapshot: { status: "requires_action", activeTurnId: "turn" } });
  expect(await ai.result("session")).toMatchObject({ status: "pending", turnId: "turn" });
});

test("an exhausted stream and a non-advancing replay page fail instead of claiming completion", async () => {
  await expect(fixture([]).ai.result("session")).rejects.toThrow("ended before the turn settled");
  const { ai } = fixture([], { snapshot: { lastSequence: 1 } });
  await expect(ai.result("session")).rejects.toThrow("replay did not reach the session cursor");
});

test("terminal delivery aborts upstream before non-awaited iterator return", async () => {
  const { ai, client } = fixture([]);
  let returned = false;
  let signal: AbortSignal | undefined;
  client.streamEvents = (_workspace, _session, options = {}) => {
    signal = options.signal;
    const iterator = (async function* () {
      yield events([{ type: "turn.completed" }])[0]!;
    })();
    iterator.return = () => {
      expect(signal?.aborted).toBe(true);
      returned = true;
      return new Promise(() => {}); // Cancelling the body must not hold up the result.
    };
    return iterator;
  };
  expect(await ai.result("session")).toMatchObject({ status: "completed" });
  expect(returned).toBe(true);
  expect(signal?.aborted).toBe(true);
});

test("abort interrupts observation with a pending iterator read and never controls the session", async () => {
  const { ai, client, requests } = fixture([]);
  const controller = new AbortController();
  const reason = new Error("stop observing");
  let returned = false;
  let handle: string | undefined;
  client.streamEvents = (_workspace, _session, options = {}) => {
    const iterator = (async function* () {
      yield events([{ type: "turn.completed" }])[0]!;
    })();
    iterator.next = () => {
      controller.abort(reason);
      return new Promise(() => {});
    };
    iterator.return = () => {
      expect(options.signal?.aborted).toBe(true);
      returned = true;
      return new Promise(() => {});
    };
    return iterator;
  };
  await expect(
    ai.run(
      { initialMessage: "Keep working" },
      {
        signal: controller.signal,
        onSession: (id) => {
          handle = id;
        },
      },
    ),
  ).rejects.toBe(reason);
  expect(handle).toBe("session");
  expect(requests).toHaveLength(1);
  expect(returned).toBe(true);
});

test("abort during a native page read settles observation even though the API has no page signal", async () => {
  const { ai, client } = fixture([{ type: "turn.completed" }]);
  const controller = new AbortController();
  const reason = new Error("page observation stopped");
  client.listEventPage = () => {
    controller.abort(reason);
    return new Promise<never>(() => {});
  };
  await expect(ai.result("session", { signal: controller.signal })).rejects.toBe(reason);
});

test("abort during the fresh session read promptly stops observation", async () => {
  const { ai, client } = fixture([]);
  const controller = new AbortController();
  const reason = new Error("session observation stopped");
  let upstream: AbortSignal | undefined;
  client.getSession = (_workspace, _session, options = {}) => {
    upstream = options.signal;
    controller.abort(reason);
    return new Promise(() => {});
  };
  await expect(ai.result("session", { signal: controller.signal })).rejects.toBe(reason);
  expect(upstream?.aborted).toBe(true);
});
