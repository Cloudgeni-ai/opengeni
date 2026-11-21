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
    chars: 33354,
    sha256: "72b477d6a5a1000a5741c7c5439f4ffa341c85ce52497b289803930d903ca9b0",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34228,
    sha256: "4e0af1bcf5e06f6dca4b9b8816d24cf06f1ce1bf9477c356ec6cc6514a798f76",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31944,
    sha256: "a8f844833b9572aba84d21271c66ab491f21ed3cdf03e31adaa3c0d7186e9e0d",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31944,
    sha256: "a8f844833b9572aba84d21271c66ab491f21ed3cdf03e31adaa3c0d7186e9e0d",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37794,
    sha256: "4c29116683541a78d49445415f6af0d279e8e104d30fdff9790b813993ab1ba5",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36808,
    sha256: "dd549f402c615751c65a0bc4ced1c4bb80bd9f3b8692cffaf962c81eb3082bb5",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33354,
    sha256: "72b477d6a5a1000a5741c7c5439f4ffa341c85ce52497b289803930d903ca9b0",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 33892,
    sha256: "c0c001d4156457605e8db9f1b61d80f3e7347090b6649cee5086b204dd07042e",
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
