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
    chars: 33355,
    sha256: "6660c2083e9eb03c385225194ae54cc2fe348e5e0f86b306c9233d007193f9dd",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34229,
    sha256: "b47a497a418a473d68620e96cc46dd5aa9e7ec1e7eecc08fba7fcd6f9d303f2e",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31945,
    sha256: "747ef96def6bb16d2c85aac182194d60bb3da829f150b05219b45f5c3a28ef76",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31945,
    sha256: "747ef96def6bb16d2c85aac182194d60bb3da829f150b05219b45f5c3a28ef76",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37795,
    sha256: "9c9ee8f050b9bcf06c068bd4008991431779f78823c44cc601a6958b99d69245",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36809,
    sha256: "c40a66a661927e191498b62a2a8c0f5b22c2b3ad2f66445816824ef5668bd240",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33355,
    sha256: "6660c2083e9eb03c385225194ae54cc2fe348e5e0f86b306c9233d007193f9dd",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 33893,
    sha256: "78245df1e4fa77c5fece460f36d63fd2e33699364febf99a5ffb45efd886ba7c",
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
