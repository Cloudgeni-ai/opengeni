import { expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";

test("permission updates preserve explicit default and tool targets on the wire", async () => {
  const requests: Request[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ saved: true });
    },
  });
  await client.updateConnectorToolPermissions("workspace", "mcp:fixture", {
    connectionId: "connection",
    target: "default",
    permission: "ask",
  });
  await client.updateConnectorToolPermissions("workspace", "mcp:fixture", {
    connectionId: "connection",
    target: "tools",
    toolNames: ["read_item"],
    permission: "allow",
  });
  expect(requests.map((request) => request.method)).toEqual(["PATCH", "PATCH"]);
  expect(new URL(requests[0]!.url).pathname).toBe(
    "/v1/workspaces/workspace/capabilities/mcp%3Afixture/tool-permissions",
  );
  expect(await requests[0]!.json()).toEqual({
    connectionId: "connection",
    target: "default",
    permission: "ask",
  });
  expect(await requests[1]!.json()).toEqual({
    connectionId: "connection",
    target: "tools",
    toolNames: ["read_item"],
    permission: "allow",
  });
});

test("session MCP permissions address the exact attached server on the wire", async () => {
  const requests: Request[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(
        requests.length === 1
          ? {
              connectionId: "session-mcp:host-tools:abc",
              serverId: "host-tools",
              defaultPermission: null,
              tools: [],
              revision: "r1",
              canManage: true,
              appliesTo: "next_attempt",
            }
          : { saved: true },
      );
    },
  });
  const server = { serverId: "host-tools", url: "https://host.example.test/mcp?x=1&y=2" };
  const read = await client.getSessionMcpToolPermissions("workspace", server);
  expect(read.revision).toBe("r1");
  await client.updateSessionMcpToolPermissions("workspace", {
    ...server,
    target: "tools",
    toolNames: ["delete_item"],
    permission: "block",
    expectedRevision: "r1",
  });
  const [get, patch] = requests;
  expect(get!.method).toBe("GET");
  const getUrl = new URL(get!.url);
  expect(getUrl.pathname).toBe("/v1/workspaces/workspace/session-mcp-tool-permissions");
  expect(getUrl.searchParams.get("serverId")).toBe("host-tools");
  expect(getUrl.searchParams.get("url")).toBe(server.url);
  expect(patch!.method).toBe("PATCH");
  expect(await patch!.json()).toEqual({
    ...server,
    target: "tools",
    toolNames: ["delete_item"],
    permission: "block",
    expectedRevision: "r1",
  });
});
