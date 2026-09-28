import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import {
  PrefixedMcpServer,
  toolCallFamily,
  toolFamilyForCatalogIdentity,
  withToolCallFamily,
  type ToolFamilyRegistryEntry,
} from "../src/index";

const registry: ToolFamilyRegistryEntry[] = [
  { id: "opengeni", url: "http://127.0.0.1:8000/mcp" },
  { id: "linear", url: "https://mcp.linear.app/mcp" },
  {
    id: "gitlab-self-hosted",
    url: "https://gitlab.internal.example/mcp",
    connectionRef: { providerDomain: "gitlab.internal.example" },
  },
  {
    id: "github-rest",
    url: "http://127.0.0.1:9/github",
    connectionRef: { providerDomain: "github.com" },
  },
];

function server(registryId: string, tools: string[]): PrefixedMcpServer {
  const inner = {
    cacheToolsList: false,
    name: registryId,
    connect: async () => {},
    close: async () => {},
    listTools: async () =>
      tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
    callTool: async () => [],
  } as MCPServer;
  return new PrefixedMcpServer(inner, registryId);
}

describe("tool-call analytics family", () => {
  test("classifies catalog identities by source without exporting free text", () => {
    expect(
      toolFamilyForCatalogIdentity(
        { identity: { serverId: "interaction", toolName: "browser_open" }, source: "interaction" },
        registry,
      ),
    ).toBe("browser_open");
    expect(
      toolFamilyForCatalogIdentity(
        { identity: { serverId: "opengeni", toolName: "not_a_real_tool" }, source: "opengeni" },
        registry,
      ),
    ).toBeNull();
    expect(
      toolFamilyForCatalogIdentity(
        { identity: { serverId: "codex_apps", toolName: "anything" }, source: "codex_apps" },
        registry,
      ),
    ).toBe("integration:chatgpt.com");
    expect(
      toolFamilyForCatalogIdentity(
        { identity: { serverId: "linear", toolName: "list_issues" }, source: "mcp" },
        registry,
      ),
    ).toBe("integration:mcp.linear.app");
    expect(
      toolFamilyForCatalogIdentity(
        { identity: { serverId: "gitlab-self-hosted", toolName: "list" }, source: "mcp" },
        registry,
      ),
    ).toBe("custom");
    expect(
      toolFamilyForCatalogIdentity(
        {
          identity: { serverId: "google-drive-publishing", toolName: "google_drive_publish_file" },
          source: "mcp",
        },
        registry,
      ),
    ).toBe("integration:googleapis.com");
    expect(
      toolFamilyForCatalogIdentity(
        { identity: { serverId: "constructor", toolName: "x" }, source: "mcp" },
        registry,
      ),
    ).toBeNull();
  });

  test("resolves a model-visible name through its prepared server", async () => {
    const servers = [
      server("opengeni", ["goal_set"]),
      server("linear", ["list_issues"]),
      server("gitlab-self-hosted", ["list_merge_requests"]),
      server("github-rest", ["create_issue"]),
    ];
    const names = await Promise.all(servers.map(async (item) => (await item.listTools())[0]!.name));
    expect(names.map((name) => toolCallFamily(servers, registry, name))).toEqual([
      "goal_set",
      "integration:mcp.linear.app",
      "custom",
      "integration:github.com",
    ]);
    // Base runtime tools are not served by any MCP server.
    expect(toolCallFamily(servers, registry, "exec_command")).toBe("exec_command");
    // An unknown name is never exported, not even as custom.
    expect(toolCallFamily(servers, registry, "invented_by_the_model")).toBeNull();
  });

  test("stamps the family on an event copy only", async () => {
    const servers = [server("linear", ["list_issues"])];
    const [tool] = await servers[0]!.listTools();
    const payload = { id: "call-1", name: tool!.name, arguments: { query: "private" } };
    expect(withToolCallFamily(servers, registry, payload)).toEqual({
      ...payload,
      toolFamily: "integration:mcp.linear.app",
    });
    expect(payload).not.toHaveProperty("toolFamily");
    const unknown = { id: "call-2", name: "invented_by_the_model", arguments: {} };
    expect(withToolCallFamily(servers, registry, unknown)).toBe(unknown);
  });
});
