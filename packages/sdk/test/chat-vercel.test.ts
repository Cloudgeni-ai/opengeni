import { describe, expect, test } from "bun:test";
import {
  chatSessionId,
  handleVercelChatRequest,
  UI_MESSAGE_STREAM_HEADER,
  type ChatResolve,
} from "../src/chat";
import { fakeServer, readBody, sseDataLines } from "./chat-helpers";
import { WORKSPACE_ID } from "./helpers";

const ENDPOINT = "https://product.example.test/api/chat";

function useChatRequest(body: unknown): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const resolveTenant: ChatResolve = async () => ({ tenant: "acme", user: "u_42" });
const U_42 = { source: "app", id: "u_42" };

function parts(body: string): Array<Record<string, unknown>> {
  return sseDataLines(body)
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("handleVercelChatRequest", () => {
  test("streams the v1 UI message protocol for the last user message using the chat id as conversation", async () => {
    const server = fakeServer();
    const response = await handleVercelChatRequest(
      server.og,
      useChatRequest({
        id: "c_9",
        trigger: "submit-message",
        messages: [
          { id: "m0", role: "assistant", parts: [{ type: "text", text: "earlier" }] },
          {
            id: "m1",
            role: "user",
            parts: [
              { type: "text", text: "hello" },
              { type: "file", url: "x" },
              { type: "text", text: "world" },
            ],
          },
        ],
      }),
      resolveTenant,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(UI_MESSAGE_STREAM_HEADER)).toBe("v1");
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await readBody(response);
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    const types = parts(body).map((part) => part.type);
    expect(types).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    const deltas = parts(body).filter((part) => part.type === "text-delta");
    expect(deltas.map((part) => part.delta)).toEqual(["Hel", "lo"]);
    expect(
      new Set(
        parts(body)
          .filter((part) => "id" in part)
          .map((part) => part.id),
      ).size,
    ).toBe(1);
    expect(typeof parts(body)[0]!.messageId).toBe("string");

    expect(server.creates[0]!.initialMessage).toBe("hello\nworld");
    expect(server.creates[0]!.requestedSessionId).toBe(
      await chatSessionId(WORKSPACE_ID, "c_9", U_42),
    );
    expect(server.creates[0]!.modelContext).toBe(
      "Earlier conversation imported from the product, oldest first:\nassistant: earlier",
    );
  });

  test("imports the messages before the last user message only on the first create", async () => {
    const server = fakeServer();
    const history = [
      { id: "m0", role: "system", parts: [{ type: "text", text: "Be terse." }] },
      { id: "m1", role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "one" }] },
    ];
    await readBody(
      await handleVercelChatRequest(
        server.og,
        useChatRequest({
          id: "c_9",
          messages: [
            ...history,
            { id: "m3", role: "user", parts: [{ type: "text", text: "second" }] },
          ],
        }),
        resolveTenant,
      ),
    );
    expect(server.creates[0]).toMatchObject({
      initialMessage: "second",
      modelContext: [
        "Earlier conversation imported from the product, oldest first:",
        "system: Be terse.",
        "user: first",
        "assistant: one",
      ].join("\n"),
    });

    await readBody(
      await handleVercelChatRequest(
        server.og,
        useChatRequest({
          id: "c_9",
          messages: [
            ...history,
            { id: "m3", role: "user", parts: [{ type: "text", text: "second" }] },
            { id: "m4", role: "assistant", parts: [{ type: "text", text: "two" }] },
            { id: "m5", role: "user", parts: [{ type: "text", text: "third" }] },
          ],
        }),
        resolveTenant,
      ),
    );
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")[0]!.json()).toEqual({
      type: "user.message",
      payload: { text: "third" },
    });

    const fresh = fakeServer();
    await readBody(
      await handleVercelChatRequest(
        fresh.og,
        useChatRequest({
          id: "c_1",
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "only" }] }],
        }),
        resolveTenant,
      ),
    );
    expect(fresh.creates[0]!.modelContext).toBeUndefined();
  });

  test("the conversation header wins over the chat id when the host names only the user", async () => {
    const server = fakeServer();
    const request = new Request(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opengeni-conversation": "header_c" },
      body: JSON.stringify({
        id: "c_9",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      }),
    });
    await readBody(await handleVercelChatRequest(server.og, request, resolveTenant));
    expect(server.creates[0]!.requestedSessionId).toBe(
      await chatSessionId(WORKSPACE_ID, "header_c", U_42),
    );
  });

  test("the host's resolve can override the chat id and regenerate steers", async () => {
    const server = fakeServer();
    const resolve: ChatResolve = async () => ({ tenant: "acme", conversation: "host_c" });
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }];
    await readBody(
      await handleVercelChatRequest(server.og, useChatRequest({ id: "c_9", messages }), resolve),
    );
    expect(server.creates[0]!.requestedSessionId).toBe(await chatSessionId(WORKSPACE_ID, "host_c"));

    await readBody(
      await handleVercelChatRequest(
        server.og,
        useChatRequest({ id: "c_9", trigger: "regenerate-message", messages }),
        resolve,
      ),
    );
    expect(server.requestsTo("POST", "/steer")).toHaveLength(1);
  });

  test("a pending approval becomes a tool-approval-request part after its tool input", async () => {
    const server = fakeServer({
      reply: () => [
        { type: "agent.message.delta", payload: { text: "May I?" } },
        {
          type: "session.requiresAction",
          payload: {
            approvals: [
              { name: "delete_file", rawItem: { callId: "call_9", arguments: { path: "x" } } },
            ],
          },
        },
      ],
    });
    const body = await readBody(
      await handleVercelChatRequest(
        server.og,
        useChatRequest({
          id: "c_9",
          messages: [{ role: "user", parts: [{ type: "text", text: "go" }] }],
        }),
        resolveTenant,
      ),
    );
    const streamed = parts(body);
    expect(streamed.map((part) => part.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-approval-request",
      "finish-step",
      "finish",
    ]);
    expect(streamed[5]).toEqual({
      type: "tool-input-available",
      toolCallId: "call_9",
      toolName: "delete_file",
      input: { path: "x" },
    });
    expect(streamed[6]).toEqual({
      type: "tool-approval-request",
      toolCallId: "call_9",
      approvalId: "call_9",
    });
  });

  test("tool calls map to tool-input and tool-output parts", async () => {
    const server = fakeServer({
      reply: () => [
        {
          type: "agent.toolCall.created",
          payload: { id: "call_1", name: "search", arguments: { q: 1 } },
        },
        { type: "agent.toolCall.output", payload: { id: "call_1", output: "ok" } },
        { type: "agent.message.completed", payload: { text: "Found it." } },
        { type: "turn.completed", payload: {} },
      ],
    });
    const body = await readBody(
      await handleVercelChatRequest(
        server.og,
        useChatRequest({
          id: "c_9",
          messages: [{ role: "user", parts: [{ type: "text", text: "go" }] }],
        }),
        resolveTenant,
      ),
    );
    const streamed = parts(body);
    expect(streamed.slice(2, 5)).toEqual([
      { type: "tool-input-start", toolCallId: "call_1", toolName: "search" },
      { type: "tool-input-available", toolCallId: "call_1", toolName: "search", input: { q: 1 } },
      { type: "tool-output-available", toolCallId: "call_1", output: { status: "completed" } },
    ]);
    expect(streamed.find((part) => part.type === "text-delta")?.delta).toBe("Found it.");
  });

  test("a failed turn emits an error part and still terminates the stream", async () => {
    const server = fakeServer({
      reply: () => [{ type: "turn.failed", payload: { error: "boom", code: "provider_error" } }],
    });
    const body = await readBody(
      await handleVercelChatRequest(
        server.og,
        useChatRequest({
          id: "c_9",
          messages: [{ role: "user", parts: [{ type: "text", text: "go" }] }],
        }),
        resolveTenant,
      ),
    );
    expect(parts(body).at(-1)).toEqual({ type: "error", errorText: "boom" });
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
  });

  test("rejects a client chat id when the host names neither a user nor a conversation", async () => {
    const server = fakeServer();
    const response = await handleVercelChatRequest(
      server.og,
      useChatRequest({
        id: "c_9",
        messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }],
      }),
      async () => ({ tenant: "acme" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "conversation_required" } });
    expect(server.creates).toHaveLength(0);
  });

  test("rejects a request without user text or conversation", async () => {
    const server = fakeServer();
    const noText = await handleVercelChatRequest(
      server.og,
      useChatRequest({
        id: "c_9",
        messages: [{ role: "assistant", parts: [{ type: "text", text: "x" }] }],
      }),
      resolveTenant,
    );
    expect(noText.status).toBe(400);
    const noConversation = await handleVercelChatRequest(
      server.og,
      useChatRequest({ messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }] }),
      resolveTenant,
    );
    expect(noConversation.status).toBe(400);
    expect(await noConversation.json()).toMatchObject({ error: { code: "conversation_required" } });
  });
});
