import { describe, expect, test } from "bun:test";
import {
  codexRequestStorage,
  codexSubscriptionFetch,
  type CodexProviderRequestIdentity,
  type CodexProviderRequestSettlement,
  type CodexRequestContext,
  type FetchLike,
} from "../src";

const request = {
  method: "POST",
  body: JSON.stringify({ model: "test", input: [], stream: true }),
};
const terminal =
  'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n';
const sse = () => new Response(terminal, { headers: { "content-type": "text/event-stream" } });
function context(overrides: Partial<CodexRequestContext>): CodexRequestContext {
  return {
    clientVersion: "test",
    getToken: async () => ({
      accessToken: "fixture-old",
      chatgptAccountId: null,
      isFedramp: false,
    }),
    refresh: async () => ({ accessToken: "fixture-new", chatgptAccountId: null, isFedramp: false }),
    resolveModel: (model) => model,
    nextRequestId: () => "request-1",
    ...overrides,
  };
}
const dispatch = (ctx: CodexRequestContext, base: FetchLike, init: RequestInit = request) =>
  codexRequestStorage.run(ctx, () =>
    codexSubscriptionFetch(base)("https://fixture.invalid/responses", init),
  );

describe("one-shot Codex physical request admission", () => {
  test("wire prechecks run before reservation and denied reservations never fetch", async () => {
    let reservations = 0;
    let fetches = 0;
    const denied = new Error("source disconnected");
    const ctx = context({
      beforeProviderDispatch: () => {
        reservations++;
        throw denied;
      },
    });
    const base: FetchLike = async () => {
      fetches++;
      return sse();
    };
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(dispatch(ctx, base, { ...request, signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(reservations).toBe(0);
    await expect(dispatch(ctx, base)).rejects.toBe(denied);
    expect(reservations).toBe(1);
    expect(fetches).toBe(0);
  });

  test("401 refresh and retry reserve a NEW physical request with a new token", async () => {
    const permits: CodexProviderRequestIdentity[] = [];
    const settlements: CodexProviderRequestSettlement[] = [];
    const auth: string[] = [];
    const response = await dispatch(
      context({
        beforeProviderDispatch: (permit) => {
          permits.push(permit!);
        },
        onProviderRequestSettled: (outcome) => {
          settlements.push(outcome);
        },
      }),
      async (_url, init) => {
        expect(init?.redirect).toBe("error");
        auth.push(new Headers(init?.headers).get("authorization")!);
        expect(permits).toHaveLength(auth.length);
        return auth.length === 1
          ? new Response('{"error":{"message":"unauthorized"}}', { status: 401 })
          : sse();
      },
    );
    await response.text();
    expect(auth).toEqual(["Bearer fixture-old", "Bearer fixture-new"]);
    expect(permits).toEqual([
      { requestId: "request-1", transportAttempt: 1 },
      { requestId: "request-1", transportAttempt: 2 },
    ]);
    expect(settlements.map((value) => value.outcome)).toEqual(["refused", "response_received"]);
  });

  test.each([
    [503, "refused", "upstream connect error or disconnect/reset before headers"],
    [507, "refused", "exceeded request buffer limit while retrying upstream"],
    [500, "refused", '{"error":{"message":"server error"}}'],
    [504, "unknown", "upstream request timeout"],
    [408, "unknown", "request timeout"],
    [409, "unknown", '{"error":{"message":"request in progress"}}'],
  ] as const)(
    "a provider %i answer settles as %s, so only a definite error is retried",
    async (status, expected, body) => {
      const settlements: CodexProviderRequestSettlement[] = [];
      const response = await dispatch(
        context({
          onProviderRequestSettled: (value) => {
            settlements.push(value);
          },
        }),
        async () => new Response(body, { status }),
      );
      expect(response.status).toBe(status);
      expect(settlements.map((value) => value.outcome)).toEqual([expected]);
    },
  );

  test("cancellation during reservation never spends the permit on fetch", async () => {
    const controller = new AbortController();
    let fetches = 0;
    const outcomes: CodexProviderRequestSettlement[] = [];
    await expect(
      dispatch(
        context({
          beforeProviderDispatch: () => {
            controller.abort(new Error("cancelled during admission"));
          },
          onProviderRequestSettled: (value) => {
            outcomes.push(value);
          },
        }),
        async () => {
          fetches++;
          return sse();
        },
        { ...request, signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled during admission");
    expect(fetches).toBe(0);
    expect(outcomes.map((value) => value.outcome)).toEqual(["refused"]);
  });

  test("disconnect while receiving 401 prevents refresh and token reuse", async () => {
    let disconnected = false;
    let fetches = 0;
    let refreshes = 0;
    const ctx = context({
      refresh: async () => {
        refreshes++;
        if (disconnected) throw new Error("source disconnected");
        throw new Error("unexpected refresh");
      },
    });
    await expect(
      dispatch(ctx, async () => {
        fetches++;
        disconnected = true;
        return new Response("{}", { status: 401 });
      }),
    ).rejects.toThrow("source disconnected");
    expect(fetches).toBe(1);
    expect(refreshes).toBe(1);
  });

  test("a rejected auth retry permit cannot reuse the first permit", async () => {
    let fetches = 0;
    let permits = 0;
    await expect(
      dispatch(
        context({
          beforeProviderDispatch: () => {
            if (++permits === 2) throw new Error("source disconnected");
          },
        }),
        async () => {
          fetches++;
          return new Response("{}", { status: 401 });
        },
      ),
    ).rejects.toThrow("source disconnected");
    expect(fetches).toBe(1);
    expect(permits).toBe(2);
  });

  test("admitted stream drains once after persisted token scrubbing; next request is fenced", async () => {
    let token: string | null = "fixture-in-memory";
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let fetches = 0;
    const outcomes: CodexProviderRequestSettlement[] = [];
    const ctx = context({
      getToken: async () => {
        if (!token) throw new Error("source disconnected");
        return { accessToken: token, chatgptAccountId: null, isFedramp: false };
      },
      onProviderRequestSettled: (value) => {
        outcomes.push(value);
      },
    });
    const base: FetchLike = async (_url, init) => {
      fetches++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-in-memory");
      return new Response(
        new ReadableStream({
          start: (value) => {
            controller = value;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const response = await dispatch(ctx, base);
    token = null;
    controller.enqueue(new TextEncoder().encode(terminal));
    controller.close();
    expect(await response.text()).toBe(terminal);
    await expect(dispatch(ctx, base)).rejects.toThrow("source disconnected");
    expect(fetches).toBe(1);
    expect(outcomes).toEqual([
      { requestId: "request-1", transportAttempt: 1, outcome: "response_received" },
    ]);
  });

  test("detached timeout stays unknown even when an ignored-abort fetch returns later", async () => {
    let resolve!: (response: Response) => void;
    let fetches = 0;
    const outcomes: CodexProviderRequestSettlement[] = [];
    const response = await dispatch(
      context({
        responseTimeoutPolicy: {
          headersTimeoutMs: 10,
          wholeRequestTimeoutMs: 100,
          streamIdleTimeoutMs: 50,
        },
        onProviderRequestSettled: (value) => {
          outcomes.push(value);
        },
      }),
      async () => {
        fetches++;
        return await new Promise<Response>((yes) => {
          resolve = yes;
        });
      },
    );
    expect(response.status).toBe(504);
    resolve(sse());
    await Bun.sleep(1);
    expect(fetches).toBe(1);
    expect(outcomes.map((value) => value.outcome)).toEqual(["unknown"]);
  });

  test("successful response observation is independent of rejected terminal audit", async () => {
    const outcomes: CodexProviderRequestSettlement[] = [];
    const response = await dispatch(
      context({
        onProviderRequestSettled: (value) => {
          outcomes.push(value);
        },
        onModelRequestEvent: (event) => {
          if (event.phase === "completed") throw new Error("audit unavailable");
        },
      }),
      async () => sse(),
    );
    await response.text().catch(() => undefined);
    expect(outcomes.map((value) => value.outcome)).toEqual(["response_received"]);
    // This is transport evidence only: worker tests require durable history
    // before committing this observation as response_received in the DB.
  });

  test.each([false, true])(
    "streamed auth refusal is replay-safe only without completed output (output=%s)",
    async (withOutput) => {
      const outcomes: CodexProviderRequestSettlement[] = [];
      const prefix = withOutput
        ? 'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"effect","call_id":"call","arguments":"{}"}}\n\n'
        : "";
      const response = await dispatch(
        context({
          onProviderRequestSettled: (value) => {
            outcomes.push(value);
          },
        }),
        async () =>
          new Response(
            prefix +
              'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_api_key"}}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      await expect(response.text()).rejects.toThrow();
      // Cancellation of the failed transform joins physical observation.
      await Bun.sleep(1);
      expect(outcomes.map((value) => value.outcome)).toEqual([withOutput ? "unknown" : "refused"]);
    },
  );
});
