import { expect, test } from "bun:test";
import { createSiteToolBridge } from "../src/site";
import { OpenGeniClient } from "../src/client";
import type { ToolGatewayCatalog, ToolGatewayCallResponse } from "../src/types";

const identity = { serverId: "product", toolName: "lookup" };
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
