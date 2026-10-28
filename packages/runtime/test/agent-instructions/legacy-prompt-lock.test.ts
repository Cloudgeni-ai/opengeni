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
 * variable_set_list / variableSetIds wording, and proceeding past routine local
 * blocks (Git identity, a missing base branch, human-only AGENTS.md steps).
 * Reviewed instruction changes update their locks;
 * Modular composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35421,
    sha256: "427f6d35769c77b202ef9aff1e0dd564a6869267f9120175a0cecc44d7e8ca50",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36295,
    sha256: "8f87c3e51814b2382701a0a77ea17e9f8903fca24b0c7757d9fa4ba5d13f6bcb",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 34011,
    sha256: "dd2c9d17fbcc95667d3a10be030b31e8aeea6a56924a8bd823f4e04c821c3620",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 34011,
    sha256: "dd2c9d17fbcc95667d3a10be030b31e8aeea6a56924a8bd823f4e04c821c3620",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 40138,
    sha256: "b1aa57f7f45222fe88cb23a222296379840fa22b017092b977d7aa27de855ac9",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 39237,
    sha256: "bf339125cf169d2a020e8d73a22f9bda59443b1e4af52f73f54d86367c4055e5",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35421,
    sha256: "427f6d35769c77b202ef9aff1e0dd564a6869267f9120175a0cecc44d7e8ca50",
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
