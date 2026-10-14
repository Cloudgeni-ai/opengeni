import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/index";
import {
  OpenGeniAllowanceExhaustedError,
  OpenGeniApiError,
  OpenGeniSessionUsageLimitReachedError,
  OpenGeniSessionUsageLimitUnsupportedError,
  allowanceExhaustedFields,
  sessionUsageLimitReachedFields,
} from "../src/errors";
import { createSessionProxyHandler } from "../src/session-proxy";
import {
  getSessionUsageLimit,
  sessionUsageLimitReachedMessage,
  parseSessionUsageLimitReachedRefusal,
  setSessionUsageLimit,
} from "../src/session-usage-limits";

// additive SDK surface, exact echo so a mixed-version server can
// never silently accept an unenforced limit, a typed refusal that is never
// mapped to credits, and a browser proxy that cannot write limits.

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ROOT_ID = "33333333-3333-4333-8333-333333333333";

const REFUSAL = {
  code: "session_usage_limit_reached",
  basis: "model_api_equivalent_v1",
  rootSessionId: ROOT_ID,
  limitMicros: 5_000_000,
  usedMicros: 5_250_000,
  message: "This task reached its usage limit.",
};

function state(limitMicros: number | null, version = 1) {
  return {
    basis: "model_api_equivalent_v1",
    rootSessionId: SESSION_ID,
    inherited: false,
    limitMicros,
    usedMicros: 0,
    status: limitMicros === null ? "unlimited" : "within",
    history: "complete",
    pricedCalls: 0,
    freeCalls: 0,
    unpricedCalls: 0,
    version,
  };
}

function client(responder: (request: Request, body: unknown) => Response) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const og = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input : String(input), init);
      const body = request.method === "GET" ? undefined : await request.json().catch(() => null);
      requests.push({ method: request.method, path: new URL(request.url).pathname, body });
      return responder(request, body);
    }) as typeof fetch,
  });
  return { og, requests };
}

function created(usageLimit?: unknown) {
  return Response.json(
    {
      id: SESSION_ID,
      accountId: "44444444-4444-4444-8444-444444444444",
      workspaceId: WORKSPACE_ID,
      status: "queued",
      ...(usageLimit === undefined ? {} : { usageLimit }),
    },
    { status: 201 },
  );
}

describe("createSession usage limit echo", () => {
  test("a requested limit echoed by the server is accepted", async () => {
    const { og, requests } = client(() => created(state(2_500_000)));
    const session = await og.createSession(WORKSPACE_ID, {
      initialMessage: "hi",
      usageLimitMicros: 2_500_000,
    });
    expect(session.usageLimit?.limitMicros).toBe(2_500_000);
    expect(requests[0]!.body).toMatchObject({ usageLimitMicros: 2_500_000 });
  });

  test("an older server that strips the field fails loudly instead of running unlimited", async () => {
    const { og } = client(() => created());
    await expect(
      og.createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 0 }),
    ).rejects.toThrow("did not confirm its usage limit");
  });

  test("a different echoed value is refused", async () => {
    const { og } = client(() => created(state(1)));
    await expect(
      og.createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 2 }),
    ).rejects.toThrow("did not confirm its usage limit");
  });

  test("no requested limit needs no echo (old servers keep working)", async () => {
    const { og, requests } = client(() => created());
    const session = await og.createSession(WORKSPACE_ID, { initialMessage: "hi" });
    expect(session.id).toBe(SESSION_ID);
    expect(requests[0]!.body).not.toHaveProperty("startMode");
  });

  test("a limited create spells out startMode standard; an explicit realtime is kept", async () => {
    const { og, requests } = client(() => created(state(5)));
    await og.createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 5 });
    expect(requests[0]!.body).toMatchObject({ startMode: "standard", usageLimitMicros: 5 });
    const realtime = client(() => created(state(5)));
    await realtime.og.createSession(WORKSPACE_ID, { startMode: "realtime", usageLimitMicros: 5 });
    expect(realtime.requests[0]!.body).toMatchObject({ startMode: "realtime" });
  });

  test("an older server rejects the whole limited create before starting work: typed, no session", async () => {
    // Exact status and body captured from main 7ca987b20 (before usage
    // limits) for the body a limited create sends: its create route parses
    // the request and answers 422 before creating or dispatching anything.
    const { og, requests } = client(
      () =>
        new Response(
          '{"code":"INVALID_SESSION_CREATE_REQUEST","message":"Invalid session create request: startMode failed schema validation"}',
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const error = await og
      .createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 5 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenGeniSessionUsageLimitUnsupportedError);
    expect(error).toMatchObject({ code: "session_usage_limit_unsupported", sessionId: null });
    expect((error as Error).cause).toBeInstanceOf(OpenGeniApiError);
    expect(requests).toHaveLength(1);
  });

  test("other create validation errors stay ordinary API errors", async () => {
    for (const message of [
      "Invalid session create request: usageLimitMicros failed schema validation",
      "Invalid session create request: startModeOptions failed schema validation",
    ]) {
      const { og } = client(() =>
        Response.json({ code: "INVALID_SESSION_CREATE_REQUEST", message }, { status: 422 }),
      );
      const error = await og
        .createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 5 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenGeniApiError);
      expect(error).not.toBeInstanceOf(OpenGeniSessionUsageLimitUnsupportedError);
    }
    // An unlimited create never reinterprets a startMode error.
    const unlimited = client(() =>
      Response.json(
        {
          code: "INVALID_SESSION_CREATE_REQUEST",
          message: "Invalid session create request: startMode failed schema validation",
        },
        { status: 422 },
      ),
    );
    const error = await unlimited.og
      .createSession(WORKSPACE_ID, { initialMessage: "hi", startMode: "realtime" })
      .catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(OpenGeniSessionUsageLimitUnsupportedError);
  });

  test("a request-body validator naming startMode is also typed", async () => {
    const { og, requests } = client(() =>
      Response.json(
        {
          error: {
            message: "Invalid request body",
            details: {
              code: "invalid_request_body",
              issues: [{ path: "startMode", message: 'Invalid input: expected "realtime"' }],
            },
          },
        },
        { status: 400 },
      ),
    );
    const error = await og
      .createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 5 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenGeniSessionUsageLimitUnsupportedError);
    expect(error).toMatchObject({ code: "session_usage_limit_unsupported", sessionId: null });
    expect(requests).toHaveLength(1);
  });

  test("an unconfirmed echo names the created session in a typed error", async () => {
    const { og } = client(() => created());
    const error = await og
      .createSession(WORKSPACE_ID, { initialMessage: "hi", usageLimitMicros: 5 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenGeniSessionUsageLimitUnsupportedError);
    expect(error).toMatchObject({ sessionId: SESSION_ID });
  });
});

describe("usage limit reads and writes", () => {
  test("client and free functions use the same route and verify the committed limit", async () => {
    const { og, requests } = client((request, body) =>
      request.method === "GET"
        ? Response.json(state(null, 3))
        : Response.json(state((body as { limitMicros: number | null }).limitMicros, 4)),
    );
    expect((await og.getSessionUsageLimit(WORKSPACE_ID, SESSION_ID)).version).toBe(3);
    expect((await getSessionUsageLimit(og, WORKSPACE_ID, SESSION_ID)).version).toBe(3);
    const request = { limitMicros: 1_000_000, expectedVersion: 3, operationId: "op-1" };
    expect((await og.setSessionUsageLimit(WORKSPACE_ID, SESSION_ID, request)).version).toBe(4);
    expect((await setSessionUsageLimit(og, WORKSPACE_ID, SESSION_ID, request)).version).toBe(4);
    const cleared = await og.setSessionUsageLimit(WORKSPACE_ID, SESSION_ID, {
      limitMicros: null,
      expectedVersion: 4,
      operationId: "op-2",
    });
    expect(cleared.limitMicros).toBeNull();
    for (const recorded of requests) {
      expect(recorded.path).toBe(
        `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/usage-limit`,
      );
    }
  });

  test("a write the server did not apply is not reported as success", async () => {
    const { og } = client(() => Response.json(state(null, 4)));
    const request = { limitMicros: 1_000_000, expectedVersion: 3, operationId: "op-1" };
    await expect(og.setSessionUsageLimit(WORKSPACE_ID, SESSION_ID, request)).rejects.toThrow(
      "did not confirm the requested usage limit",
    );
    await expect(setSessionUsageLimit(og, WORKSPACE_ID, SESSION_ID, request)).rejects.toThrow(
      "did not confirm the requested usage limit",
    );
  });
});

describe("refusal errors", () => {
  test("a 402 refusal becomes a typed, non-retryable usage-limit error, never credits", async () => {
    // The API's exact envelope: public refusal fields only, in `details`.
    const envelope = {
      error: {
        code: "session_usage_limit_reached",
        message: REFUSAL.message,
        retryable: false,
        outcomeUnknown: false,
        details: {
          basis: REFUSAL.basis,
          rootSessionId: ROOT_ID,
          limitMicros: REFUSAL.limitMicros,
          usedMicros: REFUSAL.usedMicros,
        },
      },
    };
    const { og } = client(() => Response.json(envelope, { status: 402 }));
    const error = await og
      .sendMessage(WORKSPACE_ID, SESSION_ID, { content: "more" } as never)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenGeniSessionUsageLimitReachedError);
    expect(error).toBeInstanceOf(OpenGeniApiError);
    expect(error).not.toBeInstanceOf(OpenGeniAllowanceExhaustedError);
    const typed = error as OpenGeniSessionUsageLimitReachedError;
    expect(typed.status).toBe(402);
    expect(typed.code).toBe("session_usage_limit_reached");
    expect(typed.retryable).toBe(false);
    expect(typed).toMatchObject({
      rootSessionId: ROOT_ID,
      limitMicros: 5_000_000,
      usedMicros: 5_250_000,
    });
  });

  test("the allowance parser (older clients) does not recognize a usage-limit refusal", () => {
    const body = JSON.stringify({ error: REFUSAL });
    expect(allowanceExhaustedFields(body)).toBeNull();
    expect(sessionUsageLimitReachedFields(body)).toMatchObject({ limitMicros: 5_000_000 });
  });

  test("presentation is about the task's limit, never credits or a monthly reset", () => {
    const parsed = parseSessionUsageLimitReachedRefusal(REFUSAL);
    expect(parsed).not.toBeNull();
    const text = sessionUsageLimitReachedMessage(parsed!);
    expect(text.toLowerCase()).not.toMatch(/credit|monthly|resets?\b|billing/u);
    expect(text).toContain("$5");
  });
});

describe("browser session proxy", () => {
  const handlerFor = (onUpstream: (path: string) => void) => {
    const { og } = client((request) => {
      onUpstream(`${request.method} ${new URL(request.url).pathname}`);
      if (new URL(request.url).pathname === "/v1/config/client") {
        return Response.json({ sessionUsageLimits: { enabled: true } });
      }
      return created(state(1));
    });
    return createSessionProxyHandler(og, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "alice" }),
      createSession: async (input) => ({ initialMessage: input.initialMessage ?? "" }),
    });
  };
  const base = `https://product.test/api/opengeni/v1/workspaces/${WORKSPACE_ID}`;

  test("a browser cannot set a limit on create", async () => {
    const upstream: string[] = [];
    const response = await handlerFor((path) => upstream.push(path))(
      new Request(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initialMessage: "hi", usageLimitMicros: 0 }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "create_field_not_allowed" } });
    expect(upstream).toEqual([]);
  });

  test("a browser cannot read or write the limit route through the proxy", async () => {
    const upstream: string[] = [];
    const handler = handlerFor((path) => upstream.push(path));
    for (const method of ["GET", "PUT"]) {
      const response = await handler(
        new Request(`${base}/sessions/${SESSION_ID}/usage-limit`, {
          method,
          ...(method === "PUT"
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ limitMicros: null, expectedVersion: 1, operationId: "x" }),
              }
            : {}),
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(upstream.filter((path) => path.includes("usage-limit"))).toEqual([]);
  });

  test("the proxied client config does not advertise limit editing", async () => {
    const response = await handlerFor(() => undefined)(
      new Request("https://product.test/api/opengeni/v1/config/client"),
    );
    expect(response.status).toBe(200);
    const config = (await response.json()) as Record<string, unknown>;
    expect(config.sessionUsageLimits).toBeUndefined();
  });
});
