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
    chars: 34158,
    sha256: "981bf4d38d268a317a308f1f05033d8405f615fd6e933e3669dba00dc12e7174",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 35032,
    sha256: "47a94d748d8274ced214b223e3621234e37ffec0ddc2e609a9da65cf9ff4921d",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32748,
    sha256: "ec650896f12711cdfd6fb56db66be22efa0cc1be06a2f797eea302ca10f30276",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32748,
    sha256: "ec650896f12711cdfd6fb56db66be22efa0cc1be06a2f797eea302ca10f30276",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38875,
    sha256: "427f195af77495d498498048955b578b938423c0b202f186490acc001321b27b",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37974,
    sha256: "4592cd3801e921d3fb7ec7b0c30af92a748a55208017aa2dce4a422a5dea8982",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 34158,
    sha256: "981bf4d38d268a317a308f1f05033d8405f615fd6e933e3669dba00dc12e7174",
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
