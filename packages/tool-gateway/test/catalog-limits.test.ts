import { describe, expect, test } from "bun:test";
import {
  ATTEMPT_TOOL_CATALOG_MAX_BYTES,
  ATTEMPT_TOOL_CATALOG_MAX_ENTRIES,
} from "@opengeni/contracts";
import {
  createWorkspaceToolGateway,
  type ToolGatewayCatalogWarning,
  type ToolGatewayDefinition,
} from "../src";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
};

function tool(
  serverId: string,
  toolName: string,
  overrides: Partial<ToolGatewayDefinition> = {},
): ToolGatewayDefinition {
  return {
    identity: { serverId, toolName },
    modelName: `${serverId}__${toolName}`,
    codemodePath: [serverId, toolName],
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    source: "mcp",
    approval: "none",
    execute: () => ({ content: [{ type: "text", text: toolName }] }),
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

describe("catalog-wide limits leave tools out instead of failing the catalog", () => {
  test("more tools than the entry limit: the catalog keeps the limit, built-in tools first", () => {
    // Before: ToolGatewayCatalog.parse rejected the whole catalog (entries max 4096).
    const connector = Array.from({ length: ATTEMPT_TOOL_CATALOG_MAX_ENTRIES }, (_, index) =>
      tool("big", `tool_${index}`),
    );
    const builtIn = tool("interaction", "browser_open", { source: "interaction" });
    const built = build([...connector, builtIn]);
    expect(built.catalog.entries).toHaveLength(ATTEMPT_TOOL_CATALOG_MAX_ENTRIES);
    expect(built.catalog.entries.at(-1)!.identity).toEqual(builtIn.identity);
    // Kept by stable id: the connector tool with the last name is left out.
    expect(built.warnings).toEqual([
      {
        code: "catalog_entry_limit",
        serverId: "big",
        toolName: "tool_999",
        modelName: "big__tool_999",
      },
    ]);
    // The same tools in another order give the same catalog.
    const reordered = build([builtIn, ...[...connector].reverse()]);
    expect(reordered.catalog.entries.map((entry) => entry.identity.toolName).sort()).toEqual(
      built.catalog.entries.map((entry) => entry.identity.toolName).sort(),
    );
  });

  test("more bytes than the 16 MB limit: later connector tools are left out", async () => {
    // Before: assertToolGatewayCatalogSize threw ToolGatewayCatalogTooLargeError.
    const bulky = "x".repeat(480 * 1024);
    const count = Math.ceil(ATTEMPT_TOOL_CATALOG_MAX_BYTES / bulky.length) + 2;
    const definitions = Array.from({ length: count }, (_, index) =>
      tool("bulky", `tool_${index}`, {
        inputSchema: { type: "object", description: bulky, additionalProperties: true },
      }),
    );
    const built = build([tool("files", "read", { source: "files" }), ...definitions]);
    const bytes = Buffer.byteLength(JSON.stringify(built.catalog));
    expect(bytes).toBeLessThanOrEqual(ATTEMPT_TOOL_CATALOG_MAX_BYTES);
    expect(built.catalog.entries[0]!.identity).toEqual({ serverId: "files", toolName: "read" });
    const left = built.warnings.filter((warning) => warning.code === "catalog_byte_limit");
    expect(left.length).toBeGreaterThan(0);
    expect(built.catalog.entries.length + left.length).toBe(count + 1);
    // The tools left out are the ones with the last names, whatever the listing order.
    const byName = definitions.map((d) => d.identity.toolName).sort();
    expect(left.map((warning) => warning.toolName).sort()).toEqual(
      byName.slice(byName.length - left.length),
    );
    // A kept tool still runs; a left-out one is not found.
    const kept = built.catalog.entries.find((entry) => entry.identity.toolName === byName[0])!;
    expect(
      await built.gateway.callModel({
        modelName: kept.modelName,
        arguments: {},
        subjectId: "agent:test",
      }),
    ).toMatchObject({ content: [{ type: "text", text: kept.identity.toolName }] });
    await expect(
      built.gateway.callModel({
        modelName: left[0]!.modelName,
        arguments: {},
        subjectId: "agent:test",
      }),
    ).rejects.toMatchObject({ name: "ToolGatewayToolNotFoundError" });
  });

  test("a catalog within the limits is unchanged and warning-free", () => {
    const built = build([tool("a", "one"), tool("a", "two")]);
    expect(built.catalog.entries.map((entry) => entry.identity.toolName)).toEqual(["one", "two"]);
    expect(built.warnings).toEqual([]);
  });
});
