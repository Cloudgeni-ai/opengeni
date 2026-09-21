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
