import { describe, expect, test } from "bun:test";

import {
  type XaiProviderRequestIdentity,
  type XaiProviderRequestSettlement,
  type XaiSubscriptionRequestContext,
  xaiSubscriptionFetch,
  xaiSubscriptionRequestStorage,
} from "../src";

const URL_RESPONSES = "https://cli-chat-proxy.grok.com/v1/responses";

function sse(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A scripted upstream and a custody recorder; no network is reachable. */
function harness(responses: Array<() => Response | Promise<Response>>) {
  const order: string[] = [];
  const admitted: XaiProviderRequestIdentity[] = [];
  const settled: XaiProviderRequestSettlement[] = [];
  let call = 0;
  const wrapped = xaiSubscriptionFetch(async () => {
    order.push(`send:${call + 1}`);
    const next = responses[call++];
    if (!next) throw new Error("unexpected provider call");
    return await next();
  });
  let sequence = 0;
  const context = (overrides: Partial<XaiSubscriptionRequestContext> = {}) =>
    ({
      clientVersion: "1.0.1",
      sessionId: "session-1",
      turnId: "turn-1",
      getToken: async () => ({ accessToken: "access", userId: "user-1" }),
      refresh: async () => ({ accessToken: "fresh", userId: "user-1" }),
      resolveModel: (slug: string) => slug,
      nextRequestId: () => `request-${++sequence}`,
      beforeProviderDispatch: async (request: XaiProviderRequestIdentity) => {
        order.push(`admit:${request.requestId}:${request.transportAttempt}`);
        admitted.push(request);
      },
      onProviderRequestSettled: async (request: XaiProviderRequestSettlement) => {
        order.push(`settle:${request.requestId}:${request.transportAttempt}:${request.outcome}`);
        settled.push(request);
      },
      ...overrides,
    }) satisfies XaiSubscriptionRequestContext;
  const withoutCustody = (full: XaiSubscriptionRequestContext): XaiSubscriptionRequestContext => {
    const { beforeProviderDispatch: _before, onProviderRequestSettled: _settled, ...rest } = full;
    return rest;
  };
  const send = (
    overrides: Partial<XaiSubscriptionRequestContext> = {},
    options: { custody?: boolean } = {},
  ) =>
    xaiSubscriptionRequestStorage.run(
      options.custody === false ? withoutCustody(context(overrides)) : context(overrides),
      () =>
        wrapped(URL_RESPONSES, {
          method: "POST",
          body: JSON.stringify({ model: "supergrok/grok-4.6", input: "hello" }),
        }),
    );
  return { order, admitted, settled, send, calls: () => call };
}

async function drain(response: Response): Promise<unknown> {
  try {
    await response.text();
    return null;
  } catch (error) {
    return error;
  }
}

describe("SuperGrok request custody hooks", () => {
  test("admits before the physical send and settles a completed stream as response_received", async () => {
    const h = harness([
      () =>
        sse(
          { type: "response.created", response: { id: "r1" } },
          { type: "response.output_text.delta", delta: "hi" },
          { type: "response.completed", response: { id: "r1", output: [] } },
        ),
    ]);
    await drain(await h.send());
    expect(h.order).toEqual([
      "admit:request-1:1",
      "send:1",
      "settle:request-1:1:response_received",
    ]);
  });

  test("a refused admission sends nothing and settles nothing", async () => {
    const h = harness([() => sse({ type: "response.completed", response: {} })]);
    const refusal = new Error("outcome unknown");
    await expect(
      h.send({
        beforeProviderDispatch: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(h.calls()).toBe(0);
    expect(h.settled).toEqual([]);
  });

  test("the 401 refresh retry is a second admitted physical request; the first is refused", async () => {
    const h = harness([
      () => Response.json({ error: "expired" }, { status: 401 }),
      () => sse({ type: "response.completed", response: { id: "r1", output: [] } }),
    ]);
    await drain(await h.send());
    expect(h.order).toEqual([
      "admit:request-1:1",
      "send:1",
      "settle:request-1:1:refused",
      "admit:request-1:2",
      "send:2",
      "settle:request-1:2:response_received",
    ]);
  });

  test("definite HTTP refusals settle refused; ambiguous statuses settle unknown", async () => {
    for (const [status, outcome] of [
      [403, "refused"],
      [429, "refused"],
      [503, "refused"],
      [408, "unknown"],
      [409, "unknown"],
      [504, "unknown"],
    ] as const) {
      const h = harness([() => Response.json({ error: "x" }, { status })]);
      const response = await h.send();
      expect(response.status).toBe(status);
      expect(h.settled.map((request) => request.outcome)).toEqual([outcome]);
    }
  });

  test("an HTTP-200 capacity terminal before output is a refusal", async () => {
    for (const event of [
      { type: "error", message: "The model is currently at capacity due to high demand." },
      { type: "error", code: "usage_limit_reached", message: "limit" },
      { type: "response.failed", response: { error: { code: "insufficient_quota" } } },
    ]) {
      const h = harness([() => sse({ type: "response.created", response: {} }, event)]);
      expect(await drain(await h.send())).toBeTruthy();
      expect(h.settled.map((request) => request.outcome)).toEqual(["refused"]);
    }
  });

  test("a capacity terminal after output, other terminals, drops and idle stalls are unknown", async () => {
    const cases: Array<() => Response> = [
      () =>
        sse(
          { type: "response.output_text.delta", delta: "partial" },
          { type: "error", code: "usage_limit_reached", message: "limit" },
        ),
      () => sse({ type: "error", code: "invalid_prompt", message: "bad" }),
      () => sse({ type: "response.output_text.delta", delta: "partial" }),
    ];
    for (const next of cases) {
      const h = harness([next]);
      await drain(await h.send());
      expect(h.settled.map((request) => request.outcome)).toEqual(["unknown"]);
    }
    const stalled = harness([
      () =>
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ]);
    await drain(await stalled.send({ streamIdleTimeoutMs: 20 }));
    expect(stalled.settled.map((request) => request.outcome)).toEqual(["unknown"]);
  });

  test("a connection loss before headers is unknown and is never retried", async () => {
    const h = harness([
      () => {
        throw new TypeError("socket hang up");
      },
    ]);
    await expect(h.send()).rejects.toThrow("socket hang up");
    expect(h.calls()).toBe(1);
    expect(h.settled.map((request) => request.outcome)).toEqual(["unknown"]);
  });

  test("without custody hooks the transport behaves as before", async () => {
    const h = harness([() => sse({ type: "response.completed", response: { output: [] } })]);
    await drain(await h.send({}, { custody: false }));
    expect(h.order).toEqual(["send:1"]);
  });
});
