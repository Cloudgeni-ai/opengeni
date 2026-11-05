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
 * routine, reversible steps, the Skill index reading Skills by name, and
 * answering privacy questions from `privacy_facts`, and the shorter Codemode
 * directive, and the search rule that no longer assumes `rg`; `unattended` pins the
 * unattended-session CORE paragraph, which no other case carries. Reviewed
 * instruction changes update their locks; Modular composition must never
 * change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35240,
    sha256: "9e2cc44d7d82afac39b85c81e66cb0f66709583e77cf821de535f4c8e42594f4",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36114,
    sha256: "14019c71509806ec583d9910209b299700ab1c65654ec8c99cac6d601544a498",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33830,
    sha256: "f523ab177788e091878206f3e0261492d490451b28a5c24ff8ce3e562788252d",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33830,
    sha256: "f523ab177788e091878206f3e0261492d490451b28a5c24ff8ce3e562788252d",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39419,
    sha256: "d09761dc5eb05d011f0c0542899d1c5093e20b77f54ba004e78a79e6ffe0945a",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38433,
    sha256: "bcdb7e706a0b75daf6712a482eca3888d06c1adc066c97b8b076e4157bb874fd",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35240,
    sha256: "9e2cc44d7d82afac39b85c81e66cb0f66709583e77cf821de535f4c8e42594f4",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 35778,
    sha256: "1dfb939c699e1d0468ffc91b25d936a74445f02cd86f56ed5e0bcac5d3da40d7",
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
