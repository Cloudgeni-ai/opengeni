import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import {
  chatSessionId,
  decodeResponseId,
  encodeResponseId,
  handleChatCompletionsRequest,
  handleResponsesRequest,
  type ChatResolve,
} from "../src/chat";
import { fakeServer, readBody, sseDataLines, type ScriptedEvent } from "./chat-helpers";
import { WORKSPACE_ID } from "./helpers";

const ENDPOINT = "https://product.example.test/v1";

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ENDPOINT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const resolveTenant: ChatResolve = async () => ({ tenant: "acme", user: "u_42" });

function responsesClient(server: ReturnType<typeof fakeServer>): OpenAI {
  return new OpenAI({
    apiKey: "test-only",
    baseURL: ENDPOINT,
    maxRetries: 0,
    fetch: async (input, init) =>
      handleResponsesRequest(server.og, new Request(input, init), resolveTenant),
  });
}

describe("handleChatCompletionsRequest", () => {
  test("streams chat.completion.chunk objects and terminates with [DONE]", async () => {
    const server = fakeServer();
    const response = await handleChatCompletionsRequest(
      server.og,
      post(
        "/chat/completions",
        {
          model: "gpt-anything",
          stream: true,
          user: "ignored-body-user",
          messages: [
            { role: "system", content: "ignored" },
            { role: "user", content: [{ type: "text", text: "hello" }] },
          ],
        },
        { "x-opengeni-conversation": "c_9" },
      ),
      resolveTenant,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const lines = sseDataLines(await readBody(response));
    expect(lines.at(-1)).toBe("[DONE]");
    const chunks = lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const chunk of chunks) {
      expect(chunk).toMatchObject({ object: "chat.completion.chunk", model: "gpt-anything" });
      expect(chunk.id).toBe(`chatcmpl-${server.creates[0]!.requestedSessionId}`);
    }
    const choices = chunks.map((chunk) => (chunk.choices as Array<Record<string, unknown>>)[0]!);
    expect(choices[0]).toEqual({
      index: 0,
      delta: { role: "assistant", content: "" },
      finish_reason: null,
    });
    expect(
      choices.slice(1, 3).map((choice) => (choice.delta as { content: string }).content),
    ).toEqual(["Hel", "lo"]);
    expect(choices.at(-1)).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
    expect(chunks.at(-1)!.opengeni).toMatchObject({ status: "completed", pending: null });

    expect(server.creates[0]!.initialMessage).toBe("hello");
    expect(
      JSON.parse(
        decodeURIComponent(
          server.requestsTo("POST", "/sessions")[0]!.headers["x-opengeni-external-actor"]!,
        ),
      ),
    ).toEqual({ mode: "external", identity: { source: "app", externalId: "u_42" } });
    expect(Object.hasOwn(server.creates[0]!, "endUser")).toBe(false);
    expect(server.creates[0]!.requestedSessionId).toBe(await chatSessionId(WORKSPACE_ID, "c_9"));
    expect(server.creates[0]!.modelContext).toBe(
      "Earlier conversation imported from the product, oldest first:\nsystem: ignored",
    );
  });

  test("imports prior messages as context on the first create only", async () => {
    const server = fakeServer();
    const prior = [
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
    ];
    const send = async (messages: unknown[]) =>
      readBody(
        await handleChatCompletionsRequest(
          server.og,
          post("/chat/completions", { messages }, { "x-opengeni-conversation": "c_9" }),
          resolveTenant,
        ),
      );
    await send([...prior, { role: "user", content: "second" }]);
    expect(server.creates[0]).toMatchObject({
      initialMessage: "second",
      modelContext: [
        "Earlier conversation imported from the product, oldest first:",
        "system: Be terse.",
        "user: first",
        "assistant: one",
      ].join("\n"),
    });
    await send([
      ...prior,
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
      { role: "user", content: "third" },
    ]);
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")[0]!.json()).toEqual({
      type: "user.message",
      payload: { text: "third" },
    });
  });

  test("returns a chat.completion object without stream and reads metadata.conversation_id", async () => {
    const server = fakeServer();
    const response = await handleChatCompletionsRequest(
      server.og,
      post("/chat/completions", {
        messages: [{ role: "user", content: "hello" }],
        metadata: { conversation_id: "c_meta" },
      }),
      resolveTenant,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "opengeni",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
      ],
    });
    expect(server.creates[0]!.requestedSessionId).toBe(await chatSessionId(WORKSPACE_ID, "c_meta"));
  });

  test("returns 400 without a conversation and 5xx-class JSON for a failed turn", async () => {
    const server = fakeServer({
      reply: () => [{ type: "turn.failed", payload: { error: "boom", code: "provider_error" } }],
    });
    const missing = await handleChatCompletionsRequest(
      server.og,
      post("/chat/completions", { messages: [{ role: "user", content: "hello" }] }),
      resolveTenant,
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "conversation_required" } });

    const failed = await handleChatCompletionsRequest(
      server.og,
      post(
        "/chat/completions",
        { messages: [{ role: "user", content: "hello" }] },
        { "x-opengeni-conversation": "c_9" },
      ),
      resolveTenant,
    );
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      error: { code: "provider_error", message: "boom" },
    });
  });
});

describe("handleResponsesRequest", () => {
  test("the official Responses stream helper receives stable, complete snapshots", async () => {
    const server = fakeServer();
    const client = responsesClient(server);
    const stream = client.responses.stream({ model: "m", input: "hello", conversation: "c_9" });
    const events: OpenAI.Responses.ResponseStreamEvent[] = [];
    const snapshots: string[] = [];
    stream.on("event", (event) => events.push(event));
    stream.on("response.output_text.delta", (event) => snapshots.push(event.snapshot));
    const response = await stream.finalResponse();
    expect(snapshots).toEqual(["Hel", "Hello"]);
    expect(response.output_text).toBe("Hello");
    const created = events.find((event) => event.type === "response.created")!;
    expect(created.type).toBe("response.created");
    if (created.type !== "response.created") throw new Error("Missing response.created");
    expect(response.id).toBe(created.response.id);
    expect(response.created_at).toBe(created.response.created_at);
    const message = response.output[0]!;
    if (message.type !== "message") throw new Error("Expected an assistant message");
    for (const event of events) {
      if ("response" in event) {
        expect(event.response.id).toBe(response.id);
        expect(event.response.created_at).toBe(response.created_at);
      }
      if ("item_id" in event) expect(event.item_id).toBe(message.id);
      if ("item" in event) expect(event.item.id).toBe(message.id);
    }
    const next = await client.responses
      .stream({ model: "m", input: "again", previous_response_id: response.id })
      .finalResponse();
    expect(next.id).not.toBe(response.id);
    expect(next.output[0]!.id).not.toBe(message.id);
    expect(next.previous_response_id).toBe(response.id);
    expect(server.creates).toHaveLength(1);
  });

  test("streams the complete response, output-item, and content-part lifecycle", async () => {
    const server = fakeServer();
    const response = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "hello", stream: true, conversation: { id: "c_9" }, model: "m" }),
      resolveTenant,
    );
    expect(response.status).toBe(200);
    const body = await readBody(response);
    const eventNames = body
      .split("\n")
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice(7));
    expect(eventNames).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const events = sseDataLines(body).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((events[0]!.response as Record<string, unknown>).status).toBe("in_progress");
    expect(events[2]).toMatchObject({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    expect(events[3]).toMatchObject({
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    });
    expect(events[4]).toMatchObject({
      type: "response.output_text.delta",
      delta: "Hel",
      output_index: 0,
      logprobs: [],
    });
    expect(events[6]).toMatchObject({
      type: "response.output_text.done",
      text: "Hello",
      logprobs: [],
    });
    expect(events[7]).toMatchObject({
      type: "response.content_part.done",
      part: { type: "output_text", text: "Hello", annotations: [] },
    });
    const completed = events[9]!.response as Record<string, unknown>;
    const sessionId = server.creates[0]!.requestedSessionId!;
    expect(completed).toMatchObject({
      object: "response",
      status: "completed",
      model: "m",
      output_text: "Hello",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
      ],
    });
    expect(decodeResponseId(completed.id)).toBe(sessionId);
    expect(server.creates[0]!.requestedSessionId).toBe(await chatSessionId(WORKSPACE_ID, "c_9"));
  });

  const terminalCases: Array<{
    name: string;
    events: ScriptedEvent[];
    text: string;
    status: "completed" | "incomplete";
  }> = [
    {
      name: "an empty reply",
      events: [{ type: "turn.completed" }],
      text: "",
      status: "completed",
    },
    {
      name: "a cancelled reply",
      events: [
        { type: "agent.message.delta", payload: { text: "Partial" } },
        { type: "turn.cancelled" },
      ],
      text: "Partial",
      status: "incomplete",
    },
    {
      name: "an approval wait without text",
      events: [
        {
          type: "session.requiresAction",
          payload: { approvals: [{ rawItem: { callId: "approval", name: "shell" } }] },
        },
      ],
      text: "",
      status: "incomplete",
    },
    {
      name: "text before and after a tool",
      events: [
        { type: "agent.message.delta", payload: { text: "Before." } },
        { type: "agent.toolCall.created", payload: { id: "tool", name: "search" } },
        { type: "agent.message.delta", payload: { text: "After." } },
        { type: "turn.completed" },
      ],
      text: "Before.\n\nAfter.",
      status: "completed",
    },
  ];
  for (const scenario of terminalCases) {
    test(`the official Responses helper settles ${scenario.name}`, async () => {
      const server = fakeServer({ reply: () => scenario.events });
      const stream = responsesClient(server).responses.stream({
        model: "m",
        input: "hello",
        conversation: "c_9",
      });
      let text = "";
      const events: OpenAI.Responses.ResponseStreamEvent[] = [];
      stream.on("event", (event) => events.push(event));
      stream.on("response.output_text.delta", (event) => {
        text += event.delta;
      });
      const response = await stream.finalResponse();
      expect(text).toBe(scenario.text);
      expect(response).toMatchObject({ status: scenario.status, output_text: text });
      expect(response.output[0]).toMatchObject({ status: scenario.status });
      expect(events.at(-1)).toMatchObject({ type: `response.${scenario.status}` });
    });
  }

  test("the official Responses helper rejects a failed turn", async () => {
    const server = fakeServer({
      reply: () => [
        { type: "agent.message.delta", payload: { text: "Partial" } },
        { type: "turn.failed", payload: { error: "boom", code: "provider_error" } },
      ],
    });
    await expect(
      responsesClient(server)
        .responses.stream({
          model: "m",
          input: "hello",
          conversation: "c_9",
        })
        .finalResponse(),
    ).rejects.toThrow("boom");
  });

  test("imports prior array input items as context on the first create only", async () => {
    const server = fakeServer();
    const first = await handleResponsesRequest(
      server.og,
      post("/responses", {
        conversation: "c_9",
        input: [
          { role: "user", content: [{ type: "input_text", text: "first" }] },
          { role: "assistant", content: [{ type: "output_text", text: "one" }] },
          { type: "function_call", name: "search", arguments: "{}" },
          { role: "user", content: [{ type: "input_text", text: "second" }] },
        ],
      }),
      resolveTenant,
    );
    expect(first.status).toBe(200);
    expect(server.creates[0]).toMatchObject({
      initialMessage: "second",
      modelContext: [
        "Earlier conversation imported from the product, oldest first:",
        "user: first",
        "assistant: one",
      ].join("\n"),
    });
    await handleResponsesRequest(
      server.og,
      post("/responses", {
        conversation: "c_9",
        input: [
          { role: "user", content: [{ type: "input_text", text: "second" }] },
          { role: "user", content: [{ type: "input_text", text: "third" }] },
        ],
      }),
      resolveTenant,
    );
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")[0]!.json()).toEqual({
      type: "user.message",
      payload: { text: "third" },
    });
  });

  test("continues a conversation from previous_response_id and accepts array input", async () => {
    const server = fakeServer();
    const first = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "hello", conversation: "c_9" }),
      resolveTenant,
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      object: "response",
      status: "completed",
      output_text: "Hello",
    });
    const sessionId = server.creates[0]!.requestedSessionId!;
    expect(firstBody.id).toBe(encodeResponseId(sessionId, 6));

    const second = await handleResponsesRequest(
      server.og,
      post("/responses", {
        input: [{ role: "user", content: [{ type: "input_text", text: "again" }] }],
        previous_response_id: firstBody.id,
      }),
      resolveTenant,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toMatchObject({ previous_response_id: firstBody.id, output_text: "Hello" });
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")[0]!.json()).toEqual({
      type: "user.message",
      payload: { text: "again" },
    });
  });

  test("previous_response_id of another user's session is 403", async () => {
    const server = fakeServer({ authorizeSession: (user) => user === "u_42" });
    const first = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "hello", conversation: "c_9" }),
      resolveTenant,
    );
    const firstBody = (await first.json()) as { id: string };

    const other = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "again", previous_response_id: firstBody.id }),
      async () => ({ tenant: "acme", user: "u_43" }),
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: "forbidden" } });

    const anonymous = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "again", previous_response_id: firstBody.id }),
      async () => ({ tenant: "acme" }),
    );
    expect(anonymous.status).toBe(400);
    expect(await anonymous.json()).toMatchObject({ error: { code: "conversation_required" } });
    expect(server.requestsTo("POST", "/events")).toHaveLength(0);
  });

  test("previous_response_id that disagrees with the host-named conversation is 409", async () => {
    const server = fakeServer();
    const first = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "hello" }),
      async () => ({ tenant: "acme", conversation: "host_a" }),
    );
    const firstBody = (await first.json()) as { id: string };

    const mismatch = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "again", previous_response_id: firstBody.id }),
      async () => ({ tenant: "acme", conversation: "host_b" }),
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: { code: "conversation_mismatch" } });

    const same = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "again", previous_response_id: firstBody.id }),
      async () => ({ tenant: "acme", conversation: "host_a" }),
    );
    expect(same.status).toBe(200);
    expect(server.creates).toHaveLength(1);
    expect(server.requestsTo("POST", "/events")).toHaveLength(1);
  });

  test("returns 400 without any conversation source", async () => {
    const server = fakeServer();
    const response = await handleResponsesRequest(
      server.og,
      post("/responses", { input: "hello", previous_response_id: "resp_not-a-uuid" }),
      resolveTenant,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "conversation_required" } });
  });

  test("response ids round-trip and reject foreign shapes", () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    expect(decodeResponseId(encodeResponseId(sessionId, 12))).toBe(sessionId);
    expect(decodeResponseId(`resp_${sessionId}`)).toBe(sessionId);
    expect(decodeResponseId(`resp_${sessionId}_${crypto.randomUUID()}`)).toBe(sessionId);
    expect(decodeResponseId(`resp_${sessionId}_${"-".repeat(36)}`)).toBeNull();
    expect(decodeResponseId(`resp_${sessionId}_arbitrary`)).toBeNull();
    expect(decodeResponseId("resp_abc")).toBeNull();
    expect(decodeResponseId(42)).toBeNull();
  });
});
