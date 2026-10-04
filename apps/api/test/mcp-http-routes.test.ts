import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import * as db from "@opengeni/db";
import * as core from "@opengeni/core";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import type { AccessContext } from "@opengeni/contracts";
import { createApp } from "../src/app";
import * as gateway from "../src/workspace-tool-gateway";
import * as oauth from "../src/mcp-oauth";

const accountId = "00000000-0000-4000-8000-000000000101";
const workspaceId = "00000000-0000-4000-8000-000000000102";
const path = `/v1/workspaces/${workspaceId}/mcp`;
const secret = "SECRET_MCP_HTTP_CANARY";
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

function fixture(options: { unauthenticated?: boolean; preparationError?: Error } = {}) {
  const context: AccessContext = {
    mode: "local",
    subjectId: "dev",
    accountGrants: [{ accountId, subjectId: "dev", permissions: ["account:admin"] }],
    workspaceGrants: [
      {
        accountId,
        workspaceId,
        subjectId: "dev",
        principalKind: "human_session",
        permissions: ["workspace:read"],
      },
    ],
    defaultAccountId: accountId,
    defaultWorkspaceId: workspaceId,
  };
  // Only persistence/catalog dependencies are replaced. The real app performs
  // perimeter, native access resolution, workspace authorization and transport.
  const bootstrap = spyOn(db, "bootstrapWorkspace").mockResolvedValue(context);
  const workspace = spyOn(db, "getWorkspace").mockResolvedValue(null);
  const otherGrant = spyOn(db, "getWorkspaceGrant").mockResolvedValue(null);
  let closed = 0;
  const prepared: gateway.PreparedWorkspaceToolGateway = {
    toolGatewayCatalog: { digest: "fixture", entries: [] } as never,
    toolGateway: {} as never,
    close: async () => {
      closed++;
    },
  };
  const preparation = spyOn(gateway, "prepareWorkspaceToolGateway").mockImplementation(async () => {
    if (options.preparationError) throw options.preparationError;
    return prepared;
  });
  const settings = testSettings({
    productAccessMode: options.unauthenticated ? "managed" : "local",
    observabilityStructuredLogs: true,
    mcpOauthEnabled: true,
    publicBaseUrl: "https://api.example.test",
  });
  const observability = createObservability(settings, { component: "api" });
  const errors: string[] = [];
  const infos: string[] = [];
  const errorLog = spyOn(console, "error").mockImplementation((value) =>
    errors.push(String(value)),
  );
  const infoLog = spyOn(console, "log").mockImplementation((value) => infos.push(String(value)));
  for (const spy of [bootstrap, workspace, otherGrant, preparation, errorLog, infoLog]) {
    restorers.push(() => spy.mockRestore());
  }
  const app = createApp({
    settings,
    db: { execute: async () => [] } as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    observability,
  });
  return {
    app,
    preparation,
    prepared,
    context,
    errors,
    infos,
    observability,
    closed: () => closed,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

describe("workspace MCP Streamable HTTP routes", () => {
  test.each([{}, { "mcp-session-id": secret, "last-event-id": secret }])(
    "authorized GET refuses an unsupported stream without preparing tools (%j)",
    async (headers) => {
      const f = fixture({ preparationError: new TypeError(secret) });
      const response = await f.app.request(path, {
        headers: {
          accept: "text/event-stream",
          "x-opengeni-correlation-id": "get-probe",
          ...headers,
        },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("x-opengeni-correlation-id")).toBe("get-probe");
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Method not allowed." },
      });
      expect(f.preparation).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    },
  );

  test("GET preserves protocol-version validation without preparing tools", async () => {
    const f = fixture();
    const response = await f.app.request(path, {
      headers: { accept: "text/event-stream", "mcp-protocol-version": secret },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000 },
    });
    expect(f.preparation).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  });

  test.each(["denied", "unavailable"])(
    "GET keeps bound-session authorization %s",
    async (outcome) => {
      const f = fixture();
      f.context.workspaceGrants[0]!.metadata = {
        delegated: true,
        sessionId: "00000000-0000-4000-8000-000000000103",
      };
      const authorize = spyOn(core, "requireSessionAuthorization").mockRejectedValue(
        outcome === "denied"
          ? new core.SessionAuthorizationDeniedError("revoked")
          : new core.SessionAuthorizationUnavailableError(),
      );
      restorers.push(() => authorize.mockRestore());
      const response = await f.app.request(path, { headers: { accept: "text/event-stream" } });
      expect(response.status).toBe(outcome === "denied" ? 404 : 503);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(f.preparation).not.toHaveBeenCalled();
    },
  );

  test("OAuth GET also skips tool preparation only after OAuth authorization", async () => {
    const f = fixture();
    const resolve = spyOn(oauth, "resolveMcpOAuthRouteAccess").mockResolvedValue({
      grant: { ...f.context.workspaceGrants[0]!, metadata: { mcpOAuth: true } },
      allowedToolIdentities: [],
    });
    const prepare = spyOn(gateway, "prepareMcpOAuthWorkspaceToolGateway").mockRejectedValue(
      new Error(secret),
    );
    restorers.push(
      () => resolve.mockRestore(),
      () => prepare.mockRestore(),
    );
    const response = await f.app.request(path, { headers: { accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
  });

  test("GET keeps anonymous and invalid OAuth challenges and cross-workspace denial", async () => {
    const f = fixture({ unauthenticated: true });
    for (const headers of [{}, { authorization: `Bearer ogmcp_at_${"a".repeat(43)}` }]) {
      const response = await f.app.request(path, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(`oauth-protected-resource${path}`);
    }
    expect(f.preparation).not.toHaveBeenCalled();
    const local = fixture();
    const denied = await local.app.request(
      "/v1/workspaces/00000000-0000-4000-8000-000000000999/mcp",
    );
    expect(denied.status).toBe(404);
    expect(local.preparation).not.toHaveBeenCalled();
  });

  test("real stateless POST initialization, ping, tools/list and notification stay intact", async () => {
    const f = fixture();
    const initialize = await f.app.request(
      path,
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    );
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    expect(await initialize.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });
    const ping = await f.app.request(
      path,
      post({ jsonrpc: "2.0", id: 2, method: "ping" }, { "mcp-session-id": secret }),
    );
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const tools = await f.app.request(path, post({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    expect(tools.status).toBe(200);
    expect(await tools.json()).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [] } });
    const notification = await f.app.request(
      path,
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(202);
    expect(f.closed()).toBe(4);
    expect(f.errors).toEqual([]);
  });

  test("POST preserves SDK protocol, Accept, media-type and malformed-body validation", async () => {
    const f = fixture();
    for (const [headers, status] of [
      [{ "mcp-protocol-version": "invalid" }, 400],
      [{ accept: "application/json" }, 406],
      [{ "content-type": "text/plain" }, 415],
    ] as const) {
      const response = await f.app.request(
        path,
        post({ jsonrpc: "2.0", id: 4, method: "ping" }, headers),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: {} });
    }
    const invalid = await f.app.request(path, { ...post({}), body: "{bad json" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
  });
});

describe("HTTP unexpected error logging through the real router", () => {
  test("a thrown GET 500 logs its safe cause kind and keeps the response correlation", async () => {
    const f = fixture();
    f.app.get("/v1/test/caused-error", () => {
      throw new TypeError(secret);
    });
    const response = await f.app.request(`/v1/test/caused-error?token=${secret}`, {
      headers: {
        authorization: secret,
        cookie: secret,
        "mcp-session-id": secret,
        "x-opengeni-correlation-id": "failed-get",
      },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("x-opengeni-correlation-id")).toBe("failed-get");
    expect(await response.json()).toMatchObject({
      error: { status: 500, requestId: "failed-get" },
    });
    expect(f.errors).toHaveLength(1);
    expect(JSON.parse(f.errors[0]!)).toMatchObject({
      method: "GET",
      route: "/v1/test/caused-error",
      correlationId: "failed-get",
      status: 500,
      reasonKind: "TypeError",
      errorClass: "HttpOperationError",
    });
    expect([...f.errors, ...f.infos].join("\n")).not.toContain(secret);
  });

  test("a thrown MCP preparation failure logs once with safe cause and request context", async () => {
    const cause = new TypeError(secret);
    const f = fixture({ preparationError: new Error(secret, { cause }) });
    const diagnostic = spyOn(f.observability, "recordFailureDiagnostic");
    restorers.push(() => diagnostic.mockRestore());
    const response = await f.app.request(
      `${path}?token=${secret}`,
      post(
        { jsonrpc: "2.0", id: 5, method: "ping", params: { secret } },
        {
          authorization: secret,
          cookie: secret,
          "mcp-session-id": secret,
          "x-opengeni-correlation-id": "failed-post",
        },
      ),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { status: 500, code: "internal_error", requestId: "failed-post" },
    });
    expect(f.errors).toHaveLength(1);
    expect(JSON.parse(f.errors[0]!)).toMatchObject({
      level: "error",
      message: "HTTP request failed",
      method: "POST",
      route: "/v1/workspaces/:workspaceId/mcp",
      status: 500,
      correlationId: "failed-post",
      errorClass: "HttpOperationError",
      errorCode: "internal_error",
      reasonKind: "Error",
    });
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0]![0]).toMatchObject({
      code: "http_request_failed",
      stage: "http.request",
      error: expect.any(Error),
    });
    expect([...f.errors, ...f.infos].join("\n")).not.toContain(secret);
    const metric = (await f.observability.prometheusMetrics())
      .split("\n")
      .filter((line) => line.startsWith("opengeni_http_errors_total{"));
    expect(metric).toHaveLength(1);
    expect(metric[0]).toContain('code="internal_error"');
    expect(metric[0]).toContain('route="/v1/workspaces/:workspaceId/mcp"');
    expect(metric[0]).toContain('status="500"');
    expect(metric[0]).toEndWith(" 1");
  });

  test("returned 500s log, client errors do not, and logging failure cannot change the response", async () => {
    const f = fixture();
    f.app.get("/v1/test/returned-error", (c) => c.json({ error: "failed" }, 500));
    f.app.get("/v1/test/client-error", () => {
      throw new HTTPException(400);
    });
    f.app.get("/v1/test/thrown-error", () => {
      throw new TypeError(secret);
    });
    expect((await f.app.request("/v1/test/returned-error")).status).toBe(500);
    expect(f.errors).toHaveLength(1);
    expect(JSON.parse(f.errors[0]!)).toMatchObject({
      status: 500,
      method: "GET",
      route: "/v1/test/returned-error",
      reasonKind: "Response",
    });
    expect((await f.app.request("/v1/test/client-error")).status).toBe(400);
    expect(f.errors).toHaveLength(1);
    const brokenLogger = spyOn(f.observability, "error").mockImplementation(() => {
      throw new Error(secret);
    });
    restorers.push(() => brokenLogger.mockRestore());
    const response = await f.app.request("/v1/test/thrown-error", {
      headers: { "x-opengeni-correlation-id": "<unsafe>" },
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain(secret);
  });
});
