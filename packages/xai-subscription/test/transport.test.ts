import { describe, expect, test } from "bun:test";

import {
  isXaiSubscriptionTransportError,
  normalizeXaiResponseEventJson,
  normalizeXaiSubscriptionRequestBody,
  type XaiModelRequestEvent,
  XaiSubscriptionStreamIdleTimeoutError,
  XaiSubscriptionStreamingTerminalError,
  xaiSubscriptionFetch,
  xaiSubscriptionRequestStorage,
} from "../src";

describe("SuperGrok request normalization", () => {
  test("strips namespace, forces stateless encrypted reasoning, and injects hosted search", () => {
    expect(
      normalizeXaiSubscriptionRequestBody(
        {
          model: "supergrok/grok-4.6",
          store: true,
          include: ["file_search_call.results"],
          tools: [
            { type: "function", name: "shell" },
            { type: "web_search", search_context_size: "medium" },
          ],
        },
        (slug) => slug,
        { webSearch: true, xSearch: { allowed_x_handles: ["xai"] } },
      ),
    ).toEqual({
      model: "grok-4.6",
      store: false,
      include: ["file_search_call.results", "reasoning.encrypted_content"],
      tools: [
        { type: "function", name: "shell" },
        { type: "web_search" },
        { type: "x_search", allowed_x_handles: ["xai"] },
      ],
    });
  });

  test("removes only unknown echoed tool declarations and preserves x_search output items", () => {
    const result = normalizeXaiResponseEventJson({
      type: "response.completed",
      response: {
        tools: [{ type: "function", name: "shell" }, { type: "x_search" }],
        output: [{ type: "x_search_call", id: "xs-1", status: "completed" }],
        usage: {
          input_tokens: 6003,
          output_tokens: 711,
          total_tokens: 6714,
          context_details: { input_tokens: 5022, output_tokens: 571 },
        },
      },
    });
    expect(result.finalContextTokens).toBe(5593);
    expect(result.value).toEqual({
      type: "response.completed",
      response: {
        tools: [{ type: "function", name: "shell" }],
        output: [{ type: "x_search_call", id: "xs-1", status: "completed" }],
        usage: {
          input_tokens: 6003,
          output_tokens: 711,
          total_tokens: 5593,
          context_details: { input_tokens: 5022, output_tokens: 571 },
        },
      },
    });
  });
});

describe("SuperGrok subscription fetch", () => {
  test("isolates token context, injects proxy routing, normalizes SSE, and retries only 401", async () => {
    const authorizations: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const observedUsage: number[] = [];
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async (_input, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("authorization") ?? "");
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
      expect(headers.get("x-grok-conv-id")).toBe("session-1");
      expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
      if (calls === 1) return Response.json({ error: "expired" }, { status: 401 });
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          tools: [{ type: "x_search" }],
          output: [{ type: "x_search_call", id: "xs-1", status: "completed" }],
          usage: {
            total_tokens: 100,
            context_details: { input_tokens: 40, output_tokens: 2 },
          },
        },
      });
      return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "stale", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        hostedSearch: { xSearch: true },
        onFinalContextUsage: (usage) => observedUsage.push(usage.totalTokens),
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    const text = await response.text();
    expect(authorizations).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(bodies[0]).toEqual({
      model: "grok-4.6",
      input: "hello",
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "x_search" }],
    });
    expect(text).not.toContain('"type":"x_search"');
    expect(text).toContain('"type":"x_search_call"');
    expect(text).toContain('"total_tokens":42');
    expect(observedUsage).toEqual([42]);
  });

  test("does not retry ambiguous 503 responses", async () => {
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async () => {
      calls += 1;
      return Response.json({ error: "busy" }, { status: 503 });
    });
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    expect(response.status).toBe(503);
    expect(calls).toBe(1);
  });

  test("fails any response stream that stops producing valid events without replaying it", async () => {
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  type: "response.output_item.done",
                  item: { type: "web_search_call", id: "search-1", status: "completed" },
                })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        streamIdleTimeoutMs: 10,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "response.output_item.done",
    );
    await expect(reader.read()).rejects.toBeInstanceOf(XaiSubscriptionStreamIdleTimeoutError);
    expect(calls).toBe(1);
  });

  test("fails HTTP-200 SSE error terminals with the exact bounded provider message and no body in audit", async () => {
    const durable: XaiModelRequestEvent[] = [];
    const wrapped = xaiSubscriptionFetch(async () => {
      return new Response(
        `data: ${JSON.stringify({
          type: "error",
          code: "invalid_request",
          message: "SECRET context overflow after tool results",
        })}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "prov-sse-error",
          },
        },
      );
    });
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        nextRequestId: () => "request-sse-error",
        onModelRequestEvent: (event) => {
          durable.push(event);
        },
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let caught: unknown;
    try {
      await reader.read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "XaiSubscriptionStreamingTerminalError",
      message: "SECRET context overflow after tool results",
      code: "invalid_request",
      eventType: "error",
      requestId: "request-sse-error",
      status: 400,
    });
    expect(caught).toBeInstanceOf(XaiSubscriptionStreamingTerminalError);
    expect(isXaiSubscriptionTransportError(caught)).toBe(true);
    expect(JSON.stringify(durable)).not.toContain("SECRET");
    expect(durable.map((event) => event.phase)).toEqual([
      "started",
      "headers",
      "first_event",
      "failed",
    ]);
    expect(durable.at(-1)).toMatchObject({
      eventCount: 1,
      lastEventType: "error",
      responseObserved: true,
      status: 200,
    });
  });

  test("maps HTTP-200 SuperGrok capacity SSE terminals to a retryable 429 without leaking the body into audit", async () => {
    const durable: XaiModelRequestEvent[] = [];
    const wrapped = xaiSubscriptionFetch(async () => {
      return new Response(
        `data: ${JSON.stringify({
          type: "error",
          message:
            "The model is currently at capacity due to high demand. Please try again in a few minutes.",
        })}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "prov-sse-capacity",
          },
        },
      );
    });
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        nextRequestId: () => "request-sse-capacity",
        onModelRequestEvent: (event) => {
          durable.push(event);
        },
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let caught: unknown;
    try {
      await reader.read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "XaiSubscriptionStreamingTerminalError",
      message:
        "The model is currently at capacity due to high demand. Please try again in a few minutes.",
      code: "rate_limit_exceeded",
      eventType: "error",
      requestId: "request-sse-capacity",
      status: 429,
    });
    expect(isXaiSubscriptionTransportError(caught)).toBe(true);
    expect(JSON.stringify(durable)).not.toContain("high demand");
  });

  test("does not map isolated high-demand wording onto the SuperGrok capacity waiter", async () => {
    const wrapped = xaiSubscriptionFetch(async () => {
      return new Response(
        `data: ${JSON.stringify({
          type: "error",
          code: "response_error",
          message: "This feature is paused due to high demand policy.",
        })}\n\n`,
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "prov-sse-high-demand-policy",
          },
        },
      );
    });
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        nextRequestId: () => "request-sse-high-demand-policy",
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    const reader = response.body!.getReader();
    let caught: unknown;
    try {
      await reader.read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "XaiSubscriptionStreamingTerminalError",
      message: "This feature is paused due to high demand policy.",
      code: "response_error",
      status: 502,
    });
  });

  test("keeps a healthy hosted-search continuation streaming to its terminal response", async () => {
    const encoder = new TextEncoder();
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "response.output_item.done",
                    item: { type: "web_search_call", id: "search-1", status: "completed" },
                  })}\n\n`,
                ),
              );
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n` +
                      `data: ${JSON.stringify({
                        type: "response.completed",
                        response: { output: [], usage: {} },
                      })}\n\n`,
                  ),
                );
              }, 5);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        streamIdleTimeoutMs: 50,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    const text = await response.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
  });

  test("keeps reading when the first SSE event spans multiple upstream chunks", async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode(
      `data: ${JSON.stringify({
        type: "response.created",
        response: {
          id: "response-fragmented",
          status: "in_progress",
          instructions: "x".repeat(15_000),
        },
      })}\n\n` +
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { id: "response-fragmented", output: [], usage: {} },
        })}\n\n`,
    );
    const boundaries = [6_839, 8_186, 12_287, payload.byteLength];
    const chunks = boundaries.map((end, index) => payload.slice(boundaries[index - 1] ?? 0, end));
    let index = 0;
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks[index++];
              if (chunk) {
                controller.enqueue(chunk);
                return;
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        streamIdleTimeoutMs: 50,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    const text = await response.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.completed");
  });

  test("closes a terminal SSE response even if the upstream socket stays open", async () => {
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    type: "response.completed",
                    response: { output: [], usage: {} },
                  })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    expect(await response.text()).toContain("response.completed");
  });

  test("recognizes standard CRLF SSE framing as valid progress and terminal state", async () => {
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\r\n\r\n` +
            "data: [DONE]\r\n\r\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        streamIdleTimeoutMs: 20,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    expect(await response.text()).toContain("[DONE]");
  });

  test("does not let comments, malformed data, or partial bytes reset stream liveness", async () => {
    const encoder = new TextEncoder();
    const durable: XaiModelRequestEvent[] = [];
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "a" })}\n\n`,
                ),
              );
              setTimeout(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 4);
              setTimeout(() => controller.enqueue(encoder.encode("data: not-json\n\n")), 8);
              setTimeout(() => controller.enqueue(encoder.encode("data: {}\n\n")), 10);
              setTimeout(
                () =>
                  controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta"')),
                12,
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        streamIdleTimeoutMs: 20,
        nextRequestId: () => "request-idle",
        onModelRequestEvent: (event) => {
          durable.push(event);
        },
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "response.output_text.delta",
    );
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": keepalive");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("not-json");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: {}");
    await expect(reader.read()).rejects.toMatchObject({
      code: "xai_response_stream_idle_timeout",
      requestId: "request-idle",
      responseObserved: true,
      eventCount: 1,
      lastEventType: "response.output_text.delta",
    });
    expect(durable.map((event) => event.phase)).toEqual([
      "started",
      "headers",
      "first_event",
      "timed_out",
    ]);
    expect(durable.at(-1)).toMatchObject({
      eventCount: 1,
      lastEventType: "response.output_text.delta",
      responseObserved: true,
    });
    expect(durable.at(-1)?.silenceDurationMs).toBeGreaterThanOrEqual(15);
  });

  test("allows a long response when every valid event arrives inside the idle interval", async () => {
    const encoder = new TextEncoder();
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const [index, delay] of [0, 15, 30, 45].entries()) {
                setTimeout(
                  () =>
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: String(index) })}\n\n`,
                      ),
                    ),
                  delay,
                );
              }
              setTimeout(
                () =>
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: "response.completed",
                        response: { output: [], usage: {} },
                      })}\n\n`,
                    ),
                  ),
                60,
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const startedAt = performance.now();
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        streamIdleTimeoutMs: 35,
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    expect(await response.text()).toContain("response.completed");
    expect(performance.now() - startedAt).toBeGreaterThan(50);
  });

  test("emits retry-aware durable checkpoints and metadata-only diagnostics", async () => {
    const durable: XaiModelRequestEvent[] = [];
    const diagnostics: XaiModelRequestEvent[] = [];
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("expired", {
          status: 401,
          headers: { "x-request-id": "provider-401" },
        });
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { output: [], usage: {} },
          })}\n\n`,
        {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "provider-ok",
          },
        },
      );
    });
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "stale", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        nextRequestId: () => "request-audit",
        onModelRequestDiagnostic: (event) => diagnostics.push(event),
        onModelRequestEvent: (event) => {
          durable.push(event);
        },
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "secret output" }),
        }),
    );
    await response.text();
    expect(durable.map(({ transportAttempt, phase }) => `${transportAttempt}:${phase}`)).toEqual([
      "1:started",
      "1:headers",
      "1:failed",
      "2:started",
      "2:headers",
      "2:first_event",
      "2:completed",
    ]);
    expect(durable[2]).toMatchObject({
      providerRequestId: "provider-401",
      status: 401,
      willRetry: true,
    });
    expect(durable.at(-1)).toMatchObject({
      requestId: "request-audit",
      providerRequestId: "provider-ok",
      eventCount: 2,
      lastEventType: "response.completed",
    });
    expect(diagnostics.some((event) => event.phase === "progress")).toBe(true);
    expect(JSON.stringify({ durable, diagnostics })).not.toContain("secret output");
    expect(JSON.stringify({ durable, diagnostics })).not.toContain("Bearer");
  });

  test("reports a failed terminal and makes no provider call when the started audit fails", async () => {
    const diagnostics: XaiModelRequestEvent[] = [];
    let calls = 0;
    const wrapped = xaiSubscriptionFetch(async () => {
      calls += 1;
      return new Response();
    });

    await expect(
      xaiSubscriptionRequestStorage.run(
        {
          clientVersion: "1.0.1",
          sessionId: "session-1",
          turnId: "turn-1",
          getToken: async () => ({ accessToken: "access", userId: "user-1" }),
          refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
          resolveModel: (slug) => slug,
          onModelRequestDiagnostic: (event) => {
            diagnostics.push(event);
          },
          onModelRequestEvent: () => {
            throw new Error("audit unavailable");
          },
        },
        async () =>
          await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
            method: "POST",
            body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
          }),
      ),
    ).rejects.toThrow("audit unavailable");
    expect(calls).toBe(0);
    expect(diagnostics.map((event) => event.phase)).toEqual(["started", "failed"]);
  });

  test("propagates a terminal audit failure instead of leaving the response stream hanging", async () => {
    const wrapped = xaiSubscriptionFetch(
      async () =>
        new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { output: [], usage: {} },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await xaiSubscriptionRequestStorage.run(
      {
        clientVersion: "1.0.1",
        sessionId: "session-1",
        turnId: "turn-1",
        getToken: async () => ({ accessToken: "access", userId: "user-1" }),
        refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
        resolveModel: (slug) => slug,
        onModelRequestEvent: (event) => {
          if (event.phase === "completed") throw new Error("terminal audit unavailable");
        },
      },
      async () =>
        await wrapped("https://cli-chat-proxy.grok.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
    await expect(response.text()).rejects.toThrow("terminal audit unavailable");
  });
});
