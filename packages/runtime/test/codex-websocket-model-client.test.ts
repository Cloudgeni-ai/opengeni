import { expect, test } from "bun:test";
import {
  CODEX_TRANSPORT_HEADER,
  codexResponsesTransport,
  type CodexWebSocketLike,
} from "@opengeni/codex";
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
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe("websocket; connection=new");
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  expect(events).toEqual(["response.created", "response.completed"]);
  expect(httpCalls).toEqual([]);
});
