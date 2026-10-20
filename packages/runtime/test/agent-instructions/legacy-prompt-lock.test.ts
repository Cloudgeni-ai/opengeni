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
    chars: 32564,
    sha256: "a71dfc31daa383101a4abe820300e49c0085c0c9990be892c962729a3cf9e4dc",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33438,
    sha256: "4e4effdb10a34926b6cdd7c63dca69e450c2f26c9102ff5586424da81dcce149",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31154,
    sha256: "ae45b93e6162935ef707ab430be06182e328b9f69f4bcce6b1146baf3b2be67f",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31154,
    sha256: "ae45b93e6162935ef707ab430be06182e328b9f69f4bcce6b1146baf3b2be67f",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37281,
    sha256: "9100db8806aac7b0d4297d89bdfd9e789ac42dd7461d2b240fd20bb9ce5e9507",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36380,
    sha256: "36df14d0b087841cf3e75d09ed040058f37f1e3d113d8de33e27e0814d80c4c4",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32564,
    sha256: "a71dfc31daa383101a4abe820300e49c0085c0c9990be892c962729a3cf9e4dc",
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
