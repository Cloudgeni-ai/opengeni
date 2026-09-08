import { describe, expect, test } from "bun:test";
import {
  chatSessionId,
  decodeResponseId,
  encodeResponseId,
  handleChatCompletionsRequest,
  handleResponsesRequest,
  type ChatResolve,
} from "../src/chat";
import { fakeServer, readBody, sseDataLines } from "./chat-helpers";
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
    expect(server.creates[0]!.endUser).toEqual({ source: "app", id: "u_42" });
    expect(server.creates[0]!.requestedSessionId).toBe(await chatSessionId(WORKSPACE_ID, "c_9"));
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
  test("streams response.created, output_text deltas, output_text.done, and response.completed", async () => {
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
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ]);
    const events = sseDataLines(body).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3, 4]);
    expect((events[0]!.response as Record<string, unknown>).status).toBe("in_progress");
    expect(events[1]).toMatchObject({
      type: "response.output_text.delta",
      delta: "Hel",
      output_index: 0,
    });
    expect(events[3]).toMatchObject({ type: "response.output_text.done", text: "Hello" });
    const completed = events[4]!.response as Record<string, unknown>;
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
    expect(decodeResponseId("resp_abc")).toBeNull();
    expect(decodeResponseId(42)).toBeNull();
  });
});
