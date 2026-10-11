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
 * Codemode approval guidance. Reviewed instruction changes update their locks;
 * Modular composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 32811,
    sha256: "4c0176bf558a7c142fe007be86279c941447a0581c2ef6d8511475596a77c14b",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33685,
    sha256: "efee4201bf6be29a28447fc35787286b3fea473371727ed3e74d861ab7b4f088",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31401,
    sha256: "afa4a8663c501811d2dda2bc45b41be4e14d2fb9530f20312feb4a9b3bc17320",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31401,
    sha256: "afa4a8663c501811d2dda2bc45b41be4e14d2fb9530f20312feb4a9b3bc17320",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37528,
    sha256: "ab8be3f32d90767770b46d2ad7e1756f51c1182c522aa58a9032ab1d8a23e498",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36627,
    sha256: "9f8654b39597a42e4a6651702b9548eb18f42d11bc3972d1a88d0c7e7767e7c8",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32811,
    sha256: "4c0176bf558a7c142fe007be86279c941447a0581c2ef6d8511475596a77c14b",
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
