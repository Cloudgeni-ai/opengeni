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
    chars: 32790,
    sha256: "1303106ca1d09f282097497b6a3eb98967f6c5eada050201ab9b3918529fac43",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 33664,
    sha256: "3dbb18a2e275bfe772f1f01e360499d639a1b20838f28253c74eba8f084fb007",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 31380,
    sha256: "6cbe2e2e76c65a463b08eda2e1fccc12c462628ea883f9910ec104a78826a25e",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 31380,
    sha256: "6cbe2e2e76c65a463b08eda2e1fccc12c462628ea883f9910ec104a78826a25e",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 37303,
    sha256: "f687c16a9ae60860e7b6dd5bd9bac550ab06727c08253ad1410017cd4289fc32",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 36402,
    sha256: "1755927b79f72f79463f80291cf35b3a14065cf00adac531d20569277a325a99",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 32790,
    sha256: "1303106ca1d09f282097497b6a3eb98967f6c5eada050201ab9b3918529fac43",
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
