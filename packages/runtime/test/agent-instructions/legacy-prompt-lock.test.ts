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
    chars: 33515,
    sha256: "2a1ad35c33fe780fff6c35d72107be4b250df76114a60659708a413b00e7f9a8",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34389,
    sha256: "39f7b45faf3c868cc179bda5e951f42331e609392cc795ffcff38c534ea875f1",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32105,
    sha256: "48028c65f7a9cd4076dfc53eef0e928bf9ffae4585255dfa625ffc7b0520cc56",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32105,
    sha256: "48028c65f7a9cd4076dfc53eef0e928bf9ffae4585255dfa625ffc7b0520cc56",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38232,
    sha256: "fe6dd3ac4857164299c470109413e2f62862e13da7266161cfe87f40097f9b30",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37331,
    sha256: "00f79d45e0f5e3343e935cd48c31cfbfa8b8ebd7f1eaffab56ea7a4528026e5b",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33515,
    sha256: "2a1ad35c33fe780fff6c35d72107be4b250df76114a60659708a413b00e7f9a8",
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
