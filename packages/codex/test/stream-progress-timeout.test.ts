import { describe, expect, test } from "bun:test";
import {
  type CodexModelRequestEvent,
  type CodexRequestContext,
  type CodexResponseTimeoutPolicy,
  classifyCodexResponseTimeoutError,
  codexRequestStorage,
  codexSubscriptionFetch,
} from "../src";
import {
  codexResponsesTransport,
  createResponsesTurn,
  withResponsesConversation,
  type CodexWebSocketLike,
} from "../src/responses-websocket";
import { resolveCodexResponseTimeoutPolicy } from "../src/response-timeout";

// A wedged generation behind a live socket: the provider keeps sending status
// frames, so the connection never goes silent but the model never advances.
// These tests drive the real Codex fetch over the real WebSocket transport
// with a scripted socket and short deadlines.

class ScriptedSocket implements CodexWebSocketLike {
  readyState = 0;
  handshakeStatus?: number;
  closed = false;
  onopen: CodexWebSocketLike["onopen"] = null;
  onmessage: CodexWebSocketLike["onmessage"] = null;
  onerror: CodexWebSocketLike["onerror"] = null;
  onclose: CodexWebSocketLike["onclose"] = null;
  constructor(private readonly script: (socket: ScriptedSocket) => void) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(event: Record<string, unknown>) {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(event) });
  }
  send() {
    this.script(this);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

const POLICY: Partial<CodexResponseTimeoutPolicy> = {
  headersTimeoutMs: 1_000,
  streamIdleTimeoutMs: 60,
  streamProgressTimeoutMs: 200,
  wholeRequestTimeoutMs: 3_000,
};

const reasoningDelta = (delta: string) => ({
  type: "response.reasoning_summary_text.delta",
  item_id: "rs_1",
  output_index: 0,
  summary_index: 0,
  delta,
});
const completed = {
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
  },
};

/** Emit `frames` one after another, `everyMs` apart; stop when the socket closes. */
function play(socket: ScriptedSocket, frames: Array<Record<string, unknown> | null>, everyMs = 10) {
  let index = 0;
  const timer = setInterval(() => {
    if (socket.closed || index >= frames.length) {
      clearInterval(timer);
      return;
    }
    const frame = frames[index++];
    if (frame) socket.emit(frame);
  }, everyMs);
}

/** `count` copies of a status-only frame: the socket stays busy, the model does not. */
const inProgress = (count: number) =>
  Array.from({ length: count }, () => ({
    type: "response.in_progress",
    response: { id: "resp_1", status: "in_progress" },
  }));

async function run(script: (socket: ScriptedSocket) => void) {
  const sockets: ScriptedSocket[] = [];
  const events: CodexModelRequestEvent[] = [];
  const transport = codexResponsesTransport(
    async () => new Response("unexpected http", { status: 500 }),
    {
      createSocket: () => {
        const socket = new ScriptedSocket(script);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      connectTimeoutMs: 1_000,
    },
  );
  const context: CodexRequestContext = {
    clientVersion: "1.2.3",
    getToken: async () => ({ accessToken: "AC1", chatgptAccountId: "acct_1", isFedramp: false }),
    refresh: async () => ({ accessToken: "AC2", chatgptAccountId: "acct_1", isFedramp: false }),
    resolveModel: (model) => model,
    responseTimeoutPolicy: POLICY,
    onModelRequestEvent: (event) => {
      events.push(event);
    },
  };
  const startedAt = performance.now();
  const response = await codexRequestStorage.run(context, () =>
    withResponsesConversation(createResponsesTurn("conversation"), () =>
      codexSubscriptionFetch(transport)("https://chatgpt.com/backend-api/responses", {
        method: "POST",
        headers: { session_id: "conversation" },
        body: JSON.stringify({ model: "m", input: [], stream: true }),
      }),
    ),
  );
  let body = "";
  let error: unknown;
  try {
    body = await response.text();
  } catch (caught) {
    error = caught;
  }
  return { body, error, events, sockets, elapsedMs: performance.now() - startedAt };
}

describe("Codex stream progress deadline", () => {
  test("real deltas then only response.in_progress fail once as a progress timeout, well before the whole-request deadline", async () => {
    const { error, events, sockets, elapsedMs } = await run((socket) =>
      play(socket, [
        { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        reasoningDelta("Checking"),
        reasoningDelta(" the"),
        reasoningDelta(" report"),
        reasoningDelta("."),
        // Status frames every 10 ms: far inside the 60 ms silence bound.
        ...inProgress(1_000),
      ]),
    );
    expect(classifyCodexResponseTimeoutError(error)).toMatchObject({
      timeoutClass: "progress_stream",
      responseObserved: true,
    });
    const terminals = events.filter((event) =>
      ["completed", "failed", "timed_out"].includes(event.phase),
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ phase: "timed_out", timeoutClass: "progress_stream" });
    // About one progress window after the last delta, nowhere near 3 s.
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(1_000);
    // The wedged socket is retired, not handed to the next request; there is
    // no transport replay.
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
  });

  test("true silence still fails as an idle-stream timeout", async () => {
    const { error, events, elapsedMs } = await run((socket) =>
      play(socket, [
        { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        reasoningDelta("Checking"),
      ]),
    );
    expect(classifyCodexResponseTimeoutError(error)).toMatchObject({
      timeoutClass: "idle_stream",
      responseObserved: true,
    });
    expect(events.at(-1)).toMatchObject({ phase: "timed_out", timeoutClass: "idle_stream" });
    expect(elapsedMs).toBeLessThan(200);
  });

  test("steady model progress never times out, however long the response runs", async () => {
    // 60 deltas 10 ms apart: the response outlives the progress window three
    // times over, but each delta renews it.
    const deltas = Array.from({ length: 60 }, (_, index) => reasoningDelta(`step ${index} `));
    const { body, error, events, elapsedMs } = await run((socket) =>
      play(socket, [
        { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        ...deltas,
        completed,
      ]),
    );
    expect(error).toBeUndefined();
    expect(body).toContain("response.completed");
    expect(events.at(-1)?.phase).toBe("completed");
    expect(elapsedMs).toBeGreaterThan(POLICY.streamProgressTimeoutMs!);
  });

  test("long legitimate gaps between progress survive", async () => {
    // Production's longest gap between model-progress events in a completed
    // request was about 5.5 minutes against a 10-minute progress window. Keep
    // that proportion: 110 ms of status-only frames against a 200 ms window,
    // repeated, with real progress between the gaps.
    const gap = inProgress(11);
    const { body, error, events } = await run((socket) =>
      play(socket, [
        { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
        ...gap,
        reasoningDelta("first"),
        ...gap,
        reasoningDelta("second"),
        ...gap,
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, delta: "ok" },
        ...gap,
        completed,
      ]),
    );
    expect(error).toBeUndefined();
    expect(body).toContain("response.completed");
    expect(events.at(-1)?.phase).toBe("completed");
  });

  test("over HTTP, in-band keepalive through a long silent reasoning stretch keeps only the silence bound", async () => {
    // HTTP SSE has to keep proxies alive in band, and real requests have
    // reasoned silently for many minutes that way. Three progress windows of
    // status-only events must not end the response.
    const encoder = new TextEncoder();
    const sse = (event: Record<string, unknown>) =>
      encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    const frames = [
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      ...inProgress(60),
      completed,
    ];
    const events: CodexModelRequestEvent[] = [];
    const response = await codexRequestStorage.run(
      {
        clientVersion: "1.2.3",
        getToken: async () => ({
          accessToken: "AC1",
          chatgptAccountId: "acct_1",
          isFedramp: false,
        }),
        refresh: async () => ({
          accessToken: "AC2",
          chatgptAccountId: "acct_1",
          isFedramp: false,
        }),
        resolveModel: (model) => model,
        responseTimeoutPolicy: POLICY,
        onModelRequestEvent: (event) => {
          events.push(event);
        },
      },
      () =>
        codexSubscriptionFetch(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  let index = 0;
                  const timer = setInterval(() => {
                    const frame = frames[index++];
                    if (!frame) {
                      clearInterval(timer);
                      controller.close();
                      return;
                    }
                    controller.enqueue(sse(frame));
                  }, 10);
                },
              }),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            ),
        )("https://chatgpt.com/backend-api/responses", {
          method: "POST",
          body: JSON.stringify({ model: "m", input: [], stream: true }),
        }),
    );
    expect(await response.text()).toContain("response.completed");
    expect(events.at(-1)?.phase).toBe("completed");
  });

  test("the default progress window leaves room for the longest measured gap and ends before the whole request", () => {
    const policy = resolveCodexResponseTimeoutPolicy(undefined);
    expect(policy.streamProgressTimeoutMs).toBe(10 * 60_000);
    // Longest measured gap between model-progress events in a completed request.
    // 380 seconds is the longest measured gap between model-progress events in
    // completed WebSocket responses; the default must stay well above it.
    expect(policy.streamProgressTimeoutMs).toBeGreaterThan(380_000);
    expect(policy.streamProgressTimeoutMs).toBeLessThan(policy.wholeRequestTimeoutMs);
    // Never shorter than the silence bound, even when configured that way.
    expect(
      resolveCodexResponseTimeoutPolicy({ streamIdleTimeoutMs: 1_000, streamProgressTimeoutMs: 10 })
        .streamProgressTimeoutMs,
    ).toBe(1_000);
  });
});
