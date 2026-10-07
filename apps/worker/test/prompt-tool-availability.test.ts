import { describe, expect, test } from "bun:test";
import { allowedFirstPartyMcpToolsForSession } from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  allAgentCapabilities,
  resolveAgentToolFamilies,
  type FirstPartyMcpToolName,
  type Permission,
  type ResolvedAgentConfig,
} from "@opengeni/contracts";
import { inspectPersistentAgentInstructions, type BuildAgentOptions } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { promptToolAvailabilityForTurn } from "../src/activities/agent-turn/prompt-tool-availability";
import { linkedTurnFirstPartyPermissions } from "../src/activities/agent-turn/tool-environment";

const settings = testSettings({ sandboxBackend: "docker" });

const agentConfig: ResolvedAgentConfig = {
  version: 1,
  from: "all",
  capabilities: allAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};

const GOAL_AND_KNOWLEDGE_TOOLS = [
  "goal_set",
  "goal_update",
  "goal_progress",
  "goal_complete",
  "goal_pause",
  "goal_resume",
  "knowledge_search",
  "knowledge_prepare_save",
  "knowledge_get",
  "knowledge_browse",
  "knowledge_save",
  "knowledge_retain_file",
  "knowledge_retain_message",
  "knowledge_archive",
  "instruction_policy_save",
  "instruction_policy_get",
] as const satisfies readonly FirstPartyMcpToolName[];

/** The worker's selection: deployment ceiling, then capability gating, as in tool-environment. */
function selectionFor(stored: readonly FirstPartyMcpToolName[] | null): FirstPartyMcpToolName[] {
  return resolveAgentToolFamilies(agentConfig, { sandboxAttached: true }).firstPartyTools(
    allowedFirstPartyMcpToolsForSession(settings, stored),
  );
}

function instructions(options: Partial<BuildAgentOptions> = {}): string {
  return inspectPersistentAgentInstructions(settings, {
    agentConfig,
    codemodeAvailable: true,
    ...options,
  }).composed;
}

function promptFor(
  stored: readonly FirstPartyMcpToolName[] | null,
  permissions: readonly Permission[] | null,
  options: Partial<BuildAgentOptions> = {},
): string {
  const availability = promptToolAvailabilityForTurn({
    agentConfig,
    selectedFirstPartyMcpTools: selectionFor(stored),
    firstPartyPermissions: permissions,
  });
  return instructions({
    ...options,
    ...(availability ? { agentPromptToolAvailability: availability } : {}),
  });
}

describe("worker prompt tool availability (OPE-725)", () => {
  test("a session without an agent configuration receives no availability view", () => {
    for (const config of [null, undefined]) {
      expect(
        promptToolAvailabilityForTurn({
          agentConfig: config,
          selectedFirstPartyMcpTools: [],
          firstPartyPermissions: [],
        }),
      ).toBeUndefined();
    }
  });

  test("the default selection and ceiling keep today's configured prompt bytes", () => {
    expect(promptFor(null, null)).toBe(instructions());
  });

  test("a selection excluding goal and Knowledge functions stops naming them", () => {
    const stored = DEFAULT_FIRST_PARTY_MCP_TOOLS.filter(
      (tool) => !(GOAL_AND_KNOWLEDGE_TOOLS as readonly string[]).includes(tool),
    );
    const unknown = instructions();
    const narrowed = promptFor(stored, null);
    expect(unknown).toContain("opengeni__goal_complete");
    expect(unknown).toContain("knowledge_save");
    for (const tool of GOAL_AND_KNOWLEDGE_TOOLS) expect(narrowed).not.toContain(tool);
    // Capabilities stay on: the general goal and learning obligations remain.
    expect(narrowed).toContain("# Goals");
    expect(narrowed).toContain("If the session has a goal, you own it");
    expect(narrowed).toContain("# Knowledge and durable storage");
    expect(narrowed).toContain("Follow the accepted learning modes and scope:");
  });

  test("a permission ceiling without goals:manage or documents:search stops naming their tools", () => {
    const ceiling = DEFAULT_FIRST_PARTY_MCP_PERMISSIONS.filter(
      (permission) => permission !== "goals:manage" && permission !== "documents:search",
    );
    const narrowed = promptFor(null, ceiling);
    for (const tool of GOAL_AND_KNOWLEDGE_TOOLS) expect(narrowed).not.toContain(tool);
    // Tools under other permissions keep their guidance.
    expect(narrowed).toContain("task_note_save");
    expect(narrowed).toContain("`wait_for_input`");
  });

  test("a partial Knowledge family keeps only the admitted tools", () => {
    const stored = DEFAULT_FIRST_PARTY_MCP_TOOLS.filter(
      (tool) => tool !== "knowledge_save" && tool !== "knowledge_prepare_save",
    );
    const narrowed = promptFor(stored, null);
    expect(narrowed).toContain("Use knowledge_search and knowledge_get before work");
    expect(narrowed).not.toContain("knowledge_save");
    expect(narrowed).not.toContain("knowledge_prepare_save");
  });

  test("child narrowing removes only the child's omitted tools", () => {
    const parentStored = [...DEFAULT_FIRST_PARTY_MCP_TOOLS];
    // A non-delegating leaf without Knowledge writes, created from that parent.
    const childStored = parentStored.filter(
      (tool) => tool !== "session_create" && tool !== "knowledge_save",
    );
    const parent = promptFor(parentStored, null);
    const child = promptFor(childStored, null);
    expect(parent).toBe(instructions());
    expect(parent).toContain("knowledge_save");
    expect(child).not.toContain("knowledge_save");
    expect(child).toContain("knowledge_search");
    // A linked turn narrows the child's ceiling further through the same helper.
    const linked = linkedTurnFirstPartyPermissions(null, {
      permissions: DEFAULT_FIRST_PARTY_MCP_PERMISSIONS.filter(
        (permission) => permission !== "goals:manage",
      ),
    });
    const linkedChild = promptFor(childStored, linked);
    expect(linkedChild).not.toContain("opengeni__goal_");
    expect(linkedChild).not.toContain("knowledge_save");
  });

  test("generic and Codex-native transports render the same frozen view", () => {
    const stored = DEFAULT_FIRST_PARTY_MCP_TOOLS.filter((tool) => tool !== "goal_set");
    const generic = promptFor(stored, null, { lazyToolTransport: "generic_dispatch" });
    const codex = promptFor(stored, null, { lazyToolTransport: "codex_native" });
    const openai = promptFor(stored, null, { lazyToolTransport: "openai_native" });
    expect(codex).toBe(generic);
    expect(openai).toBe(generic);
    expect(generic).not.toContain("opengeni__goal_set");
    // Deferred tools are not absent: discovery guidance remains on every transport.
    expect(codex).toContain("## Tool discovery");
    expect(codex).toContain("opengeni__goal_complete");
  });

  test("recovery and later turns with the same selection keep an identical prefix", () => {
    const stored = DEFAULT_FIRST_PARTY_MCP_TOOLS.filter((tool) => tool !== "session_events");
    const first = promptFor(stored, null, { sessionInstructions: "turn 1" });
    const recovered = promptFor([...stored].reverse(), null, { sessionInstructions: "turn 2" });
    const contract = (text: string) => text.slice(0, text.indexOf("# Session instructions"));
    expect(contract(recovered)).toBe(contract(first));
  });
});
