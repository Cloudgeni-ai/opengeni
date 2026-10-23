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
    chars: 33800,
    sha256: "5e25ea37b01c88ab3b3b1eba68c5babf1ae75f1e20b60c18494090b7899a9750",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34674,
    sha256: "0330c8124fb1b95ab32b7012501f17c1ebf0e208c0026290afa82b3b3af4df2c",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32390,
    sha256: "65ffa26d7bbb711f9ce6333e0ad496659ba9f8816bf1be1022bbe08248e5ae2f",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32390,
    sha256: "65ffa26d7bbb711f9ce6333e0ad496659ba9f8816bf1be1022bbe08248e5ae2f",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38517,
    sha256: "4e5a46a06409a2d8347b2220626bdb326e7a66b9c4204748068bbcc12e7bef37",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37616,
    sha256: "2c2f947c20cc93ec079e6f40d111f88d9fa24faca070d9400cdc71885af020e2",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33800,
    sha256: "5e25ea37b01c88ab3b3b1eba68c5babf1ae75f1e20b60c18494090b7899a9750",
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
