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
 * answering privacy questions from `privacy_facts`; `unattended` pins the
 * unattended-session CORE paragraph, which no other case carries. Reviewed
 * instruction changes update their locks; Modular composition must never
 * change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35041,
    sha256: "562cadb329c4318bb87b11d67a2693cff457d4a045528a6cf13bb711e56fa992",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 35915,
    sha256: "766f2501adc3aa3e827ead70701064fa49219e4708b6845024906599fd2098e0",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33631,
    sha256: "a347afab5df96fb6256bcf95362e4dbc11bc6a658a03cb777a3c965c3d771a87",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33631,
    sha256: "a347afab5df96fb6256bcf95362e4dbc11bc6a658a03cb777a3c965c3d771a87",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39843,
    sha256: "837218a365fce3af928e94ac533e269d6a9d9bcd1587caff2cf9bd7301928385",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38857,
    sha256: "a0c773225131776df57fc1ea66da3fd12b2bce7c6c3ee652b57f8f9065a11dcf",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35041,
    sha256: "562cadb329c4318bb87b11d67a2693cff457d4a045528a6cf13bb711e56fa992",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 35579,
    sha256: "723609f3a1a252e940f01cd753d0a11443adcac80fa11e4418489b4a8dcaa25d",
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
