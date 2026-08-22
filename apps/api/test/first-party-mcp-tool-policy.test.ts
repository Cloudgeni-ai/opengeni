import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_MCP_TOOL_NAMES,
  FIRST_PARTY_REMOTE_MCP_TOOL_NAMES,
  Permission,
  SESSION_INSTRUCTIONS_MAX_CHARACTERS,
  type AccessGrant,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { INTERACTION_ATTEMPT_TOOL_NAMES } from "@opengeni/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
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
  "x_accounts_list",
  "x_search_live",
  "x_mentions_live",
  "x_thread_fetch",
  "reddit_accounts_list",
  "reddit_search_live",
  "reddit_mentions_live",
  "reddit_thread_fetch",
  "slack_bot_list_channels",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
  "slack_bot_delete_message",
] as const satisfies readonly FirstPartyMcpToolName[];
const INTERACTION_ATTEMPT_TOOL_NAME_SET = new Set<string>(INTERACTION_ATTEMPT_TOOL_NAMES);

function broadServerTools(tools: readonly FirstPartyMcpToolName[]): FirstPartyMcpToolName[] {
  return tools.filter((tool) => !INTERACTION_ATTEMPT_TOOL_NAME_SET.has(tool));
}

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
  depth?: { nestedAgentDepth: number; effectiveMaxNestedAgentDepth: number },
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
      ...(depth ?? {}),
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

async function callRegisteredTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  isError?: boolean;
  structuredContent?: { error?: { code?: string; message?: string } };
}> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  return (await tool.handler(args, {})) as {
    isError?: boolean;
    structuredContent?: { error?: { code?: string; message?: string } };
  };
}

describe("first-party MCP tool visibility policy", () => {
  test("omission splits the complete safe default catalog across broad and local adapters", () => {
    const server = buildOpenGeniMcpServer(deps(), grant([...Permission.options]), {
      workspaceMemoryEnabled: true,
    });

    const broad = registeredToolNames(server);
    expect(broad).toEqual(broadServerTools(DEFAULT_FIRST_PARTY_MCP_TOOLS).sort());
    expect([...broad, ...INTERACTION_ATTEMPT_TOOL_NAMES].sort()).toEqual(
      [...DEFAULT_FIRST_PARTY_MCP_TOOLS].sort(),
    );
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

  test("sandbox file publication requires both read and upload authority", () => {
    const readOnly = buildOpenGeniMcpServer(
      deps(),
      grant(["files:read"], ["sandbox_file_publish"]),
    );
    const uploadOnly = buildOpenGeniMcpServer(
      deps(),
      grant(["files:upload"], ["sandbox_file_publish"]),
    );
    const admitted = buildOpenGeniMcpServer(
      deps(),
      grant(["files:read", "files:upload"], ["sandbox_file_publish"]),
    );

    expect(registeredToolNames(readOnly)).toEqual([]);
    expect(registeredToolNames(uploadOnly)).toEqual([]);
    expect(registeredToolNames(admitted)).toEqual(["sandbox_file_publish"]);
  });

  test("trusted exhausted depth hides session_create while legacy and remaining-depth grants retain it", () => {
    const legacy = buildOpenGeniMcpServer(deps(), grant(["sessions:create"], ["session_create"]));
    const remaining = buildOpenGeniMcpServer(
      deps(),
      grant(["sessions:create"], ["session_create"], {
        nestedAgentDepth: 2,
        effectiveMaxNestedAgentDepth: 3,
      }),
    );
    const exhausted = buildOpenGeniMcpServer(
      deps(),
      grant(["sessions:create"], ["session_create"], {
        nestedAgentDepth: 3,
        effectiveMaxNestedAgentDepth: 3,
      }),
    );

    expect(registeredToolNames(legacy)).toEqual(["session_create"]);
    expect(registeredToolNames(remaining)).toEqual(["session_create"]);
    expect(registeredToolNames(exhausted)).toEqual([]);
  });

  test("model-facing session_create omits absolute depth and literal shared traps", async () => {
    let databaseTouches = 0;
    const routeDeps = deps();
    routeDeps.db = new Proxy(
      {},
      {
        get() {
          databaseTouches += 1;
          throw new Error("invalid model request reached storage");
        },
      },
    ) as ApiRouteDeps["db"];
    const server = buildOpenGeniMcpServer(
      routeDeps,
      grant(["sessions:create"], ["session_create"], {
        nestedAgentDepth: 1,
        effectiveMaxNestedAgentDepth: 3,
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "session-create-schema-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "session_create",
      );
      expect(tool?.description).toContain("non-delegating leaf");
      expect(tool?.description).toContain("do not use a child-local depth override");
      const serialized = JSON.stringify(tool?.inputSchema);
      expect(serialized).not.toContain("maxNestedAgentDepth");
      expect(serialized).not.toContain('"const":"shared"');
      expect(serialized).not.toContain('"enum":["shared"');
      expect(serialized).toContain("machineTarget");
      expect(serialized).toContain("targetSandboxId");
      expect(serialized).toContain("workingDir");
      expect(serialized).toContain('"required":["targetSandboxId"]');
      expect(tool?.inputSchema).toMatchObject({
        properties: {
          instructions: { maxLength: SESSION_INSTRUCTIONS_MAX_CHARACTERS },
        },
      });
      for (const arguments_ of [
        { initialMessage: "bad cwd", workingDir: "/tmp" },
        {
          initialMessage: "bad shared variable set",
          variableSetId: crypto.randomUUID(),
          sandbox: "shared",
        },
        {
          initialMessage: "bad shared rig",
          rigId: crypto.randomUUID(),
          sandbox: "shared",
        },
        { initialMessage: "bad depth", maxNestedAgentDepth: 0 },
      ]) {
        const result = await client.callTool({ name: "session_create", arguments: arguments_ });
        expect(result).toMatchObject({ isError: true });
      }
      expect(databaseTouches).toBe(0);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("orchestration failures return bounded structured code and message", async () => {
    const rawMessage = `invalid\u0000 request ${"🧪".repeat(600)}`;
    const routeDeps = deps();
    routeDeps.db = new Proxy(
      {},
      {
        get() {
          throw new HTTPException(422, { message: rawMessage });
        },
      },
    ) as ApiRouteDeps["db"];
    const server = buildOpenGeniMcpServer(
      routeDeps,
      grant(["sessions:create", "sessions:control"], ["session_create", "session_send_message"], {
        nestedAgentDepth: 1,
        effectiveMaxNestedAgentDepth: 3,
      }),
    );

    const create = await callRegisteredTool(server, "session_create", {
      initialMessage: "work",
    });
    expect(create.isError).toBe(true);
    expect(create.structuredContent?.error?.code).toBe("session_create_rejected");
    expect(create.structuredContent?.error?.message).not.toContain("\u0000");
    expect(create.structuredContent?.error?.message).not.toContain("�");
    expect(
      new TextEncoder().encode(create.structuredContent?.error?.message ?? "").byteLength,
    ).toBeLessThanOrEqual(1_024);

    routeDeps.db = new Proxy(
      {},
      {
        get() {
          throw new HTTPException(409, { message: "target session is no longer writable" });
        },
      },
    ) as ApiRouteDeps["db"];
    const messageServer = buildOpenGeniMcpServer(
      routeDeps,
      grant(["sessions:control"], ["session_send_message"]),
    );
    const message = await callRegisteredTool(messageServer, "session_send_message", {
      sessionId: crypto.randomUUID(),
      text: "status",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(message).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "session_send_message_conflict",
          message: "target session is no longer writable",
        },
      },
    });
  });

  test("the broad catalog excludes compatibility-only and local first-party tools", () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], [...FIRST_PARTY_MCP_TOOL_NAMES]),
      { workspaceMemoryEnabled: true },
    );

    const broad = registeredToolNames(server);
    expect(broad).toEqual([...FIRST_PARTY_REMOTE_MCP_TOOL_NAMES].sort());
    expect(broad).not.toContain("slack_bot_post_message");
    expect(INTERACTION_ATTEMPT_TOOL_NAMES).not.toContain("slack_bot_post_message");
    expect(broad).not.toContain("files_get_download_url");
    expect(broad).not.toContain("github_token");
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

  test("generic MCP omits Slack posting without a trusted logical-delivery identity", async () => {
    let databaseTouches = 0;
    const routeDeps = deps();
    routeDeps.db = new Proxy(
      {},
      {
        get() {
          databaseTouches += 1;
          throw new Error("generic Slack posting must not resolve a connection");
        },
      },
    ) as ApiRouteDeps["db"];
    const server = buildOpenGeniMcpServer(
      routeDeps,
      grant(["connections:read"], ["slack_bot_post_message", "slack_bot_delete_message"]),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "slack-write-boundary-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).not.toContain("slack_bot_post_message");
      const remove = tools.find((tool) => tool.name === "slack_bot_delete_message");
      expect(remove?.inputSchema).toMatchObject({
        required: expect.arrayContaining(["operationId", "channelId", "timestamp"]),
        properties: {
          operationId: { type: "string" },
          channelId: { type: "string" },
          timestamp: { type: "string" },
        },
      });
      for (const operationId of [crypto.randomUUID(), crypto.randomUUID()]) {
        const result = await client.callTool({
          name: "slack_bot_post_message",
          arguments: { operationId, channelId: "C123", text: "do not send" },
        });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toMatch(/not found|unknown/i);
      }
      expect(databaseTouches).toBe(0);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("capability discovery is default-visible but separates search from human authorization", async () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant(["workspace:read"], ["capability_catalog_search", "capability_authorization_request"]),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "capability-discovery-schema-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      const search = tools.find((tool) => tool.name === "capability_catalog_search");
      const request = tools.find((tool) => tool.name === "capability_authorization_request");
      expect(search?.description).toContain("never installs, connects, or authorizes");
      expect(search?.inputSchema).toMatchObject({
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "integer" } },
      });
      expect(request?.description).toContain("never grants access");
      expect(request?.inputSchema).toMatchObject({
        required: expect.arrayContaining(["capabilityId", "rationale"]),
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("sandbox inventory describes idle home sandboxes as wakeable", async () => {
    const server = buildOpenGeniMcpServer(deps(), grant(["sessions:read"], ["sandboxes_list"]));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sandbox-inventory-description-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "sandboxes_list",
      );
      expect(tool?.description).toContain("operationAvailability");
      expect(tool?.description).toContain("`wakeable`");
      expect(tool?.description).toContain("will wake or restore");
      expect(tool?.description).toContain("not ordinary operation availability");
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

describe("agent-facing goal_set schema", () => {
  test("does not accept maxAutoContinuations; the ceiling is API/scheduled configuration", async () => {
    const server = buildOpenGeniMcpServer(deps(), grant(["goals:manage"]));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "goal-set-schema-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "goal_set",
      );
      expect(tool).toBeDefined();
      const serialized = JSON.stringify(tool?.inputSchema);
      expect(serialized).not.toContain("maxAutoContinuations");
      expect(tool?.inputSchema).toMatchObject({
        properties: { text: expect.anything(), successCriteria: expect.anything() },
        required: ["text"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
