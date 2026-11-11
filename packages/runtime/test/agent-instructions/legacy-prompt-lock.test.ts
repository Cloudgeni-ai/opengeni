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
    chars: 33625,
    sha256: "bf091f3f87565485294cf4a2fdd93b9bafb22fe8d100f9e6e2ad9e8e4da46078",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34499,
    sha256: "0f11a109f90fd51da1ec3271a4394a1da1b6c5b264d3a8179c2659ad9e1d1bec",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32215,
    sha256: "67c833070b58fceae16a09e2f68ed154357d5a7d79d4b81b4668827f046fd987",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32215,
    sha256: "67c833070b58fceae16a09e2f68ed154357d5a7d79d4b81b4668827f046fd987",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38065,
    sha256: "66681fd516e90ee3807a6a302fea31a79b4040f5ffa6c53826fc7d37419f6692",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37079,
    sha256: "0393593326c5feb83f7e8ca7125b1b7bfd1f4a7f4e3473b9e0d667d0dd769ff4",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33625,
    sha256: "bf091f3f87565485294cf4a2fdd93b9bafb22fe8d100f9e6e2ad9e8e4da46078",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 34163,
    sha256: "4dca91aee899af87050f3632c19290c07feb8c4be829d09f36e73e46cb2a237c",
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
