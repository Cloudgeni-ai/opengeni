import { describe, expect, test } from "bun:test";
import { DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";
import { allAgentCapabilities, noneAgentCapabilities } from "@opengeni/contracts";
import {
  appendSessionInstructions,
  appendWorkspaceGovernance,
  appendWorkspaceMemory,
  composeAgentInstructions,
  inspectPersistentAgentInstructions,
  type ResolvedAgentConfig,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import { standaloneCompactionInstructions } from "../src/activities/agent-turn/compaction-prep";

const settings = testSettings({ sandboxBackend: "docker" });

function agentConfig(overrides: Partial<ResolvedAgentConfig> = {}): ResolvedAgentConfig {
  return {
    version: 1,
    from: "all",
    capabilities: allAgentCapabilities(),
    unavailable: [],
    identity: null,
    renderer: "opengeni",
    source: "request",
    ...overrides,
  };
}

const context = {
  workspaceAgentInstructions: "You are Acme Assistant. {{core}}",
  workspaceAgentIdentity: "You are Acme Assistant.",
  workspaceGovernance: "GOVERNANCE",
  structuredWorkspacePolicyActive: true,
  workspaceMemory: "MEMORY",
  rig: { name: "python", version: 2 },
};

describe("standalone compaction instructions (AC16)", () => {
  test("a legacy session keeps the historical composition byte-for-byte", () => {
    const session = { agent: null, instructions: "SESSION", resources: [] };
    expect(standaloneCompactionInstructions({ settings, session, ...context })).toBe(
      appendWorkspaceMemory(
        appendSessionInstructions(
          appendWorkspaceGovernance(
            composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS, undefined, context.rig),
            "GOVERNANCE",
          ),
          "SESSION",
        ),
        "MEMORY",
      ),
    );
  });

  test("a configured session uses the turn composer and the same module selection", () => {
    const config = agentConfig({
      from: "none",
      capabilities: { ...noneAgentCapabilities(), goals: true },
      renderer: "markdown",
    });
    const session = { agent: config, instructions: "SESSION", resources: [] };
    const instructions = standaloneCompactionInstructions({ settings, session, ...context });
    const turn = inspectPersistentAgentInstructions(settings, {
      agentConfig: config,
      workspaceAgentIdentity: context.workspaceAgentIdentity,
      workspaceGovernance: "GOVERNANCE",
      workspaceMemory: "MEMORY",
      sessionInstructions: "SESSION",
      rig: context.rig,
    });
    expect(instructions).toBe(turn.composed);
    expect(instructions.startsWith("You are Acme Assistant.")).toBe(true);
    expect(instructions).toContain("# Goals");
    expect(instructions).toContain("# Links and rendering");
    expect(instructions).not.toContain("knowledge_search");
    expect(instructions).toContain("GOVERNANCE");
  });
});
