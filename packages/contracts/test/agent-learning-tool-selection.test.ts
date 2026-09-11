import { describe, expect, test } from "bun:test";
import { currentAgentLearningToolSelection, DEFAULT_FIRST_PARTY_MCP_TOOLS } from "../src";

describe("current Agent learning tool selection", () => {
  test("replaces the full legacy writer and retrieval bundle", () => {
    expect(
      currentAgentLearningToolSelection([
        "memory_search",
        "memory_save",
        "memory_correct",
        "instruction_policy_propose",
      ]),
    ).toEqual([
      "knowledge_search",
      "knowledge_get",
      "knowledge_browse",
      "knowledge_save",
      "knowledge_retain_file",
      "knowledge_retain_message",
      "instruction_policy_save",
      "instruction_policy_get",
    ]);
  });
  test("never turns an empty, create-only or correct-only selection into the full writer", () => {
    expect(currentAgentLearningToolSelection([])).toEqual([]);
    expect(currentAgentLearningToolSelection(["memory_save"])).toEqual([]);
    expect(currentAgentLearningToolSelection(["memory_correct"])).toEqual([]);
    expect(currentAgentLearningToolSelection(["memory_search"])).not.toContain("knowledge_save");
  });
  test("keeps only confirmation recovery from an old remember selection", () => {
    expect(currentAgentLearningToolSelection(["remember", "remember_confirm"])).toEqual([
      "remember_confirm",
    ]);
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).not.toContain("remember_confirm");
  });
  test("new defaults contain only the current learning surfaces", () => {
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).toContain("knowledge_save");
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).toContain("instruction_policy_save");
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).not.toContain("memory_save");
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).not.toContain("remember");
  });
});
