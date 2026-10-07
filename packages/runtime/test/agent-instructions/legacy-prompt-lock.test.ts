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
    chars: 32811,
    sha256: "49630a7d91e42db1e42109924d1343491cc25055c9367b04a1ef31c3746e7432",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33685,
    sha256: "fc077276c3e2e5a5309794df8cb3c4f76f4bf92f3c75547db981cd9aa3ed1f23",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31401,
    sha256: "1064719dd100153639e64164552e236a56c714a8717b066718e74df3439dd957",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31401,
    sha256: "1064719dd100153639e64164552e236a56c714a8717b066718e74df3439dd957",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37528,
    sha256: "b26170de12942ad98b78b9594f8fa38926bacf615c7984bd7acb4971e2e17ca5",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36627,
    sha256: "f207c82e96827411b028810dc62ab752845058c3b78359233ff8cfd4faea1a3f",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32811,
    sha256: "49630a7d91e42db1e42109924d1343491cc25055c9367b04a1ef31c3746e7432",
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
