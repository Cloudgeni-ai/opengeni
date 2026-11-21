import { expect, test } from "bun:test";
import {
  FIRST_PARTY_MCP_TOOL_ALIASES,
  FIRST_PARTY_MCP_TOOL_ALIAS_NAMES,
} from "@opengeni/contracts";
import {
  firstPartyAliasModelToolName,
  mcpToolReferenceAliases,
  mcpToolReferenceMatches,
  type McpToolReference,
} from "../src/mcp-model-tool-name";

const reference = (registryId: string, toolName: string): McpToolReference => ({
  wireName: `${registryId}__${toolName}`,
  namespace: registryId,
  namespaceBase: registryId,
  registryId,
  toolName,
});

test("every hidden alias refers to its current first-party tool in tool_search names and Skill tool lists", () => {
  for (const alias of FIRST_PARTY_MCP_TOOL_ALIAS_NAMES) {
    const current = FIRST_PARTY_MCP_TOOL_ALIASES[alias];
    const tool = reference("opengeni", current);
    for (const name of [alias, `opengeni__${alias}`, `opengeni.${alias}`]) {
      expect(mcpToolReferenceMatches(tool, name)).toBe(true);
    }
    expect(firstPartyAliasModelToolName(alias)).toBe(`opengeni__${current}`);
    expect(firstPartyAliasModelToolName(`opengeni__${alias}`)).toBe(`opengeni__${current}`);
    expect(firstPartyAliasModelToolName(`other__${alias}`)).toBeUndefined();
    expect(mcpToolReferenceAliases(tool)).toEqual([alias]);
    // Another server's tool never answers to an Opengeni alias.
    expect(mcpToolReferenceMatches(reference("other", current), `other__${alias}`)).toBe(false);
  }
  expect(firstPartyAliasModelToolName("app_data_query")).toBeUndefined();
});
