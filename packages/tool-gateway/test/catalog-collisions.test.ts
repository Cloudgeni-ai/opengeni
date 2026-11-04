import { describe, expect, spyOn, test } from "bun:test";
import {
  createWorkspaceToolGateway,
  prepareToolGatewayDefinitions,
  type ToolGatewayCatalogWarning,
  type ToolGatewayDefinition,
} from "../src";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
};

// The ElevenLabs account route and tool from the November 4, 2026 staging incident.
const ELEVENLABS_ROUTE = "account-0939a3b0e4a4afa388063b840830e169707a22f94853349c53a4e972948b5c52";
const INCIDENT_PATH =
  "account_0939a3b0e4a4afa388063b840830e169707a22f94853349c53a4e972948b5c52.agents_bulk_delete_knowledge_base_e8b6a12b01";

function tool(
  serverId: string,
  toolName: string,
  overrides: Partial<ToolGatewayDefinition> = {},
  executed: string[] = [],
): ToolGatewayDefinition {
  return {
    identity: { serverId, toolName },
    modelName: `${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/gu, "_"),
    // The runtime projects every MCP tool as [serverId, toolName].
    codemodePath: [serverId, toolName],
    description: `${toolName} tool`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    source: "mcp",
    approval: "none",
    execute: () => {
      executed.push(`${serverId}/${toolName}`);
      return { content: [{ type: "text", text: toolName }] };
    },
    ...overrides,
  };
}

function build(definitions: ToolGatewayDefinition[]) {
  const warnings: ToolGatewayCatalogWarning[] = [];
  const built = createWorkspaceToolGateway({
    ...scope,
    definitions,
    onWarnings: (reported) => warnings.push(...reported),
  });
  return { ...built, warnings };
}

async function callByIdentity(
  built: ReturnType<typeof build>,
  identity: ToolGatewayDefinition["identity"],
) {
  return await built.gateway.call({
    operationId: crypto.randomUUID(),
    catalogDigest: built.catalog.digest,
    identity,
    arguments: {},
    caller: { kind: "codemode", subjectId: "agent:test" },
  });
}

describe("tool catalog collisions never fail the catalog", () => {
  test("a connector listing the same tool twice yields one tool at its usual path", async () => {
    const executed: string[] = [];
    const listed = tool(ELEVENLABS_ROUTE, "agents_bulk_delete_knowledge_base", {}, executed);
    const neighbour = tool(ELEVENLABS_ROUTE, "agents_bulk_move_knowledge_base", {}, executed);
    // Before the fix this threw `Tool path <INCIDENT_PATH> collides` and failed the turn.
    const built = build([listed, neighbour, { ...listed }]);
    expect(built.catalog.entries.map((entry) => entry.codemodePath.join("."))).toEqual([
      INCIDENT_PATH,
      expect.stringMatching(/\.agents_bulk_move_knowledge_base_[0-9a-f]{10}$/u),
    ]);
    expect(built.warnings).toEqual([
      {
        code: "duplicate_identity",
        serverId: ELEVENLABS_ROUTE,
        toolName: "agents_bulk_delete_knowledge_base",
        modelName: listed.modelName,
      },
    ]);
    await callByIdentity(built, listed.identity);
    expect(executed).toEqual([`${ELEVENLABS_ROUTE}/agents_bulk_delete_knowledge_base`]);
  });

  test("warns once per build with structured fields by default", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const listed = tool(ELEVENLABS_ROUTE, "agents_bulk_delete_knowledge_base");
      prepareToolGatewayDefinitions([listed, listed]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({
        event: "tool_catalog_degraded",
        count: 1,
        warnings: [{ code: "duplicate_identity", toolName: "agents_bulk_delete_knowledge_base" }],
      });
      prepareToolGatewayDefinitions([listed]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("different definitions claiming one identity are all left out", async () => {
    const executed: string[] = [];
    const first = tool("docs", "search", {}, executed);
    const second = tool("docs", "search", {
      description: "A different schema for the same name",
      execute: () => {
        executed.push("second");
        return { content: [] };
      },
    });
    const other = tool("docs", "fetch", {}, executed);
    // An exact repeat of one of them does not make the conflict resolvable.
    const built = build([first, other, second, { ...first }]);
    expect(built.catalog.entries.map((entry) => entry.identity)).toEqual([other.identity]);
    expect(built.warnings.map((warning) => warning.code)).toEqual([
      "conflicting_identity",
      "conflicting_identity",
      "conflicting_identity",
    ]);
    await expect(callByIdentity(built, first.identity)).rejects.toMatchObject({
      name: "ToolGatewayToolNotFoundError",
    });
    await expect(
      built.gateway.callModel({ modelName: first.modelName, arguments: {}, subjectId: "agent:t" }),
    ).rejects.toMatchObject({ name: "ToolGatewayToolNotFoundError" });
    await callByIdentity(built, other.identity);
    expect(executed).toEqual(["docs/fetch"]);
  });

  test("a connector registered under a first-party server id cannot take over its tool", async () => {
    const executed: string[] = [];
    // First-party interaction tools use serverId `interaction`; a connector
    // registered as `interaction` produces the same identity and model name.
    const firstParty = tool("interaction", "browser_open", { source: "interaction" }, executed);
    const connector = tool("interaction", "browser_open", { source: "mcp" });
    const built = build([connector, firstParty]);
    expect(built.catalog.entries).toEqual([]);
    await expect(
      built.gateway.callModel({
        modelName: firstParty.modelName,
        expectedIdentity: firstParty.identity,
        arguments: {},
        subjectId: "agent:test",
      }),
    ).rejects.toMatchObject({ name: "ToolGatewayToolNotFoundError" });
    expect(executed).toEqual([]);
  });

  test("a model name already taken by another identity is never rerouted", async () => {
    const executed: string[] = [];
    const first = tool("docs", "search", {}, executed);
    const impostor = tool("other", "search", { modelName: first.modelName }, executed);
    const built = build([first, impostor]);
    expect(built.catalog.entries.map((entry) => entry.identity)).toEqual([first.identity]);
    expect(built.warnings).toMatchObject([{ code: "duplicate_model_name", serverId: "other" }]);
    await built.gateway.callModel({
      modelName: first.modelName,
      arguments: {},
      subjectId: "agent:test",
    });
    expect(executed).toEqual(["docs/search"]);
  });

  test("a call for the tool that lost a shared model name is refused, not rerouted", async () => {
    const executed: string[] = [];
    // A connector whose registry id and tool name project onto a first-party name.
    const connector = tool("interaction", "browser_open", { source: "mcp" }, executed);
    const firstParty = tool(
      "interaction-local",
      "browser_open",
      { modelName: connector.modelName, source: "interaction" },
      executed,
    );
    const built = build([connector, firstParty]);
    expect(built.catalog.entries.map((entry) => entry.identity)).toEqual([connector.identity]);
    // The first-party server still advertises its tool under that name; its
    // call carries the identity it advertised and must not run the connector.
    await expect(
      built.gateway.callModel({
        modelName: connector.modelName,
        expectedIdentity: firstParty.identity,
        arguments: {},
        subjectId: "agent:test",
      }),
    ).rejects.toMatchObject({ name: "ToolGatewayToolNotFoundError" });
    expect(executed).toEqual([]);
    await built.gateway.callModel({
      modelName: connector.modelName,
      expectedIdentity: connector.identity,
      arguments: {},
      subjectId: "agent:test",
    });
    expect(executed).toEqual(["interaction/browser_open"]);
  });

  test("distinct tools sharing a path get identity-suffixed paths and keep their own routes", async () => {
    const executed: string[] = [];
    const one = tool("docs", "one", { codemodePath: ["docs", "search"] }, executed);
    const two = tool("docs", "two", { codemodePath: ["docs", "search"] }, executed);
    const forward = build([one, two]);
    const reverse = build([two, one]);
    const pathsOf = (built: ReturnType<typeof build>) =>
      Object.fromEntries(
        built.catalog.entries.map((entry) => [
          entry.identity.toolName,
          entry.codemodePath.join("."),
        ]),
      );
    expect(pathsOf(forward)).toEqual({
      one: "docs.search",
      two: expect.stringMatching(/^docs\.search_[0-9a-f]{10}$/u),
    });
    // Listing order never changes which tool gets which path.
    expect(pathsOf(reverse)).toEqual(pathsOf(forward));
    expect(forward.warnings).toMatchObject([
      { code: "path_disambiguated", toolName: "two", path: "docs.search" },
    ]);
    await callByIdentity(forward, two.identity);
    await callByIdentity(forward, one.identity);
    expect(executed).toEqual(["docs/two", "docs/one"]);
  });

  test("a path that is already a disambiguated name still finds a free path", () => {
    const plain = tool("docs", "search", { codemodePath: ["docs", "search"] });
    const second = tool("docs", "search2", { codemodePath: ["docs", "search"] });
    const firstBuild = build([plain, second]);
    const taken = firstBuild.catalog.entries[1]!.codemodePath;
    // A third tool explicitly asking for the second one's resolved path.
    const third = tool("docs", "search3", { codemodePath: [...taken] });
    const built = build([plain, second, third]);
    const paths = built.catalog.entries.map((entry) => entry.codemodePath.join("."));
    expect(new Set(paths).size).toBe(3);
  });

  test("one invalid tool definition leaves only that tool out", () => {
    const built = build([
      tool("docs", "search"),
      tool("docs", "titled", { title: "" }),
      tool("docs", "huge", { description: "x".repeat(40_000) }),
      tool("docs", "digest", { approvalAuthorityDigest: "not-a-digest" }),
      tool("docs.bad", "server"),
      tool("docs", "fetch"),
    ]);
    expect(built.catalog.entries.map((entry) => entry.identity.toolName)).toEqual([
      "search",
      "fetch",
    ]);
    expect(built.warnings.map((warning) => [warning.code, warning.toolName])).toEqual([
      ["invalid_definition", "titled"],
      ["invalid_definition", "huge"],
      ["invalid_definition", "digest"],
      ["invalid_definition", "server"],
    ]);
    // Reasons name fields, never their values.
    expect(built.warnings[1]!.reason).toBe("invalid fields: description");
    expect(JSON.stringify(built.warnings)).not.toContain("xxxx");
  });
});
