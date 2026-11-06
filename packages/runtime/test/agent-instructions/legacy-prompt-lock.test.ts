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
    chars: 35225,
    sha256: "5b2debb8600c6a8e677099deb7066e137735200b711f3abca6a90f3f13a683b1",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36099,
    sha256: "9690f1a73a8dcf973517692bada15060ca80bf227cc6fcb6dcd138a14b0c0c65",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33815,
    sha256: "a251e295ad7eb90963d194c1f18660243f4048298895dce0e0f16db52602f5da",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33815,
    sha256: "a251e295ad7eb90963d194c1f18660243f4048298895dce0e0f16db52602f5da",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39404,
    sha256: "b6f98f6a4a1be82077f11382d595bdc13c7e3ba5fc157ecc3525afe9bf31975a",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38418,
    sha256: "a9720905eb243f00052411df3d21bdf5b977e47382096a0abda2fe403d20bf0b",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35225,
    sha256: "5b2debb8600c6a8e677099deb7066e137735200b711f3abca6a90f3f13a683b1",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 35763,
    sha256: "46aba1906d87cd27769be912180cb50464c3614c07fa1cfaaafc6d43a6588dd7",
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
