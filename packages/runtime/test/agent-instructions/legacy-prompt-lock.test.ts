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
    chars: 33633,
    sha256: "17b82cd983aa962899aee8c51aaf60b19b54f09b5f33863dd489201dfb00dd06",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34507,
    sha256: "9a4a41419e387b82bf06f10fbaab28bf3092911bf0a5ab15b1b8520e4fbbfe4d",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32223,
    sha256: "37da38a8ca1694a6f3e0ad3eb519e2ba7ee851932d2574a61e3f327314d42552",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32223,
    sha256: "37da38a8ca1694a6f3e0ad3eb519e2ba7ee851932d2574a61e3f327314d42552",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38350,
    sha256: "56446365c9414091160772d8dff8c853dbb93118e912ec3edd2ab7c724f52e92",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37449,
    sha256: "9b3dc9828f272bfeab9f57b3ac597ebb1a5f96f80ff60e205e9ac6bc10b0d324",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33633,
    sha256: "17b82cd983aa962899aee8c51aaf60b19b54f09b5f33863dd489201dfb00dd06",
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
