import { describe, expect, test } from "bun:test";
import {
  CODEX_RESPONSES_WEBSOCKET_BETA,
  CODEX_TRANSPORT_HEADER,
  codexResponsesTransport,
  formatCodexRequestTransport,
  parseCodexRequestTransport,
  type CodexWebSocketLike,
} from "../src/responses-websocket";
import { parseCodexUsageHeaders } from "../src/fetch";

const URL = "https://chatgpt.example/backend-api/codex/responses";

class FakeSocket implements CodexWebSocketLike {
  readyState = 0;
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

function harness(options: { autoOpen?: boolean; now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const httpCalls: string[] = [];
  const transport = codexResponsesTransport(
    async (input) => {
      httpCalls.push(String(input));
      return new Response("http", { status: 200 });
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
    },
  );
  return { transport, sockets, httpCalls };
}

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
  sockets[0]!.drop(1006);
  const failed = await pending;
  expect(failed.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=handshake_failed");
  expect(await failed.text()).toBe("http");
  transport.warm(URL, request().headers);
  const backedOff = await transport(URL, request());
  expect(backedOff.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=handshake_backoff");
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
    },
  );
  const body = { model: "m", input: [{ role: "user", content: "hi" }], stream: true };
  const pending = transport(URL, streamedRequest(body));
  const socket = await nextSend(() => sockets[0]);
  expect(socket.sent[0]).toMatchObject({ type: "response.create", ...body });
  // While the socket is busy, the same kind of request still reaches HTTP whole.
  const busy = await transport(URL, streamedRequest(body));
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

test("a failed handshake falls back to HTTP and backs off", async () => {
  const { transport, sockets, httpCalls } = harness({ autoOpen: false });
  const pending = transport(URL, request());
  for (let i = 0; i < 50 && !sockets[0]; i++) await Bun.sleep(1);
  sockets[0]!.drop(1006);
  const failed = await pending;
  expect(failed.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=handshake_failed");
  expect(await failed.text()).toBe("http");
  const backedOff = await transport(URL, request());
  expect(backedOff.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=handshake_backoff");
  expect(await backedOff.text()).toBe("http");
  expect(sockets).toHaveLength(1);
  expect(httpCalls).toHaveLength(2);
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

test("a conversation whose socket keeps dropping mid-response falls back to HTTP", async () => {
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

  // A second drop close to the first moves the conversation to HTTP.
  await dropOnce(2);
  const viaHttp = await transport(URL, request());
  expect(viaHttp.headers.get(CODEX_TRANSPORT_HEADER)).toBe("http; reason=stream_dropped");
  transport.warm(URL, request().headers);
  expect(sockets).toHaveLength(3);
  expect(httpCalls).toEqual([URL]);

  // After the fallback period the conversation tries the socket again.
  clock += 31 * 60_000;
  const again = transport(URL, request());
  const fresh = await nextSend(() => sockets[3]);
  fresh.emit({ type: "response.completed", response: {} });
  expect((await again).headers.get(CODEX_TRANSPORT_HEADER)).toBe(
    "websocket; connection=new; handshake_ms=0",
  );
  expect(parseCodexRequestTransport("http; reason=stream_dropped")).toEqual({
    kind: "http",
    reason: "stream_dropped",
  });
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
    for (const item of [reasoning, preamble, call]) {
      socket.emit({ type: "response.output_item.done", item });
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
    socket.emit({ type: "response.output_item.done", item: call });
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
