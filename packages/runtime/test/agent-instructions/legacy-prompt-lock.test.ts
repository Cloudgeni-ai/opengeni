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
    chars: 33910,
    sha256: "e1e2d1c47a3d0ebbdaf5ee4c646f73a08fcb27483f77f0624b59edfdeb1ea596",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34784,
    sha256: "d8e4e7da7c6fe6fbaf4b2efd63693c572850b5d66c9393591d24ce96d9e72370",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32500,
    sha256: "9ace8534c33fb3c2c47404f4e5dad455e49d2785c17f92c8594be642e9271163",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32500,
    sha256: "9ace8534c33fb3c2c47404f4e5dad455e49d2785c17f92c8594be642e9271163",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38627,
    sha256: "b0cf1f9d95286c5e66da6bd56c2707fd2eb65c1aff4b1bc9533dfcceded78ff1",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37726,
    sha256: "68a960b1f08d9a1b46d751fd6b836ed4163b51dc07e030b269694f66ad161651",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33910,
    sha256: "e1e2d1c47a3d0ebbdaf5ee4c646f73a08fcb27483f77f0624b59edfdeb1ea596",
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
