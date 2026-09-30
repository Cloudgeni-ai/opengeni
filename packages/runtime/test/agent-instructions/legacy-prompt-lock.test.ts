import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { testSettings } from "@opengeni/testing";
import { inspectPersistentAgentInstructions } from "../../src/index";
import { LEGACY_PROMPT_CASES } from "./legacy-cases";

/**
 * D19/AC1: a session without an agent configuration keeps byte-identical
 * system instructions. These digests were recorded from the composition that
 * existed before the modular composer; a change here is a legacy prompt change
 * and must never happen as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35247,
    sha256: "bb2f3b60838240a12c3189054c1f25224f6000fe1f0853d0bcb66af86a07f186",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36121,
    sha256: "a195bef064a88fe5cdc26326cf0639c7a508dbfd2a50b2514ee0d6fcc358a801",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33837,
    sha256: "80de396fd9b834e5080c3ddcf998e4c3bd5fa5c1b60d00e9f25f71ceac535b80",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33837,
    sha256: "80de396fd9b834e5080c3ddcf998e4c3bd5fa5c1b60d00e9f25f71ceac535b80",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39513,
    sha256: "607c7c7d4cf70a3e7ecd5bdf08ca0beefb3653516ab75e280b053cd5761d68ee",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38612,
    sha256: "4f07e4c1aecc88e66fd601039723986dd842595e051d706cba6d5daeed4bcdfd",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35247,
    sha256: "bb2f3b60838240a12c3189054c1f25224f6000fe1f0853d0bcb66af86a07f186",
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
        expect(createHash("sha256").update(inspection.composed).digest("hex")).toBe(
          locked.sha256,
        );
        expect(inspection.layers.map((layer) => layer.id).join(",")).toBe(locked.layers);
      });
    }
  }
});
