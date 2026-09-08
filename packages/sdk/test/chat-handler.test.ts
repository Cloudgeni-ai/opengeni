import { describe, expect, test } from "bun:test";
import {
  CHAT_CONVERSATION_HEADER,
  CHAT_FORMAT_HEADER,
  chatSessionId,
  createChatHandler,
  parseChatChunkStream,
  UI_MESSAGE_STREAM_HEADER,
  type ChatChunk,
  type ChatResolve,
} from "../src/chat";
import { openResolvedChat } from "../src/chat/http";
import { fakeServer, readBody } from "./chat-helpers";
import { collect, WORKSPACE_ID } from "./helpers";

const ENDPOINT = "https://product.example.test/api/chat";

function post(body: unknown, headers: Record<string, string> = {}, path = ""): Request {
  return new Request(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const resolveAcme: ChatResolve = async () => ({
  tenant: "acme",
  user: "u_42",
  conversation: "c_9",
});

describe("createChatHandler", () => {
  test("rejects methods other than GET and POST with 405 and an Allow header", async () => {
    const handler = createChatHandler(fakeServer().og, { resolve: resolveAcme });
    const response = await handler(new Request(ENDPOINT, { method: "DELETE" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
    expect(await response.json()).toMatchObject({ error: { code: "method_not_allowed" } });
  });

  test("returns 400 when the host resolves neither a conversation nor a user", async () => {
    const handler = createChatHandler(fakeServer().og, {
      resolve: async () => ({ tenant: "acme" }),
    });
    const response = await handler(post({ message: "hi" }, { [CHAT_CONVERSATION_HEADER]: "c_9" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conversation_required",
        message:
          "Return a conversation from resolve, or a user so client conversation ids are scoped to that user.",
      },
    });
  });

  test("a header-only conversation streams when the host names the user", async () => {
    const server = fakeServer();
    const handler = createChatHandler(server.og, {
      resolve: async () => ({ tenant: "acme", user: "u_42" }),
    });
    const response = await handler(post({ message: "hi" }, { [CHAT_CONVERSATION_HEADER]: "c_9" }));
    expect(response.status).toBe(200);
    const chunks = await collect(parseChatChunkStream(response.body!));
    expect(chunks.at(-1)).toMatchObject({ type: "done", reply: { text: "Hello" } });
    expect(server.creates[0]!.requestedSessionId).toBe(
      await chatSessionId(WORKSPACE_ID, "c_9", { source: "app", id: "u_42" }),
    );
    expect(server.creates[0]!.endUser).toEqual({ source: "app", id: "u_42" });

    const missing = await handler(post({ message: "hi" }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "conversation_required" } });
  });

  test("GET returns the conversation history, created: false before the first message", async () => {
    const server = fakeServer();
    const handler = createChatHandler(server.og, {
      resolve: async () => ({ tenant: "acme", user: "u_42" }),
    });
    const get = (headers: Record<string, string> = {}) =>
      handler(new Request(ENDPOINT, { method: "GET", headers }));

    const before = await get({ [CHAT_CONVERSATION_HEADER]: "c_9" });
    expect(before.status).toBe(200);
    expect(before.headers.get("Content-Type")).toContain("application/json");
    expect(await before.json()).toEqual({
      conversation: "c_9",
      sessionId: await chatSessionId(WORKSPACE_ID, "c_9", { source: "app", id: "u_42" }),
      created: false,
      messages: [],
    });
    expect(server.creates).toHaveLength(0);

    await readBody(await handler(post({ message: "hi" }, { [CHAT_CONVERSATION_HEADER]: "c_9" })));
    const after = (await (await get({ [CHAT_CONVERSATION_HEADER]: "c_9" })).json()) as {
      created: boolean;
      messages: Array<{ role: string; text: string; sequence: number }>;
    };
    expect(after.created).toBe(true);
    expect(after.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello"],
    ]);

    const unnamed = await get();
    expect(unnamed.status).toBe(400);
    expect(await unnamed.json()).toMatchObject({ error: { code: "conversation_required" } });
    const respond = await handler(new Request(`${ENDPOINT}/respond`, { method: "GET" }));
    expect(respond.status).toBe(405);
  });

  test("returns 400 when the body has no message", async () => {
    const handler = createChatHandler(fakeServer().og, { resolve: resolveAcme });
    const response = await handler(post({ conversation: "from-body" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "message_required" } });
  });

  test("passes through a Response returned by resolve", async () => {
    const handler = createChatHandler(fakeServer().og, {
      resolve: async () => new Response("nope", { status: 401 }),
    });
    const response = await handler(post({ message: "hi" }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("nope");
  });

  test("streams the native chunk format and identifies it in a header", async () => {
    const server = fakeServer();
    const handler = createChatHandler(server.og, { resolve: resolveAcme });
    const response = await handler(post({ message: "hi", tenant: "evil", conversation: "evil" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get(CHAT_FORMAT_HEADER)).toBe("native");
    const chunks = await collect(parseChatChunkStream(response.body!));
    expect(chunks.slice(0, 2)).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
    ]);
    const done = chunks.at(-1) as Extract<ChatChunk, { type: "done" }>;
    expect(done.reply.text).toBe("Hello");
    // Identity came from resolve, never from the body.
    expect(server.creates[0]!.endUser).toEqual({ source: "app", id: "u_42" });
    expect(server.requestsTo("PUT", "/v1/workspaces/external")[0]!.json().externalId).toBe("acme");
  });

  test("a failed turn becomes an error event the native reader throws", async () => {
    const server = fakeServer({
      reply: () => [{ type: "turn.failed", payload: { error: "boom", code: "provider_error" } }],
    });
    const handler = createChatHandler(server.og, { resolve: resolveAcme });
    const response = await handler(post({ message: "hi" }));
    const body = await readBody(response);
    expect(body).toContain("event: error");
    await expect(collect(parseChatChunkStream(new Response(body).body!))).rejects.toMatchObject({
      code: "provider_error",
      message: "boom",
    });
  });

  test("dispatches on the format option and the per-request header", async () => {
    const server = fakeServer();
    const vercel = createChatHandler(server.og, { resolve: resolveAcme, format: "vercel" });
    const vercelResponse = await vercel(
      post({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    );
    expect(vercelResponse.headers.get(UI_MESSAGE_STREAM_HEADER)).toBe("v1");

    const native = createChatHandler(server.og, { resolve: resolveAcme });
    const openai = await native(
      post(
        { messages: [{ role: "user", content: "hi" }] },
        { [CHAT_FORMAT_HEADER]: "openai-chat" },
      ),
    );
    expect(openai.headers.get("Content-Type")).toContain("application/json");
    expect(await openai.json()).toMatchObject({ object: "chat.completion" });

    const responses = await native(
      post({ input: "hi" }, { [CHAT_FORMAT_HEADER]: "openai-responses" }),
    );
    expect(await responses.json()).toMatchObject({ object: "response", output_text: "Hello" });

    const unknown = await native(post({ message: "hi" }, { [CHAT_FORMAT_HEADER]: "soap" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown_format" } });
  });

  test("POST .../respond answers a pending approval and streams the continuation", async () => {
    const server = fakeServer({
      reply: () => [
        {
          type: "session.requiresAction",
          payload: { approvals: [{ name: "delete_file", rawItem: { callId: "call_9" } }] },
        },
      ],
      continuation: () => [
        { type: "agent.message.delta", payload: { text: "Done." } },
        { type: "turn.completed", payload: {} },
      ],
    });
    const handler = createChatHandler(server.og, { resolve: resolveAcme });
    const first = await collect(
      parseChatChunkStream((await handler(post({ message: "hi" }))).body!),
    );
    expect(first[0]).toMatchObject({
      type: "pending",
      pending: { kind: "approval", requestId: "call_9" },
    });

    const continued = await handler(
      post({ requestId: "call_9", decision: "approve" }, {}, "/respond"),
    );
    expect(continued.status).toBe(200);
    const chunks = await collect(parseChatChunkStream(continued.body!));
    expect(chunks[0]).toEqual({ type: "text", text: "Done." });
    expect(chunks.at(-1)).toMatchObject({
      type: "done",
      reply: { text: "Done.", status: "completed" },
    });

    const invalid = await handler(post({ requestId: "call_9" }, {}, "/respond"));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "respond_input_invalid" } });
  });
});

describe("openResolvedChat", () => {
  const opened = (result: Awaited<ReturnType<typeof openResolvedChat>>) =>
    "chat" in result && result.chat ? result.chat : null;

  test("requires a host-named conversation or a user for a client conversation id", async () => {
    const server = fakeServer();
    const neither = await openResolvedChat(server.og, { tenant: "acme" }, "c_9");
    expect(neither.response?.status).toBe(400);
    expect(await neither.response!.json()).toMatchObject({
      error: { code: "conversation_required" },
    });

    const scoped = opened(
      await openResolvedChat(server.og, { tenant: "acme", user: "u_42" }, "c_9"),
    );
    expect(scoped?.conversation).toBe("c_9");
    expect(scoped?.sessionId).toBe(
      await chatSessionId(WORKSPACE_ID, "c_9", { source: "app", id: "u_42" }),
    );

    const named = opened(
      await openResolvedChat(server.og, { tenant: "acme", conversation: "host" }, "c_9"),
    );
    expect(named?.conversation).toBe("host");
    expect(named?.sessionId).toBe(await chatSessionId(WORKSPACE_ID, "host"));

    const unsent = await openResolvedChat(server.og, { tenant: "acme", user: "u_42" }, undefined);
    expect(unsent.response?.status).toBe(400);
  });
});
