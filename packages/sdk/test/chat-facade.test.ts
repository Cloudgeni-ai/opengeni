import { describe, expect, test } from "bun:test";
import {
  CHAT_SESSION_NAMESPACE,
  chatIdempotencyKey,
  chatSessionId,
  OpenGeniChatError,
  uuidV5,
  type ChatChunk,
} from "../src/chat";
import { OPENGENI_API_CONTRACT_HEADER } from "../src/types";
import { fakeServer, helloReply, ORGANIZATION_ID, type ScriptedEvent } from "./chat-helpers";
import { collect, WORKSPACE_ID } from "./helpers";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("chat identities", () => {
  test("uuidV5 matches the RFC 4122 DNS example", async () => {
    await expect(uuidV5("hello.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).resolves.toBe(
      "fdda765f-fc57-5604-a269-52a7df8164ec",
    );
  });

  test("two chat() calls for one conversation address one session and cache the tenant workspace", async () => {
    const server = fakeServer();
    const first = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const second = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const other = await server.og.chat({ tenant: "acme", conversation: "c_10" });

    expect(first.sessionId).toMatch(UUID_V5);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionId).toBe(await chatSessionId(WORKSPACE_ID, "c_9"));
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(first.workspaceId).toBe(WORKSPACE_ID);
    expect(first.created).toBe(false);

    const ensures = server.requestsTo("PUT", "/v1/workspaces/external");
    expect(ensures).toHaveLength(1);
    expect(ensures[0]!.json()).toEqual({
      accountId: ORGANIZATION_ID,
      externalSource: "app",
      externalId: "acme",
      name: "acme",
    });
    expect(ensures[0]!.headers[OPENGENI_API_CONTRACT_HEADER]).toBeString();
    expect(ensures[0]!.headers.authorization).toBe("Bearer og_test_key");
    expect(server.requestsTo("GET", `/sessions/${first.sessionId}`)).toHaveLength(2);
  });

  test("the session id differs per user for one conversation and matches the RFC v5 derivation", async () => {
    const server = fakeServer();
    const anonymous = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const alice = await server.og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
    const bob = await server.og.chat({ tenant: "acme", user: "u_43", conversation: "c_9" });

    expect(alice.sessionId).not.toBe(anonymous.sessionId);
    expect(alice.sessionId).not.toBe(bob.sessionId);
    expect(alice.sessionId).toBe(
      await uuidV5(`${WORKSPACE_ID}:app:u_42:c_9`, CHAT_SESSION_NAMESPACE),
    );
    expect(alice.sessionId).toBe(
      await chatSessionId(WORKSPACE_ID, "c_9", { source: "app", id: "u_42" }),
    );
    expect(anonymous.sessionId).toBe(await uuidV5(`${WORKSPACE_ID}:c_9`, CHAT_SESSION_NAMESPACE));
    expect(chatIdempotencyKey("c_9", { source: "app", id: "u_42" })).toBe("chat:app:u_42:c_9");
    expect(chatIdempotencyKey("c_9")).toBe("chat:c_9");
  });
});

describe("Chat.send", () => {
  test("creates the session on the first send with facade fields, identity, and idempotency", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
    const reply = await chat.send("hello");

    expect(reply.text).toBe("Hello");
    expect(String(reply)).toBe("Hello");
    expect(reply.status).toBe("completed");
    expect(reply.turnId).toBe("turn-1");
    expect(reply.pending).toBeNull();
    expect(reply.sessionId).toBe(chat.sessionId);
    expect(reply.workspaceId).toBe(WORKSPACE_ID);
    expect(reply.events.map((event) => event.type)).toContain("agent.message.completed");
    expect(chat.created).toBe(true);

    expect(server.creates).toHaveLength(1);
    expect(server.creates[0]).toEqual({
      agentAccess: "session",
      memoryScope: "session",
      endUser: { source: "app", id: "u_42" },
      initialMessage: "hello",
      requestedSessionId: chat.sessionId,
      idempotencyKey: "chat:app:u_42:c_9",
    });
    const stream = server.requestsTo("GET", "/events/stream");
    expect(stream).toHaveLength(1);
    expect(new URL(stream[0]!.url).searchParams.get("after")).toBe("0");
  });

  test("imported history lands in modelContext of the create body only once", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const importedHistory = [
      { role: "system" as const, text: "Be terse." },
      { role: "user" as const, text: "Earlier question" },
      { role: "assistant" as const, text: "Earlier answer" },
    ];
    await chat.send("hello", { importedHistory });
    expect(server.creates[0]!.modelContext).toBe(
      [
        "Earlier conversation imported from the product, oldest first:",
        "system: Be terse.",
        "user: Earlier question",
        "assistant: Earlier answer",
      ].join("\n"),
    );
    expect(server.creates[0]!.initialMessage).toBe("hello");

    await chat.send("again", { importedHistory });
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")[0]!.json()).toEqual({
      type: "user.message",
      payload: { text: "again" },
    });
  });

  test("imported history is truncated from the oldest end and yields to an explicit modelContext", async () => {
    const server = fakeServer();
    const oldest = "a".repeat(20_000);
    const newest = "b".repeat(20_000);
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    await chat.send("hello", {
      importedHistory: [
        { role: "user", text: oldest },
        { role: "assistant", text: newest },
      ],
    });
    const context = server.creates[0]!.modelContext!;
    expect(context.length).toBeLessThanOrEqual(30_000);
    expect(context).toContain(`assistant: ${newest}`);
    expect(context).not.toContain("aaaa");

    const explicit = await server.og.chat({
      tenant: "acme",
      conversation: "c_10",
      create: { modelContext: "host context" },
    });
    await explicit.send("hello", { importedHistory: [{ role: "user", text: "ignored" }] });
    expect(server.creates[1]!.modelContext).toBe("host context");

    const empty = await server.og.chat({ tenant: "acme", conversation: "c_11" });
    await empty.send("hello", { importedHistory: [] });
    expect(server.creates[2]!.modelContext).toBeUndefined();
  });

  test("a later send posts user.message and streams after the accepted sequence", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    await chat.send("hello");
    const reply = await chat.send("again");

    expect(reply.text).toBe("Hello");
    expect(reply.turnId).toBe("turn-2");
    const posts = server.requestsTo("POST", "/events");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.json()).toEqual({ type: "user.message", payload: { text: "again" } });
    const streams = server.requestsTo("GET", "/events/stream");
    const acceptedSequence = server.sessions
      .get(chat.sessionId)!
      .events.find((event) => event.type === "user.message" && event.turnId === "turn-2")!.sequence;
    expect(new URL(streams[1]!.url).searchParams.get("after")).toBe(String(acceptedSequence));
  });

  test("a chat opened in a new process sends instead of creating when the session exists", async () => {
    const server = fakeServer();
    await (await server.og.chat({ tenant: "acme", conversation: "c_9" })).send("hello");
    const resumed = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    expect(resumed.created).toBe(true);
    await resumed.send("again");
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")).toHaveLength(1);
  });

  test("memory defaults follow agentAccess, false maps to off, and user memory requires a user", async () => {
    const server = fakeServer();
    await (
      await server.og.chat({ tenant: "acme", user: "u_1", conversation: "a", agentAccess: "user" })
    ).send("x");
    await (
      await server.og.chat({
        tenant: "acme",
        conversation: "b",
        agentAccess: "workspace",
        memory: false,
      })
    ).send("x");
    await (
      await server.og.chat({ tenant: "acme", conversation: "c", memory: "workspace" })
    ).send("x");
    expect(server.creates.map((create) => [create.agentAccess, create.memoryScope])).toEqual([
      ["user", "user"],
      ["workspace", "off"],
      ["session", "workspace"],
    ]);
    expect(server.creates[1]!.endUser).toBeUndefined();

    const failure = server.og.chat({ tenant: "acme", conversation: "d", memory: "user" });
    await expect(failure).rejects.toBeInstanceOf(OpenGeniChatError);
    await expect(failure).rejects.toMatchObject({ code: "memory_scope_requires_user" });
  });

  test("create passthrough wins over facade fields but never over the message or identity", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({
      workspaceId: WORKSPACE_ID,
      conversation: "c_9",
      model: "facade-model",
      instructions: "Be brief.",
      create: {
        model: "explicit-model",
        sandboxBackend: "none",
        requestedSessionId: "not-this",
        idempotencyKey: "not-this",
        initialMessage: "not-this",
      },
    });
    await chat.send("hello");
    expect(server.creates[0]).toMatchObject({
      model: "explicit-model",
      instructions: "Be brief.",
      sandboxBackend: "none",
      initialMessage: "hello",
      requestedSessionId: chat.sessionId,
      idempotencyKey: "chat:c_9",
    });
    expect(server.requestsTo("PUT", "/v1/workspaces/external")).toHaveLength(0);
  });

  test("a failed turn throws OpenGeniChatError carrying the failure code and event", async () => {
    const server = fakeServer({
      reply: () => [
        { type: "agent.message.delta", payload: { text: "partial" } },
        { type: "turn.failed", payload: { error: "boom", code: "provider_error" } },
      ],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const failure = chat.send("hello");
    await expect(failure).rejects.toBeInstanceOf(OpenGeniChatError);
    await expect(failure).rejects.toMatchObject({
      code: "provider_error",
      message: "boom",
      event: { type: "turn.failed" },
    });
  });

  test("a cancelled turn resolves with the text so far and status cancelled", async () => {
    const server = fakeServer({
      reply: () => [
        { type: "agent.message.delta", payload: { text: "half" } },
        { type: "turn.cancelled", payload: {} },
      ],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const reply = await chat.send("hello");
    expect(reply).toMatchObject({ text: "half", status: "cancelled" });
  });

  test("settlement of another turn never ends the reply early", async () => {
    const server = fakeServer({
      reply: ({ turnId }) => [
        { type: "turn.completed", payload: {}, turnId: "turn-stale" },
        { type: "agent.message.delta", payload: { text: "ok" }, turnId },
        { type: "turn.completed", payload: {}, turnId },
      ],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const reply = await chat.send("hello");
    expect(reply.text).toBe("ok");
    expect(reply.events.some((event) => event.turnId === "turn-stale")).toBe(false);
  });
});

describe("Chat.stream", () => {
  test("yields tool and text chunks in order and ends with done", async () => {
    const server = fakeServer({
      reply: () => [
        {
          type: "agent.toolCall.created",
          payload: { id: "call_1", name: "search", arguments: { q: "x" } },
        },
        { type: "agent.toolCall.output", payload: { id: "call_1", output: { isError: true } } },
        ...helloReply(),
      ],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const chunks = await collect(chat.stream("hello"));
    expect(chunks.slice(0, -1)).toEqual([
      { type: "tool", name: "search", status: "started", callId: "call_1", input: { q: "x" } },
      { type: "tool", name: "search", status: "failed", callId: "call_1" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ]);
    const done = chunks.at(-1) as Extract<ChatChunk, { type: "done" }>;
    expect(done.type).toBe("done");
    expect(done.reply.text).toBe("Hello");
  });

  test("a completed text that extends the streamed deltas emits only the remainder", async () => {
    const server = fakeServer({
      reply: () => [
        { type: "agent.message.delta", payload: { text: "Hel" } },
        { type: "agent.message.completed", payload: { text: "Hello there" } },
        { type: "turn.completed", payload: {} },
      ],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const chunks = await collect(chat.stream("hello"));
    expect(chunks.filter((chunk) => chunk.type === "text")).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo there" },
    ]);
  });

  test("an aborted stream rejects with AbortError", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(chat.stream("hello", { signal: controller.signal })),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("Chat pending actions", () => {
  const approvalReply = (): ScriptedEvent[] => [
    { type: "agent.message.delta", payload: { text: "May I?" } },
    {
      type: "session.requiresAction",
      payload: {
        approvals: [
          { name: "delete_file", rawItem: { callId: "call_9", arguments: { path: "x" } } },
        ],
      },
    },
  ];

  test("an approval wait resolves with pending and respond streams the continuation", async () => {
    const server = fakeServer({
      reply: approvalReply,
      continuation: ({ type, payload }) =>
        type === "user.approvalDecision" && payload.decision === "approve"
          ? [
              { type: "agent.message.delta", payload: { text: "Done." } },
              { type: "turn.completed", payload: {} },
            ]
          : [],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const reply = await chat.send("delete it");
    expect(reply.status).toBe("pending");
    expect(reply.text).toBe("May I?");
    expect(reply.pending).toMatchObject({
      kind: "approval",
      requestId: "call_9",
      name: "delete_file",
    });

    const continued = await chat.respond({ requestId: "call_9", decision: "approve" });
    expect(continued.text).toBe("Done.");
    expect(continued.status).toBe("completed");
    expect(continued.turnId).toBe("turn-1");
    const posts = server.requestsTo("POST", "/events");
    expect(posts.at(-1)!.json()).toEqual({
      type: "user.approvalDecision",
      payload: { approvalId: "call_9", decision: "approve" },
    });
  });

  test("a human-input wait maps answers and skip to user.humanInputResponse", async () => {
    const server = fakeServer({
      reply: () => [
        {
          type: "session.humanInput.requested",
          payload: {
            request: {
              id: "hi_1",
              questions: [{ id: "q1", prompt: "Which?", kind: "text", options: [] }],
              allowSkip: true,
            },
          },
        },
      ],
      continuation: () => [{ type: "turn.completed", payload: {} }],
    });
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    const reply = await chat.send("ask me");
    expect(reply.pending).toMatchObject({ kind: "human_input", requestId: "hi_1", name: null });

    await chat.respond({ requestId: "hi_1", answers: [{ questionId: "q1", values: ["a"] }] });
    expect(server.requestsTo("POST", "/events").at(-1)!.json()).toEqual({
      type: "user.humanInputResponse",
      payload: {
        requestId: "hi_1",
        response: { outcome: "answered", answers: [{ questionId: "q1", values: ["a"] }] },
      },
    });
    await chat.respond({ requestId: "hi_1", skip: true });
    expect(server.requestsTo("POST", "/events").at(-1)!.json()).toEqual({
      type: "user.humanInputResponse",
      payload: { requestId: "hi_1", response: { outcome: "skipped" } },
    });
  });
});

describe("Chat.steer, history, sessions.list, chatBySessionId", () => {
  test("steer posts to the steer route and folds the accepted turn", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    await chat.send("hello");
    const reply = await chat.steer("actually, stop");
    expect(reply.text).toBe("Hello");
    expect(reply.turnId).toBe("turn-2");
    expect(server.requestsTo("POST", "/steer")[0]!.json()).toEqual({ text: "actually, stop" });
  });

  test("history folds user and assistant text from the event log", async () => {
    const server = fakeServer();
    const chat = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    expect(await chat.history()).toEqual([]);
    await chat.send("hello");
    await chat.send("again");
    const history = await chat.history();
    expect(history.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Hello"],
      ["user", "again"],
      ["assistant", "Hello"],
    ]);
    expect(history.map((message) => message.sequence)).toEqual(
      [...history.map((message) => message.sequence)].sort((a, b) => a - b),
    );
    const page = server.requestsTo("GET", "/events").at(-1)!;
    expect(new URL(page.url).searchParams.get("includeTypes")).toBe(
      "user.message,agent.message.completed",
    );
  });

  test("sessions.list filters by the end-user label", async () => {
    const server = fakeServer({ source: "helpdesk" });
    await (await server.og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" })).send("hi");
    const sessions = await server.og.sessions.list({ tenant: "acme", user: "u_42", limit: 5 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endUser).toEqual({ source: "helpdesk", id: "u_42" });
    const list = server.requestsTo("GET", "/sessions").at(-1)!;
    const query = new URL(list.url).searchParams;
    expect(query.get("endUserSource")).toBe("helpdesk");
    expect(query.get("endUserId")).toBe("u_42");
    expect(query.get("limit")).toBe("5");
  });

  test("chatBySessionId addresses an existing session and rejects a missing one", async () => {
    const server = fakeServer();
    const original = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    await original.send("hello");
    const chat = await server.og.chatBySessionId({
      workspaceId: WORKSPACE_ID,
      sessionId: original.sessionId,
      user: null,
    });
    expect(chat.created).toBe(true);
    expect(chat.conversation).toBeNull();
    expect((await chat.send("again")).text).toBe("Hello");
    await expect(
      server.og.chatBySessionId({
        workspaceId: WORKSPACE_ID,
        sessionId: crypto.randomUUID(),
        user: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("chatBySessionId denies a session owned by another user and allows the same user", async () => {
    const server = fakeServer();
    const alice = await server.og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
    await alice.send("hello");
    const anonymous = await server.og.chat({ tenant: "acme", conversation: "c_9" });
    await anonymous.send("hello");

    const same = await server.og.chatBySessionId({
      workspaceId: WORKSPACE_ID,
      sessionId: alice.sessionId,
      user: "u_42",
    });
    expect(same.sessionId).toBe(alice.sessionId);

    const other = server.og.chatBySessionId({
      workspaceId: WORKSPACE_ID,
      sessionId: alice.sessionId,
      user: "u_43",
    });
    await expect(other).rejects.toBeInstanceOf(OpenGeniChatError);
    await expect(other).rejects.toMatchObject({ code: "conversation_not_authorized" });

    // A session without an end user is not this user's either.
    await expect(
      server.og.chatBySessionId({
        workspaceId: WORKSPACE_ID,
        sessionId: anonymous.sessionId,
        user: "u_42",
      }),
    ).rejects.toMatchObject({ code: "conversation_not_authorized" });
    expect(server.requestsTo("POST", "/events")).toHaveLength(0);
  });
});
