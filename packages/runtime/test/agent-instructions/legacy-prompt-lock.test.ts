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
    chars: 33267,
    sha256: "b80ba5c84175a7c47ee4435abb42e3a859aa9b0493d2e135e4a7cbbfc3b46860",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34141,
    sha256: "b6f7b4dfb8873260dcf65068bad913536f308e416e3b525388321b2b23987a08",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31857,
    sha256: "abfb523a0a2b164f817b213e71392e3291e9d52ae8aef1d7ccaf0a4bddc2c0b6",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31857,
    sha256: "abfb523a0a2b164f817b213e71392e3291e9d52ae8aef1d7ccaf0a4bddc2c0b6",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37984,
    sha256: "1155e0c5592980e27ebc8f686ff7b9d6e6d410dda895b559a66a35ae9b96ae2a",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37083,
    sha256: "772d796b4cbb53379efcbc6f6130d09ce735abed89a2dbbf88785a710644d31c",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33267,
    sha256: "b80ba5c84175a7c47ee4435abb42e3a859aa9b0493d2e135e4a7cbbfc3b46860",
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
