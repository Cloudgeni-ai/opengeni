import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { CapabilityPack } from "@opengeni/contracts";
import { settingsWithPackSandboxImage, workspacePackRuntimeFromPacks } from "../src/activities/packs";

function pack(overrides: Record<string, unknown>): CapabilityPack {
  return CapabilityPack.parse({
    id: "test-pack",
    name: "Test pack",
    description: "A pack used in worker runtime tests.",
    role: "infrastructure",
    category: "infrastructure",
    version: "0.1.0",
    ...overrides,
  });
}

const infraSkill = {
  name: "infra-ops",
  files: [
    { path: "SKILL.md", content: "---\nname: infra-ops\ndescription: Operate infrastructure safely.\n---\n# Infra ops\n" },
    { path: "references/runbook.md", content: "Runbook." },
  ],
};

describe("workspace pack runtime resolution", () => {
  test("resolves to the global-image fallback when no pack declares a runtime", () => {
    expect(workspacePackRuntimeFromPacks([])).toEqual({ sandboxImage: null, skills: [] });
    expect(workspacePackRuntimeFromPacks([pack({ id: "plain" })])).toEqual({ sandboxImage: null, skills: [] });
  });

  test("selects the single declared sandbox image and collects pack skills", () => {
    const runtime = workspacePackRuntimeFromPacks([
      pack({ id: "plain" }),
      pack({
        id: "infra-runtime",
        sandboxImage: "ghcr.io/example/infra-sandbox@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        skills: [infraSkill],
      }),
    ]);
    expect(runtime.sandboxImage).toBe("ghcr.io/example/infra-sandbox@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(runtime.skills).toEqual([
      {
        name: "infra-ops",
        description: null,
        files: infraSkill.files,
      },
    ]);
  });

  test("fails plainly when more than one enabled pack declares a sandbox image", () => {
    const packs = [
      pack({ id: "pack-b", sandboxImage: "example.com/b:1" }),
      pack({ id: "pack-a", sandboxImage: "example.com/a:1" }),
    ];
    expect(() => workspacePackRuntimeFromPacks(packs)).toThrow(
      "Multiple enabled packs declare a sandbox image (pack-a, pack-b). Only one enabled pack per workspace may declare sandboxImage; disable the others and retry.",
    );
  });

  test("fails plainly when two enabled packs declare the same skill name", () => {
    const packs = [
      pack({ id: "pack-a", skills: [infraSkill] }),
      pack({ id: "pack-b", skills: [infraSkill] }),
    ];
    expect(() => workspacePackRuntimeFromPacks(packs)).toThrow(
      'Enabled packs pack-a and pack-b both declare a skill named "infra-ops".',
    );
  });

  test("keeps explicit skill descriptions", () => {
    const runtime = workspacePackRuntimeFromPacks([
      pack({ id: "infra-runtime", skills: [{ ...infraSkill, description: "Operate workspace infrastructure." }] }),
    ]);
    expect(runtime.skills[0]?.description).toBe("Operate workspace infrastructure.");
  });
});

describe("pack sandbox image settings", () => {
  const settings = {
    dockerImage: "opengeni-sandbox:local",
    modalImageRef: undefined,
  } as unknown as Settings;

  test("leaves settings untouched without a pack image (global fallback)", () => {
    expect(settingsWithPackSandboxImage(settings, null)).toBe(settings);
  });

  test("overrides docker and modal image refs with the pack image", () => {
    const derived = settingsWithPackSandboxImage(settings, "ghcr.io/example/infra-sandbox@sha256:abc");
    expect(derived.dockerImage).toBe("ghcr.io/example/infra-sandbox@sha256:abc");
    expect(derived.modalImageRef).toBe("ghcr.io/example/infra-sandbox@sha256:abc");
    // The original settings object is never mutated.
    expect(settings.dockerImage).toBe("opengeni-sandbox:local");
    expect(settings.modalImageRef).toBeUndefined();
  });
});
