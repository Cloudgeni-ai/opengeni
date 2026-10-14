import { expect, test } from "bun:test";
import { createSiteToolBridge } from "../src/site";
import { OpenGeniClient } from "../src/index";
import type { ToolGatewayCatalog, ToolGatewayCallResponse } from "../src/types";

const identity = { serverId: "product", toolName: "lookup" };
test("shared Site HTTP forwarding preserves main's bounded session API and host authentication", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const bridge = createSiteToolBridge({
    workspaceId: "workspace",
    artifactId: "site",
    siteVersionId: "version",
    requestedTools: [],
    workspaceTools: { $catalog: async () => catalog },
    callTool: async () => {
      throw new Error("unexpected tool call");
    },
    fetchResponse: async (path, init) => {
      requests.push({ path, init });
      return new Response("ok");
    },
  });
  const message = {
    type: "opengeni.site.http" as const,
    requestId: "request",
    method: "GET",
    path: "/v1/workspaces/site-host/sessions/session-1/events/stream",
    headers: [
      ["authorization", "forged"],
      ["x-opengeni-external-actor", "other"],
      ["x-opengeni-site-id", "forged-site"],
      ["x-opengeni-site-version", "forged-version"],
      ["x-opengeni-site-frame-id", "forged-frame"],
      ["accept", "text/event-stream"],
      ["range", "bytes=0-1023"],
      ["if-none-match", "image-version"],
      ["idempotency-key", "operation-1"],
    ] as [string, string][],
  };
  await bridge.fetch!(message, new AbortController().signal);
  for (const [name, value] of [
    ["range", "bytes=0-1023"],
    ["if-none-match", "image-version"],
    ["idempotency-key", "operation-1"],
  ])
    expect(new Headers(requests[0]!.init.headers).get(name!)).toBe(value!);
  expect(requests[0]!.path).toBe("/v1/workspaces/workspace/sessions/session-1/events/stream");
  expect(new Headers(requests[0]!.init.headers).get("authorization")).toBeNull();
  expect(new Headers(requests[0]!.init.headers).get("x-opengeni-external-actor")).toBeNull();
  expect(new Headers(requests[0]!.init.headers).get("accept")).toBe("text/event-stream");
  expect(new Headers(requests[0]!.init.headers).get("x-opengeni-site-id")).toBe("site");
  expect(new Headers(requests[0]!.init.headers).get("x-opengeni-site-version")).toBe("version");
  expect(new Headers(requests[0]!.init.headers).get("x-opengeni-site-frame")).toBe("1");
  const frameId = new Headers(requests[0]!.init.headers).get("x-opengeni-site-frame-id");
  expect(frameId).toMatch(/^[0-9a-f-]{36}$/u);
  await bridge.fetch!(
    { ...message, path: "/v1/workspaces/site-host/sessions?originSiteId=current" },
    new AbortController().signal,
  );
  expect(requests[1]!.path).toBe("/v1/workspaces/workspace/sessions?originSiteId=site");
  // One bridge is one frame: its id is stable across its requests.
  expect(new Headers(requests[1]!.init.headers).get("x-opengeni-site-frame-id")).toBe(frameId);
  await expect(
    bridge.fetch!(
      { ...message, path: "/v1/workspaces/other/sessions" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Unsupported");
  expect(requests).toHaveLength(2);
});

test("Site HTTP forwarding refuses every route outside SITE_OPERATIONS before any request", async () => {
  const requests: string[] = [];
  const bridge = createSiteToolBridge({
    workspaceId: "workspace",
    artifactId: "site",
    siteVersionId: "version",
    requestedTools: [],
    workspaceTools: { $catalog: async () => catalog },
    callTool: async () => {
      throw new Error("unexpected tool call");
    },
    fetchResponse: async (path) => {
      requests.push(path);
      return new Response("ok");
    },
  });
  const request = (method: string, path: string) =>
    bridge.fetch!(
      { type: "opengeni.site.http", requestId: "r", method, path, headers: [] },
      new AbortController().signal,
    );
  for (const [method, path] of [
    ["POST", "/v1/workspaces/site-host/scheduled-tasks"],
    ["POST", "/v1/workspaces/site-host/scheduled-tasks/task-1/trigger"],
    ["PATCH", "/v1/workspaces/site-host/scheduled-tasks/task-1"],
    ["POST", "/v1/workspaces/site-host/automations/triggers"],
    ["POST", "/v1/workspaces/site-host/api-keys"],
    ["PUT", "/v1/workspaces/site-host/sessions/session-1/tool-policy"],
    ["POST", "/v1/workspaces/site-host/sessions/session-1/fork"],
    ["GET", "/v1/workspaces/site-host/sessions"],
    ["GET", "/v1/workspaces/site-host/sessions?channelId=project"],
    ["DELETE", "/v1/workspaces/site-host/sessions/session-1"],
    ["POST", "/v1/workspaces/site-host/tools/calls"],
  ] as const)
    await expect(request(method, path)).rejects.toThrow("Unsupported");
  expect(requests).toEqual([]);
  for (const [method, path] of [
    ["POST", "/v1/workspaces/site-host/sessions"],
    ["POST", "/v1/workspaces/site-host/sessions/session-1/events"],
    ["POST", "/v1/workspaces/site-host/sessions/session-1/steer"],
    ["POST", "/v1/workspaces/site-host/sessions/session-1/control"],
    ["POST", "/v1/workspaces/site-host/sessions/session-1/composer-draft/submit"],
  ] as const)
    await request(method, path);
  expect(requests).toHaveLength(5);
});
const catalog: ToolGatewayCatalog = {
  version: 1,
  accountId: "org",
  workspaceId: "workspace",
  generation: 1,
  digest: "a".repeat(64),
  createdAt: "2026-09-08T00:00:00Z",
  entries: [
    {
      identity,
      modelName: "product__lookup",
      codemodePath: ["product", "lookup"],
      title: "Lookup",
      description: "Lookup",
      inputSchema: { type: "object" },
      source: "mcp",
      approval: "human",
    },
  ],
};

test("public Site bridge pins host authority, strips extra input and does not retry uncertain effects", async () => {
  const requests: unknown[] = [];
  const bridge = createSiteToolBridge({
    workspaceId: "workspace",
    artifactId: "site",
    siteVersionId: "version",
    requestedTools: [identity],
    workspaceTools: { $catalog: async () => catalog },
    callTool: async ({ request }) => {
      requests.push(request);
      throw new Error("connection lost after write");
    },
  });
  const hostile = {
    catalogDigest: "forged",
    identity,
    arguments: {},
    operationId: "operation",
    siteArtifactId: "foreign",
    siteVersionId: "foreign",
    approvalToken: "must-not-forward",
  };
  await expect(bridge.call(hostile, { signal: new AbortController().signal })).rejects.toThrow(
    "connection lost",
  );
  expect(requests).toEqual([
    {
      catalogDigest: catalog.digest,
      identity,
      arguments: {},
      operationId: "operation",
      siteArtifactId: "site",
      siteVersionId: "version",
    },
  ]);
});

test("public Site bridge rejects another workspace before a tool call", async () => {
  let calls = 0;
  const bridge = createSiteToolBridge({
    workspaceId: "other",
    artifactId: "site",
    siteVersionId: "version",
    requestedTools: [identity],
    workspaceTools: { $catalog: async () => catalog },
    callTool: async () => {
      calls++;
      return {} as ToolGatewayCallResponse;
    },
  });
  await expect(bridge.catalog({ signal: new AbortController().signal })).rejects.toThrow(
    "workspace mismatch",
  );
  expect(calls).toBe(0);
});

test("base SDK sends pinned Site calls through the actor-scoped gateway", async () => {
  let observed: { path: string; actor: string | null; body: unknown } | undefined;
  const client = new OpenGeniClient({
    toolGatewayMode: "catalog",
    baseUrl: "https://example.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      observed = {
        path: new URL(String(url)).pathname,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({});
    },
  }).asUser("host-user");
  const request = {
    catalogDigest: catalog.digest,
    identity,
    arguments: {},
    siteArtifactId: "site",
    siteVersionId: "version",
  };
  await client.callWorkspaceSiteTool("space/one", request);
  expect(observed?.path).toBe("/v1/workspaces/space%2Fone/tools/calls");
  expect(observed?.actor).not.toBeNull();
  expect(observed?.body).toEqual(request);
});

test("inline HTML reuses the bridge without inventing a saved Site identity", async () => {
  const calls: unknown[] = [];
  const bridge = createSiteToolBridge({
    workspaceId: "workspace",
    workspaceTools: { $catalog: async () => catalog },
    callTool: async ({ request }) => {
      calls.push(request);
      return {} as ToolGatewayCallResponse;
    },
  });
  const signal = new AbortController().signal;
  expect((await bridge.catalog({ signal })).entries).toHaveLength(1);
  await bridge.call({ catalogDigest: catalog.digest, identity, arguments: {} }, { signal });
  expect(calls).toEqual([{ catalogDigest: catalog.digest, identity, arguments: {} }]);
  await expect(
    bridge.call(
      {
        catalogDigest: catalog.digest,
        identity: { serverId: "other", toolName: "bad" },
        arguments: {},
      },
      { signal },
    ),
  ).rejects.toThrow("not enabled");
  expect(calls).toHaveLength(1);
});

test("an unpinned host (inline HTML) forwards no Site Data and marks its requests as framed", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const bridge = createSiteToolBridge({
    workspaceId: "workspace",
    workspaceTools: { $catalog: async () => catalog },
    callTool: async () => {
      throw new Error("unexpected tool call");
    },
    fetchResponse: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return new Response("ok");
    },
  } as unknown as Parameters<typeof createSiteToolBridge>[0]);
  const base = {
    type: "opengeni.site.http" as const,
    requestId: "request",
    method: "POST",
    headers: [["x-opengeni-site-frame", "0"]] as [string, string][],
  };
  for (const path of [
    "/v1/workspaces/site-host/published-artifacts/current/data/query",
    "/v1/workspaces/site-host/published-artifacts/11111111-2222-4333-8444-555555555555/data/query",
    "/v1/workspaces/site-host/published-artifacts/11111111-2222-4333-8444-555555555555/files",
  ])
    await expect(bridge.fetch!({ ...base, path }, new AbortController().signal)).rejects.toThrow();
  expect(requests).toHaveLength(0);
  await bridge.fetch!(
    { ...base, path: "/v1/workspaces/site-host/sessions" },
    new AbortController().signal,
  );
  expect(new Headers(requests[0]!.init.headers).get("x-opengeni-site-frame")).toBe("1");
  expect(new Headers(requests[0]!.init.headers).get("x-opengeni-site-id")).toBeNull();
  // Each mounted frame gets its own id; another bridge never shares it.
  const other = createSiteToolBridge({
    workspaceId: "workspace",
    workspaceTools: { $catalog: async () => catalog },
    callTool: async () => {
      throw new Error("unexpected tool call");
    },
    fetchResponse: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return new Response("ok");
    },
  } as unknown as Parameters<typeof createSiteToolBridge>[0]);
  await other.fetch!(
    { ...base, path: "/v1/workspaces/site-host/sessions" },
    new AbortController().signal,
  );
  const first = new Headers(requests[0]!.init.headers).get("x-opengeni-site-frame-id");
  const second = new Headers(requests[1]!.init.headers).get("x-opengeni-site-frame-id");
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
});
