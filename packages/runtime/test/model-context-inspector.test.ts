import { describe, expect, test } from "bun:test";
import { AGENT_INSTRUCTIONS_CORE_PLACEHOLDER, DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { OPENGENI_OPERATIONAL_INSTRUCTIONS } from "../src/operational-instructions";
import {
  CODEMODE_PROGRAMMATIC_DIRECTIVE,
  composeAgentInstructions,
  coreInstructions,
  inspectPersistentAgentInstructions,
  joinPersistentAgentInstructionLayers,
} from "../src/index";
import {
  skillsFromGovernanceLayer,
  splitCapturedInstructions,
} from "../src/model-context-inspector";

describe("model context inspector", () => {
  test("persistent layers join to the exact composed instructions", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {
      sessionInstructions: "Be terse.",
    });
    expect(inspection.composed).toBe(joinPersistentAgentInstructionLayers(inspection.layers));
    expect(inspection.composed.startsWith(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBe(true);
    expect(inspection.composed.endsWith("Be terse.")).toBe(true);
    expect(inspection.layers.map((layer) => layer.id)).toEqual([
      "operational_contract",
      "persona_and_core",
      "session_instructions",
    ]);
  });

  test("governance reorders session instructions before codemode", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {
      workspaceGovernance: "Workspace global policy\nNever rotate the token.",
      sessionInstructions: "SESSION RULE",
      codemodeAvailable: true,
    });
    expect(inspection.layers.map((layer) => layer.id)).toEqual([
      "operational_contract",
      "persona_and_core",
      "workspace_governance",
      "session_instructions",
      "codemode",
    ]);
    expect(inspection.composed).toContain(CODEMODE_PROGRAMMATIC_DIRECTIVE);
    expect(inspection.composed.indexOf("SESSION RULE")).toBeLessThan(
      inspection.composed.indexOf(CODEMODE_PROGRAMMATIC_DIRECTIVE),
    );
  });

  test("captured remainder after composed instructions is labeled as SDK capability text", () => {
    const inspection = inspectPersistentAgentInstructions(testSettings(), {});
    const layers = splitCapturedInstructions({
      persistentLayers: inspection.layers,
      capturedInstructions: `${inspection.composed}\n\n## Skills\n- pr-review`,
      genesisTitleDirective: "TITLE DIRECTIVE",
    });
    expect(layers.at(-1)?.id).toBe("sdk_capability_instructions");
    expect(layers.at(-1)?.content).toContain("## Skills");
  });

  test("parses preference descriptors from the governance prompt JSON", () => {
    const skills = skillsFromGovernanceLayer(
      `Workspace Skill descriptors (full instructions are on-demand):\n${JSON.stringify([
        {
          title: "Never rotate the workspace GitHub token",
          description: "Treat it as use-only.",
          scope: "workspace",
        },
      ])}`,
    );
    expect(skills).toEqual([
      {
        kind: "preference_descriptor",
        name: "Never rotate the workspace GitHub token",
        description: "Treat it as use-only.",
        source: "workspace",
      },
    ]);
  });

  test("persona+CORE composition remains the historical default", () => {
    expect(composeAgentInstructions(DEFAULT_AGENT_INSTRUCTIONS)).toContain(
      coreInstructions().join(" "),
    );
    expect(DEFAULT_AGENT_INSTRUCTIONS).toContain(AGENT_INSTRUCTIONS_CORE_PLACEHOLDER);
  });
});
