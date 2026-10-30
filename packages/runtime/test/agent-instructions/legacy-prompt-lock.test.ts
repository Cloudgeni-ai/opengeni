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
 * routine, reversible steps, and the Skill index reading Skills by name;
 * `unattended` pins the unattended-session CORE paragraph, which no other case
 * carries. Reviewed instruction changes update their locks; Modular
 * composition must never change legacy bytes as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 34832,
    sha256: "19991757ee6d07bb83b372cd4452c7f42e723f655e01a908ba0eca6a9bd690c1",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 35706,
    sha256: "2480f26f37db617bac441f498e960a31318da80157491e2fc510d962b5a17e0d",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 33422,
    sha256: "5a627a6207edef18f945a5fca5dd635c9f07ce806350e47e04dcf54f6059d422",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 33422,
    sha256: "5a627a6207edef18f945a5fca5dd635c9f07ce806350e47e04dcf54f6059d422",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39634,
    sha256: "59637c7cebe3d8cde03eafcfc70db0347a8f307ec2a5871f33e65d32e1adda81",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38648,
    sha256: "625a7d9579ea60e699fb84dd05d8eb994c09e69ec01f0adcfc7f73ad6013c66b",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 34832,
    sha256: "19991757ee6d07bb83b372cd4452c7f42e723f655e01a908ba0eca6a9bd690c1",
    layers: "operational_contract,persona_and_core",
  },
  unattended: {
    chars: 35370,
    sha256: "e1b4de94278a9bd63ada5e45a9ec1a946d5cc17b59be75039133511a05a8362d",
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
