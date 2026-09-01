import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent } from "../src/index";
import { OPENGENI_OPERATIONAL_INSTRUCTIONS } from "../src/operational-instructions";

describe("provider-neutral operational instructions", () => {
  test("does not carry Codex-only runtime language", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("You are Codex");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("GPT-5");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("$CODEX_HOME");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("`commentary` channel");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("`final` channel");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("skill://");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("orchestrator");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("/abs/path");
  });

  test("teaches OpenGeni sandbox file links with optional line numbers", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("[app.py](sandbox:/workspace/app.py:12)");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "[My Report.md](<sandbox:/workspace/My Project/My Report.md:3>)",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Never link to /tmp");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "copy it into the current workspace before responding",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("canonical sandbox path");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Do not provide ranges of lines.");
  });

  test("is non-configurable and precedes every workspace persona", () => {
    for (const sandboxBackend of ["none", "docker"] as const) {
      const agent = buildOpenGeniAgent(testSettings({ sandboxBackend }), [], {
        instructionsTemplate: "CUSTOM WORKSPACE PERSONA {{core}}",
        workspaceGovernance: "STRUCTURED WORKSPACE GOVERNANCE",
        sessionInstructions: "SESSION-SPECIFIC INSTRUCTIONS",
      });
      expect(agent.instructions.startsWith(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBe(true);
      expect(agent.instructions.split(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toHaveLength(2);
      expect(agent.instructions).toContain("CUSTOM WORKSPACE PERSONA");
      expect(agent.instructions.indexOf(OPENGENI_OPERATIONAL_INSTRUCTIONS)).toBeLessThan(
        agent.instructions.indexOf("CUSTOM WORKSPACE PERSONA"),
      );
      expect(agent.instructions.indexOf("CUSTOM WORKSPACE PERSONA")).toBeLessThan(
        agent.instructions.indexOf("STRUCTURED WORKSPACE GOVERNANCE"),
      );
      expect(agent.instructions.indexOf("STRUCTURED WORKSPACE GOVERNANCE")).toBeLessThan(
        agent.instructions.indexOf("SESSION-SPECIFIC INSTRUCTIONS"),
      );
    }
  });

  test("requires selective child delegation and a terminal-result join", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "only for a concrete, bounded subtask that can run independently",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "Do not delegate a scope that you will also perform yourself.",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain('waitFor: "completion"');
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "A `goal.completed` event records goal state but is not a terminal child result",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("continuation segment settlements");
  });
});
