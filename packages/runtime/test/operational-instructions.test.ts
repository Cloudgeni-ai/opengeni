import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildOpenGeniAgent } from "../src/index";
import { OPENGENI_OPERATIONAL_INSTRUCTIONS } from "../src/operational-instructions";

describe("provider-neutral operational instructions", () => {
  test("retains the agreed Codex behaviors without Codex-only runtime language", () => {
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("# Working with the user");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("# Rules for getting work done");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("# Destructive Actions");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("# Using skills");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("Use `apply_patch` for local file edits");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain("[app.py](/abs/path/app.py:12)");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).toContain(
      "the live Skills sections supplied with the current runtime are authoritative",
    );
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("You are Codex");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("GPT-5");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("$CODEX_HOME");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("`commentary` channel");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("`final` channel");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("skill://");
    expect(OPENGENI_OPERATIONAL_INSTRUCTIONS).not.toContain("orchestrator");
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
});
