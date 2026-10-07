import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  allAgentCapabilities,
  type FirstPartyMcpToolName,
  type Permission,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  DEFAULT_AGENT_IDENTITY,
  composeModularAgentInstructions,
  deriveAgentPromptToolAvailability,
  inspectPersistentAgentInstructions,
  type AgentPromptToolAvailability,
} from "../../src/index";
import {
  KNOWLEDGE_GUIDANCE,
  knowledgeGuidance,
} from "../../src/agent-instructions/modules/knowledge";
import { ALL_RESOURCES } from "./prompt-sentences";

/** Every first-party tool a modular prompt clause names. */
const PROMPT_NAMED_TOOLS = [
  "goal_set",
  "goal_update",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "task_note_save",
  "knowledge_search",
  "knowledge_get",
  "knowledge_save",
  "knowledge_prepare_save",
  "knowledge_retain_message",
  "knowledge_retain_file",
  "instruction_policy_get",
  "instruction_policy_save",
  "variable_set_list",
  "capability_catalog_search",
  "capability_authorization_request",
  "custom_mcp_setup_request",
  "session_events",
  "session_send_message",
  "session_wait",
  "session_get",
  "wait_for_input",
  "command_read",
  "command_wait",
  "sandbox_file_publish",
  "rig_propose_change",
  "rig_get",
] as const satisfies readonly FirstPartyMcpToolName[];

function compose(toolAvailability?: AgentPromptToolAvailability) {
  return composeModularAgentInstructions({
    capabilities: allAgentCapabilities(),
    renderer: "opengeni",
    identity: DEFAULT_AGENT_IDENTITY,
    resources: ALL_RESOURCES,
    codemode: undefined,
    ...(toolAvailability ? { toolAvailability } : {}),
  }).composed;
}

/** Matches a tool name, including its `opengeni__` prefixed form, but not longer names. */
function names(text: string, tool: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9_]|__)${tool}(?![a-z0-9_])`, "u").test(text);
}

function without(...tools: FirstPartyMcpToolName[]): FirstPartyMcpToolName[] {
  return DEFAULT_FIRST_PARTY_MCP_TOOLS.filter((tool) => !tools.includes(tool));
}

function withoutPermissions(...permissions: Permission[]): Permission[] {
  return DEFAULT_FIRST_PARTY_MCP_PERMISSIONS.filter(
    (permission) => !permissions.includes(permission),
  );
}

describe("deriveAgentPromptToolAvailability", () => {
  test("default selection and ceiling prove no prompt-named tool absent", () => {
    const view = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      firstPartyPermissions: null,
    });
    expect(PROMPT_NAMED_TOOLS.filter((tool) => view.unavailable.includes(tool))).toEqual([]);
    expect(compose(view)).toBe(compose());
  });

  test("a narrowed selection proves exactly the omitted tools absent", () => {
    const view = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: without("goal_complete", "knowledge_save"),
    });
    expect(view.unavailable).toContain("goal_complete");
    expect(view.unavailable).toContain("knowledge_save");
    expect(view.unavailable).not.toContain("goal_pause");
    expect(view.unavailable).not.toContain("knowledge_search");
  });

  test("a missing permission ceiling entry proves its tools absent", () => {
    const view = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      firstPartyPermissions: withoutPermissions("goals:manage", "files:read"),
    });
    for (const tool of ["goal_set", "goal_update", "goal_complete", "goal_pause", "goal_resume"]) {
      expect(view.unavailable).toContain(tool);
    }
    // knowledge_retain_file needs documents:search and files:read.
    expect(view.unavailable).toContain("knowledge_retain_file");
    expect(view.unavailable).not.toContain("knowledge_save");
    expect(view.unavailable).not.toContain("wait_for_input");
  });

  test("an explicit empty ceiling proves every first-party tool absent", () => {
    const view = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      firstPartyPermissions: [],
    });
    for (const tool of PROMPT_NAMED_TOOLS) expect(view.unavailable).toContain(tool);
  });

  test("a ceiling that might still be satisfied never proves absence", () => {
    // Legacy grants treat workspace:admin as a superset of the exact permission.
    const admin = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: ["goal_complete", "wait_for_input"],
      firstPartyPermissions: ["workspace:admin"],
    });
    expect(admin.unavailable).not.toContain("goal_complete");
    expect(admin.unavailable).not.toContain("wait_for_input");
    // anyOf: either scheduled-task permission admits the list tool.
    const anyOf = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: ["scheduled_tasks_list", "scheduled_tasks_create"],
      firstPartyPermissions: ["scheduled_tasks:run"],
    });
    expect(anyOf.unavailable).not.toContain("scheduled_tasks_list");
    expect(anyOf.unavailable).toContain("scheduled_tasks_create");
  });

  test("only first-party names can be proven absent; deferred and external tools stay unknown", () => {
    const view = deriveAgentPromptToolAvailability({
      selectedFirstPartyTools: [],
      firstPartyPermissions: [],
    });
    for (const name of [
      "tool_search",
      "tool_list",
      "generate_image",
      "generate_video",
      "skill_read",
      "command_input",
      "exec_command",
      "linear__save_issue",
    ]) {
      expect(view.unavailable).not.toContain(name);
    }
    const composed = compose(view);
    expect(composed).toContain("## Tool discovery");
    expect(composed).toContain("use `tool_search` for one focused capability");
    expect(composed).toContain("`generate_image` is a runtime tool");
    expect(composed).toContain("Use `command_input` only to send input where supported");
  });

  test("the view is sorted and deterministic, so an unchanged selection keeps the prefix", () => {
    const input = {
      selectedFirstPartyTools: without("session_events", "knowledge_save"),
      firstPartyPermissions: withoutPermissions("variable-sets:list"),
    };
    const first = deriveAgentPromptToolAvailability(input);
    const reordered = deriveAgentPromptToolAvailability({
      ...input,
      selectedFirstPartyTools: [...input.selectedFirstPartyTools].reverse(),
    });
    expect(reordered).toEqual(first);
    expect([...first.unavailable].sort()).toEqual([...first.unavailable]);
    expect(compose(reordered)).toBe(compose(first));
  });
});

describe("modular prompt: tool-specific clauses", () => {
  test("unknown availability and an empty proof are byte-identical to no input", () => {
    const baseline = compose();
    expect(compose({ unavailable: [] })).toBe(baseline);
    expect(compose({ unavailable: ["social_post_reply", "fiken_invoice_get"] })).toBe(baseline);
  });

  test("knowledge guidance with every tool available equals the shared legacy constant", () => {
    expect(knowledgeGuidance(() => true)).toEqual(KNOWLEDGE_GUIDANCE);
  });

  for (const tool of PROMPT_NAMED_TOOLS) {
    test(`a proven-absent ${tool} is never named`, () => {
      expect(names(compose(), tool)).toBe(true);
      const composed = compose({ unavailable: [tool] });
      expect(names(composed, tool)).toBe(false);
    });
  }

  test("no prompt-named tool survives when every one is proven absent", () => {
    const composed = compose({ unavailable: [...PROMPT_NAMED_TOOLS] });
    expect(PROMPT_NAMED_TOOLS.filter((tool) => names(composed, tool))).toEqual([]);
  });

  test("absent goal tools keep goal ownership and a truthful completion rule", () => {
    const composed = compose({
      unavailable: ["goal_set", "goal_update", "goal_complete", "goal_pause", "goal_resume"],
    });
    expect(composed).toContain("# Goals");
    expect(composed).toContain("If the session has a goal, you own it: keep working toward it.");
    expect(composed).toContain(
      "Saying or verifying that the work is done does not complete the goal, and this session has no goal-completion tool: report the outcome instead of claiming the goal is complete.",
    );
    expect(composed).not.toContain("opengeni__goal_");
    // Goal-state guidance that names no tool remains.
    expect(composed).toContain("an active goal continues on its own");
    expect(composed).toContain("A `goal.completed` event records goal state");
  });

  test("a partial goal family names only what remains", () => {
    const composed = compose({ unavailable: ["goal_set", "goal_resume"] });
    expect(composed).toContain(
      "If the session has a goal, you own it: keep working until you call opengeni__goal_complete with concrete evidence or opengeni__goal_pause with a rationale; revise it with opengeni__goal_update.",
    );
    expect(composed).toContain("Goal completion records short ledger proof");
    expect(composed).toContain("A definitive missing permission or required human decision");
  });

  test("knowledge_search allowed but knowledge_save absent keeps retrieval and policy", () => {
    const composed = compose({
      unavailable: ["knowledge_save", "knowledge_prepare_save", "knowledge_retain_message"],
    });
    expect(composed).toContain(
      "Use knowledge_search and knowledge_get before work that depends on prior decisions or requirements; skip unrelated searches.",
    );
    expect(composed).toContain("Follow the accepted learning modes and scope:");
    expect(composed).toContain("Learn from user corrections, adopted choices");
    expect(composed).toContain("Use knowledge_retain_file for useful supporting evidence");
    expect(composed).not.toContain("Before saving,");
    expect(composed).not.toContain("Save a separate finding");
  });

  test("knowledge_save allowed but knowledge_search absent keeps saving guidance", () => {
    const composed = compose({ unavailable: ["knowledge_search"] });
    expect(composed).toContain(
      "Use knowledge_get before work that depends on prior decisions or requirements.",
    );
    expect(composed).toContain("Save useful lasting findings with knowledge_save");
    expect(composed).toContain("Before saving, use knowledge_prepare_save");
  });

  test("absent wait_for_input drops the waiting mechanics and keeps compaction", () => {
    const composed = compose({ unavailable: ["wait_for_input"] });
    expect(composed).not.toContain("## Waiting");
    expect(composed).toContain("## Compaction");
    expect(composed).toContain(
      "Keep the user informed while work is underway, then end the turn with a self-contained final response.",
    );
    expect(composed).toContain("## Background commands");
    expect(composed).toContain(
      "Pending Codemode calls need the current live attempt; keep observing them with `command_wait`/`command_read` instead of ending the turn.",
    );
  });
});

describe("buildAgent instructions: tool availability", () => {
  const settings = testSettings();
  const agentConfig: ResolvedAgentConfig = {
    version: 1,
    from: "all",
    capabilities: allAgentCapabilities(),
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
  };

  test("the option reaches the modular composer and only the operational contract changes", () => {
    const options = {
      agentConfig,
      agentPromptResources: { ...ALL_RESOURCES, attachments: false },
      codemodeAvailable: true,
      workspaceGovernance: "GOVERNANCE",
      sessionInstructions: "SESSION",
    };
    const unknown = inspectPersistentAgentInstructions(settings, options);
    const narrowed = inspectPersistentAgentInstructions(settings, {
      ...options,
      agentPromptToolAvailability: deriveAgentPromptToolAvailability({
        selectedFirstPartyTools: without("knowledge_save", "goal_complete"),
      }),
    });
    expect(narrowed.composed).not.toBe(unknown.composed);
    expect(narrowed.composed).not.toContain("knowledge_save");
    const layer = (inspection: typeof unknown, id: string) =>
      inspection.layers.find((entry) => entry.id === id)?.content;
    for (const id of ["identity", "codemode", "workspace_governance", "session_instructions"]) {
      expect(layer(narrowed, id)).toBe(layer(unknown, id));
    }
    expect(layer(narrowed, "operational_contract")).not.toBe(
      layer(unknown, "operational_contract"),
    );
  });
});
