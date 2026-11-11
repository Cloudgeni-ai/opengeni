import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "@opengeni/sdk";
import { createHostHandler, type HostIdentity } from "./host";

const origin = "http://127.0.0.1:3104";
const identity: HostIdentity = {
  tenantId: "tenant-a",
  userId: "alice",
  workspaceId: "ws-a",
  source: "harbor",
  csrf: "host-csrf",
};
function fixture() {
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://service.example",
    apiKey: "test-server-key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : undefined;
      calls.push({ path, headers: request.headers, body });
      if (path.endsWith("/config/client")) return Response.json({});
      if (path === "/v1/access/me") return Response.json({ subjectId: "subject-alice" });
      if (path.endsWith("/sessions") && request.method === "GET")
        return Response.json({ sessions: [], pinned: [], nextCursor: null });
      return Response.json({ id: "session-a", workspaceId: "ws-a", status: "idle" });
    },
  });
  const handler = createHostHandler(client, {
    origin,
    authenticate: async (request) =>
      request.headers.get("cookie") === "host=alice" ? identity : null,
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${origin}${path}`, {
      method,
      headers: {
        cookie: "host=alice",
        origin,
        "x-host-csrf": identity.csrf,
        "content-type": "application/json",
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { handler, calls, request };
}

describe("published SDK same-origin host boundary", () => {
  test("requires verified host authentication and exposes no server key", async () => {
    const { handler, calls, request } = fixture();
    expect(
      (await handler(request("/api/context", "GET", undefined, { cookie: "forged" }))).status,
    ).toBe(401);
    expect(
      (
        await handler(
          request("/api/conversation/v1/workspaces/ws-a/sessions", "GET", undefined, {
            cookie: "forged",
          }),
        )
      ).status,
    ).toBe(401);
    expect(calls.length).toBe(0);
    const context = await handler(request("/api/context"));
    expect(context.headers.get("cache-control")).toBe("no-store");
    expect(await context.text()).not.toContain("test-server-key");
  });
  test("rejects foreign workspace, arbitrary passthrough and privileged browser creation", async () => {
    const { handler, calls, request } = fixture();
    expect((await handler(request("/api/conversation/v1/workspaces/ws-b/sessions"))).status).toBe(
      403,
    );
    expect((await handler(request("/api/conversation/v1/accounts"))).status).toBe(404);
    expect(
      (
        await handler(
          request("/api/conversation/v1/workspaces/ws-a/sessions", "POST", {
            initialMessage: "hello",
            tools: [{ kind: "mcp", id: "arbitrary" }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(calls.length).toBe(0);
  });
  test("requires matching origin AND host CSRF for cookie mutations", async () => {
    const { handler, calls, request } = fixture();
    for (const headers of [
      { origin: "https://attacker.example" },
      { "x-host-csrf": "wrong" },
      { origin: "" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[]) {
      expect(
        (
          await handler(
            request(
              "/api/conversation/v1/workspaces/ws-a/sessions",
              "POST",
              { initialMessage: "hello" },
              headers,
            ),
          )
        ).status,
      ).toBe(403);
    }
    expect(calls.length).toBe(0);
  });
  test("scopes reads as the authenticated user and keeps creation policy server-owned", async () => {
    const { handler, calls, request } = fixture();
    expect(
      (await handler(request("/api/conversation/v1/workspaces/ws-a/sessions?view=page"))).status,
    ).toBe(200);
    expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer test-server-key");
    expect(calls.at(-1)?.headers.get("x-opengeni-external-actor")).not.toBeNull();
    const response = await handler(
      request("/api/conversation/v1/workspaces/ws-a/sessions", "POST", {
        initialMessage: "hello",
        idempotencyKey: "stable-create",
      }),
    );
    expect(response.status).toBe(200);
    expect(calls.at(-1)?.body).toMatchObject({
      initialMessage: "hello",
      idempotencyKey: "stable-create",
      sandboxBackend: "none",
      tools: [],
      visibility: "private",
      agent: { renderer: "markdown", capabilities: { from: "none", humanInput: true } },
    });
  });
});
