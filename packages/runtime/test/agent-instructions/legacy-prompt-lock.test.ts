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
    chars: 32459,
    sha256: "81da623c61c82e9423a81112763c9498870b54c6ebaf83a8d1b2a0913baf29af",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33333,
    sha256: "4b9875eb42a5bdd29678f19e85c48261c32af0c41db89d9e7f4b8509b53e8de9",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31049,
    sha256: "22b65af18d89b9ecd828295fb1bdd2894768103253cd3239f216adcaa9008fbf",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31049,
    sha256: "22b65af18d89b9ecd828295fb1bdd2894768103253cd3239f216adcaa9008fbf",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37176,
    sha256: "d9a598c976b8d3271f4d5a944340439cc00a0eeccb889f00b5dd0cb99bf7cfe3",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36275,
    sha256: "87f69fd9397f6723358ffb5e0c0dd877abbe00df70a85964df44627d80c8ad11",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32459,
    sha256: "81da623c61c82e9423a81112763c9498870b54c6ebaf83a8d1b2a0913baf29af",
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
