import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { testSettings } from "@opengeni/testing";
import { inspectPersistentAgentInstructions } from "../../src/index";
import { LEGACY_PROMPT_CASES } from "./legacy-cases";

/**
 * D19/AC1: a session without an agent configuration keeps byte-identical
 * system instructions. These digests track the reviewed upstream legacy
 * composition, including goal-completion, child-answer delivery and durable
 * Codemode approval guidance. Reviewed instruction changes update their locks;
 * Modular composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 37238,
    sha256: "8989b48d7d740d0970b172542eed5a4c73826f00d5cb37d91db5c7373a04d1a9",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 38112,
    sha256: "5b15e5664f29b33519ac9f97393b65a619ddce2937182142e69ee1d505d5f08a",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 35828,
    sha256: "b2322ad5c017d39ebd4e736b728387aef98c4d3239225d7ea4f16a2d1fd85e5b",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 35828,
    sha256: "b2322ad5c017d39ebd4e736b728387aef98c4d3239225d7ea4f16a2d1fd85e5b",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 41751,
    sha256: "74795f692616afe3b29737825ac4f997fc167d2a756b579608b8a85357fe188d",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 40850,
    sha256: "25abafbb12e00ba958c502c0663bc319ed3a580df6ec868cab4008b3bbce2d85",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 37238,
    sha256: "8989b48d7d740d0970b172542eed5a4c73826f00d5cb37d91db5c7373a04d1a9",
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
});
