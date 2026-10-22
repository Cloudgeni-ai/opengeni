import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FIRST_PARTY_MCP_TOOL_NAMES } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { inspectPersistentAgentInstructions } from "../../src/index";
import { LEGACY_PROMPT_CASES } from "./legacy-cases";

/**
 * D19/AC1: a session without an agent configuration keeps byte-identical
 * system instructions. These digests track the reviewed upstream legacy
 * composition, including goal-completion, child-answer delivery and durable
 * Codemode approval guidance and the secrets overhaul's removal of the retired
 * variable_set_list / variableSetIds wording. Reviewed instruction changes update their locks;
 * Modular composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 33215,
    sha256: "aac31df8781a6bccf1b2e0cb14691a464cde8ca64c3e9bef1c35d3d46505633b",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34089,
    sha256: "2c19f672d86a4a65ec442b890089304de62d29eedec94b573a84f3dfae4a41f0",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31805,
    sha256: "b43154017863ea4710c9b4541e71a909fb31c9f5e304019deb7487ecff777513",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31805,
    sha256: "b43154017863ea4710c9b4541e71a909fb31c9f5e304019deb7487ecff777513",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37932,
    sha256: "bdbe25a4d5cbc64e990e0b09428468cd4ee80f107e56128f80295fd13cd656f6",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37031,
    sha256: "229916c4fddae49d3c5ab31b1fb091606d43b005026b78e673ab8f46268f935b",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33215,
    sha256: "aac31df8781a6bccf1b2e0cb14691a464cde8ca64c3e9bef1c35d3d46505633b",
    layers: "operational_contract,persona_and_core",
  },
};

describe("legacy prompt bytes (null agent configuration)", () => {
  const settings = testSettings();
  for (const [name, options] of Object.entries(LEGACY_PROMPT_CASES)) {
    for (const agentConfig of [undefined, null] as const) {
      test(`${name} (${agentConfig === undefined ? "omitted" : "null"} config)`, () => {
        const inspection = inspectPersistentAgentInstructions(settings, {
          ...options,
          ...(agentConfig === null ? { agentConfig } : {}),
        });
        const locked = LOCKED[name]!;
        expect(inspection.composed.length).toBe(locked.chars);
        expect(createHash("sha256").update(inspection.composed).digest("hex")).toBe(locked.sha256);
        expect(inspection.layers.map((layer) => layer.id).join(",")).toBe(locked.layers);
      });
    }
  }

  // Tool availability is a modular-only rendering input: even a view proving
  // every first-party tool absent leaves the legacy bytes untouched.
  for (const [name, options] of Object.entries(LEGACY_PROMPT_CASES)) {
    test(`${name} ignores tool availability`, () => {
      const inspection = inspectPersistentAgentInstructions(settings, {
        ...options,
        agentPromptToolAvailability: { unavailable: [...FIRST_PARTY_MCP_TOOL_NAMES] },
      });
      const locked = LOCKED[name]!;
      expect(inspection.composed.length).toBe(locked.chars);
      expect(createHash("sha256").update(inspection.composed).digest("hex")).toBe(locked.sha256);
      expect(inspection.layers.map((layer) => layer.id).join(",")).toBe(locked.layers);
    });
  }
});
