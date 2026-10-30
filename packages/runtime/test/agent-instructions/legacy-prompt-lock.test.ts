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
 * routine, reversible steps, and answering privacy questions from
 * `privacy_facts`; `unattended` pins the unattended-session CORE
 * paragraph, which no other case carries. Reviewed instruction changes update
 * their locks; Modular composition must never change legacy bytes as a side
 * effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35179,
    sha256: "15cc08cc2bee3b72879c2e7d271b2cde78075fdd4ad17a18ffd5fffd6455e2a7",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36053,
    sha256: "5acfdaf48b0d28c68fa47b74618fcf4370925293624ea094afe50a0179d4e77c",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33769,
    sha256: "2b1c4263439e958981fdd776e3451fe74953ba9c049548831644699276789734",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33769,
    sha256: "2b1c4263439e958981fdd776e3451fe74953ba9c049548831644699276789734",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39896,
    sha256: "3e685f199170cfd36c5c7de07eae8e75c1adcc3e39b5661754fe3e14cf3563a9",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38995,
    sha256: "1a98de953aaee124fb39c96ddf6ae71daf55243209ae273ea2278dda966f2869",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35179,
    sha256: "15cc08cc2bee3b72879c2e7d271b2cde78075fdd4ad17a18ffd5fffd6455e2a7",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 35717,
    sha256: "41a20fa5ed2cb1f29aa1102cc7e9972cccf7a050c72ba62682d9c3d7b14c5a72",
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
