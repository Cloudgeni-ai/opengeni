import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FIRST_PARTY_MCP_TOOL_NAMES } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
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
    chars: 32853,
    sha256: "dcc71efee71c94865b92d6bf79f83b19e8c6e2d1fb0141647dc8d2f976febaf1",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33727,
    sha256: "e5c3c6db16109879bc07cd3ca131d02ad14b63f0d0d7556ec0ed42a2b9af3e2b",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31443,
    sha256: "e691bc6f43034dcbf0a517656400496470a63c85253e9d5fba5c1000cc6df325",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31443,
    sha256: "e691bc6f43034dcbf0a517656400496470a63c85253e9d5fba5c1000cc6df325",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37570,
    sha256: "1bf3cdd453cf69b61419b62377ace6afb9d9398b7ffd20c0be4f8d18957c84bd",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36669,
    sha256: "5c7d7c4b477a56439489fd433a2f15ef42c7a7bb86bdf6d468dca9c2b1d23472",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32853,
    sha256: "dcc71efee71c94865b92d6bf79f83b19e8c6e2d1fb0141647dc8d2f976febaf1",
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
