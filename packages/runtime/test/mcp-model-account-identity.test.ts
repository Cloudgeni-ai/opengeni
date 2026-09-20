import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  prefixedMcpToolName,
  type ConnectorActionToolCall,
} from "../src/index";

for (const backend of ["none", "docker"] as const) {
  test(`${backend}: actual SDK account tools are bounded, reversible and approval-gated after cloning`, async () => {
    const routes = [`account-${"a".repeat(64)}`, `account-${"b".repeat(64)}`];
    const names = [
      "write",
      `${"long_underlying_tool_".repeat(5)}a`,
      `${"long_underlying_tool_".repeat(5)}b`,
      "send-mail",
      "send_mail",
    ];
    const dispatched: Array<{ route: string; name: string }> = [];
    const settings = testSettings({
      sandboxBackend: backend,
      mcpServers: routes.map((id) => ({
        id,
        url: "https://example.test/mcp",
        connectionRef: { connectionId: id, providerDomain: "example.test" },
        requireApproval: true,
      })),
    });
    const prepared = await prepareAgentTools(
      settings,
      routes.map((id) => ({ kind: "mcp", id })),
      {
        localMcpServers: routes.map((id) => ({
          id,
          resolvedConnectionId: id,
          server: {
            name: id,
            cacheToolsList: false,
            connect: async () => {},
            close: async () => {},
            listTools: async () =>
              names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
            callTool: async (name) => {
              dispatched.push({ route: id, name });
              return [];
            },
          } as MCPServer,
        })),
      },
    );
    const policyCalls: ConnectorActionToolCall[] = [];
    try {
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        connectorActionPolicy: {
          prepare: async (call) => {
            policyCalls.push(call);
            return { managed: true, decision: "ask" };
          },
          begin: async () => ({
            allowed: false,
            managed: true,
            requestId: "blocked",
            reason: "approval_required",
          }),
          complete: async () => {},
        },
      })
        .clone({})
        .clone({});
      const tools = await agent.getMcpTools(new RunContext());
      expect(tools).toHaveLength(routes.length * names.length);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      for (const [routeIndex, route] of routes.entries()) {
        for (const name of names) {
          const modelName = prefixedMcpToolName(route, name);
          expect(modelName.length).toBeLessThanOrEqual(64);
          expect(modelName).toMatch(/^[A-Za-z0-9_]+$/);
          const tool = tools.find((entry) => entry.name === modelName);
          if (!tool || tool.type !== "function") throw new Error("SDK model tool missing");
          expect(await tool.needsApproval(new RunContext(), {}, `call-${modelName}`)).toBe(true);
          expect(policyCalls.at(-1)).toMatchObject({
            serverId: route,
            toolName: name,
            connectionId: route,
          });
          // The low-level dispatch projection remains exactly reversible; normal
          // model calls above still go through the durable approval hooks.
          await prepared.mcpServers[routeIndex]!.callTool(modelName, {});
          expect(dispatched.at(-1)).toEqual({ route, name });
        }
      }
      expect(policyCalls).toHaveLength(10);
    } finally {
      await prepared.close();
    }
  });
}
