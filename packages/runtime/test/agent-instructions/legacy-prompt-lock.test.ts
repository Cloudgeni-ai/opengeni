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
 * variable_set_list / variableSetIds wording, and proceeding past routine local
 * blocks (Git identity, a missing base branch, human-only AGENTS.md steps).
 * Reviewed instruction changes update their locks;
 * Modular composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35107,
    sha256: "6df71813bab5512b87b57e6b260348f8a526d66057f09fa341236f80370172cb",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 35981,
    sha256: "d94f0847be3e25fb82449944e735ba1938c4cb82f2b92e2529a5139dab6a3f20",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33697,
    sha256: "c8ed65297786a010a20ea7f57ab0eaee2450cbd7bef28b5cd77e32c7e018f510",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33697,
    sha256: "c8ed65297786a010a20ea7f57ab0eaee2450cbd7bef28b5cd77e32c7e018f510",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39824,
    sha256: "9d8740e5eac8230ecbf4b733cb2e7b038c38c508c2d5b51a5c38ac4ec1614464",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38923,
    sha256: "de5bfda378468247cbb8c8c7f5ef2a15e72698fc70e3fb604bd5281ca4bbb2a4",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35107,
    sha256: "6df71813bab5512b87b57e6b260348f8a526d66057f09fa341236f80370172cb",
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
