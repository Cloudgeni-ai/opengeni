import { expect, spyOn, test } from "bun:test";
import {
  CODEX_TRANSPORT_HEADER,
  codexRequestStorage,
  codexResponsesTransport,
  codexSubscriptionFetch,
  warmCodexResponsesConnection,
  type CodexRequestContext,
  type CodexModelRequestEvent,
  type CodexWebSocketLike,
} from "@opengeni/codex";
import OpenAI from "openai";
import { ReplayableJsonOpenAI } from "../src/replayable-json-body";
import {
  isModelSocketTransportError,
  responsesTransport,
  OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
  createResponsesTurn,
  withResponsesConversation,
} from "@opengeni/network/responses-websocket";
import { instrumentedModelFetch } from "../src/model-provider-client";
import { withModelTransportStartedObserver } from "../src/model-preparation-diagnostics";

function withCodexTurn<T>(context: CodexRequestContext, fn: () => T): T {
  return withResponsesConversation(context.sessionId ?? "fixture", () =>
    codexRequestStorage.run(context, fn),
  );
}

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

test("Codex receipts snapshot local dispatch and response-scoped server timing without exposing timing frames", async () => {
  let socket!: FakeSocket;
  const events: CodexModelRequestEvent[] = [];
  const transport = codexResponsesTransport(
    async () => {
      throw new Error("unexpected HTTP");
    },
    {
      createSocket: () => {
        socket = new FakeSocket();
        queueMicrotask(() => socket.open());
        return socket;
      },
    },
  );
  const context: CodexRequestContext = {
    clientVersion: "fixture",
    sessionId: "timing-chat",
    getToken: async () => ({
      accessToken: "fixture",
      chatgptAccountId: "fixture",
      isFedramp: false,
    }),
    refresh: async () => {
      throw new Error("unexpected refresh");
    },
    resolveModel: (model) => model,
    beforeProviderDispatch: async () => {
      await Bun.sleep(5);
    },
    onModelRequestEvent: (event) => {
      events.push(event);
    },
  };
  const client = new OpenAI({
    apiKey: "fixture",
    baseURL: "https://chatgpt.example/backend-api",
    maxRetries: 0,
    fetch: codexSubscriptionFetch(transport) as typeof globalThis.fetch,
  });
  const pending = withCodexTurn(context, () =>
    client.responses.create({ model: "m", input: "hello", stream: true }).withResponse(),
  );
  for (let i = 0; i < 100 && !socket?.sent.length; i++) await Bun.sleep(1);
  socket.emit({ type: "response.created", response: { id: "timed-response" } });
  const { data: stream } = await pending;
  const headers = events.find((event) => event.phase === "headers")!;
  expect(headers.dispatchDelayMs).toBeGreaterThanOrEqual(4);
  expect(headers.transport).toMatchObject({
    kind: "websocket",
    timing: { transportPreparationMs: expect.any(Number), sendToFirstEventMs: expect.any(Number) },
  });
  const snapshot = JSON.stringify(headers);
  socket.emit({
    type: "responsesapi.websocket_timing",
    timing_metrics: {
      response_id: "timed-response",
      timing_scope: "logical_turn",
      pre_inference_ms: 9999,
      total_turn_time_s: 9999,
      critical_path: {
        scope: "response",
        responses_pre_inference_ms: 32,
        engine_wall_ms: 1100,
        responses_other_ms: 25,
        responses_harness_unblocked_ms: 1157,
        client_tool_pause_ms: 0,
        num_engine_calls: 1,
        unrecognized_private_detail: "do not retain",
      },
    },
  });
  // Late/malformed/unscoped evidence must not replace this request's sample.
  for (const timing_metrics of [
    { response_id: "other", critical_path: { scope: "response", engine_wall_ms: 9000 } },
    {
      response_id: "timed-response",
      critical_path: { scope: "logical_turn", engine_wall_ms: 9000 },
    },
    {
      response_id: "timed-response",
      critical_path: { scope: "response", engine_wall_ms: -1, responses_other_ms: "2" },
    },
  ])
    socket.emit({ type: "responsesapi.websocket_timing", timing_metrics });
  socket.emit({
    type: "response.completed",
    response: { id: "timed-response", status: "completed", output: [] },
  });
  const types = [];
  for await (const event of stream) types.push(event.type);
  expect(types).toEqual(["response.created", "response.completed"]);
  expect(JSON.stringify(headers)).toBe(snapshot);
  const completed = events.find((event) => event.phase === "completed")!;
  expect(completed.transport).toMatchObject({
    kind: "websocket",
    timing: {
      server: {
        responsesPreInferenceMs: 32,
        engineWallMs: 1100,
        responsesOtherMs: 25,
        responsesHarnessUnblockedMs: 1157,
        clientToolPauseMs: 0,
        numEngineCalls: 1,
      },
    },
  });
  expect(JSON.stringify(completed)).not.toContain("private_detail");
  expect(completed).not.toHaveProperty("transport.timing.server.total_turn_time_s");
  expect(completed).not.toHaveProperty("transport.timing.server.pre_inference_ms");
  socket.close();
});

test.each([false, true])(
  "generic continuation retry rechecks dispatch admission (refused=%s)",
  async (refused) => {
    let socket!: FakeSocket;
    let admissions = 0;
    const refusal = new Error("dispatch revoked");
    const transport = responsesTransport(
      async () => {
        throw new Error("unexpected HTTP");
      },
      {
        endpoint: OPENAI_RESPONSES_WEBSOCKET_ENDPOINT,
        createSocket: () => {
          socket = new FakeSocket();
          queueMicrotask(() => socket.open());
          return socket;
        },
      },
    );
    const fetch = instrumentedModelFetch("openai", transport as typeof globalThis.fetch);
    const turn = createResponsesTurn("generic-chat");
    const user = { role: "user", content: "hi" };
    const send = (input: unknown[]) =>
      withResponsesConversation(turn, () =>
        withModelTransportStartedObserver(
          async () => {
            admissions++;
            if (refused && admissions === 3) throw refusal;
          },
          () =>
            fetch("https://api.openai.com/v1/responses", {
              method: "POST",
              body: JSON.stringify({ model: "m", input, stream: true }),
            }),
        ),
      );
    const first = send([user]);
    for (let i = 0; i < 100 && !socket?.sent.length; i++) await Bun.sleep(1);
    socket.emit({ type: "response.completed", response: { id: "first" } });
    await (await first).text();
    const second = send([user, { role: "user", content: "next" }]);
    const outcome = second.then(
      (response) => response,
      (error: unknown) => error,
    );
    for (let i = 0; i < 100 && socket.sent.length < 2; i++) await Bun.sleep(1);
    socket.emit({
      type: "error",
      status: 400,
      error: { code: "previous_response_not_found", param: "previous_response_id" },
    });
    for (let i = 0; i < 100; i++) {
      if (admissions >= 3) break;
      await Bun.sleep(1);
    }
    expect(admissions).toBe(3);
    if (refused) {
      expect(await outcome).toBe(refusal);
      expect(socket.sent).toHaveLength(2);
    } else {
      expect(socket.sent).toHaveLength(3);
      expect(socket.sent[2]).not.toHaveProperty("previous_response_id");
      socket.emit({ type: "response.completed", response: { id: "second" } });
      await (await second).text();
    }
  },
);

test.each(["headers", "idle"])(
  "Codex %s timeout retains socket evidence through the SDK",
  async (phase) => {
    let socket!: FakeSocket;
    const transport = codexResponsesTransport(
      async () => {
        throw new Error("unexpected HTTP");
      },
      {
        createSocket: () => {
          socket = new FakeSocket();
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
      responseTimeoutPolicy: {
        headersTimeoutMs: 40,
        streamIdleTimeoutMs: 15,
        wholeRequestTimeoutMs: 200,
      },
    };
    const client = new OpenAI({
      apiKey: "fake",
      baseURL: "https://chatgpt.example/backend-api",
      maxRetries: 0,
      fetch: codexSubscriptionFetch(transport) as typeof globalThis.fetch,
    });
    const result = withCodexTurn(context, async () => {
      try {
        const stream = await client.responses.create({ model: "m", input: "hello", stream: true });
        for await (const _event of stream) {
          /* drain */
        }
        return null;
      } catch (error) {
        return error;
      }
    });
    for (let i = 0; i < 100 && !socket?.sent.length; i++) await Bun.sleep(1);
    if (phase === "idle") socket.emit({ type: "response.created", response: { id: "pending" } });
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(isModelSocketTransportError(error)).toBe(true);
    expect(socket.sent).toHaveLength(1);
  },
);

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

  const pending = withResponsesConversation("fixture", () =>
    client.responses.create({ model: "m", input: "hi", stream: true }).withResponse(),
  );
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

  await withCodexTurn(context, () =>
    warmCodexResponsesConnection(transport, "https://chatgpt.example/backend-api/"),
  );
  expect(sockets).toHaveLength(1);
  await Bun.sleep(1);

  const pending = withCodexTurn(context, () =>
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

test("replacement preparation excludes the refused request and custody settlement", async () => {
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  let socket!: FakeSocket;
  const events: CodexModelRequestEvent[] = [];
  let sequence = 0;
  try {
    const transport = codexResponsesTransport(
      async () => {
        throw new Error("unexpected HTTP");
      },
      {
        createSocket: () => {
          socket = new FakeSocket();
          queueMicrotask(() => socket.open());
          return socket;
        },
      },
    );
    const context: CodexRequestContext = {
      clientVersion: "fixture",
      sessionId: "replacement-timing",
      getToken: async () => ({
        accessToken: "fixture",
        chatgptAccountId: "fixture",
        isFedramp: false,
      }),
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
      resolveModel: (model) => model,
      nextRequestId: () => `request-${++sequence}`,
      beforeProviderDispatch: async (request) => {
        if (request?.requestId === "request-2" && request.transportAttempt === 2) now = 170;
      },
      onProviderRequestSettled: async (request) => {
        if (request.requestId === "request-2" && request.outcome === "refused") now = 160;
      },
      onModelRequestEvent: (event) => {
        events.push(event);
      },
    };
    const fetch = codexSubscriptionFetch(transport);
    const user = { role: "user", content: "hello" };
    const send = (input: unknown[]) =>
      withCodexTurn(context, () =>
        fetch("https://chatgpt.example/backend-api/responses", {
          method: "POST",
          body: JSON.stringify({ model: "m", stream: true, input }),
        }),
      );
    const first = send([user]);
    for (let i = 0; i < 100 && !socket?.sent.length; i++) await Bun.sleep(1);
    socket.emit({
      type: "response.completed",
      response: { id: "first", status: "completed", output: [] },
    });
    await (await first).text();
    now = 10;
    const second = send([user, { role: "user", content: "next" }]);
    for (let i = 0; i < 100 && socket.sent.length < 2; i++) await Bun.sleep(1);
    now = 110;
    socket.emit({
      type: "error",
      status: 400,
      error: { code: "previous_response_not_found", param: "previous_response_id" },
    });
    for (let i = 0; i < 100 && socket.sent.length < 3; i++) await Bun.sleep(1);
    now = 190;
    socket.emit({
      type: "response.completed",
      response: { id: "second", status: "completed", output: [] },
    });
    await (await second).text();
    expect(
      events.find(
        (event) =>
          event.requestId === "request-2" &&
          event.transportAttempt === 2 &&
          event.phase === "completed",
      ),
    ).toMatchObject({
      dispatchDelayMs: 10,
      transport: {
        kind: "websocket",
        input: "full",
        timing: { transportPreparationMs: 0, sendToFirstEventMs: 20 },
      },
    });
    expect(
      events.find(
        (event) =>
          event.requestId === "request-2" &&
          event.transportAttempt === 1 &&
          event.phase === "failed",
      ),
    ).toMatchObject({
      transport: { input: "incremental", timing: { transportPreparationMs: 0 } },
    });
  } finally {
    socket?.close();
    clock.mockRestore();
  }
});

test.each([
  "success",
  "close_during_admission",
  "close_during_settlement",
  "abort_during_admission",
  "timeout_during_admission",
])("continuation refusal accounts for every physical request: %s", async (scenario) => {
  const sockets: FakeSocket[] = [];
  const custody: string[] = [];
  let requestSequence = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const abort = new AbortController();
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
    ...(scenario === "timeout_during_admission"
      ? { responseTimeoutPolicy: { headersTimeoutMs: 30, wholeRequestTimeoutMs: 1000 } }
      : {}),
    getToken: async () => ({ accessToken: "fake", chatgptAccountId: "fake", isFedramp: false }),
    refresh: async () => ({ accessToken: "fake", chatgptAccountId: "fake", isFedramp: false }),
    resolveModel: (model) => model,
    nextRequestId: () => `request-${++requestSequence}`,
    beforeProviderDispatch: async (request) => {
      custody.push(`admit:${request?.requestId}:${request?.transportAttempt}`);
      if (
        request?.requestId === "request-2" &&
        request.transportAttempt === 2 &&
        scenario.endsWith("during_admission")
      )
        await gate;
    },
    onProviderRequestSettled: async (request) => {
      custody.push(`${request.outcome}:${request.requestId}:${request.transportAttempt}`);
      if (
        request.requestId === "request-2" &&
        request.transportAttempt === 1 &&
        request.outcome === "refused" &&
        scenario === "close_during_settlement"
      )
        await gate;
    },
  };
  const fetch = codexSubscriptionFetch(transport);
  const user = { role: "user", content: "hello" };
  const send = (input: unknown[]) =>
    withCodexTurn(context, () =>
      fetch("https://chatgpt.example/backend-api/responses", {
        method: "POST",
        signal: abort.signal,
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
  if (scenario !== "success") {
    let settled = false;
    const result = second.then(
      (response) => {
        settled = true;
        return response;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const held =
      scenario === "close_during_settlement" ? "refused:request-2:1" : "admit:request-2:2";
    for (let i = 0; i < 100 && !custody.includes(held); i++) await Bun.sleep(1);
    expect(custody).toContain(held);
    if (scenario === "timeout_during_admission") await Bun.sleep(40);
    else if (scenario === "abort_during_admission") abort.abort(new Error("cancelled"));
    else socket.close();
    await Bun.sleep(1);
    expect(settled).toBe(false);
    releaseGate();
    const outcome = await result;
    if (scenario === "timeout_during_admission") expect((outcome as Response).status).toBe(504);
    else expect(outcome).toBeInstanceOf(Error);
    expect(socket.sent).toHaveLength(2);
    expect(custody.at(-1)).toBe(
      scenario === "close_during_settlement" ? "refused:request-2:1" : "refused:request-2:2",
    );
    return;
  }
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
