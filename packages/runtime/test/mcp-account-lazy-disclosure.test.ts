import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent, prepareAgentTools, prefixedMcpToolName } from "../src/index";
import { lazyToolRuntimeForAgent } from "../src/lazy-tool-transport";
import { isSearchableMcpFunctionTool } from "../src/codex-tool-search";

for (const transport of ["codex_native", "openai_native", "generic_dispatch"] as const) {
  for (const backend of ["none", "docker"] as const) {
    for (const eager of [true, false]) {
      test(`${transport}/${backend}: cloned SDK keeps ${eager ? "eager" : "deferred"} account tool classification`, async () => {
        const ids = ["mail", `account-${"a".repeat(64)}`];
        const settings = testSettings({
          sandboxBackend: backend,
          codexToolSearchEnabled: true,
          lazyToolSearchEnabled: true,
          mcpServers: ids.map((id) => ({ id, url: "https://example.test/mcp" })),
        });
        const prepared = await prepareAgentTools(
          settings,
          ids.map((id) => ({ kind: "mcp", id, eager })),
          {
            deferNonEagerUntilToolDemand: true,
            localMcpServers: ids.map((id) => ({
              id,
              server: {
                name: id,
                cacheToolsList: false,
                connect: async () => {},
                close: async () => {},
                listTools: async () => [
                  {
                    name: "send",
                    description: "Send mail",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
                callTool: async () => [],
              } as MCPServer,
            })),
          },
        );
        try {
          // Keep the initially returned proxies, not the resolved replacement
          // array, to exercise exact identity through deferred preparation.
          await prepared.ready;
          const agent = buildOpenGeniAgent(settings, [], {
            mcpServers: prepared.mcpServers,
            lazyToolTransport: transport,
            toolPreparationReady: Promise.resolve(),
          })
            .clone({})
            .clone({});
          await Promise.resolve();
          const visible = await agent.getAllTools(new RunContext());
          const runtime = lazyToolRuntimeForAgent(agent)!;
          for (const id of ids) {
            const name = prefixedMcpToolName(id, "send");
            expect(visible.some((tool) => tool.type === "function" && tool.name === name)).toBe(
              eager,
            );
            expect(runtime.inspectSearchableTools().some((tool) => tool.name === name)).toBe(
              !eager,
            );
            expect(
              runtime.shouldHideSerializedTool({
                type: "function",
                name,
                description: "Send mail",
                parameters: {},
                strict: false,
              }),
            ).toBe(!eager);
            expect((await runtime.resolveAuthorizedFunctionTool(name))?.name).toBe(name);
          }
        } finally {
          await prepared.close();
        }
      });
    }
  }
}

test("exact hashed classification cannot widen the selected server set", () => {
  const server = `account-${"a".repeat(64)}`;
  const name = prefixedMcpToolName(server, "send");
  const tool = { type: "function", name };
  const identities = new Map([[name, server]]);
  expect(isSearchableMcpFunctionTool(tool, new Set([server]), identities)).toBe(true);
  expect(isSearchableMcpFunctionTool(tool, new Set(), identities)).toBe(false);
  expect(isSearchableMcpFunctionTool(tool, new Set([server]))).toBe(false);
});
