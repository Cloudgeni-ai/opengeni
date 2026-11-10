import { describe, expect, test } from "bun:test";
import {
  allAgentCapabilities,
  FIRST_PARTY_MCP_TOOL_NAMES,
  noneAgentCapabilities,
  type FirstPartyMcpToolName,
  type ResolvedAgentCapabilities,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  composeModularAgentInstructions,
  INSTRUCTION_PRECEDENCE,
  inspectPersistentAgentInstructions,
  NEUTRAL_AGENT_IDENTITY,
  type AgentPromptResources,
  type AgentPromptToolAvailability,
} from "../../src/index";
import type { AgentGuidance } from "@opengeni/contracts";
import { ALL_RESOURCES } from "./prompt-sentences";

const NO_COMPUTE: AgentPromptResources = {
  managedSandbox: false,
  connectedMachine: false,
  repositories: false,
  gitCredentials: false,
  skillsReadable: false,
};

/** An embedded "none" session: only its question, Skill-read and title tools, nothing deferred. */
function embeddedAvailability(): AgentPromptToolAvailability {
  const selected: readonly FirstPartyMcpToolName[] = [
    "request_human_input",
    "skill_read",
    "set_session_title",
  ];
  return {
    unavailable: FIRST_PARTY_MCP_TOOL_NAMES.filter((name) => !selected.includes(name)).sort(),
    toolSearchAbsent: true,
  };
}

function compose(
  capabilities: ResolvedAgentCapabilities,
  resources: AgentPromptResources,
  guidance?: AgentGuidance,
  toolAvailability?: AgentPromptToolAvailability,
) {
  return composeModularAgentInstructions({
    capabilities,
    renderer: "opengeni",
    identity: NEUTRAL_AGENT_IDENTITY,
    resources,
    ...(toolAvailability ? { toolAvailability } : {}),
    ...(guidance ? { guidance } : {}),
  });
}

function contract(result: ReturnType<typeof compose>) {
  return result.layers.find((layer) => layer.id === "operational_contract")!;
}

const DESTRUCTIVE_ACTIONS = `# Destructive Actions

Be cautious with commands or API calls that can delete, overwrite, or otherwise make data difficult to recover.

Before taking a destructive action:

- Make sure the action is clearly within the user's request.
- Resolve the exact targets with read-only checks when necessary.
- Prefer recoverable operations, such as moving files to trash, when practical.
- If the target or scope is unclear, stop and ask the user.

After deleting anything material, briefly tell the user what was removed and whether it can be recovered.`;

/** The complete lean contract of an embedded no-compute "none" session. */
const EMBEDDED_LEAN_CONTRACT = `${INSTRUCTION_PRECEDENCE}

# Working with the user

Match the user's tone and lead with the answer. Keep replies brief and in plain language, with only the formatting the content needs; you may format with GitHub-flavored Markdown. Mention tool names, technical details, or session mechanics only when they help the user. Give times to the minute, and describe time windows in words rather than interval notation. Answer a simple question from the fewest tool calls that establish it, and run independent tool calls in parallel. Do not introduce unsolicited warnings, disclaimers, approval flows, or safety/compliance checklists due to hypothetical risk.

## Acting for the user

A question, explanation, or status request does not authorize external writes, messages, or other changes unless the user also asks for one. Do not infer authorization for a materially different action than the user requested. Act without asking when the action is read-only or affects only the systems, data, and people the user placed in scope. Make informed assumptions within the user's intent and scope, and state an assumption when it would change the task beyond what the user specified. Ask only when the step is destructive, acts outside the workspace, needs authority the user has not given, or has no conventional default and the choice would materially change the result. If completion needs new authority or a meaningful expansion beyond the user's intent, stop and request direction rather than assuming permission. When the user asks a clarifying question or objects, answer with concrete evidence and reasoning rather than unsubstantiated deference. Tool approvals remain human-only.

${DESTRUCTIVE_ACTIONS}

# Runtime mechanics

## New messages while you work

When the user sends a new message while you work, decide whether it replaces the active request or adds to it, and handle it accordingly. Treat "thanks", "nice", and similar replies as acknowledgement, not approval of a next step.

## Compaction

When earlier context is compacted, continue from the supplied summary and durable session history without restarting, redoing completed work, or repeating what you already told the user. Summaries locate evidence; they do not prove current state, so recheck anything that may have changed before relying on it.`;

describe("lean guidance", () => {
  test("full and omitted guidance render the same bytes", () => {
    for (const [capabilities, resources] of [
      [allAgentCapabilities(), ALL_RESOURCES],
      [noneAgentCapabilities(), NO_COMPUTE],
    ] as const) {
      expect(compose(capabilities, resources, "full").composed).toBe(
        compose(capabilities, resources).composed,
      );
    }
  });

  test("an embedded no-compute session gets exactly the lean contract", () => {
    const lean = compose(noneAgentCapabilities(), NO_COMPUTE, "lean", embeddedAvailability());
    const full = compose(noneAgentCapabilities(), NO_COMPUTE, undefined, embeddedAvailability());
    expect(contract(lean).content).toBe(EMBEDDED_LEAN_CONTRACT);
    expect(contract(lean).modules!.map((module) => module.id)).toEqual([
      "base_behavior",
      "runtime_mechanics",
    ]);
    // The identity layer is untouched, and the general guidance shrinks by more than half.
    expect(lean.layers[0]).toEqual(full.layers[0]);
    expect(lean.composed.length * 2).toBeLessThan(full.composed.length);
    expect(full.composed).toContain(DESTRUCTIVE_ACTIONS);
  });

  test("leaves out guidance for long-running autonomous work", () => {
    const lean = compose(allAgentCapabilities(), ALL_RESOURCES, "lean").composed;
    for (const heading of [
      "# Personality",
      "## Match effort to the request",
      "## Progress updates",
      "## Final answer",
      "## Autonomy and persistence",
      "# Rules for getting work done",
    ]) {
      expect(lean).not.toContain(heading);
    }
    expect(lean).not.toContain("A terminal condition such as");
    expect(lean).not.toContain("Decide the design before building it.");
    expect(lean).not.toContain("Match verification to the full requested scope.");
  });

  test("modules and every other layer are the same as with full guidance", () => {
    const instructions = {
      agentInstructions: "Only discuss bookings.",
      sessionInstructions: "Answer in Norwegian.",
      workspaceGovernance: "Never refund more than 100 EUR.",
    };
    const full = composeModularAgentInstructions({
      capabilities: allAgentCapabilities(),
      renderer: "opengeni",
      identity: "You are Acme's booking assistant.",
      resources: ALL_RESOURCES,
      ...instructions,
    });
    const lean = composeModularAgentInstructions({
      capabilities: allAgentCapabilities(),
      renderer: "opengeni",
      identity: "You are Acme's booking assistant.",
      resources: ALL_RESOURCES,
      guidance: "lean",
      ...instructions,
    });
    const withoutContract = (result: typeof full) =>
      result.layers.filter((layer) => layer.id !== "operational_contract");
    expect(withoutContract(lean)).toEqual(withoutContract(full));
    const fullModules = contract(full).modules!;
    const leanModules = contract(lean).modules!;
    expect(leanModules.map((module) => module.id)).toEqual(fullModules.map((module) => module.id));
    // Every capability module renders the same text: its share of the contract
    // after base behavior and runtime mechanics is identical.
    const tail = (result: typeof full) => {
      const [base, mechanics] = contract(result).modules!;
      return contract(result).content.slice(base!.chars + mechanics!.chars + 4);
    };
    expect(tail(lean)).toBe(tail(full));
  });

  test("keeps guidance tied to tools the session has", () => {
    const lean = (capabilities: Partial<ResolvedAgentCapabilities>, resources = NO_COMPUTE) =>
      compose({ ...noneAgentCapabilities(), ...capabilities }, resources, "lean").composed;
    const none = lean({});
    expect(none).toContain("call `wait_for_input` with the answer in its `reply`");
    expect(none).toContain("## Waiting");
    expect(none).toContain("## Tool discovery");
    expect(none).not.toContain("published sources");
    expect(none).not.toContain("`privacy_facts`");
    expect(none).not.toContain("setup card");
    expect(none).not.toContain("## Background commands");
    expect(lean({ webSearch: true })).toContain("An answer built from web or published sources");
    expect(lean({ privacyFacts: true })).toContain(
      "Answer questions about privacy, retention, training, the model or provider, or where data is processed only from `privacy_facts`",
    );
    expect(lean({ workspaceAdmin: true })).toContain("`admin_actions_search`");
    expect(lean({ workspaceConnectors: true })).toContain("show its setup card");
    expect(lean({ knowledge: true })).toContain("Useful learning follows its accepted policy");
    expect(lean({ goals: true })).toContain(
      "Always retain the full completion audit and required completion evidence.",
    );
    expect(lean({}, { ...NO_COMPUTE, managedSandbox: true })).toContain("## Background commands");
    // The external-commitment rule follows the capabilities that can build or connect things.
    const commitment = "Ask before making a new external commitment";
    expect(none).not.toContain(commitment);
    expect(lean({ workspaceConnectors: true })).toContain(commitment);
    expect(lean({}, { ...NO_COMPUTE, managedSandbox: true })).toContain(commitment);
  });

  test("a lean agent configuration selects lean guidance at build time", () => {
    const base: ResolvedAgentConfig = {
      version: 1,
      from: "none",
      capabilities: noneAgentCapabilities(),
      unavailable: [],
      identity: null,
      renderer: "opengeni",
      source: "request",
    };
    const inspect = (config: ResolvedAgentConfig) =>
      inspectPersistentAgentInstructions(testSettings(), {
        agentConfig: config,
        agentPromptResources: NO_COMPUTE,
      }).composed;
    const full = inspect(base);
    const lean = inspect({ ...base, guidance: "lean" });
    expect(full).toContain("## Autonomy and persistence");
    expect(lean).not.toContain("## Autonomy and persistence");
    expect(lean).toContain("## Acting for the user");
    expect(lean).toContain(DESTRUCTIVE_ACTIONS);
  });
});
