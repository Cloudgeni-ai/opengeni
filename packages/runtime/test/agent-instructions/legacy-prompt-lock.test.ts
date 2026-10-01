import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { testSettings } from "@opengeni/testing";
import { inspectPersistentAgentInstructions } from "../../src/index";
import { LEGACY_PROMPT_CASES } from "./legacy-cases";

/**
 * D19/AC1: a session without an agent configuration keeps byte-identical
 * system instructions. These digests track the reviewed upstream legacy
 * composition, including #3053's goal-completion handoff guidance. All fourteen
 * cases were verified byte-for-byte against main 709eef238d52 before refreshing
 * the locks. Modular composition must never change them as a side effect.
 */
const LOCKED: Record<string, { chars: number; sha256: string; layers: string }> = {
  default: {
    chars: 35612,
    sha256: "7228c35963dc15d726cf29c3a37ac39a09bde07efd686273b6bbe754f29e376c",
    layers: "operational_contract,persona_and_core",
  },
  environment_and_rig: {
    chars: 36486,
    sha256: "1c49a225b8014a8cd30b81e122f1dba81baa9ed1486987602e236be6e181a671",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_with_marker: {
    chars: 34202,
    sha256: "6e64fb97e0358107de81756c80052fc1511c6209e1017a916efcf89f78132e2c",
    layers: "operational_contract,persona_and_core",
  },
  custom_template_without_marker: {
    chars: 34202,
    sha256: "6e64fb97e0358107de81756c80052fc1511c6209e1017a916efcf89f78132e2c",
    layers: "operational_contract,persona_and_core",
  },
  extras_without_governance: {
    chars: 39878,
    sha256: "6662ce3894077d9378569d55cff941f4fde18a19bd5d95b3d4af72555639da63",
    layers:
      "operational_contract,persona_and_core,codemode,code_search,git_bindings,workspace_memory,skill_catalog,session_instructions",
  },
  extras_with_governance: {
    chars: 38977,
    sha256: "b3dd4ac788d34b13978e755572475b4f2a85c8508b0121a2561dceab8eb618ef",
    layers:
      "operational_contract,persona_and_core,workspace_governance,session_instructions,codemode,code_search,workspace_memory",
  },
  selfhosted_with_bindings: {
    chars: 35612,
    sha256: "7228c35963dc15d726cf29c3a37ac39a09bde07efd686273b6bbe754f29e376c",
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
