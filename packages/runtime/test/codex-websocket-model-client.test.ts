import { expect, test } from "bun:test";
import {
  CODEX_TRANSPORT_HEADER,
  codexRequestStorage,
  codexResponsesTransport,
  codexSubscriptionFetch,
  warmCodexResponsesConnection,
  type CodexRequestContext,
  type CodexWebSocketLike,
} from "@opengeni/codex";
import OpenAI from "openai";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";

class FakeSocket implements CodexWebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: CodexWebSocketLike["onopen"] = null;
  onmessage: CodexWebSocketLike["onmessage"] = null;
  onerror: CodexWebSocketLike["onerror"] = null;
  onclose: CodexWebSocketLike["onclose"] = null;
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

test("the model client's Codex Responses requests go over the WebSocket", async () => {
  const sockets: FakeSocket[] = [];
  const httpCalls: string[] = [];
  const transport = codexResponsesTransport(
    async (input) => {
      httpCalls.push(String(input));
      return new Response("unexpected", { status: 500 });
    },
    {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      connectTimeoutMs: 1_000,
    },
  );
  const client = new ReplayableJsonOpenAI({
    apiKey: "token",
    baseURL: "https://chatgpt.example/backend-api/codex",
    maxRetries: 0,
    fetch: transport as typeof globalThis.fetch,
  });

  const pending = client.responses.create({ model: "m", input: "hi", stream: true }).withResponse();
  for (let i = 0; i < 100 && !sockets[0]?.sent.length; i++) await Bun.sleep(1);
  const socket = sockets[0]!;
  expect(socket.sent[0]).toMatchObject({ type: "response.create", model: "m", input: "hi" });
  socket.emit({ type: "response.created", response: { id: "r1" } });
  socket.emit({ type: "response.completed", response: { id: "r1" } });

  const { data: stream, response } = await pending;
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toMatch(
    /^websocket; connection=new; input=full; handshake_ms=\d+$/,
  );
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  expect(events).toEqual(["response.created", "response.completed"]);
  expect(httpCalls).toEqual([]);
});

test("a Codex turn's warmed connection carries its first model request", async () => {
  const sockets: FakeSocket[] = [];
  const httpCalls: string[] = [];
  const transport = codexResponsesTransport(
    async (input) => {
      httpCalls.push(String(input));
      return new Response("unexpected", { status: 500 });
    },
    {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      connectTimeoutMs: 1_000,
      now: () => 1_000,
    },
  );
  const context: CodexRequestContext = {
    clientVersion: "test",
    sessionId: "conversation",
    getToken: async () => ({ accessToken: "token", chatgptAccountId: "acct", isFedramp: false }),
    refresh: async () => ({ accessToken: "token", chatgptAccountId: "acct", isFedramp: false }),
    resolveModel: (model) => model,
  };
  const client = new OpenAI({
    apiKey: "placeholder",
    baseURL: "https://chatgpt.example/backend-api",
    maxRetries: 0,
    fetch: codexSubscriptionFetch(transport) as typeof globalThis.fetch,
  });

  await codexRequestStorage.run(context, () =>
    warmCodexResponsesConnection(transport, "https://chatgpt.example/backend-api/"),
  );
  expect(sockets).toHaveLength(1);
  await Bun.sleep(1);

  const pending = codexRequestStorage.run(context, () =>
    client.responses.create({ model: "m", input: "hi", stream: true }).withResponse(),
  );
  for (let i = 0; i < 100 && !sockets[0]?.sent.length; i++) await Bun.sleep(1);
  const socket = sockets[0]!;
  expect(socket.sent[0]).toMatchObject({ type: "response.create", model: "m" });
  socket.emit({ type: "response.created", response: { id: "r1" } });
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  const { data: stream, response } = await pending;
  // The SDK's own headers did not split the connection: the warmed one served
  // the request, which waited for none of its handshake.
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  for await (const _event of stream) {
    // drain
  }
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toEqual([]);
});

test("continuation refusal settles and re-admits before the full physical request", async () => {
  const sockets: FakeSocket[] = [];
  const custody: string[] = [];
  let requestSequence = 0;
  const transport = codexResponsesTransport(
    async () => {
      throw new Error("unexpected HTTP");
    },
    {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    },
  );
  const context: CodexRequestContext = {
    clientVersion: "test",
    sessionId: "conversation",
    getToken: async () => ({ accessToken: "fake", chatgptAccountId: "fake", isFedramp: false }),
    refresh: async () => ({ accessToken: "fake", chatgptAccountId: "fake", isFedramp: false }),
    resolveModel: (model) => model,
    nextRequestId: () => `request-${++requestSequence}`,
    beforeProviderDispatch: async (request) => {
      custody.push(`admit:${request?.requestId}:${request?.transportAttempt}`);
    },
    onProviderRequestSettled: async (request) => {
      custody.push(`${request.outcome}:${request.requestId}:${request.transportAttempt}`);
    },
  };
  const fetch = codexSubscriptionFetch(transport);
  const user = { role: "user", content: "hello" };
  const send = (input: unknown[]) =>
    codexRequestStorage.run(context, () =>
      fetch("https://chatgpt.example/backend-api/responses", {
        method: "POST",
        body: JSON.stringify({ model: "m", stream: true, input }),
      }),
    );
  const first = send([user]);
  for (let i = 0; i < 100 && !sockets[0]?.sent.length; i++) await Bun.sleep(1);
  const socket = sockets[0]!;
  socket.emit({
    type: "response.completed",
    response: { id: "first", status: "completed", output: [] },
  });
  await (await first).text();
  const second = send([user, { role: "user", content: "next" }]);
  for (let i = 0; i < 100 && socket.sent.length < 2; i++) await Bun.sleep(1);
  expect(socket.sent[1]?.previous_response_id).toBe("first");
  socket.emit({
    type: "error",
    status: 400,
    error: { code: "previous_response_not_found", param: "previous_response_id" },
  });
  for (let i = 0; i < 100 && socket.sent.length < 3; i++) await Bun.sleep(1);
  expect(custody).toEqual([
    "admit:request-1:1",
    "response_received:request-1:1",
    "admit:request-2:1",
    "refused:request-2:1",
    "admit:request-2:2",
  ]);
  expect(socket.sent[2]).not.toHaveProperty("previous_response_id");
  socket.emit({
    type: "response.completed",
    response: { id: "second", status: "completed", output: [] },
  });
  await (await second).text();
  expect(custody.at(-1)).toBe("response_received:request-2:2");
});
