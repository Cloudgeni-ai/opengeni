import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FIRST_PARTY_MCP_TOOL_NAMES } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
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
    chars: 32482,
    sha256: "cf2186486ae1ed4b763d1e561ad35f180dfb639c51bd0651e599edbf26c70914",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33356,
    sha256: "fbc72e0553473be091bad5909e333917ffdd98d863f998f3829395e50caf1731",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31072,
    sha256: "3df6f759666623fa95c4073d94f27ab968c3d1a1cb3ece970f393d1fb6a9a300",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31072,
    sha256: "3df6f759666623fa95c4073d94f27ab968c3d1a1cb3ece970f393d1fb6a9a300",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37199,
    sha256: "24fd630d921960efeba33b8c36a339f3505f8c2a3e8af8eede3c3a5fcf258fba",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36298,
    sha256: "72ccac47ae8a02f3d550bbf266f719dc7ab3a191168c21790a6587cdc3b535e6",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32482,
    sha256: "cf2186486ae1ed4b763d1e561ad35f180dfb639c51bd0651e599edbf26c70914",
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
