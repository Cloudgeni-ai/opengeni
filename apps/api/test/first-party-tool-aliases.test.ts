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
import {
  requireWorkspaceSiteToolAuthorization,
  workspaceToolGatewayDefinitionFilter,
} from "../src/workspace-tool-gateway";

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

describe("first-party tool aliases in gateway allowlists", () => {
  test("an identity frozen under a former name keeps the current tool", () => {
    const definition = (toolName: string) =>
      ({ identity: { serverId: "opengeni", toolName }, approval: "policy" }) as Parameters<
        ReturnType<typeof workspaceToolGatewayDefinitionFilter>
      >[0];
    const keep = workspaceToolGatewayDefinitionFilter({}, [
      { serverId: "opengeni", toolName: "site_data_query" },
    ]);
    expect(keep(definition("app_data_query"))).toBe(true);
    expect(keep(definition("app_data_write"))).toBe(false);
    // A deployment allowlist written with a former name allows the current tool.
    const deployment = workspaceToolGatewayDefinitionFilter({
      allowedFirstPartyMcpTools: ["site_data_query"],
    });
    expect(deployment(definition("app_data_query"))).toBe(true);
    expect(deployment(definition("app_data_write"))).toBe(false);
  });
});

describe("first-party tool aliases in Site declarations", () => {
  test("either name of a declared tool is authorized; an undeclared tool is not", async () => {
    const versionDeclaring = (toolName: string) =>
      (async (_db: unknown, _grant: unknown, _artifactId: string, id: string) => ({
        status: "active",
        version: { id, requestedTools: [{ serverId: "opengeni", toolName }] },
      })) as unknown as Parameters<typeof requireWorkspaceSiteToolAuthorization>[3];
    const check = (declared: string, called: string) =>
      requireWorkspaceSiteToolAuthorization(
        null as never,
        grant,
        {
          siteArtifactId: "site",
          siteVersionId: "version",
          identity: { serverId: "opengeni", toolName: called },
        },
        versionDeclaring(declared),
      );
    for (const declared of ["site_data_query", "app_data_query"])
      for (const called of ["site_data_query", "app_data_query"])
        await expect(check(declared, called)).resolves.toBeUndefined();
    await expect(check("site_data_query", "app_data_write")).rejects.toMatchObject({
      status: 403,
    });
  });
});
