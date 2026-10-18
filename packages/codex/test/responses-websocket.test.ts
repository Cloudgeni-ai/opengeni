import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CODEX_RESPONSES_WEBSOCKET_BETA,
  CODEX_TRANSPORT_HEADER,
  codexResponsesTransport,
  formatCodexRequestTransport,
  parseCodexRequestTransport,
  OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
  withResponsesConversation,
  createResponsesTurn,
  type CodexWebSocketLike,
  type ResponsesWebSocketEndpoint,
} from "../src/responses-websocket";
import { parseCodexUsageHeaders } from "../src/fetch";
import {
  markResponsesPrefixReady,
  hasResponsesTurn,
  type ResponsesTransportDiagnostic,
} from "@opengeni/network/responses-websocket";

const URL = "https://chatgpt.example/backend-api/codex/responses";

class FakeSocket implements CodexWebSocketLike {
  readyState = 0;
  handshakeStatus?: number;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: CodexWebSocketLike["onopen"] = null;
  onmessage: CodexWebSocketLike["onmessage"] = null;
  onerror: CodexWebSocketLike["onerror"] = null;
  onclose: CodexWebSocketLike["onclose"] = null;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
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
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  drop(code = 1006) {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness(
  options: {
    autoOpen?: boolean;
    now?: () => number;
    endpoint?: ResponsesWebSocketEndpoint;
    observe?: (event: ResponsesTransportDiagnostic) => void;
    httpOnly?: boolean;
    httpResponse?: () => Response;
    onFallback?: () => Promise<void>;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const httpCalls: string[] = [];
  const transport = codexResponsesTransport(
    async (input) => {
      httpCalls.push(String(input));
      return options.httpResponse?.() ?? new Response("http", { status: 200 });
    },
    {
      createSocket: (url, headers) => {
        const socket = new FakeSocket(url, headers);
        sockets.push(socket);
        if (options.autoOpen !== false) queueMicrotask(() => socket.open());
        return socket;
      },
      connectTimeoutMs: 1_000,
      // A fixed clock by default: a new connection's handshake reports 0 ms.
      now: options.now ?? (() => 1_000),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    },
  );
  let turn = createResponsesTurn("conversation", options.observe, {
    httpOnly: options.httpOnly ?? false,
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  });
  const scoped = options.endpoint?.conversationScoped
    ? transport
    : Object.assign(
        (...args: Parameters<typeof transport>) =>
          withResponsesConversation(turn, () => transport(...args)),
        {
          warm: (...args: Parameters<typeof transport.warm>) =>
            withResponsesConversation(turn, () => transport.warm(...args)),
        },
      );
  return {
    transport: scoped,
    rawTransport: transport,
    sockets,
    httpCalls,
    prefixReady: () => withResponsesConversation(turn, markResponsesPrefixReady),
    nextTurn: () => {
      turn = createResponsesTurn("conversation", options.observe);
    },
  };
}

test("a title outside the conversation cannot take its warmed main socket", async () => {
  const { transport, rawTransport, sockets, httpCalls } = harness();
  transport.warm(URL, request().headers);
  await Bun.sleep(1);
  const titlePending = rawTransport(
    URL,
    request(
      { model: "m", input: [], stream: true },
      {
        headers: {
          ...request().headers,
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "session_title" }),
        },
      },
    ),
  );
  await Bun.sleep(1);
  const main = transport(URL, request());
  await Bun.sleep(1);
  for (const socket of sockets)
    socket.emit({ type: "response.completed", response: { id: "main-1", output: [] } });
  const title = await titlePending;
  expect(title.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=not_eligible");
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.sent).toHaveLength(1);
  const first = await main;
  expect(first.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  await first.text();
  expect(httpCalls).toHaveLength(1);
});

test("clearing an inherited conversation keeps title traffic off the socket and preserves continuation", async () => {
  const { rawTransport, sockets, httpCalls } = harness();
  const turn = createResponsesTurn("conversation");
  const user = { role: "user", content: "Question" };
  await withResponsesConversation(turn, async () => {
    const first = rawTransport(URL, request({ model: "m", input: [user], stream: true }));
    const socket = await nextSend(() => sockets[0]);
    socket.emit({ type: "response.completed", response: { id: "main-first", output: [] } });
    await (await first).text();
    await withResponsesConversation(undefined, async () => {
      expect(hasResponsesTurn()).toBe(false);
      rawTransport.warm(URL, request().headers);
      const title = await rawTransport(URL, request());
      expect(title.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=not_eligible");
    });
    expect(hasResponsesTurn()).toBe(true);
    const second = rawTransport(
      URL,
      request({ model: "m", input: [user, { role: "user", content: "Follow-up" }], stream: true }),
    );
    for (let i = 0; i < 50 && socket.sent.length < 2; i++) await Bun.sleep(1);
    expect(socket.sent[1]).toMatchObject({
      previous_response_id: "main-first",
      input: [{ role: "user", content: "Follow-up" }],
    });
    socket.emit({ type: "response.completed", response: { id: "main-second", output: [] } });
    await (await second).text();
    expect(sockets).toHaveLength(1);
    expect(socket.closed).toBe(false);
    expect(httpCalls).toHaveLength(1);
    socket.close();
  });
  expect(hasResponsesTurn()).toBe(false);
});

function request(
  body: Record<string, unknown> = { model: "m", input: [], stream: true },
  extra = {},
) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer token",
      "chatgpt-account-id": "acct",
      session_id: "conversation",
      "idempotency-key": `req-${Math.random()}`,
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...extra,
  } satisfies RequestInit;
}

async function nextSend(socket: () => FakeSocket | undefined) {
  for (let i = 0; i < 50; i++) {
    const current = socket();
    if (current && current.sent.length > 0) return current;
    await Bun.sleep(1);
  }
  throw new Error("request was never sent");
}

const rateLimits = {
  type: "codex.rate_limits",
  rate_limits: {
    primary: {
      used_percent: 12,
      window_minutes: 300,
      reset_after_seconds: 60,
      reset_at: 1_900_000_000,
    },
    secondary: {
      used_percent: 40,
      window_minutes: 10_080,
      reset_after_seconds: 600,
      reset_at: 1_900_000_600,
    },
  },
};

test("transient handshake failure stays on sockets for the next durable retry", async () => {
  const { transport, sockets, httpCalls } = harness({ autoOpen: false });
  const first = transport(URL, request());
  const rejection = expect(first).rejects.toThrow("WebSocket");
  for (let i = 0; i < 50 && !sockets[0]; i++) await Bun.sleep(1);
  sockets[0]!.drop();
  await rejection;
  const retry = transport(URL, request());
  for (let i = 0; i < 50 && !sockets[1]; i++) await Bun.sleep(1);
  sockets[1]!.open();
  const socket = await nextSend(() => sockets[1]);
  socket.emit({ type: "response.completed", response: { id: "retry" } });
  await (await retry).text();
  expect(httpCalls).toEqual([]);
});

test("a recovered HTTP-only turn skips warming and opens again on the next turn", async () => {
  const { transport, sockets, nextTurn } = harness({ httpOnly: true });
  transport.warm(URL, request().headers);
  expect((await transport(URL, request())).headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "http; reason=turn_fallback",
  );
  expect(sockets).toHaveLength(0);
  nextTurn();
  const pending = transport(URL, request());
  const socket = await nextSend(() => sockets[0]);
  socket.emit({ type: "response.completed", response: { id: "new-turn" } });
  await (await pending).text();
});

test.each([
  'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
])("HTTP reader cancellation is not a model failure: %s", async (body) => {
  const events: ResponsesTransportDiagnostic[] = [];
  const cancellations: unknown[] = [];
  const { transport } = harness({
    httpOnly: true,
    observe: (event) => events.push(event),
    httpResponse: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
          },
          cancel(reason) {
            cancellations.push(reason);
          },
        }),
      ),
  });
  const reader = (await transport(URL, request())).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(body);
  const pending = reader.read();
  const reason = new Error("consumer finished reading");
  await reader.cancel(reason);
  expect((await pending).done).toBe(true);
  expect(cancellations).toEqual([reason]);
  expect(events.filter((event) => event.phase === "terminal")).toMatchObject([
    { transport: { kind: "http" }, outcome: "cancelled" },
  ]);
});

test.each([200, 503])("HTTP EOF retains status-based outcome for %s", async (status) => {
  const events: ResponsesTransportDiagnostic[] = [];
  const { transport } = harness({
    httpOnly: true,
    observe: (event) => events.push(event),
    httpResponse: () => new Response("body", { status }),
  });
  expect(await (await transport(URL, request())).text()).toBe("body");
  expect(events.filter((event) => event.phase === "terminal")).toMatchObject([
    { outcome: status === 200 ? "completed" : "failed" },
  ]);
});

test("HTTP read errors still record one failure", async () => {
  const events: ResponsesTransportDiagnostic[] = [];
  const { transport } = harness({
    httpOnly: true,
    observe: (event) => events.push(event),
    httpResponse: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("broken response"));
          },
        }),
      ),
  });
  await expect((await transport(URL, request())).text()).rejects.toThrow("broken response");
  expect(events.filter((event) => event.phase === "terminal")).toMatchObject([
    { outcome: "failed" },
  ]);
});

test("diagnostics separate first/later calls, wire bytes, cache usage, and final prefix readiness", async () => {
  const events: ResponsesTransportDiagnostic[] = [];
  const { transport, sockets, prefixReady } = harness({ observe: (event) => events.push(event) });
  const user = { role: "user", content: "x".repeat(1000) };
  prefixReady();
  const first = transport(URL, request({ model: "m", input: [user], stream: true }));
  const socket = await nextSend(() => sockets[0]);
  socket.emit({
    type: "response.completed",
    response: {
      id: "r1",
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 } },
    },
  });
  await (await first).text();
  prefixReady();
  const second = transport(
    URL,
    request({ model: "m", input: [user, { role: "user", content: "next" }], stream: true }),
  );
  for (let i = 0; i < 50 && socket.sent.length < 2; i++) await Bun.sleep(1);
  socket.emit({
    type: "response.completed",
    response: {
      id: "r2",
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 } },
    },
  });
  await (await second).text();
  const terminals = events.filter((event) => event.phase === "terminal");
  expect(terminals).toMatchObject([
    { position: "first", outcome: "completed", promptTokens: 100, cachedTokens: 20 },
    { position: "later", outcome: "completed", promptTokens: 120, cachedTokens: 100 },
  ]);
  expect(events.filter((event) => event.phase === "prefix_ready_to_send")).toHaveLength(2);
  const sends = events.filter((event) => event.phase === "send");
  expect(sends).toHaveLength(2);
  expect(sends[1]!.inputBytes!).toBeLessThan(sends[1]!.fullInputBytes!);
});

test("diagnostic observer failures cannot fail a model request", async () => {
  const { transport, sockets } = harness({
    observe: () => {
      throw new Error("observer unavailable");
    },
  });
  const pending = transport(URL, request());
  const socket = await nextSend(() => sockets[0]);
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  expect((await pending).status).toBe(200);
});

test("socket refusal persists its turn policy before dispatching HTTP", async () => {
  let release!: () => void;
  const write = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { transport, sockets, httpCalls } = harness({ autoOpen: false, onFallback: () => write });
  const pending = transport(URL, request());
  for (let i = 0; i < 50 && !sockets[0]; i++) await Bun.sleep(1);
  sockets[0]!.handshakeStatus = 426;
  sockets[0]!.drop();
  await Bun.sleep(1);
  expect(httpCalls).toHaveLength(0);
  release();
  expect((await pending).status).toBe(200);
  expect(httpCalls).toHaveLength(1);
});

test("persistent socket resources do not inherit the opening request context", async () => {
  const execution = new AsyncLocalStorage<{ turn: string }>();
  let socket!: FakeSocket;
  let openingContext: unknown = "not opened";
  const transport = codexResponsesTransport(async () => new Response("HTTP"), {
    createSocket: (url, headers) => {
      openingContext = execution.getStore();
      socket = new FakeSocket(url, headers);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const pending = execution.run({ turn: "opening-turn" }, () =>
    withResponsesConversation("conversation", () => transport(URL, request())),
  );
  await nextSend(() => socket);
  expect(openingContext).toBeUndefined();
  socket.emit({ type: "response.completed", response: { id: "first" } });
  await (await pending).text();
  socket.close();
});

test("streams a response over one reused connection as SSE with usage headers", async () => {
  const { transport, sockets, httpCalls } = harness();
  const pending = transport(URL, request());
  const socket = await nextSend(() => sockets[0]);
  expect(socket.url).toBe("wss://chatgpt.example/backend-api/codex/responses");
  expect(socket.headers["openai-beta"]).toBe(CODEX_RESPONSES_WEBSOCKET_BETA);
  expect(socket.headers["idempotency-key"]).toBeUndefined();
  expect(socket.sent[0]).toMatchObject({ type: "response.create", model: "m", stream: true });
  socket.emit(rateLimits);
  socket.emit({ type: "codex.response.metadata", headers: { "x-request-id": "upstream-1" } });
  socket.emit({ type: "response.created", response: { id: "r1" } });
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("x-request-id")).toBe("upstream-1");
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  expect(parseCodexUsageHeaders(response.headers)).toMatchObject({
    primaryUsedPercent: 12,
    secondaryUsedPercent: 40,
  });
  socket.emit({ type: "responsesapi.websocket_timing", timing_metrics: {} });
  socket.emit({ type: "response.output_text.delta", delta: "ok" });
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  const text = await response.text();
  expect(text).toBe(
    [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
    ].join(""),
  );

  const second = transport(URL, request());
  for (let i = 0; i < 50 && socket.sent.length < 2; i++) await Bun.sleep(1);
  expect(socket.sent).toHaveLength(2);
  socket.emit({ type: "response.completed", response: { id: "r2" } });
  const reused = await second;
  expect(reused.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=reused; input=full",
  );
  await reused.text();
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toEqual([]);
});

test("a connection warmed ahead of the first request carries it without another handshake", async () => {
  const { transport, sockets, httpCalls } = harness();
  const { headers } = request();
  // The model SDK's telemetry headers never split a conversation's connection.
  transport.warm(URL, { ...headers, "x-stainless-os": "Linux" });
  transport.warm(URL, headers);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.url).toBe("wss://chatgpt.example/backend-api/codex/responses");
  expect(sockets[0]!.headers).toEqual({
    authorization: "Bearer token",
    "chatgpt-account-id": "acct",
    session_id: "conversation",
    "openai-beta": CODEX_RESPONSES_WEBSOCKET_BETA,
  });
  await Bun.sleep(1);
  transport.warm(URL, headers);
  expect(sockets).toHaveLength(1);

  const pending = transport(
    URL,
    request(undefined, { headers: { ...headers, "x-stainless-retry-count": "0" } }),
  );
  const socket = await nextSend(() => sockets[0]);
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  const response = await pending;
  // The request waited for none of the handshake.
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  await response.text();
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toEqual([]);
});

test("a request waits for its conversation's handshake already in progress", async () => {
  let clock = 1_000;
  const { transport, sockets, httpCalls } = harness({ autoOpen: false, now: () => clock });
  transport.warm(URL, request().headers);
  const pending = transport(URL, request());
  await Bun.sleep(2);
  expect(sockets).toHaveLength(1);
  clock += 120;
  sockets[0]!.open();
  const socket = await nextSend(() => sockets[0]);
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  const response = await pending;
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=120",
  );
  await response.text();
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toEqual([]);
});

test("a failed warm handshake sends the waiting request over HTTP and backs off", async () => {
  const { transport, sockets, httpCalls } = harness({ autoOpen: false });
  transport.warm(URL, request().headers);
  const pending = transport(URL, request());
  await Bun.sleep(1);
  sockets[0]!.handshakeStatus = 426;
  sockets[0]!.drop(1006);
  const failed = await pending;
  expect(failed.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=handshake_failed");
  expect(await failed.text()).toBe("http");
  transport.warm(URL, request().headers);
  const backedOff = await transport(URL, request());
  expect(backedOff.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=turn_fallback");
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toHaveLength(2);
});

test("warming ignores other URLs and transports without WebSockets", async () => {
  const { transport, sockets } = harness();
  transport.warm("https://chatgpt.example/backend-api/codex/models", request().headers);
  expect(sockets).toHaveLength(0);
  const plain = codexResponsesTransport(async () => new Response("http"), { createSocket: null });
  expect(() => plain.warm(URL, request().headers)).not.toThrow();
});

function streamedRequest(body: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return request(body, {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 7));
        controller.enqueue(bytes.subarray(7));
        controller.close();
      },
    }),
    duplex: "half",
  });
}

test("a streamed request body, as the model client sends it, goes over the socket", async () => {
  const sockets: FakeSocket[] = [];
  const httpBodies: string[] = [];
  const transport = codexResponsesTransport(
    async (_input, init) => {
      httpBodies.push(await new Response(init?.body).text());
      return new Response("http", { status: 200 });
    },
    {
      createSocket: (url, headers) => {
        const socket = new FakeSocket(url, headers);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      connectTimeoutMs: 1_000,
      // A fixed clock, as in harness(): the new connection's handshake reports 0 ms.
      now: () => 1_000,
    },
  );
  const body = { model: "m", input: [{ role: "user", content: "hi" }], stream: true };
  const pending = withResponsesConversation("conversation", () =>
    transport(URL, streamedRequest(body)),
  );
  const socket = await nextSend(() => sockets[0]);
  expect(socket.sent[0]).toMatchObject({ type: "response.create", ...body });
  // While the socket is busy, the same kind of request still reaches HTTP whole.
  const busy = await withResponsesConversation("conversation", () =>
    transport(URL, streamedRequest(body)),
  );
  expect(busy.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=connection_busy");
  expect(httpBodies).toEqual([JSON.stringify(body)]);
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  const response = await pending;
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  await response.text();
});

test("a concurrent request of the same conversation uses HTTP while the socket is busy", async () => {
  const { transport, sockets, httpCalls } = harness();
  const first = transport(URL, request());
  const socket = await nextSend(() => sockets[0]);
  const second = await transport(URL, request());
  expect(second.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=connection_busy");
  expect(await second.text()).toBe("http");
  expect(httpCalls).toEqual([URL]);
  socket.emit({ type: "response.completed", response: {} });
  await (await first).text();
});

test("concurrent cold requests join one handshake, never opening two sockets", async () => {
  const { transport, sockets, httpCalls } = harness({ autoOpen: false });
  const first = transport(URL, request());
  const second = transport(URL, request());
  for (let i = 0; i < 50 && !sockets[0]; i++) await Bun.sleep(1);
  expect(sockets).toHaveLength(1);
  sockets[0]!.open();
  const socket = await nextSend(() => sockets[0]);
  socket.emit({ type: "response.completed", response: { id: "r1" } });
  await (await first).text();
  await (await second).text();
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toHaveLength(1);
});

test("cancellation during a handshake returns promptly and sends no model request", async () => {
  const { transport, sockets, httpCalls } = harness({ autoOpen: false });
  const controller = new AbortController();
  const pending = transport(URL, request(undefined, { signal: controller.signal }));
  for (let i = 0; i < 50 && !sockets[0]; i++) await Bun.sleep(1);
  controller.abort(new Error("cancel during handshake"));
  await expect(pending).rejects.toThrow("cancel during handshake");
  sockets[0]!.open();
  await Bun.sleep(1);
  expect(sockets[0]!.sent).toEqual([]);
  expect(httpCalls).toEqual([]);
  sockets[0]!.close();
});

test("credential rotation retires the old idle connection for the conversation", async () => {
  const { transport, sockets } = harness();
  const first = transport(URL, request());
  const old = await nextSend(() => sockets[0]);
  old.emit({ type: "response.completed", response: { id: "r1" } });
  await (await first).text();
  const headers = new Headers(request().headers);
  headers.set("authorization", "Bearer rotated");
  const second = transport(URL, request(undefined, { headers }));
  const next = await nextSend(() => sockets[1]);
  expect(old.closed).toBe(true);
  next.emit({ type: "response.completed", response: { id: "r2" } });
  await (await second).text();
});

test("a refused handshake falls back only for this turn; the next turn tries immediately", async () => {
  const { transport, sockets, httpCalls, nextTurn } = harness({ autoOpen: false });
  const pending = transport(URL, request());
  for (let i = 0; i < 50 && !sockets[0]; i++) await Bun.sleep(1);
  sockets[0]!.handshakeStatus = 426;
  sockets[0]!.drop(1006);
  const failed = await pending;
  expect(failed.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=handshake_failed");
  expect(await failed.text()).toBe("http");
  const backedOff = await transport(URL, request());
  expect(backedOff.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=turn_fallback");
  expect(await backedOff.text()).toBe("http");
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toHaveLength(2);
  nextTurn();
  const next = transport(URL, request());
  for (let i = 0; i < 50 && !sockets[1]; i++) await Bun.sleep(1);
  sockets[1]!.open();
  const socket = await nextSend(() => sockets[1]);
  socket.emit({ type: "response.completed", response: {} });
  await (await next).text();
  expect(sockets).toHaveLength(2);
});

test("a refused request keeps the HTTP error shape and the connection", async () => {
  const { transport, sockets } = harness();
  const pending = transport(URL, request());
  const socket = await nextSend(() => sockets[0]);
  socket.emit({
    type: "error",
    status: 429,
    error: { type: "usage_limit_reached", message: "limit" },
  });
  const response = await pending;
  expect(response.status).toBe(429);
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  expect(await response.json()).toEqual({
    error: { type: "usage_limit_reached", message: "limit" },
  });
  const next = transport(URL, request());
  for (let i = 0; i < 50 && socket.sent.length < 2; i++) await Bun.sleep(1);
  socket.emit({ type: "response.completed", response: {} });
  await (await next).text();
  expect(sockets).toHaveLength(1);
});

test("a connection lost mid-response fails that stream and is never reused", async () => {
  const { transport, sockets } = harness();
  const pending = transport(URL, request());
  const socket = await nextSend(() => sockets[0]);
  socket.emit({ type: "response.created", response: {} });
  const response = await pending;
  socket.drop(1006);
  await expect(response.text()).rejects.toThrow("closed before the response finished");
  const next = transport(URL, request());
  const replacement = await nextSend(() => sockets[1]);
  replacement.emit({ type: "response.completed", response: {} });
  await (await next).text();
  expect(sockets).toHaveLength(2);
});

test("independent dropped requests never accumulate a timer-based fallback", async () => {
  let clock = 1_000;
  const { transport, sockets, httpCalls } = harness({ now: () => clock });
  const dropOnce = async (index: number) => {
    const pending = transport(URL, request());
    const socket = await nextSend(() => sockets[index]);
    socket.emit({ type: "response.created", response: {} });
    const response = await pending;
    socket.drop(1012);
    await expect(response.text()).rejects.toThrow("closed before the response finished (1012)");
  };

  // One drop is retried on a new socket, and a completed response clears it.
  await dropOnce(0);
  const recovered = transport(URL, request());
  const replacement = await nextSend(() => sockets[1]);
  replacement.emit({ type: "response.completed", response: {} });
  await (await recovered).text();
  await dropOnce(1);
  expect(httpCalls).toEqual([]);

  // A different request's drop must not silently consume this step's budget.
  await dropOnce(2);
  const again = transport(URL, request());
  const fresh = await nextSend(() => sockets[3]);
  fresh.emit({ type: "response.completed", response: {} });
  expect((await again).headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; input=full; handshake_ms=0",
  );
  expect(parseCodexRequestTransport("http; reason=stream_dropped")).toEqual({
    kind: "http",
    reason: "stream_dropped",
  });
  expect(httpCalls).toEqual([]);
});

test("aborting a request closes its socket", async () => {
  const { transport, sockets } = harness();
  const controller = new AbortController();
  const pending = transport(URL, request(undefined, { signal: controller.signal }));
  const socket = await nextSend(() => sockets[0]);
  controller.abort(new Error("deadline"));
  await expect(pending).rejects.toThrow("deadline");
  expect(socket.closed).toBe(true);
});

test("non-streaming and non-Responses requests stay on HTTP", async () => {
  const { transport, sockets, httpCalls } = harness();
  const nonStreaming = await transport(URL, request({ model: "m", input: [], stream: false }));
  expect(nonStreaming.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=not_eligible");
  const models = await transport("https://chatgpt.example/backend-api/codex/models", request());
  expect(models.headers.get(CODEX_TRANSPORT_HEADER)).toBeNull();
  const { body: _body, ...withoutBody } = request();
  await transport(URL, { ...withoutBody, method: "GET" });
  expect(sockets).toHaveLength(0);
  expect(httpCalls).toHaveLength(3);
});

test("a transport label round-trips and unknown labels are refused", () => {
  for (const transport of [
    { kind: "websocket", connection: "new", input: "full" },
    { kind: "websocket", connection: "new", input: "full", handshakeMs: 240 },
    { kind: "websocket", connection: "reused", input: "incremental" },
    { kind: "http", reason: "connection_busy" },
    { kind: "http", reason: "unavailable" },
  ] as const) {
    expect(parseCodexRequestTransport(formatCodexRequestTransport(transport))).toEqual(transport);
  }
  expect(parseCodexRequestTransport(null)).toBeNull();
  expect(parseCodexRequestTransport("websocket; connection=other")).toBeNull();
  expect(parseCodexRequestTransport("websocket; connection=new; input=partial")).toBeNull();
  // Labels written before continuations existed always sent the full input.
  expect(parseCodexRequestTransport("websocket; connection=reused")).toEqual({
    kind: "websocket",
    connection: "reused",
    input: "full",
  });
  expect(parseCodexRequestTransport("http; reason=other")).toBeNull();
  expect(parseCodexRequestTransport("carrier-pigeon")).toBeNull();
});

test("an immutable HTTP response is labelled without losing its body", async () => {
  const transport = codexResponsesTransport(
    async () => {
      const response = await fetch("data:text/plain,from-http");
      return response;
    },
    { createSocket: null },
  );
  // Without a socket factory the transport is plain HTTP and adds nothing.
  const plain = await transport(URL, request({ model: "m", input: [], stream: false }));
  expect(plain.headers.get(CODEX_TRANSPORT_HEADER)).toBeNull();

  const labelled = codexResponsesTransport(async () => await fetch("data:text/plain,from-http"), {
    createSocket: () => new FakeSocket(URL, {}),
  });
  const response = await labelled(URL, request({ model: "m", input: [], stream: false }));
  expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=not_eligible");
  expect(await response.text()).toBe("from-http");
});

describe("continuing the previous response on a connection", () => {
  const tools = [{ type: "function", name: "get_time", parameters: { type: "object" } }];
  const base = { model: "m", instructions: "be brief", tools, stream: true, store: false };
  const user = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "what time is it?" }],
  };
  // As the backend streams them: ids, status, annotations and logprobs.
  const reasoning = {
    id: "rs_1",
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque-reasoning",
  };
  const preamble = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Checking.", annotations: [], logprobs: [] }],
  };
  const call = {
    id: "fc_1",
    type: "function_call",
    status: "completed",
    call_id: "call_1",
    name: "get_time",
    arguments: "{}",
  };
  // As the client sends the same items back.
  const sentBack = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-reasoning" },
    {
      type: "message",
      role: "assistant",
      id: "msg_1",
      content: [{ type: "output_text", text: "Checking.", annotations: [] }],
    },
    { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
  ];
  const result = { type: "function_call_output", call_id: "call_1", output: "12:34" };

  async function complete(socket: FakeSocket, pending: Promise<Response>, id: string) {
    for (const [output_index, item] of [reasoning, preamble, call].entries()) {
      socket.emit({ type: "response.output_item.done", output_index, item });
    }
    socket.emit({ type: "response.completed", response: { id } });
    const response = await pending;
    await response.text();
    return response;
  }

  async function sendNext(
    transport: ReturnType<typeof harness>["transport"],
    socket: FakeSocket,
    body: Record<string, unknown>,
  ) {
    const count = socket.sent.length;
    const pending = transport(URL, request(body));
    for (let i = 0; i < 50 && socket.sent.length === count; i++) await Bun.sleep(1);
    return { pending, sent: socket.sent.at(-1)! };
  }

  test("a request extending the previous response sends only its new items", async () => {
    const { transport, sockets } = harness();
    const first = transport(URL, request({ ...base, input: [user] }));
    const socket = await nextSend(() => sockets[0]);
    expect(socket.sent[0]).not.toHaveProperty("previous_response_id");
    const firstResponse = await complete(socket, first, "resp_1");
    expect(firstResponse.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
      "websocket; connection=new; input=full; handshake_ms=0",
    );

    const { pending, sent } = await sendNext(transport, socket, {
      ...base,
      input: [user, ...sentBack, result],
    });
    expect(sent).toEqual({
      ...base,
      type: "response.create",
      previous_response_id: "resp_1",
      input: [result],
    });
    socket.emit({ type: "response.completed", response: { id: "resp_2" } });
    const second = await pending;
    expect(second.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
      "websocket; connection=reused; input=incremental",
    );
    await second.text();

    // The chain carries on from the response the continuation produced.
    const { pending: third, sent: thirdSent } = await sendNext(transport, socket, {
      ...base,
      input: [user, ...sentBack, result, { type: "message", role: "user", content: "thanks" }],
    });
    expect(thirdSent).toMatchObject({
      previous_response_id: "resp_2",
      input: [{ type: "message", role: "user", content: "thanks" }],
    });
    socket.emit({ type: "response.completed", response: { id: "resp_3" } });
    await (await third).text();
  });

  test("empty terminal output reconstructs completed items in index order", async () => {
    const { transport, sockets } = harness();
    const first = transport(URL, request({ ...base, input: [user] }));
    const socket = await nextSend(() => sockets[0]);
    for (const index of [2, 0, 1])
      socket.emit({
        type: "response.output_item.done",
        output_index: index,
        item: [reasoning, preamble, call][index],
      });
    socket.emit({ type: "response.completed", response: { id: "r1", output: [] } });
    await (await first).text();
    const { pending, sent } = await sendNext(transport, socket, {
      ...base,
      input: [user, ...sentBack, result],
    });
    expect(sent.input).toEqual([result]);
    expect(sent.previous_response_id).toBe("r1");
    socket.emit({ type: "response.completed", response: { id: "r2" } });
    await (await pending).text();
  });

  for (const response of [{ status: "incomplete" }, { error: { code: "failed" } }]) {
    test(`unsuccessful completed-event payload never establishes continuation ${JSON.stringify(response)}`, async () => {
      const { transport, sockets } = harness();
      const first = transport(URL, request({ ...base, input: [user] }));
      const socket = await nextSend(() => sockets[0]);
      socket.emit({ type: "response.completed", response: { id: "r1", ...response } });
      await (await first).text();
      const { pending, sent } = await sendNext(transport, socket, {
        ...base,
        input: [user, result],
      });
      expect(sent).not.toHaveProperty("previous_response_id");
      socket.emit({ type: "response.completed", response: { id: "r2" } });
      await (await pending).text();
    });
  }

  test("explicit caller continuation is never replaced by the pooled chain", async () => {
    const { transport, sockets } = harness();
    const first = transport(URL, request({ ...base, input: [user] }));
    const socket = await nextSend(() => sockets[0]);
    await complete(socket, first, "pooled");
    const { pending, sent } = await sendNext(transport, socket, {
      ...base,
      previous_response_id: "caller",
      input: [user, ...sentBack, result],
    });
    expect(sent.previous_response_id).toBe("caller");
    expect(sent.input).toHaveLength(5);
    socket.emit({ type: "response.completed", response: { id: "r2" } });
    await (await pending).text();
  });

  for (const [label, body] of [
    [
      "changed instructions",
      { ...base, instructions: "be thorough", input: [user, ...sentBack, result] },
    ],
    [
      "an edited earlier item",
      {
        ...base,
        input: [
          { ...user, content: [{ type: "input_text", text: "edited" }] },
          ...sentBack,
          result,
        ],
      },
    ],
    [
      "a different model output",
      {
        ...base,
        input: [user, ...sentBack.slice(0, 2), { ...sentBack[2], arguments: '{"tz":"x"}' }, result],
      },
    ],
    [
      "changed reasoning",
      {
        ...base,
        input: [user, { ...sentBack[0], encrypted_content: "other" }, ...sentBack.slice(1), result],
      },
    ],
    ["no new item", { ...base, input: [user, ...sentBack] }],
  ] as const) {
    test(`${label} sends the full request`, async () => {
      const { transport, sockets } = harness();
      const first = transport(URL, request({ ...base, input: [user] }));
      const socket = await nextSend(() => sockets[0]);
      await complete(socket, first, "resp_1");
      const { pending, sent } = await sendNext(transport, socket, body as Record<string, unknown>);
      expect(sent).not.toHaveProperty("previous_response_id");
      expect(sent.input).toEqual((body as unknown as { input: unknown[] }).input);
      socket.emit({ type: "response.completed", response: { id: "resp_2" } });
      const response = await pending;
      expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
        "websocket; connection=reused; input=full",
      );
      await response.text();
    });
  }

  test("a response that did not complete is never continued", async () => {
    const { transport, sockets } = harness();
    const first = transport(URL, request({ ...base, input: [user] }));
    const socket = await nextSend(() => sockets[0]);
    socket.emit({ type: "response.output_item.done", output_index: 0, item: call });
    socket.emit({ type: "response.failed", response: { id: "resp_1" } });
    await (await first).text();
    const { pending, sent } = await sendNext(transport, socket, {
      ...base,
      input: [user, sentBack[2], result],
    });
    expect(sent).not.toHaveProperty("previous_response_id");
    socket.emit({ type: "response.completed", response: { id: "resp_2" } });
    await (await pending).text();
  });

  test("a continuation the backend refuses is sent again in full on the same socket", async () => {
    const { transport, sockets } = harness();
    const first = transport(URL, request({ ...base, input: [user] }));
    const socket = await nextSend(() => sockets[0]);
    await complete(socket, first, "resp_1");
    const full = { ...base, input: [user, ...sentBack, result] };
    const { pending, sent } = await sendNext(transport, socket, full);
    expect(sent).toMatchObject({ previous_response_id: "resp_1", input: [result] });
    socket.emit({
      type: "error",
      status: 400,
      error: { type: "invalid_request_error", message: "Invalid `previous_response_id`." },
    });
    for (let i = 0; i < 50 && socket.sent.length < 3; i++) await Bun.sleep(1);
    expect(socket.sent.at(-1)).toEqual({ ...full, type: "response.create" });
    socket.emit({ type: "response.output_text.delta", delta: "12:34" });
    socket.emit({ type: "response.completed", response: { id: "resp_2" } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
      "websocket; connection=reused; input=full",
    );
    expect(await response.text()).toContain("12:34");
    expect(sockets).toHaveLength(1);
  });

  test("another refusal of a continuation keeps its error", async () => {
    const { transport, sockets } = harness();
    const first = transport(URL, request({ ...base, input: [user] }));
    const socket = await nextSend(() => sockets[0]);
    await complete(socket, first, "resp_1");
    const { pending } = await sendNext(transport, socket, {
      ...base,
      input: [user, ...sentBack, result],
    });
    socket.emit({ type: "error", status: 429, error: { type: "usage_limit_reached" } });
    const response = await pending;
    expect(response.status).toBe(429);
    expect(socket.sent).toHaveLength(2);
  });
});

describe("OpenAI API and Azure OpenAI endpoints", () => {
  const OPENAI_URL = "https://api.openai.com/v1/responses";
  const AZURE_URL = "https://example-resource.openai.azure.com/openai/v1/responses";
  const openAIRequest = (body: Record<string, unknown> = { model: "m", input: [], stream: true }) =>
    ({
      method: "POST",
      headers: {
        authorization: "Bearer key",
        "idempotency-key": `req-${Math.random()}`,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }) satisfies RequestInit;

  test("matches only the OpenAI API and Azure v1 responses URLs", () => {
    const { url } = OPENAI_RESPONSES_WEBSOCKET_ENDPOINT;
    expect(url.test(OPENAI_URL)).toBe(true);
    expect(url.test(AZURE_URL)).toBe(true);
    expect(url.test("https://r.cognitiveservices.azure.com/openai/v1/responses")).toBe(true);
    expect(url.test("https://r.openai.azure.com/openai/deployments/d/responses")).toBe(false);
    expect(url.test("https://openrouter.ai/api/v1/responses")).toBe(false);
    expect(url.test("https://ai-gateway.vercel.sh/v1/responses")).toBe(false);
    expect(url.test("https://api.openai.com/v1/responses/compact")).toBe(false);
  });

  test("requests outside a conversation stay on HTTP", async () => {
    const { transport, sockets, httpCalls } = harness({
      endpoint: OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
    });
    const response = await transport(OPENAI_URL, openAIRequest());
    expect(response.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=not_eligible");
    transport.warm(OPENAI_URL, openAIRequest().headers);
    expect(sockets).toHaveLength(0);
    expect(httpCalls).toEqual([OPENAI_URL]);
  });

  test("each conversation gets its own connection and continues its previous response", async () => {
    const { transport, sockets, httpCalls } = harness({
      endpoint: OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
    });
    const user = { type: "message", role: "user", content: "hi" };
    const call = { type: "function_call", call_id: "c1", name: "f", arguments: "{}" };
    const result = { type: "function_call_output", call_id: "c1", output: "ok" };

    const first = withResponsesConversation("chat-a", () =>
      transport(AZURE_URL, openAIRequest({ model: "m", input: [user], stream: true })),
    );
    const socket = await nextSend(() => sockets[0]);
    expect(socket.url).toBe("wss://example-resource.openai.azure.com/openai/v1/responses");
    expect(socket.headers["openai-beta"]).toBeUndefined();
    expect(socket.headers.authorization).toBe("Bearer key");
    // WebSocket mode always streams; the HTTP-only field is not sent.
    expect(socket.sent[0]).toEqual({ type: "response.create", model: "m", input: [user] });
    socket.emit({
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "fc_1", ...call },
    });
    socket.emit({ type: "response.completed", response: { id: "resp_1" } });
    await (await first).text();

    // Another conversation never shares, or continues, chat-a's connection.
    const other = withResponsesConversation("chat-b", () =>
      transport(AZURE_URL, openAIRequest({ model: "m", input: [user], stream: true })),
    );
    const otherSocket = await nextSend(() => sockets[1]);
    expect(otherSocket).not.toBe(socket);
    expect(otherSocket.sent[0]).toEqual({ type: "response.create", model: "m", input: [user] });
    otherSocket.emit({ type: "response.completed", response: { id: "resp_b" } });
    await (await other).text();

    const second = withResponsesConversation("chat-a", () =>
      transport(
        AZURE_URL,
        openAIRequest({ model: "m", input: [user, call, result], stream: true }),
      ),
    );
    for (let i = 0; i < 50 && socket.sent.length < 2; i++) await Bun.sleep(1);
    expect(socket.sent[1]).toEqual({
      type: "response.create",
      model: "m",
      previous_response_id: "resp_1",
      input: [result],
    });
    socket.emit({ type: "response.completed", response: { id: "resp_2" } });
    const continued = await second;
    expect(continued.headers.get(CODEX_TRANSPORT_HEADER)).toBe(
      "websocket; connection=reused; input=incremental",
    );
    await continued.text();
    expect(sockets).toHaveLength(2);
    expect(httpCalls).toEqual([]);
  });

  test("a dropped OpenAI socket names the provider in the stream error", async () => {
    const { transport, sockets } = harness({ endpoint: OPENAI_RESPONSES_WEBSOCKET_ENDPOINT });
    const pending = withResponsesConversation("chat-a", () =>
      transport(OPENAI_URL, openAIRequest()),
    );
    const socket = await nextSend(() => sockets[0]);
    socket.emit({ type: "response.created", response: { id: "r1" } });
    const response = await pending;
    socket.drop(1006);
    await expect(response.text()).rejects.toThrow(
      "OpenAI response WebSocket closed before the response finished (1006)",
    );
  });
});
