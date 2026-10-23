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
    chars: 33629,
    sha256: "d6c9dfac4ff3d176798dc80ff97f36d608122eecf7b786ed06ae068eb040c4a0",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34503,
    sha256: "e637af3d8ff51181b9cd33a4b665898e41d8bc7b73c92fda850cbea6116eed75",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32219,
    sha256: "481055835bc1d938bbf3acc399357dc3708f7510e8d68b2bdba681c959cb7362",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32219,
    sha256: "481055835bc1d938bbf3acc399357dc3708f7510e8d68b2bdba681c959cb7362",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38346,
    sha256: "b6e049a432d2b2068565076ef39e48cfebccf37503a59d37bb3bee5442cd445b",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37445,
    sha256: "79a5720cb14f14326c5421151ba6118c26e21a748528d513897adb1a03fd2024",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33629,
    sha256: "d6c9dfac4ff3d176798dc80ff97f36d608122eecf7b786ed06ae068eb040c4a0",
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
