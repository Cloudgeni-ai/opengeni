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
 * that the `wait_for_input` description now states once, and the delegation
 * follow-up naming `session_queue_message`; `unattended` pins the
 * unattended-session CORE paragraph, which no other case carries. Reviewed
 * instruction changes update their locks; Modular composition must never
 * change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 33357,
    sha256: "5855356290c70c006b0e795dd14dbc780243b626d081a820a419c20d82288771",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34231,
    sha256: "17bbd14bfa9233fa6dcf5f19ba4819ff5b33a79a0a1bb9337c8c2b8b31bdf937",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31947,
    sha256: "3f365c9062bb00ecf5e56bb5947958f3a6a00b698794739d08673fbcd13b9382",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31947,
    sha256: "3f365c9062bb00ecf5e56bb5947958f3a6a00b698794739d08673fbcd13b9382",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37797,
    sha256: "ee5c1dcb619f4f0f51b0b3eb31caf168457456aae3ed0480a2aa7cfa930704d8",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36811,
    sha256: "056920e515448af37c0b8012a7cd83e9a45bf9cdd4586000c1fc9b71c05b676a",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33357,
    sha256: "5855356290c70c006b0e795dd14dbc780243b626d081a820a419c20d82288771",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 33895,
    sha256: "392499721bf88405877a407bb39b48681a0292be5e0d46690d9fd32f020d4131",
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
