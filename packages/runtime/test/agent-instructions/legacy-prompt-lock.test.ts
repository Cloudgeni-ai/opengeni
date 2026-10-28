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
 * variable_set_list / variableSetIds wording, and proceeding past blocked
 * routine, reversible steps. Reviewed instruction changes update their locks;
 * Modular composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 34569,
    sha256: "2ba999a6d0e6572d0dd087a2653a56b38e377306aeb56de5e850be8c01a309be",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 35443,
    sha256: "923762ccd0fbfe394534535ecf080ef00e723d6d07d9f1ae2f81df97ec1055ef",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33159,
    sha256: "e3fc31357122c825971393876a9280da184290b84559de5a459ed987b064ee8b",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33159,
    sha256: "e3fc31357122c825971393876a9280da184290b84559de5a459ed987b064ee8b",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39286,
    sha256: "aabe2690691dbcf414606d0452b6d74a4c2dbdaf90b55a577e4209cd428519b8",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38385,
    sha256: "31489b0ff6cb417669739d98dfc4b406a4c886da9f3b45a1043d7dfd7c88ba68",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 34569,
    sha256: "2ba999a6d0e6572d0dd087a2653a56b38e377306aeb56de5e850be8c01a309be",
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
