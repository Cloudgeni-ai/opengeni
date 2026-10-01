import { describe, expect, test } from "bun:test";
import {
  AGENT_CAPABILITY_IDS,
  AGENT_FUNCTION_TOOL_CAPABILITIES,
  AGENT_INSTRUCTIONS_MAX_CHARACTERS,
  AGENT_SKILL_MANAGE_TOOL_NAMES,
  AGENT_SKILL_READ_TOOL_NAMES,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_ATTEMPT_TOOL_FAMILY_NAMES,
  FIRST_PARTY_FUNCTION_TOOL_FAMILY_NAMES,
  FIRST_PARTY_MCP_TOOL_CAPABILITIES,
  FIRST_PARTY_MCP_TOOL_NAMES,
  SESSION_INSTRUCTIONS_MAX_CHARACTERS,
  firstPartyMcpToolsForCapability,
} from "../src/index";

const RUNTIME_TOOLS = ["set_session_title", "wait_for_input", "command_wait", "command_read"];

describe("agent capability registry", () => {
  test("every first-party MCP tool maps to exactly one known owner", () => {
    const mapped = Object.keys(FIRST_PARTY_MCP_TOOL_CAPABILITIES).sort();
    // Fails on any new unmapped catalog name and on any stale mapped name.
    expect(mapped).toEqual([...FIRST_PARTY_MCP_TOOL_NAMES].sort());
    expect(new Set(FIRST_PARTY_MCP_TOOL_NAMES).size).toBe(FIRST_PARTY_MCP_TOOL_NAMES.length);
    const owners = new Set<string>([...AGENT_CAPABILITY_IDS, "runtime"]);
    for (const [tool, owner] of Object.entries(FIRST_PARTY_MCP_TOOL_CAPABILITIES)) {
      expect({ tool, known: owners.has(owner) }).toEqual({ tool, known: true });
    }
  });

  test("runtime mechanics are exactly the justified set", () => {
    const runtime = Object.entries(FIRST_PARTY_MCP_TOOL_CAPABILITIES)
      .filter(([, owner]) => owner === "runtime")
      .map(([tool]) => tool)
      .sort();
    expect(runtime).toEqual([...RUNTIME_TOOLS].sort());
  });

  test("families land on their capability", () => {
    const owner = FIRST_PARTY_MCP_TOOL_CAPABILITIES;
    for (const tool of FIRST_PARTY_MCP_TOOL_NAMES) {
      if (tool.startsWith("goal_")) expect(owner[tool]).toBe("goals");
      if (/^(scheduled_task)/.test(tool)) expect(owner[tool]).toBe("schedules");
      if (/^(browser_|computer_|interaction_)/.test(tool)) expect(owner[tool]).toBe("browser");
      if (/^(artifacts_|editable_artifact_)/.test(tool)) expect(owner[tool]).toBe("artifacts");
      if (/^(slack_bot_|social_|x_|reddit_|fiken_|atlassian_|github_)/.test(tool)) {
        expect(owner[tool]).toBe("workspaceConnectors");
      }
      if (
        /^(knowledge_|task_note|instruction_policy_|preference_|company_profile_|remember|memory_|work_claim_)/.test(
          tool,
        )
      ) {
        expect(owner[tool]).toBe("knowledge");
      }
      if (/^(variable_set_|environment_|capability_|connected_machine_|rig_|project_)/.test(tool)) {
        expect(owner[tool]).toBe("workspaceAdmin");
      }
      if (/^(sessions_list|session_(?!set_project))/.test(tool)) {
        expect(owner[tool]).toBe("subagents");
      }
    }
    expect(owner.sandbox_file_publish).toBe("artifacts");
    expect(owner.custom_mcp_setup_request).toBe("workspaceAdmin");
    for (const tool of [
      "sandboxes_list",
      "sandbox_attach",
      "sandbox_swap",
      "run_on",
      "sandbox_provision",
    ] as const) {
      expect(owner[tool]).toBe("workspaceAdmin");
    }
    expect(owner.set_other_session_title).toBe("subagents");
  });

  test("every capability with MCP tools has at least one default-selected tool or is connector-only", () => {
    const defaults = new Set(DEFAULT_FIRST_PARTY_MCP_TOOLS);
    for (const id of AGENT_CAPABILITY_IDS) {
      const tools = firstPartyMcpToolsForCapability(id);
      if (tools.length === 0) continue;
      expect({ id, hasDefault: tools.some((tool) => defaults.has(tool)) }).toEqual({
        id,
        hasDefault: true,
      });
    }
  });

  test("non-MCP first-party function tools are all classified", () => {
    const known = new Set(Object.keys(AGENT_FUNCTION_TOOL_CAPABILITIES));
    // Provider-hosted call item names (web_search_call, ...) and the in-process
    // screenshot helper are event names, not model-visible function tools.
    const eventOnly = new Set([
      "computer_screenshot",
      "web_search_call",
      "image_generation_call",
      "code_interpreter_call",
      "file_search_call",
      "computer_call",
      "local_shell_call",
      "shell_call",
      "apply_patch_call",
      "files_get_download_url",
    ]);
    for (const name of [
      ...FIRST_PARTY_FUNCTION_TOOL_FAMILY_NAMES,
      ...FIRST_PARTY_ATTEMPT_TOOL_FAMILY_NAMES,
    ]) {
      if (eventOnly.has(name)) continue;
      expect({ name, classified: known.has(name) }).toEqual({ name, classified: true });
    }
    expect(
      [...AGENT_SKILL_READ_TOOL_NAMES, ...AGENT_SKILL_MANAGE_TOOL_NAMES].sort() as string[],
    ).toEqual(
      Object.entries(AGENT_FUNCTION_TOOL_CAPABILITIES)
        .filter(([, owner]) => owner === "skills")
        .map(([name]) => name)
        .sort(),
    );
  });

  test("instructions alias keeps the session instruction bound", () => {
    expect(AGENT_INSTRUCTIONS_MAX_CHARACTERS).toBe(SESSION_INSTRUCTIONS_MAX_CHARACTERS);
  });
});
