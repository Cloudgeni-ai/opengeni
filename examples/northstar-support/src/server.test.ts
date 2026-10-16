import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProductHandler, staticResponse } from "./server";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Northstar production static serving", () => {
  test("serves precompressed hashed assets and HEAD without streaming directories", async () => {
    const root = await fixture();
    const asset = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-abc123.js", {
        headers: { "accept-encoding": "br, gzip" },
      }),
      "/assets/app-abc123.js",
      root,
    );
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("vary")).toBe("Accept-Encoding");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(
      new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await asset.arrayBuffer()))),
    ).toBe("export const ready = true;\n");

    const identity = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-abc123.js", {
        headers: { "accept-encoding": "gzip; Q=0" },
      }),
      "/assets/app-abc123.js",
      root,
    );
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(await identity.text()).toBe("export const ready = true;\n");

    const head = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-abc123.js", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      }),
      "/assets/app-abc123.js",
      root,
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-encoding")).toBe("gzip");
    expect(head.headers.get("content-length")).toBe(
      String(Bun.file(join(root, "assets", "app-abc123.js.gz")).size),
    );

    const directory = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/"),
      "/assets/",
      root,
    );
    expect(directory.status).toBe(404);
  });

  test("does not cache missing hashed assets across a rollback", async () => {
    const root = await fixture();
    const missing = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-rollback.js"),
      "/assets/app-rollback.js",
      root,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    await Bun.write(join(root, "assets", "app-rollback.js"), "export const restored = true;\n");
    const restored = await staticResponse(
      new Request("https://demo.opengeni.ai/assets/app-rollback.js"),
      "/assets/app-rollback.js",
      root,
    );
    expect(restored.status).toBe(200);
    expect(restored.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("keeps traversal and symlink escapes outside the SPA fallback", async () => {
    const root = await fixture();
    expect(
      (
        await staticResponse(
          new Request("https://demo.opengeni.ai/%2e%2e%2fsecret"),
          "/%2e%2e%2fsecret",
          root,
        )
      ).status,
    ).toBe(404);

    const outside = await mkdtemp(join(tmpdir(), "northstar-static-outside-"));
    roots.push(outside);
    await Bun.write(join(outside, "secret.txt"), "not public");
    await symlink(join(outside, "secret.txt"), join(root, "assets", "linked.txt"));
    expect(
      (
        await staticResponse(
          new Request("https://demo.opengeni.ai/assets/linked.txt"),
          "/assets/linked.txt",
          root,
        )
      ).status,
    ).toBe(404);

    const spa = await staticResponse(
      new Request("https://demo.opengeni.ai/inbox/TKT-2847"),
      "/inbox/TKT-2847",
      root,
    );
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("Northstar");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "northstar-static-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  const js = "export const ready = true;\n";
  await Bun.write(join(root, "index.html"), "<!doctype html><title>Northstar</title>");
  await Bun.write(join(root, "assets", "app-abc123.js"), js);
  await Bun.write(join(root, "assets", "app-abc123.js.gz"), Bun.gzipSync(js));
  return root;
}

const ORIGIN = "https://demo.example.test";
const API = "https://api.example.test";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PROXY = `${ORIGIN}/api/opengeni/v1`;
const WORKSPACE = `${PROXY}/workspaces/${WORKSPACE_ID}`;

type UpstreamCall = { method: string; path: string; headers: Headers; body: unknown };

/** A fake Opengeni API: no network, records every call the demo server makes. */
function fakeOpenGeni(options: { membership?: Response; sessionId?: string } = {}) {
  const calls: UpstreamCall[] = [];
  const sessionsByKey = new Map<string, string>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    calls.push({ method: request.method, path: url.pathname, headers: request.headers, body });
    const base = `/v1/workspaces/${WORKSPACE_ID}`;
    if (url.pathname === `${base}/external-members`) {
      return options.membership?.clone() ?? Response.json({ subjectId: "subject-maya" });
    }
    if (url.pathname === `${base}/sessions` && request.method === "POST") {
      const key = String(body?.idempotencyKey);
      const id = options.sessionId ?? sessionsByKey.get(key) ?? crypto.randomUUID();
      sessionsByKey.set(key, id);
      return Response.json({
        id,
        workspaceId: WORKSPACE_ID,
        status: "queued",
        usageLimit: { limitMicros: body?.usageLimitMicros ?? null },
      });
    }
    if (url.pathname === "/v1/config/client") {
      return Response.json({
        apiContractRevision: "upstream",
        fileUploads: { enabled: true },
        voiceInput: { available: true, maxDurationSeconds: 60 },
      });
    }
    if (url.pathname.endsWith("/events") && request.method === "GET") return Response.json([]);
    return Response.json({ id: url.pathname.split("/")[5], workspaceId: WORKSPACE_ID });
  };
  return {
    calls,
    fetch,
    /** Upstream calls that address one session. */
    sessionCalls: (sessionId: string) => calls.filter((call) => call.path.includes(sessionId)),
  };
}

function demoServer(options: Parameters<typeof fakeOpenGeni>[0] & { now?: () => number } = {}) {
  const upstream = fakeOpenGeni(options);
  const handler = createProductHandler({
    apiBaseUrl: API,
    apiKey: "og_org_test_key",
    workspaceId: WORKSPACE_ID,
    mcpToken: "mcp-test-token",
    resolveMcpUrl: async () => `${ORIGIN}/mcp`,
    serveStatic: false,
    appOrigin: ORIGIN,
    fetch: upstream.fetch,
    ...(options.now ? { now: options.now } : {}),
  });
  return { upstream, handler };
}

type Handler = ReturnType<typeof createProductHandler>;
type BrowserInit = { method?: string; body?: unknown; headers?: Record<string, string> };

/** One browser: the visitor cookie the server issued it. */
async function newVisitor(handler: Handler): Promise<string> {
  const response = await handler(new Request(`${ORIGIN}/api/demo/state`));
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return setCookie!.split(";")[0]!;
}

function browserRequest(url: string, cookie: string | null, init: BrowserInit = {}): Request {
  const headers: Record<string, string> = { "sec-fetch-site": "same-origin", ...init.headers };
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function startRun(
  handler: Handler,
  cookie: string | null,
  runId: string = crypto.randomUUID(),
): Promise<Response> {
  return await handler(
    browserRequest(`${ORIGIN}/api/demo/sessions`, cookie, {
      method: "POST",
      body: { ticketId: "TKT-2847", initialMessage: "Investigate TKT-2847.", runId },
    }),
  );
}

async function startedSessionId(handler: Handler, cookie: string): Promise<string> {
  const response = await startRun(handler, cookie);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

async function expectStatus(
  handler: Handler,
  cookie: string | null,
  route: BrowserInit & { label: string; url: string },
  status: number,
  code: string,
): Promise<void> {
  const response = await handler(browserRequest(route.url, cookie, route));
  expect({ route: route.label, status: response.status, code: await errorCode(response) }).toEqual({
    route: route.label,
    status,
    code,
  });
}

/** Every session-scoped proxy route the stock conversation uses, plus disabled ones. */
function sessionRoutes(sessionId: string): Array<BrowserInit & { label: string; url: string }> {
  const session = `${WORKSPACE}/sessions/${sessionId}`;
  const message = { type: "user.message", payload: { text: "hello" } };
  return [
    { label: "read", url: session },
    { label: "rename", url: session, method: "PATCH", body: { title: "Mine now" } },
    { label: "events", url: `${session}/events` },
    { label: "event stream", url: `${session}/events/stream` },
    { label: "send", url: `${session}/events`, method: "POST", body: message },
    { label: "steer", url: `${session}/steer`, method: "POST", body: { text: "stop" } },
    { label: "queue", url: `${session}/queue` },
    { label: "queue edit", url: `${session}/queue/turn-1/delete`, method: "POST", body: {} },
    { label: "draft", url: `${session}/composer-draft` },
    { label: "draft save", url: `${session}/composer-draft`, method: "PUT", body: { text: "x" } },
    { label: "draft submit", url: `${session}/composer-draft/submit`, method: "POST", body: {} },
    { label: "control", url: `${session}/control`, method: "POST", body: { action: "pause" } },
    { label: "goal", url: `${session}/goal` },
    { label: "goal update", url: `${session}/goal`, method: "PATCH", body: { status: "paused" } },
    { label: "goal clear", url: `${session}/goal`, method: "DELETE" },
    { label: "human input", url: `${session}/human-input-requests` },
    { label: "human input item", url: `${session}/human-input-requests/request-1` },
    { label: "artifact", url: `${session}/artifacts/artifact-1` },
    { label: "realtime", url: `${session}/realtime`, method: "POST", body: {} },
    { label: "archive", url: `${session}/archive`, method: "PUT", body: { archived: true } },
  ];
}

describe("Northstar anonymous visitor isolation", () => {
  test("issues each browser a signed visitor cookie on API responses only", async () => {
    const { handler } = demoServer();
    const first = await handler(new Request(`${ORIGIN}/api/demo/state`));
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      /^__Host-northstar_visitor=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(first.headers.get("cache-control")).toBe("no-store");
    const cookie = setCookie.split(";")[0]!;

    // A valid cookie is kept as is.
    const again = await handler(browserRequest(`${ORIGIN}/api/demo/health`, cookie));
    expect(again.status).toBe(200);
    expect(again.headers.get("set-cookie")).toBeNull();

    // Forged, or signed by another server process: a fresh visitor.
    const forged = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    for (const invalid of [forged, await newVisitor(demoServer().handler)]) {
      const response = await handler(browserRequest(`${ORIGIN}/api/demo/state`, invalid));
      const replacement = response.headers.get("set-cookie") ?? "";
      expect(replacement).toMatch(/^__Host-northstar_visitor=/);
      expect(replacement.split(";")[0]).not.toBe(invalid);
    }

    // Static and unknown non-API paths never set cookies.
    const page = await handler(new Request(`${ORIGIN}/inbox/TKT-2847`));
    expect(page.headers.get("set-cookie")).toBeNull();
  });

  test("creates private, session-scoped, usage-limited runs for the demo operator", async () => {
    const { handler, upstream } = demoServer();
    const cookie = await newVisitor(handler);
    const runId = crypto.randomUUID();
    const response = await startRun(handler, cookie, runId);
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBeNull();

    const membership = upstream.calls.find((call) => call.path.endsWith("/external-members"));
    expect((membership!.body as { permissions: string[] }).permissions).toEqual([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "mcp_servers:attach",
    ]);

    const create = upstream.calls.find(
      (call) => call.method === "POST" && call.path === `/v1/workspaces/${WORKSPACE_ID}/sessions`,
    );
    const body = create!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      visibility: "private",
      agentAccess: "session",
      memoryScope: "off",
      usageLimitMicros: 1_000_000,
      startMode: "standard",
      firstPartyMcpTools: [],
      sandboxBackend: "none",
      tools: [{ kind: "mcp", id: "northstar_support" }],
    });
    expect(body.model).toBeUndefined();
    // Per visitor, and never the raw cookie id or run id.
    const visitorId = cookie.split("=")[1]!.split(".")[0]!;
    expect(String(body.idempotencyKey)).toMatch(/^northstar:TKT-2847:[0-9a-f-]{36}$/);
    expect(String(body.idempotencyKey)).not.toContain(runId);
    expect(String(body.idempotencyKey)).not.toContain(visitorId);
    const actor = JSON.parse(
      decodeURIComponent(create!.headers.get("x-opengeni-external-actor") ?? ""),
    ) as { identity: { externalId: string; source: string } };
    expect(actor.identity).toEqual({ externalId: "maya.chen", source: "northstar-demo" });

    // A retried start from the same browser returns the same session.
    const created = (await response.json()) as { id: string };
    const retried = await startRun(handler, cookie, runId);
    expect(retried.status).toBe(201);
    expect(((await retried.json()) as { id: string }).id).toBe(created.id);
  });

  test("lets a visitor reach only the sessions it created", async () => {
    const { handler, upstream } = demoServer();
    const owner = await newVisitor(handler);
    const other = await newVisitor(handler);
    const sessionId = await startedSessionId(handler, owner);

    const read = await handler(browserRequest(`${WORKSPACE}/sessions/${sessionId}`, owner));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { id: string }).id).toBe(sessionId);
    const events = await handler(
      browserRequest(`${WORKSPACE}/sessions/${sessionId}/events`, owner),
    );
    expect(events.status).toBe(200);
    const reached = upstream.sessionCalls(sessionId).length;
    expect(reached).toBe(2);

    for (const route of sessionRoutes(sessionId)) {
      await expectStatus(handler, other, route, 404, "session_not_found");
    }
    // Unknown sessions are denied without asking Opengeni.
    const unknownId = crypto.randomUUID();
    for (const route of sessionRoutes(unknownId)) {
      await expectStatus(handler, owner, route, 404, "session_not_found");
    }
    expect(upstream.sessionCalls(unknownId)).toEqual([]);

    // No cookie: a fresh visitor that owns nothing. Reads are denied, and
    // mutations are refused before any session check.
    const anonymousRead = await handler(browserRequest(`${WORKSPACE}/sessions/${sessionId}`, null));
    expect(anonymousRead.status).toBe(404);
    expect(anonymousRead.headers.get("set-cookie")).toMatch(/^__Host-northstar_visitor=/);
    await expectStatus(
      handler,
      null,
      {
        label: "anonymous steer",
        url: `${WORKSPACE}/sessions/${sessionId}/steer`,
        method: "POST",
        body: { text: "stop" },
      },
      403,
      "mutation_denied",
    );

    expect(upstream.sessionCalls(sessionId).length).toBe(reached);
  });

  test("never lets a replayed start hand a session to another visitor", async () => {
    const sharedId = crypto.randomUUID();
    const { handler } = demoServer({ sessionId: sharedId });
    const owner = await newVisitor(handler);
    const other = await newVisitor(handler);
    expect(await startedSessionId(handler, owner)).toBe(sharedId);

    expect((await startRun(handler, other)).status).toBe(409);
    const session = `${WORKSPACE}/sessions/${sharedId}`;
    expect((await handler(browserRequest(session, other))).status).toBe(404);
    expect((await handler(browserRequest(session, owner))).status).toBe(200);
  });

  test("turns off every proxy surface the panel does not use", async () => {
    const { handler, upstream } = demoServer();
    const cookie = await newVisitor(handler);
    const sessionId = await startedSessionId(handler, cookie);
    const callsBefore = upstream.calls.length;

    const config = (await (
      await handler(browserRequest(`${PROXY}/config/client`, cookie))
    ).json()) as Record<string, unknown>;
    expect(config).toMatchObject({
      workspaceId: WORKSPACE_ID,
      fileUploads: { enabled: false },
      voiceInput: { available: false },
      realtimeVoice: false,
      modelSelection: false,
      archive: false,
      sessionCreation: false,
      sandboxFiles: false,
      artifacts: false,
    });

    const session = `${WORKSPACE}/sessions/${sessionId}`;
    const disabled: Array<BrowserInit & { label: string; url: string }> = [
      { label: "session list", url: `${WORKSPACE}/sessions?view=page` },
      { label: "browser create", url: `${WORKSPACE}/sessions`, method: "POST", body: {} },
      { label: "upload", url: `${WORKSPACE}/files/uploads`, method: "POST", body: {} },
      { label: "download", url: `${WORKSPACE}/files/file-1/download-url`, method: "POST" },
      { label: "voice input", url: `${WORKSPACE}/transcriptions`, method: "POST" },
      { label: "voice models", url: `${WORKSPACE}/realtime-model-catalog` },
      { label: "media", url: `${WORKSPACE}/artifacts/artifact-1/content` },
      { label: "sites", url: `${WORKSPACE}/published-artifacts` },
      { label: "editable", url: `${WORKSPACE}/editable-artifacts/artifact-1` },
      { label: "archive", url: `${session}/archive`, method: "PUT", body: { archived: true } },
      { label: "realtime", url: `${session}/realtime`, method: "POST", body: {} },
      { label: "screenshot", url: `${session}/artifacts/artifact-1` },
      { label: "sandbox file", url: `${session}/fs/read`, method: "POST", body: { path: "a" } },
    ];
    for (const route of disabled) {
      await expectStatus(handler, cookie, route, 404, "route_not_allowed");
    }
    // Only the client config reached Opengeni.
    expect(upstream.calls.slice(callsBefore).map((call) => call.path)).toEqual([
      "/v1/config/client",
    ]);

    // The browser cannot pick a model, and messages stay small.
    const send = await handler(
      browserRequest(`${session}/events`, cookie, {
        method: "POST",
        body: {
          type: "user.message",
          payload: { text: "Escalate it", model: "expensive-model", reasoningEffort: "high" },
        },
      }),
    );
    expect(send.status).toBe(200);
    expect(upstream.calls.at(-1)?.body).toEqual({
      type: "user.message",
      payload: { text: "Escalate it" },
    });
    await expectStatus(
      handler,
      cookie,
      {
        label: "oversized steer",
        url: `${session}/steer`,
        method: "POST",
        body: { text: "x".repeat(40 * 1024) },
      },
      413,
      "body_too_large",
    );
  });

  test("refuses cross-site and same-site mutations", async () => {
    const { handler } = demoServer();
    const cookie = await newVisitor(handler);
    const sessionId = await startedSessionId(handler, cookie);
    for (const site of ["cross-site", "same-site"]) {
      const headers = { "sec-fetch-site": site };
      const start = await handler(
        browserRequest(`${ORIGIN}/api/demo/sessions`, cookie, {
          method: "POST",
          headers,
          body: { ticketId: "TKT-2847", runId: crypto.randomUUID() },
        }),
      );
      expect(start.status).toBe(403);
      const reset = await handler(
        browserRequest(`${ORIGIN}/api/demo/reset`, cookie, { method: "POST", headers }),
      );
      expect(reset.status).toBe(403);
      await expectStatus(
        handler,
        cookie,
        {
          label: `${site} steer`,
          url: `${WORKSPACE}/sessions/${sessionId}/steer`,
          method: "POST",
          headers,
          body: { text: "stop" },
        },
        403,
        "mutation_denied",
      );
    }
  });

  test("keeps an existing operator membership instead of failing every request", async () => {
    const { handler } = demoServer({
      membership: Response.json(
        { error: { code: "conflict", message: "existing membership differs" } },
        { status: 409 },
      ),
    });
    const cookie = await newVisitor(handler);
    const sessionId = await startedSessionId(handler, cookie);
    const read = await handler(browserRequest(`${WORKSPACE}/sessions/${sessionId}`, cookie));
    expect(read.status).toBe(200);

    const denied = demoServer({
      membership: Response.json(
        { error: { code: "forbidden", message: "membership exceeds key authority" } },
        { status: 403 },
      ),
    });
    expect((await startRun(denied.handler, await newVisitor(denied.handler))).status).toBe(502);
  });
});

describe("Northstar demo rate limits", () => {
  function testClock() {
    let now = Date.UTC(2026, 9, 16, 12);
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  function sessionCreates(upstream: ReturnType<typeof fakeOpenGeni>): number {
    return upstream.calls.filter(
      (call) => call.method === "POST" && call.path === `/v1/workspaces/${WORKSPACE_ID}/sessions`,
    ).length;
  }

  test("limits agent runs per visitor and across the whole demo", async () => {
    const clock = testClock();
    const { handler, upstream } = demoServer({ now: clock.now });
    const first = await newVisitor(handler);
    for (let run = 0; run < 6; run += 1) {
      expect((await startRun(handler, first)).status).toBe(201);
    }
    const perVisitor = await startRun(handler, first);
    expect(perVisitor.status).toBe(429);
    expect(perVisitor.headers.get("retry-after")).toBe("600");
    expect(((await perVisitor.json()) as { error: string }).error).toBe(
      "Too many agent runs from this browser. Try again in 10 minutes.",
    );

    // Other visitors keep their own allowance until the demo-wide cap.
    for (let visitor = 0; visitor < 4; visitor += 1) {
      const cookie = await newVisitor(handler);
      for (let run = 0; run < 6; run += 1) {
        expect((await startRun(handler, cookie)).status).toBe(201);
      }
    }
    // Dropping the cookie does not escape the demo-wide cap.
    const global = await startRun(handler, null);
    expect(global.status).toBe(429);
    expect(((await global.json()) as { error: string }).error).toBe(
      "The demo has started too many agent runs recently. Try again in 60 minutes.",
    );
    expect(sessionCreates(upstream)).toBe(30);

    clock.advance(60 * 60_000);
    expect((await startRun(handler, first)).status).toBe(201);
    expect(sessionCreates(upstream)).toBe(31);
  });

  test("limits demo resets", async () => {
    const clock = testClock();
    const { handler } = demoServer({ now: clock.now });
    const cookie = await newVisitor(handler);
    const reset = () =>
      handler(browserRequest(`${ORIGIN}/api/demo/reset`, cookie, { method: "POST" }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await reset()).status).toBe(200);
    }
    const limited = await reset();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(((await limited.json()) as { error: string }).error).toBe(
      "Too many resets from this browser. Try again in 60 seconds.",
    );
    clock.advance(60_000);
    expect((await reset()).status).toBe(200);
  });
});
