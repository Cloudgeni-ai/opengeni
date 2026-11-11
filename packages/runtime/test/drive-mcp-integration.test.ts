import { expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  type ConnectorActionPolicyHooks,
} from "../src/index";
import { OFFICIAL_DRIVE_MCP_URL } from "../src/drive-mcp";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
  credentialSubjectId: "human",
};
const connectionRef = {
  providerDomain: "drivemcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
  connectionId: "selected-drive",
};

async function prepareFixture(policy?: ConnectorActionPolicyHooks) {
  const calls: { url: string; authorization: string | null; method: string; body: unknown }[] = [];
  let authorized = true;
  let ambiguous = false;
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [
      {
        id: "drive",
        url: OFFICIAL_DRIVE_MCP_URL,
        connectionRef,
        cacheToolsList: false,
        allowedTools: ["create_file", "move_file"],
      },
    ],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "drive", eager: true }], {
    ...scope,
    connectorActionPolicy: policy ?? {
      prepare: async () => ({ managed: false, decision: "unmanaged" }),
      begin: async () => ({ managed: false, allowed: true }),
      complete: async () => {},
    },
    resolveCredential: async (request) => {
      expect(request.connectionRef).toEqual(connectionRef);
      expect(request.subjectId).toBe("human");
      return {
        status: "ok",
        connectionId: "selected-drive",
        headers: { authorization: "Bearer selected-drive" },
        authorizeProviderRequest: async () => authorized,
      };
    },
    mcpFetchImpl: async (url, init) => {
      const request = new Request(url, init);
      const body =
        request.method === "POST" || request.method === "PATCH" ? await request.json() : undefined;
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        method: request.method,
        body,
      });
      if (request.url === OFFICIAL_DRIVE_MCP_URL) {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        if (body.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "official-drive-fixture", version: "1" },
            };
            break;
          case "tools/list":
            result = {
              tools: [
                {
                  name: "create_file",
                  description: "Official create",
                  inputSchema: {
                    type: "object",
                    properties: { textContent: { type: "string" } },
                    required: ["textContent"],
                  },
                },
              ],
            };
            break;
          case "tools/call":
            result = {
              content: [{ type: "text", text: "official created" }],
              structuredContent: { id: "created-official" },
              _meta: { source: "official-fixture" },
            };
            break;
          default:
            throw new Error(`Unexpected MCP method ${body.method}`);
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }
      expect(new URL(request.url).origin).toBe("https://www.googleapis.com");
      if (ambiguous) throw new Error("connection dropped after dispatch");
      return Response.json({ id: "existing-file", parents: ["destination"] });
    },
  });
  return {
    prepared,
    settings,
    calls,
    revoke: () => {
      authorized = false;
    },
    makeAmbiguous: () => {
      ambiguous = true;
    },
  };
}

test("Drive preparation uses one real MCP transport plus selected-account REST tools with the same allowlist", async () => {
  const f = await prepareFixture();
  try {
    expect(f.prepared.mcpServers).toHaveLength(1);
    const server = f.prepared.mcpServers[0]!;
    expect((await server.listTools()).map((tool) => tool.name).sort()).toEqual([
      "drive__create_file",
      "drive__move_file",
    ]);
    await expect(
      server.callTool("drive__delete_file", { fileId: "existing-file" }),
    ).rejects.toThrow("not allowed");
    const official = await server.callToolResult!("drive__create_file", { textContent: "report" });
    expect(official.structuredContent).toEqual({ id: "created-official" });
    expect(official._meta).toMatchObject({ source: "official-fixture" });
    await server.callTool("drive__move_file", {
      fileId: "existing-file",
      fromParentId: "source",
      toParentId: "destination",
    });
    const rest = f.calls.filter((call) => new URL(call.url).hostname === "www.googleapis.com");
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      authorization: "Bearer selected-drive",
      method: "PATCH",
      body: {},
    });
    expect(new URL(rest[0]!.url).searchParams.get("addParents")).toBe("destination");
    expect(f.prepared.resolvedMcpConnectionIds.get("drive")).toBe("selected-drive");
    f.revoke();
    expect(
      (
        await server.callToolResult!("drive__move_file", {
          fileId: "existing-file",
          fromParentId: "source",
          toParentId: "destination",
        })
      ).isError,
    ).toBe(true);
    expect(
      f.calls.filter((call) => new URL(call.url).hostname === "www.googleapis.com"),
    ).toHaveLength(1);
  } finally {
    await f.prepared.close();
  }
});

test("Drive REST writes enter ordinary approval and settle an ambiguous dispatch uncertain without replay", async () => {
  let approved = false;
  const settlements: unknown[] = [];
  const hooks: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      expect(call.connectionId).toBe("selected-drive");
      return { managed: true, decision: "ask" };
    },
    begin: async () =>
      approved
        ? { managed: true, allowed: true, requestId: "move-request" }
        : { managed: true, allowed: false, requestId: "move-request", reason: "approval_required" },
    complete: async (result) => {
      settlements.push(result);
    },
  };
  const f = await prepareFixture(hooks);
  try {
    const agent = buildOpenGeniAgent(f.settings, [], {
      mcpServers: f.prepared.mcpServers,
      resolvedMcpConnectionIds: f.prepared.resolvedMcpConnectionIds,
      connectorActionPolicy: hooks,
    });
    const tool = (await agent.getMcpTools(new RunContext())).find(
      (entry) => entry.type === "function" && entry.name === "drive__move_file",
    );
    if (!tool || tool.type !== "function") throw new Error("Drive move tool missing");
    const args = { fileId: "existing-file", fromParentId: "source", toParentId: "destination" };
    expect(await tool.needsApproval(new RunContext(), args, "move-call")).toBe(true);
    expect(
      f.calls.filter((call) => new URL(call.url).hostname === "www.googleapis.com"),
    ).toHaveLength(0);
    approved = true;
    f.makeAmbiguous();
    const result = await tool.invoke(new RunContext(), JSON.stringify(args), {
      toolCall: { callId: "move-call" },
    } as Parameters<typeof tool.invoke>[2]);
    expect(JSON.stringify(result)).toContain("Do not retry automatically");
    expect(
      f.calls.filter((call) => new URL(call.url).hostname === "www.googleapis.com"),
    ).toHaveLength(1);
    expect(settlements).toEqual([{ requestId: "move-request", outcome: "uncertain" }]);
  } finally {
    await f.prepared.close();
  }
});
