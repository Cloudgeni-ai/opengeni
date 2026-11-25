import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";

import { registerSidebarLayoutTools } from "../src/mcp/sidebar-layout-tools";

const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "user:test",
  principalKind: "human_session",
  permissions: ["workspace:read"],
};

async function connect() {
  const server = new McpServer({ name: "sidebar", version: "1" });
  // Only the input schema is under test here; a call that passes it would
  // reach the database (covered in packages/core/test/sidebar-layout-postgres.test.ts).
  registerSidebarLayoutTools(server, {} as ApiRouteDeps, grant, (value) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sidebar-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("sidebar layout tools", () => {
  test("the agent can put apps in the Sessions list, in their own tab, or hide them", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const update = tools.find((tool) => tool.name === "sidebar_layout_update")!;
    const get = tools.find((tool) => tool.name === "sidebar_layout_get")!;
    expect(update.description).toContain("appsPlacement");
    expect(update.description).toContain("give apps their own tab");
    expect(update.description).toContain("I don't want apps in the sidebar");
    expect(get.description).toContain("appsPlacement");
    const schema = JSON.stringify(update.inputSchema);
    expect(schema).toContain('"appsPlacement"');
    for (const placement of ["sessions", "tab", "hidden"])
      expect(schema).toContain(`"${placement}"`);
    // A placement this version doesn't know is refused before anything runs.
    const refused = await client.callTool({
      name: "sidebar_layout_update",
      arguments: { scope: "personal", changes: [{ op: "options", appsPlacement: "drawer" }] },
    });
    expect(refused.isError).toBe(true);
  });
});
