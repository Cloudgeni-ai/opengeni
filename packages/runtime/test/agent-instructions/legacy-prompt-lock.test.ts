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
 * follow-up naming `session_queue_message`, and calling Sites apps; `unattended` pins the
 * unattended-session CORE paragraph, which no other case carries. Reviewed
 * instruction changes update their locks; Modular composition must never
 * change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 33668,
    sha256: "e15a829d2badb7536aa652c07cc8957210a74e6b3813fc84beb495b49732e758",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34542,
    sha256: "3324389129b539cbf9cb1bc273bf2d4b7e988c0f64a44cb14ae68b485746c1cf",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32258,
    sha256: "e9d40a6bc9aa39fec6271e60cb252f67dfc7ca06d02f009c55fc81cd07bedb27",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32258,
    sha256: "e9d40a6bc9aa39fec6271e60cb252f67dfc7ca06d02f009c55fc81cd07bedb27",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 38108,
    sha256: "1bf84009c98e05e1ba777cc9fb47ca27a6c317d117eb5a4ab9fe6b48982cc359",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 37122,
    sha256: "c78b27bf66562951d4cf84608d2ff3fc4d641833be45847d6c2437e8674ef1bf",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33668,
    sha256: "e15a829d2badb7536aa652c07cc8957210a74e6b3813fc84beb495b49732e758",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 34206,
    sha256: "1b3c5a24f3ce6606426971cf8c27da7ea89d7343597331b5c47cd354a2bb84ef",
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
