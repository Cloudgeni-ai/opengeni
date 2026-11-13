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
 * directive and its background-process credential lifetime, and the search
 * rule that no longer assumes `rg`, and the wait rules
 * that the `wait_for_input` description now states once; `unattended` pins the
 * unattended-session CORE paragraph, which no other case carries. Reviewed
 * instruction changes update their locks; Modular composition must never
 * change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 33709,
    sha256: "c24f37a71073d86a13fc3f2b9a764bcd280b1ded92436c8a95738bdc9391988f",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34583,
    sha256: "1ac830744ece9a0bb948f801668e325303ae93a49473afb1466f60ddfd5b8bfb",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32299,
    sha256: "54849dd67824590c42b6dde79127b50265c1ffb97a4b589865f2097794aac106",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32299,
    sha256: "54849dd67824590c42b6dde79127b50265c1ffb97a4b589865f2097794aac106",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38149,
    sha256: "79a4093e49834a9b1dad4ac06ef974bd836bdc33cbc437f5e617f6269187ff19",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37163,
    sha256: "c90d5c591a30e9c664cedf6d4c12463064d6d398fa174e3806a7352bfbc7285b",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33709,
    sha256: "c24f37a71073d86a13fc3f2b9a764bcd280b1ded92436c8a95738bdc9391988f",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 34247,
    sha256: "7c04cef230123d1796d495dd126cc3e8e630a8b9c1e1def4c960837944683469",
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
