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
    chars: 34421,
    sha256: "01aa27b728d055acb9c4100583c1643c1b1acafc93dd158c8f3960bf4cf51a0b",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 35295,
    sha256: "4eecfabb6d60e91d2c9ae8a102971f1e46003883129c792f74839bd321805437",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33011,
    sha256: "df4f8bcb58da5a6cfe71d8813f9cddf34deaa6da72b3b979915eab140c494ed6",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33011,
    sha256: "df4f8bcb58da5a6cfe71d8813f9cddf34deaa6da72b3b979915eab140c494ed6",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39138,
    sha256: "03752efdef510ea5cbaab634dded51fd32696860a884f67e38609a90782afe79",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38237,
    sha256: "e924db99ef24a869eab1d98020e337471acfc35ab976d0525910ecf1b71e8b1a",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 34421,
    sha256: "01aa27b728d055acb9c4100583c1643c1b1acafc93dd158c8f3960bf4cf51a0b",
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
