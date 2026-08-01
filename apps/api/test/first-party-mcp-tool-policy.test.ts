import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_MCP_TOOL_NAMES,
  Permission,
  type AccessGrant,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { buildFilesMcpServer } from "../src/mcp/files";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const turnId = crypto.randomUUID();
const attemptId = crypto.randomUUID();
const DEFAULT_AUTHORIZED_CONNECTOR_TOOLS = [
  "social_connections_list",
  "social_posts_recent",
  "social_daily_analysis_context",
  "social_search_live",
  "social_mentions_live",
  "social_thread_fetch",
  "slack_bot_list_channels",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
  "slack_bot_post_message",
  "slack_bot_delete_message",
] as const satisfies readonly FirstPartyMcpToolName[];

function deps(): ApiRouteDeps {
  return {
    settings: testSettings({ sandboxSelfhostedEnabled: true }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as ApiRouteDeps;
}

function grant(
  permissions: AccessGrant["permissions"],
  firstPartyMcpTools?: FirstPartyMcpToolName[],
): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "worker:first-party-mcp",
    permissions,
    principalKind: "agent_attempt",
    metadata: {
      sessionId,
      turnId,
      attemptId,
      executionGeneration: 1,
      ...(firstPartyMcpTools !== undefined ? { firstPartyMcpTools } : {}),
    },
  };
}

function registeredToolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  )
    .filter((name) => !name.startsWith("__opengeni_empty_"))
    .sort();
}

describe("first-party MCP tool visibility policy", () => {
  test("omission selects the complete safe default catalog when the grant authorizes every tool", () => {
    const server = buildOpenGeniMcpServer(deps(), grant([...Permission.options]), {
      workspaceMemoryEnabled: true,
    });

    expect(registeredToolNames(server)).toEqual([...DEFAULT_FIRST_PARTY_MCP_TOOLS].sort());
  });

  test("an explicit title-only selection does not widen to other authorized tools", () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS], ["set_session_title"]),
      { workspaceMemoryEnabled: true },
    );

    expect(registeredToolNames(server)).toEqual(["set_session_title"]);
  });

  test("ordinary omission excludes connector tools while explicit authorized selection stays exact", () => {
    const ordinary = buildOpenGeniMcpServer(
      deps(),
      grant([...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS]),
    );
    const connectorSet = new Set<FirstPartyMcpToolName>(DEFAULT_AUTHORIZED_CONNECTOR_TOOLS);
    expect(
      registeredToolNames(ordinary).filter((name) =>
        connectorSet.has(name as FirstPartyMcpToolName),
      ),
    ).toEqual([]);

    const explicit = buildOpenGeniMcpServer(
      deps(),
      grant([...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS], [...DEFAULT_AUTHORIZED_CONNECTOR_TOOLS]),
    );
    expect(registeredToolNames(explicit)).toEqual([...DEFAULT_AUTHORIZED_CONNECTOR_TOOLS].sort());
  });

  test("visibility never substitutes for authorization", () => {
    const denied = buildOpenGeniMcpServer(deps(), grant(["sessions:read"], ["session_create"]));
    expect(registeredToolNames(denied)).toEqual([]);

    const admitted = buildOpenGeniMcpServer(deps(), grant(["sessions:create"], ["session_create"]));
    expect(registeredToolNames(admitted)).toEqual(["session_create"]);
  });

  test("the catalog and explicit authorization table cover every broad-server tool", () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], [...FIRST_PARTY_MCP_TOOL_NAMES]),
      { workspaceMemoryEnabled: true },
    );

    expect(registeredToolNames(server)).toEqual([...FIRST_PARTY_MCP_TOOL_NAMES].sort());
    expect(registeredToolNames(server)).not.toContain("files_get_download_url");
  });

  test("the download URL tool exists only on the dedicated files MCP server", () => {
    const broad = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], [...FIRST_PARTY_MCP_TOOL_NAMES]),
    );
    const files = buildFilesMcpServer(deps(), {
      accountId,
      workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["files:read"],
    });

    expect(registeredToolNames(broad)).not.toContain("files_get_download_url");
    expect(registeredToolNames(files)).toEqual(["files_get_download_url"]);
  });

  test("Slack write schemas expose threaded posting and bot-owned deletion", async () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant(["connections:read"], ["slack_bot_post_message", "slack_bot_delete_message"]),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "slack-write-schema-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      const post = tools.find((tool) => tool.name === "slack_bot_post_message");
      const remove = tools.find((tool) => tool.name === "slack_bot_delete_message");
      expect(post?.inputSchema).toMatchObject({
        required: expect.arrayContaining(["operationId", "text"]),
        properties: {
          channelId: { type: "string" },
          threadTimestamp: { type: "string" },
        },
      });
      expect(remove?.inputSchema).toMatchObject({
        required: expect.arrayContaining(["operationId", "channelId", "timestamp"]),
        properties: {
          operationId: { type: "string" },
          channelId: { type: "string" },
          timestamp: { type: "string" },
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("the dedicated files tool is also permission-gated at registration", () => {
    const files = buildFilesMcpServer(deps(), {
      accountId,
      workspaceId,
      subjectId: "worker:first-party-mcp",
      permissions: ["workspace:read"],
    });

    expect(registeredToolNames(files)).toEqual([]);
  });

  test("an explicit empty selection returns a valid empty tools/list", async () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS], []),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "empty-first-party-policy-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([]);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
