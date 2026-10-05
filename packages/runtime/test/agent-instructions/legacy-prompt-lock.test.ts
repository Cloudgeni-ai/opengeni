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
    chars: 35834,
    sha256: "f00f3c214e6ee42ad550cd48e259f5ec3a9ca8e1a9c4680c8a4228ec4c97cf79",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36708,
    sha256: "6dd8f6f60c0666f8fd6d4a2d1ae72389857d2fd4895dba8cd404f52bd605e2cf",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 34424,
    sha256: "78004e166a240e87f3023623549a16c055c9a6c22417bff1ea0a21393b44848c",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 34424,
    sha256: "78004e166a240e87f3023623549a16c055c9a6c22417bff1ea0a21393b44848c",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 40347,
    sha256: "4f54a66fc26f3cb5d8d274524122d243c6d6e240fbadf871421689e7f6b9ae2d",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 39446,
    sha256: "2d37048a573bd8d946a3758f0f3df2e5d6b8eea54a4de01a94aff5dbe5a91dfc",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35834,
    sha256: "f00f3c214e6ee42ad550cd48e259f5ec3a9ca8e1a9c4680c8a4228ec4c97cf79",
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
