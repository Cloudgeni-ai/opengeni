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
    chars: 33476,
    sha256: "ee295a4ce72af15b8169fe3b714d2261e3697967db45f402323a7b87a8e832f5",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 34350,
    sha256: "1016b6c77806ad01514ca369041183555d173a3d54d7b09938fd58a265866663",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 32066,
    sha256: "a95b7576ad10785546484f5e532c8280a14cc7050eb3cfb5bec776ef642b8467",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 32066,
    sha256: "a95b7576ad10785546484f5e532c8280a14cc7050eb3cfb5bec776ef642b8467",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37916,
    sha256: "89fadf09f2c0da6e91d30d84dc0aae311c7264a9cd04506bc6bbf9c1b22920df",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36930,
    sha256: "836f3d6940b7e6268903977b13e4fa372dbc1b414cfda909fd40bcdb3febf5db",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 33476,
    sha256: "ee295a4ce72af15b8169fe3b714d2261e3697967db45f402323a7b87a8e832f5",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 34014,
    sha256: "55c57faba3c1b8d940d51612bcf9627895f58143d203506b93d60ad2d83fc661",
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
