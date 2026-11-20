import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  FIRST_PARTY_MCP_TOOL_ALIASES,
  FIRST_PARTY_MCP_TOOL_ALIAS_NAMES,
  type AccessGrant,
} from "@opengeni/contracts";
import * as z4 from "zod/v4";

import { PolicyMcpServer } from "../src/mcp/server";

const grant: AccessGrant = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  subjectId: "user:test",
  principalKind: "human_session",
  permissions: ["artifacts:read", "artifacts:publish"],
};

// Embedding products call first-party tools by name; a renamed tool's former
// name must keep working for them while models only ever see the new name.
describe("first-party tool aliases on the MCP server", () => {
  test("every former name runs the current tool and is never listed", async () => {
    const server = new PolicyMcpServer(grant, crypto.randomUUID(), null);
    const current = [...new Set(Object.values(FIRST_PARTY_MCP_TOOL_ALIASES))];
    for (const name of current) {
      server.registerTool(
        name,
        { description: `The ${name} tool.`, inputSchema: { value: z4.string() } },
        async ({ value }) => ({ content: [{ type: "text" as const, text: `${name}:${value}` }] }),
      );
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "aliases", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed.sort()).toEqual([...current].sort());
    for (const alias of FIRST_PARTY_MCP_TOOL_ALIAS_NAMES) {
      expect(listed).not.toContain(alias);
      const result = await client.callTool({ name: alias, arguments: { value: "x" } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([
        { type: "text", text: `${FIRST_PARTY_MCP_TOOL_ALIASES[alias]}:x` },
      ]);
    }
    const unknown = await client.callTool({ name: "site_no_such_tool", arguments: {} });
    expect(unknown.isError).toBe(true);
  });
});
