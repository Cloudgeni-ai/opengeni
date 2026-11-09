import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  allAgentCapabilities,
  type FirstPartyMcpToolName,
  type Permission,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
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
  "secret_search",
  "secret_save",
  "interaction_request_human",
  "admin_actions_search",
  "admin_action_call",
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
    // App actions run as the person, with no ceiling permission to miss.
    const appActions: readonly string[] = ["admin_actions_search", "admin_action_call"];
    for (const tool of PROMPT_NAMED_TOOLS.filter((name) => !appActions.includes(name)))
      expect(view.unavailable).toContain(tool);
    for (const tool of appActions) expect(view.unavailable).not.toContain(tool);
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
    expect(composed).toContain(
      "Once its schema is in context, call the tool by name or through `tool_invoke`",
    );
    expect(composed).toContain("`generate_image` is a runtime tool");
    expect(composed).toContain("Use `command_input` only to send input where supported");
  });

  test("an exhausted nesting depth proves session_create absent, as the MCP server hides it", () => {
    const selection = { selectedFirstPartyTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS] };
    const baseline = deriveAgentPromptToolAvailability(selection).unavailable;
    expect(baseline).not.toContain("session_create");
    for (const [depth, max] of [
      [0, 0],
      [2, 2],
      [3, 2],
    ] as const) {
      const view = deriveAgentPromptToolAvailability({
        ...selection,
        nestedAgentDepth: depth,
        effectiveMaxNestedAgentDepth: max,
      });
      expect(view.unavailable).toEqual([...baseline, "session_create"].sort());
      expect(view.childSessionsImpossible).toBe(true);
    }
    for (const depths of [
      { nestedAgentDepth: 0, effectiveMaxNestedAgentDepth: 1 },
      { nestedAgentDepth: 1, effectiveMaxNestedAgentDepth: 2 },
      { nestedAgentDepth: 5 },
      { effectiveMaxNestedAgentDepth: 0 },
      {},
    ]) {
      const view = deriveAgentPromptToolAvailability({ ...selection, ...depths });
      expect(view.unavailable).not.toContain("session_create");
      expect(view).not.toHaveProperty("childSessionsImpossible");
    }
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
    expect(composed).toContain("An active goal continues on its own");
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

  test("without session_create, delegation judgment drops and child integration remains", () => {
    const baseline = compose();
    // A turn without session_create (for example a scheduled turn with a
    // narrower selection) may still own children: integration rules stay.
    const composed = compose({ unavailable: ["session_create"] });
    for (const removed of [
      "Create a child worker only for a concrete, bounded subtask",
      "Before spawning, decide what output you need",
    ]) {
      expect(baseline).toContain(removed);
      expect(composed).not.toContain(removed);
    }
    for (const kept of [
      "# Session coordination",
      "When you are a child session, your final answer is delivered automatically to your parent session.",
      "If the user asks to create, inspect, continue, pause, resume, steer, rename, or otherwise manage a session",
      "Do not repurpose or direct an unrelated existing session unless the user explicitly asks. If no matching session tool is available on this turn, handle what you can in this session and report any required delegation that is unavailable instead of inventing an API.",
      "When supervising work, an accepted message, queued status, or changing timestamp is not proof of execution.",
      "After Send or Steer, use session_message_status",
      "After spawning, keep each child id and event cursor.",
      "Do not present delegated work as incorporated until you have consumed the completed result.",
      "`child_requires_action`",
      "For a short wait on a child or peer session inside the current turn",
    ]) {
      expect(composed).toContain(kept);
    }
    expect(composed.length).toBeLessThan(baseline.length);
  });

  test("a session that can never have children also drops child integration", () => {
    const withoutSpawn = compose({ unavailable: ["session_create"] });
    const leaf = compose({ unavailable: ["session_create"], childSessionsImpossible: true });
    for (const removed of [
      "After spawning, keep each child id and event cursor.",
      "call `wait_for_input` right after spawning",
      "Do not present delegated work as incorporated until you have consumed the completed result.",
      "`child_requires_action`",
    ]) {
      expect(withoutSpawn).toContain(removed);
      expect(leaf).not.toContain(removed);
    }
    expect(leaf).toContain(
      "When you are a child session, your final answer is delivered automatically to your parent session.",
    );
    expect(leaf).toContain("For a short wait on a child or peer session inside the current turn");
    // The fact alone, with session_create still available, changes nothing
    // the derivation can produce; it is only set together with the proof.
    expect(
      deriveAgentPromptToolAvailability({
        selectedFirstPartyTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
        nestedAgentDepth: 1,
        effectiveMaxNestedAgentDepth: 1,
      }),
    ).toMatchObject({ childSessionsImpossible: true });
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

  // A setting that blocks a tool is changed in the chat through an app action,
  // confirmed there, instead of described (staging session 12f7f50d).
  test("a blocking setting is offered as an in-chat app action while admin_action_call may exist", () => {
    const changed =
      "Show its setup card. If an app action makes the change, make it with `admin_actions_search` and `admin_action_call`; the user confirms it in the chat unless the session has full access. If neither applies, give the exact next step.";
    const legacy =
      "Show its setup card, or give the exact next step when there is no card. Continue once it is fixed.";
    expect(compose()).toContain(changed);
    expect(compose()).toContain("integration, permission, setting or secret");
    for (const tool of ["admin_actions_search", "admin_action_call"] as const) {
      const absent = compose({ unavailable: [tool] });
      expect(absent).not.toContain(changed);
      expect(absent).toContain(legacy);
    }
    const noAdmin = composeModularAgentInstructions({
      capabilities: { ...allAgentCapabilities(), workspaceAdmin: false },
      renderer: "opengeni",
      identity: DEFAULT_AGENT_IDENTITY,
      resources: ALL_RESOURCES,
      codemode: undefined,
    }).composed;
    expect(noAdmin).not.toContain(changed);
    expect(noAdmin).toContain(legacy);
  });

  test("absent wait_for_input keeps only tool-neutral waiting guidance and compaction", () => {
    const composed = compose({ unavailable: ["wait_for_input"] });
    expect(composed).toContain(
      "## Waiting\n\nWhen monitoring needs timed checks, use the available recurring-monitoring or session-wait mechanism at a meaningful cadence. Do not poll by ritual.\n\n## Compaction",
    );
    expect(names(composed, "wait_for_input")).toBe(false);
    expect(composed).not.toContain("an out-of-turn wait is available");
    expect(composed).toContain("## Compaction");
    expect(composed).toContain(
      "Keep the user informed while you work. End the turn with a self-contained final response.",
    );
    expect(composed).toContain("## Background commands");
    expect(composed).toContain(
      "Pending Codemode calls need the current live attempt; keep observing them with `command_wait`/`command_read` instead of ending the turn.",
    );
  });

  // How a wait behaves (when to call it, `reply`, the deadline, the minimum,
  // no preliminary wait, sleeping instead) is the wait_for_input
  // description's; the prompt keeps only when to end a turn on one.
  test("the prompt does not repeat what the wait_for_input description says", () => {
    const composed = compose();
    for (const repeated of [
      "reuse that reason and keep its deadline",
      "remaining time is below the tool's minimum",
      "has not consumed immediate machine input",
      "No short execution wait or preliminary status recheck is required",
      "Avoid holding execution open with long sleeps",
      "Do not use `wait_for_input` for work you can still advance",
      "put the whole answer in its `reply` argument",
      "This does not relax live-attempt requirements",
    ]) {
      expect(composed).not.toContain(repeated);
    }
    expect(composed).toContain(
      "## Waiting\n\nOutside a question or status turn, do not end with only a status reply",
    );
    expect(composed).toContain(
      "an explicit user, task or Skill cadence requires an update. When monitoring needs timed checks, use the available recurring-monitoring or session-wait mechanism at a meaningful cadence. Do not poll by ritual.\n\n## Compaction",
    );
    // The reply contract stays in the final-answer rule.
    expect(composed).toContain(
      "A turn that ends with `wait_for_input` has no final response: its `reply` carries any answer",
    );
    // Codemode's live-attempt rule renders with compute, in Background commands.
    expect(composed).toContain(
      "Exception: pending Codemode calls need the current live attempt; keep observing them with `command_wait`/`command_read` instead of ending the turn.",
    );
  });

  test("without automations or child sessions, Waiting names neither", () => {
    const composed = composeModularAgentInstructions({
      capabilities: { ...allAgentCapabilities(), schedules: false, subagents: false },
      renderer: "opengeni",
      identity: DEFAULT_AGENT_IDENTITY,
      resources: ALL_RESOURCES,
      codemode: undefined,
    }).composed;
    expect(composed).toContain("## Waiting\n\nOutside a question or status turn");
    expect(composed).not.toContain("recurring-monitoring or session-wait mechanism");
    const waiting = composed.slice(
      composed.indexOf("## Waiting"),
      composed.indexOf("## Compaction"),
    );
    for (const absent of ["session_", "child", "goal", "Steer", "Codemode"]) {
      expect(waiting).not.toContain(absent);
    }
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
      agentPromptResources: ALL_RESOURCES,
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

  test("with every prompt-named tool absent, no instruction layer names one", () => {
    // The attempt directives are not pruned (see PROMPT_CHANGELOG); the
    // Codemode directive names no prompt-named tool, so nothing survives.
    const inspection = inspectPersistentAgentInstructions(settings, {
      agentConfig,
      agentPromptResources: ALL_RESOURCES,
      codemodeAvailable: true,
      agentPromptToolAvailability: { unavailable: [...PROMPT_NAMED_TOOLS] },
    });
    const layer = (id: string) => inspection.layers.find((entry) => entry.id === id)?.content ?? "";
    expect(layer("codemode")).not.toBe("");
    expect(PROMPT_NAMED_TOOLS.filter((tool) => names(layer("operational_contract"), tool))).toEqual(
      [],
    );
    expect(PROMPT_NAMED_TOOLS.filter((tool) => names(inspection.composed, tool))).toEqual([]);
  });
});
