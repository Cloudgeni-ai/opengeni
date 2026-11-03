import { describe, expect, test } from "bun:test";
import {
  isProviderToolName,
  knownToolNameFor,
  providerToolNameAlias,
  providerValidCallName,
} from "../src/provider-tool-names";

const QUERY = "mcp_0123456789abcdef01234567__query_pelicans";
const GOAL_SET = "opengeni__goal_set";
const KNOWN = [GOAL_SET, QUERY, "opengeni__goal_complete"];

describe("model-written tool names", () => {
  test("a dotted server.tool name maps to the one authorized tool it denotes", () => {
    expect(knownToolNameFor("opengeni.goal_set", KNOWN)).toBe(GOAL_SET);
    // The published name of an aliased MCP tool.
    expect(knownToolNameFor("query.pelicans", KNOWN)).toBe(QUERY);
    expect(knownToolNameFor("other.unknown_tool", KNOWN)).toBeNull();
    // Only the leaf after the last `__` counts.
    expect(knownToolNameFor("github.create_issue", ["github_enterprise__create_issue"])).toBeNull();
    // Any other invalid character is never guessed from.
    expect(knownToolNameFor("opengeni goal_set", KNOWN)).toBeNull();
  });

  test("a call keeps a valid or known name, else gets the tool it denotes, else its alias", () => {
    expect(providerValidCallName(GOAL_SET, KNOWN)).toBe(GOAL_SET);
    expect(providerValidCallName("opengeni.goal_set", KNOWN)).toBe(GOAL_SET);
    const alias = providerValidCallName("other.unknown tool", KNOWN);
    expect(alias).toBe(providerToolNameAlias("other.unknown tool"));
    expect(isProviderToolName(alias)).toBe(true);
    // Deterministic, and two different names never share an alias.
    expect(providerValidCallName("other.unknown tool", [])).toBe(alias);
    expect(providerToolNameAlias("other.unknown tools")).not.toBe(alias);
    expect(isProviderToolName(providerToolNameAlias("x".repeat(200)))).toBe(true);
  });
});
