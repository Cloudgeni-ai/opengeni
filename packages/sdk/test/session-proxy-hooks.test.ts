import { describe, expect, test } from "bun:test";
import {
  OpenGeniClient,
  createSessionProxyHandler,
  type SessionProxyHandlerOptions,
  type SessionProxyMessageInput,
  type SessionProxyRoute,
} from "../src/index";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const API = "https://api.example.test";
const PRODUCT = "https://product.example.test";
const BASE = `${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}`;
const SESSION = `${BASE}/sessions/${SESSION_ID}`;
const TURN_ID = "77777777-7777-4777-8777-777777777777";

type Recorded = { method: string; path: string; body: unknown };

/**
 * A fake Opengeni: `answers` are consumed in order (a status, or "drop" for a
 * failed connection); after that every request answers 200.
 */
function upstreamServer(answers: Array<number | "drop"> = []) {
  const requests: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
    if (path.endsWith("/mcp-credentials/rotate")) return Response.json({ servers: [] });
    if (path === `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`) {
      return Response.json({
        id: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        status: "paused",
        mcpServers: [{ id: "crm", url: "https://crm.example.test/mcp", credentialVersion: 3 }],
      });
    }
    const answer = answers.shift();
    if (answer === "drop") throw new TypeError("fetch failed");
    if (typeof answer === "number" && answer !== 200) {
      return Response.json(
        { error: { code: "upstream", message: "Upstream." } },
        { status: answer },
      );
    }
    return Response.json({ ok: true, path });
  };
  return { requests, fetch };
}

function setup(
  overrides: Partial<SessionProxyHandlerOptions> = {},
  answers: Array<number | "drop"> = [],
) {
  const upstream = upstreamServer(answers);
  const service = new OpenGeniClient({ baseUrl: API, apiKey: "og_org_key", fetch: upstream.fetch });
  const handler = createSessionProxyHandler(service, {
    resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42" }),
    ...overrides,
  });
  /** Requests other than the relay's own session reads and credential rotations. */
  const forwarded = () =>
    upstream.requests.filter(
      (request) =>
        request.path !== `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}` &&
        !request.path.endsWith("/mcp-credentials/rotate"),
    );
  return { upstream, handler, forwarded };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("session proxy hooks", () => {
  test("afterForward sees each forwarded route with Opengeni's answer and may replace it", async () => {
    const seen: Array<{ route: SessionProxyRoute; status: number; body: unknown }> = [];
    const { handler } = setup({
      refuse: (route) => route.segments[0] === "machines",
      afterForward: async (route, response) => {
        seen.push({ route, status: response.status, body: await response.clone().json() });
        if (route.segments[0] === "files") {
          return Response.json({ error: { code: "scope" } }, { status: 409 });
        }
        return undefined;
      },
    });

    const begin = await handler(post(`${BASE}/files/uploads`, { filename: "a.csv" }));
    expect(begin.status).toBe(409);
    const read = await handler(new Request(`${SESSION}/queue`));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      ok: true,
      path: `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue`,
    });
    // Refused routes never reached Opengeni, so there is nothing to record.
    expect((await handler(new Request(`${BASE}/machines`))).status).toBe(404);

    expect(seen).toEqual([
      {
        route: { method: "POST", segments: ["files", "uploads"], sessionId: undefined },
        status: 200,
        body: { ok: true, path: `/v1/workspaces/${WORKSPACE_ID}/files/uploads` },
      },
      {
        route: {
          method: "GET",
          segments: ["sessions", SESSION_ID, "queue"],
          sessionId: SESSION_ID,
        },
        status: 200,
        body: {
          ok: true,
          path: `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/queue`,
        },
      },
    ]);
  });

  test("afterForward does not run when a host hook refuses the action", async () => {
    let after = 0;
    const { handler, forwarded } = setup({
      beforeForwardMessage: () => new Response("No credit", { status: 402 }),
      afterForward: () => {
        after++;
        return undefined;
      },
    });
    const response = await handler(post(`${SESSION}/steer`, { text: "now", clientEventId: "s1" }));
    expect(response.status).toBe(402);
    expect(after).toBe(0);
    expect(forwarded()).toHaveLength(0);
  });

  test("authorizeSession sees the route it is deciding for", async () => {
    const routes: Array<SessionProxyRoute | undefined> = [];
    const { handler } = setup({
      authorizeSession: (_sessionId, context) => {
        routes.push(context.route);
        // A stricter check for changes, except stopping work.
        return context.route?.method === "GET" || context.route?.segments[2] === "control";
      },
    });
    expect((await handler(new Request(`${SESSION}/queue`))).status).toBe(200);
    expect(
      (await handler(post(`${SESSION}/control`, { action: "pause", clientEventId: "p1" }))).status,
    ).toBe(200);
    expect((await handler(post(`${SESSION}/pin`, { pinned: true }))).status).toBe(404);
    expect(routes.map((route) => `${route?.method} ${route?.segments.join("/")}`)).toEqual([
      `GET sessions/${SESSION_ID}/queue`,
      `POST sessions/${SESSION_ID}/control`,
      `POST sessions/${SESSION_ID}/pin`,
    ]);
  });

  test("resume, retry and queue steer pass beforeForwardMessage with their key", async () => {
    const inputs: SessionProxyMessageInput[] = [];
    const { handler, forwarded } = setup({
      beforeForwardMessage: (input) => {
        inputs.push(input);
        return undefined;
      },
    });
    await handler(post(`${SESSION}/control`, { action: "pause", clientEventId: "p1" }));
    await handler(post(`${SESSION}/control`, { action: "resume", clientEventId: "r1" }));
    await handler(
      post(`${SESSION}/retry`, {
        clientEventId: "t1",
        failureEventId: "88888888-8888-4888-8888-888888888888",
      }),
    );
    await handler(
      post(`${SESSION}/queue/${TURN_ID}/steer`, { clientEventId: "q1", expectedTurnVersion: 2 }),
    );
    expect(inputs).toEqual([
      { sessionId: SESSION_ID, delivery: "resume", clientEventId: "r1" },
      { sessionId: SESSION_ID, delivery: "retry", clientEventId: "t1" },
      { sessionId: SESSION_ID, delivery: "queue-steer", clientEventId: "q1" },
    ]);
    expect(forwarded().map((request) => request.path.split(`${SESSION_ID}/`)[1])).toEqual([
      "control",
      "control",
      "retry",
      `queue/${TURN_ID}/steer`,
    ]);
  });

  test("a refused resume never reaches Opengeni; its credential rotations apply before it", async () => {
    const refusing = setup({
      beforeForwardMessage: () => new Response("No credit", { status: 402 }),
    });
    const refused = await refusing.handler(
      post(`${SESSION}/control`, { action: "resume", clientEventId: "r1" }),
    );
    expect(refused.status).toBe(402);
    expect(refusing.forwarded()).toHaveLength(0);

    const rotating = setup({
      beforeForwardMessage: () => ({
        mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer fresh" } }],
      }),
    });
    await rotating.handler(post(`${SESSION}/control`, { action: "resume", clientEventId: "r1" }));
    const paths = rotating.upstream.requests.map((request) => request.path);
    const rotate = paths.findIndex((path) => path.endsWith("/mcp-credentials/rotate"));
    expect(rotate).toBeGreaterThanOrEqual(0);
    expect(rotate).toBeLessThan(paths.findIndex((path) => path.endsWith("/control")));
    expect(rotating.upstream.requests[rotate]!.body).toMatchObject({
      updates: [
        {
          id: "crm",
          expectedCredentialVersion: 3,
          expectedServerUrl: "https://crm.example.test/mcp",
          headers: { Authorization: "Bearer fresh" },
        },
      ],
    });
  });

  test("a retried turn's model choice is dropped when the server owns model selection", async () => {
    const { handler, forwarded } = setup({ modelSelection: false });
    await handler(
      post(`${SESSION}/retry`, {
        clientEventId: "t1",
        failureEventId: "88888888-8888-4888-8888-888888888888",
        model: "expensive",
        reasoningEffort: "high",
        latencyMode: "fast",
      }),
    );
    expect(forwarded()[0]!.body).toEqual({
      clientEventId: "t1",
      failureEventId: "88888888-8888-4888-8888-888888888888",
    });
  });

  test("a keyed action is sent once more when its first outcome is unknown", async () => {
    for (const first of ["drop", 502, 503, 408] as const) {
      const { handler, forwarded } = setup({}, [first]);
      const response = await handler(
        post(`${SESSION}/steer`, { text: "now", clientEventId: "s1" }),
      );
      expect(response.status).toBe(200);
      expect(forwarded()).toHaveLength(2);
      expect(forwarded()[1]!.body).toEqual(forwarded()[0]!.body);
    }
  });

  test("an action is not repeated when Opengeni answered, or without a key", async () => {
    const answered = setup({}, [409]);
    expect(
      (await answered.handler(post(`${SESSION}/steer`, { text: "now", clientEventId: "s1" })))
        .status,
    ).toBe(409);
    expect(answered.forwarded()).toHaveLength(1);

    const unkeyed = setup({}, [503]);
    expect((await unkeyed.handler(post(`${SESSION}/steer`, { text: "now" }))).status).toBe(503);
    expect(unkeyed.forwarded()).toHaveLength(1);

    // Bodies the relay streams through untouched are never resent.
    const streamed = setup({}, [503]);
    expect((await streamed.handler(post(`${SESSION}/pin`, { pinned: true }))).status).toBe(503);
    expect(streamed.forwarded()).toHaveLength(1);
  });

  test("the retried attempt's outcome is final", async () => {
    const { handler, forwarded } = setup({}, [503, 503]);
    const response = await handler(post(`${SESSION}/steer`, { text: "now", clientEventId: "s1" }));
    expect(response.status).toBe(503);
    expect(forwarded()).toHaveLength(2);
  });
});
