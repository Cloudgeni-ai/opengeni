import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniAgent, prepareAgentTools } from "../src/index";
import { MCP_MAX_TOOL_DEFINITION_BYTES, McpPayloadTooLargeError } from "../src/mcp-network";

// Bendik's rule: one connector's oversized or clashing tool list must never end
// a turn with no way to recover. Each case below used to throw while the turn's
// tools were prepared or listed; each now leaves tools out, logs a structured
// `tool_catalog_degraded` warning and tells the model what is unavailable.

type Listed = { name: string; description?: string; inputSchema: Record<string, unknown> };

function listed(name: string, description = `${name} tool`): Listed {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

function localServer(id: string, list: () => Listed[], calls: string[] = []): MCPServer {
  return {
    name: id,
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => list(),
    callTool: async (name: string) => {
      calls.push(`${id}/${name}`);
      return [{ type: "text", text: `ran ${id}/${name}` }];
    },
  } as unknown as MCPServer;
}

function scope() {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
  };
}

function config(id: string) {
  return { id, name: id, url: `https://${id.replace(/_/g, "-")}.invalid/mcp` };
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

function degradedWarnings() {
  return warn.mock.calls
    .map(([, fields]) => fields as Record<string, unknown> | undefined)
    .filter((fields) => fields?.event === "tool_catalog_degraded");
}

async function prepare(
  servers: { id: string; list: () => Listed[]; eager?: true | string[] }[],
  calls: string[] = [],
) {
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: servers.map(({ id }) => config(id)),
  });
  const prepared = await prepareAgentTools(
    settings,
    // Required (not optional, no connection): these used to fail the turn.
    servers.map(({ id, eager }) => ({ kind: "mcp" as const, id, ...(eager ? { eager } : {}) })),
    {
      ...scope(),
      localMcpServers: servers.map(({ id, list }) => ({
        id,
        server: localServer(id, list, calls),
      })),
    },
  );
  return { settings, prepared };
}

describe("a required server's tool list over its size limits", () => {
  test("repeated pages that exceed the entry limit only before de-duplication keep every tool", async () => {
    // Before: the size check ran on the raw list and failed the required server.
    const page = Array.from({ length: 3_000 }, (_, index) => listed(`tool_${index}`));
    const { prepared } = await prepare([{ id: "paged", list: () => [...page, ...page] }]);
    try {
      expect(prepared.attemptToolCatalog!.entries).toHaveLength(3_000);
      expect(prepared.unavailableMcpServers.size).toBe(0);
      expect(degradedWarnings()).toEqual([]);
    } finally {
      await prepared.close();
    }
  });

  test("more tools than fit are trimmed, oversized ones dropped, eager ones kept", async () => {
    // Before: McpPayloadTooLargeError from the required server failed the turn.
    const tools = Array.from({ length: 4_200 }, (_, index) => listed(`tool_${index}`));
    tools.splice(10, 0, listed("huge", "x".repeat(MCP_MAX_TOOL_DEFINITION_BYTES)));
    const { prepared } = await prepare([{ id: "large", list: () => tools, eager: ["tool_4199"] }]);
    try {
      const names = prepared.attemptToolCatalog!.entries.map((entry) => entry.identity.toolName);
      expect(names).toHaveLength(4_096);
      expect(names).not.toContain("huge");
      expect(names).toContain("tool_4199");
      expect(names.slice(0, 3)).toEqual(["tool_0", "tool_1", "tool_2"]);
      expect(prepared.unavailableMcpServers.get("large")).toMatch(
        /^connected, but 105 of its tools are unavailable this turn .*Its other tools work\.$/,
      );
      expect(degradedWarnings()).toEqual([
        expect.objectContaining({
          serverId: "large",
          required: true,
          keptCount: 4_096,
          droppedCount: 105,
          reasons: { definition_too_large: 1, list_entry_limit: 104 },
        }),
      ]);
    } finally {
      await prepared.close();
    }
  });

  test("a tools/list response over the transport limit degrades to no tools", async () => {
    // Before: the required server's size refusal failed every turn the same way.
    const { prepared } = await prepare([
      {
        id: "oversized",
        list: () => {
          throw new McpPayloadTooLargeError("MCP response", 9 * 1024 * 1024, 8 * 1024 * 1024);
        },
      },
      { id: "healthy", list: () => [listed("ping")] },
    ]);
    try {
      expect(prepared.attemptToolCatalog!.entries.map((entry) => entry.identity)).toEqual([
        { serverId: "healthy", toolName: "ping" },
      ]);
      expect(prepared.unavailableMcpServers.get("oversized")).toBe(
        "connected, but its tool list is larger than one turn can hold, so its tools are unavailable this turn.",
      );
      expect(degradedWarnings()).toEqual([
        expect.objectContaining({ serverId: "oversized", required: true }),
      ]);
    } finally {
      await prepared.close();
    }
  });

  test("servers together over the aggregate limit: the later one keeps what fits", async () => {
    const first = Array.from({ length: 3_000 }, (_, index) => listed(`first_${index}`));
    const second = Array.from({ length: 3_000 }, (_, index) => listed(`second_${index}`));
    const { prepared } = await prepare([
      { id: "one", list: () => first },
      { id: "two", list: () => second },
    ]);
    try {
      expect(prepared.attemptToolCatalog!.entries).toHaveLength(4_096);
      const [trimmed] = [...prepared.unavailableMcpServers];
      expect(trimmed![1]).toMatch(/1904 of its tools are unavailable this turn/);
    } finally {
      await prepared.close();
    }
  });
});

describe("two connectors producing one model name", () => {
  // Registry ids may contain "__", so `a__b` + `c` and `a` + `b__c` are both
  // `a__b__c`. Before: the SDK's "Duplicate tool names found across MCP
  // servers" (or the runtime's identity-map collision) failed the turn.
  test("the first listing keeps the name, the other is left out and refused", async () => {
    const calls: string[] = [];
    const { settings, prepared } = await prepare(
      [
        { id: "a__b", list: () => [listed("c"), listed("own_b")] },
        { id: "a", list: () => [listed("b__c"), listed("own_a")] },
      ],
      calls,
    );
    try {
      const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
      const tools = await agent.getMcpTools(new RunContext());
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["a__b__c", "a__b__own_b", "a__own_a"]);
      const catalog = prepared.attemptToolCatalog!.entries;
      expect(catalog.filter((entry) => entry.modelName === "a__b__c")).toHaveLength(1);
      const winner = catalog.find((entry) => entry.modelName === "a__b__c")!.identity.serverId;
      const loser = winner === "a" ? "a__b" : "a";
      expect(prepared.unavailableMcpServers.get(loser)).toMatch(
        /1 of its tools are unavailable this turn .*clash with another integration/,
      );
      const loserServer = prepared.mcpServers.find(
        (server) => (server as { registryId?: string }).registryId === loser,
      )!;
      await expect(loserServer.callTool("a__b__c", {})).rejects.toMatchObject({
        name: "ToolGatewayToolNotFoundError",
      });
      const winnerServer = prepared.mcpServers.find(
        (server) => (server as { registryId?: string }).registryId === winner,
      )!;
      await winnerServer.callTool("a__b__c", {});
      expect(calls).toEqual([winner === "a" ? "a/b__c" : "a__b/c"]);
    } finally {
      await prepared.close();
    }
  });
});

test("more servers than one turn connects: required ones are kept first, the rest skipped", async () => {
  // Before: "selected MCP server count exceeds the 64-entry safety limit" failed
  // the turn, e.g. when account routes pushed a session past 64 servers.
  const kept = Array.from({ length: 64 }, (_, index) => `kept_${index}`);
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [...kept, "skipped_required", "skipped_optional"].map(config),
  });
  const prepared = await prepareAgentTools(
    settings,
    [
      { kind: "mcp", id: "skipped_optional", optional: true },
      ...kept.map((id) => ({ kind: "mcp" as const, id })),
      { kind: "mcp", id: "skipped_required" },
    ],
    {
      ...scope(),
      localMcpServers: kept.map((id) => ({
        id,
        server: localServer(id, () => [listed("ping")]),
      })),
    },
  );
  try {
    expect(prepared.attemptToolCatalog!.entries).toHaveLength(64);
    expect([...prepared.unavailableMcpServers.keys()].sort()).toEqual([
      "skipped_optional",
      "skipped_required",
    ]);
    expect(prepared.unavailableMcpServers.get("skipped_required")).toBe(
      "not loaded this turn: more than 64 integrations are selected, so its tools are unavailable.",
    );
    expect(degradedWarnings()).toEqual([
      expect.objectContaining({
        code: "server_selection_limit",
        selectedCount: 66,
        keptCount: 64,
        skippedServerIds: ["skipped_optional", "skipped_required"],
      }),
    ]);
  } finally {
    await prepared.close();
  }
});
