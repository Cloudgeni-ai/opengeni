import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type AccessGrant,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { createInteractionAttemptToolDefinitions } from "@opengeni/runtime";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { buildFilesMcpServer } from "../../src/mcp/files";
import { buildOpenGeniMcpServer } from "../../src/mcp/server";
import {
  isHarnessControlMcpFunctionTool,
  isInteractionEntryFunctionTool,
} from "../../../../packages/runtime/src/codex-tool-search";
import type { ToolSearchIndex } from "../../../../packages/runtime/src/tool-discovery-ranking";
import { withMcpClient } from "./first-party-tool-client";

type SearchableTool = ConstructorParameters<typeof ToolSearchIndex>[0][number];

const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";

function searchable(name: string, description: string, parameters: unknown): SearchableTool {
  return {
    type: "function",
    name,
    description,
    parameters,
    strict: false,
    needsApproval: async () => false,
    invoke: async () => "",
  } as unknown as SearchableTool;
}

/**
 * The default first-party tools an agent turn can search, with their real
 * descriptions and schemas, named as the runtime names them: the Opengeni
 * MCP server (with selfhosted machines on), the files server, and the
 * in-process browser and computer tools. Tools the runtime keeps in the first
 * request instead (harness controls and interaction entry tools) are left out
 * with the runtime's own predicates, so a ranking test can only expect a
 * result a real search can return.
 */
export async function defaultToolSearchPool(): Promise<SearchableTool[]> {
  const grant: AccessGrant = {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId,
    subjectId: "worker:tool-search-pool",
    principalKind: "agent_attempt",
    permissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
    metadata: {
      sessionId,
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
      firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
    },
  };
  const deps = {
    settings: testSettings({
      sandboxSelfhostedEnabled: true,
      sitesGatewayInternalOrigin: "https://internal.sites.test",
      sitesGatewaySecret: "site-sql-gateway-secret-0123456789abcdef",
    }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
  } as unknown as ApiRouteDeps;
  const listed = async (server: Parameters<typeof withMcpClient>[0], prefix: string) =>
    await withMcpClient(server, async (client) =>
      (await client.listTools()).tools
        .filter((tool) => !tool.name.startsWith("__opengeni_empty_"))
        .map((tool) =>
          searchable(`${prefix}__${tool.name}`, tool.description ?? "", tool.inputSchema),
        ),
    );
  const interaction = createInteractionAttemptToolDefinitions({
    transport: {} as never,
    workspaceId,
    sessionId,
  }).map((definition) =>
    searchable(
      `interaction__${definition.identity.toolName}`,
      definition.description ?? "",
      definition.inputSchema,
    ),
  );
  const mcpServerIds = new Set(["opengeni", "files"]);
  return [
    ...(await listed(buildOpenGeniMcpServer(deps, grant), "opengeni")),
    ...(await listed(buildFilesMcpServer(deps, grant), "files")),
    ...interaction,
  ].filter(
    (tool) =>
      !isHarnessControlMcpFunctionTool(tool, mcpServerIds) &&
      !isInteractionEntryFunctionTool(tool, mcpServerIds),
  );
}
