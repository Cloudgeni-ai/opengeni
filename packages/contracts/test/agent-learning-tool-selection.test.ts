import { describe, expect, test } from "bun:test";
import { currentAgentLearningToolSelection, DEFAULT_FIRST_PARTY_MCP_TOOLS } from "../src";

describe("current Agent learning tool selection", () => {
  test("maps legacy text retrieval and writing without widening to source retention", () => {
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
  test("retired variable-set tools select their secret successors (AG-5)", () => {
    expect(
      currentAgentLearningToolSelection([
        "variable_set_list",
        "environment_list",
        "variable_set_get_variable",
        "environment_set_variable",
      ]),
    ).toEqual(["secret_search", "secret_get", "secret_save"]);
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).not.toContain("variable_set_list");
    expect(DEFAULT_FIRST_PARTY_MCP_TOOLS).toEqual(
      expect.arrayContaining([
        "secret_search",
        "secret_save",
        "secret_get",
        "secret_move",
        "secret_delete",
      ]),
    );
  });
});
