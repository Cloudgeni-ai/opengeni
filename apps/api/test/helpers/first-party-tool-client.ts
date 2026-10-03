import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FIRST_PARTY_MCP_TOOL_NAMES, Permission, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../../src/mcp/server";

export const firstPartyToolGrant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "tool-input-test",
  principalKind: "agent_attempt",
  permissions: [...Permission.options],
  metadata: {
    sessionId: "33333333-3333-4333-8333-333333333333",
    firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
  },
};

export async function withFirstPartyToolClient<T>(run: (client: Client) => Promise<T>) {
  const server = buildOpenGeniMcpServer(
    {
      settings: testSettings({
        sandboxBackend: "none",
        allowedFirstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
      }),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("invalid input reached storage");
          },
        },
      ),
      bus: new MemoryEventBus(),
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("invalid input reached documents");
      },
    } as unknown as ApiRouteDeps,
    firstPartyToolGrant,
  );
  return withMcpClient(server, run);
}

export async function withMcpClient<T>(server: McpServer, run: (client: Client) => Promise<T>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-input-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}
