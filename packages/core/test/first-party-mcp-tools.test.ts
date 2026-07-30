import { describe, expect, test } from "bun:test";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS } from "@opengeni/contracts";
import { resolveFirstPartyMcpToolsForCreate } from "../src/domain/sessions";

describe("first-party MCP tool selection at session creation", () => {
  test("top-level omission stores the minimal-default sentinel", () => {
    expect(resolveFirstPartyMcpToolsForCreate(undefined, undefined)).toBeNull();
  });

  test("explicit empty remains authoritative", () => {
    expect(resolveFirstPartyMcpToolsForCreate([], undefined)).toEqual([]);
  });

  test("a child omission inherits the parent's exact effective selection", () => {
    expect(resolveFirstPartyMcpToolsForCreate(undefined, ["set_session_title"])).toEqual([
      "set_session_title",
    ]);
    expect(resolveFirstPartyMcpToolsForCreate(undefined, [])).toEqual([]);
    expect(resolveFirstPartyMcpToolsForCreate(undefined, null)).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_TOOLS,
    ]);
  });

  test("an explicit child selection replaces inherited visibility", () => {
    expect(resolveFirstPartyMcpToolsForCreate(["session_create"], ["set_session_title"])).toEqual([
      "session_create",
    ]);
  });
});
