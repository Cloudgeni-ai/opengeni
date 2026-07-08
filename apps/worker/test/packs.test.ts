import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { CapabilityPack } from "@opengeni/contracts";
import { mergeRigDefaultVariableSetEnvironment, settingsWithPackSandboxImage, settingsWithRigImage, workspacePackRuntimeFromPacks } from "../src/activities/packs";

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
    // Cross-pack uniqueness is case-insensitive, matching the per-pack
    // contract rule.
    expect(() => workspacePackRuntimeFromPacks([
      pack({ id: "pack-a", skills: [infraSkill] }),
      pack({ id: "pack-b", skills: [{ ...infraSkill, name: "Infra-Ops" }] }),
    ])).toThrow("both declare a skill named");
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

describe("rig sandbox image precedence (M3): rig > pack > deployment", () => {
  const DEPLOYMENT = "opengeni-sandbox:local";
  const PACK = "ghcr.io/example/pack@sha256:pack";
  const RIG = "ghcr.io/example/rig@sha256:rig";

  // The exact composition agent-turn uses: rig applied OUTERMOST over pack over
  // the deployment default settings.
  function resolve(rigImage: string | null, packImage: string | null): Settings {
    const base = { dockerImage: DEPLOYMENT, modalImageRef: undefined } as unknown as Settings;
    return settingsWithRigImage(settingsWithPackSandboxImage(base, packImage), rigImage);
  }

  // All 8 combinations of {rig, pack, deployment} image presence. Deployment is
  // always present (the settings default), so the axis that varies is rig/pack.
  const matrix: Array<{ rig: string | null; pack: string | null; expected: string; expectModal: string | undefined }> = [
    { rig: RIG, pack: PACK, expected: RIG, expectModal: RIG },   // rig wins over pack+deployment
    { rig: RIG, pack: null, expected: RIG, expectModal: RIG },   // rig wins over deployment
    { rig: null, pack: PACK, expected: PACK, expectModal: PACK }, // pack wins over deployment
    { rig: null, pack: null, expected: DEPLOYMENT, expectModal: undefined }, // deployment default
  ];

  for (const { rig, pack, expected, expectModal } of matrix) {
    test(`rig=${rig ? "set" : "none"} pack=${pack ? "set" : "none"} → ${expected}`, () => {
      const resolved = resolve(rig, pack);
      expect(resolved.dockerImage).toBe(expected);
      expect(resolved.modalImageRef).toBe(expectModal as never);
    });
  }

  test("a rig with no image is a pass-through (pack/deployment chain unchanged)", () => {
    const base = { dockerImage: DEPLOYMENT, modalImageRef: undefined } as unknown as Settings;
    expect(settingsWithRigImage(base, null)).toBe(base);
  });
});

describe("rig default variable-set env layering (M3): session wins", () => {
  test("session values override rig defaults on a key collision; rig-only keys survive", () => {
    const rigDefaults = { SHARED: "rig", RIG_ONLY: "r" };
    const sessionValues = { SHARED: "session", SESSION_ONLY: "s" };
    expect(mergeRigDefaultVariableSetEnvironment(rigDefaults, sessionValues)).toEqual({
      SHARED: "session", // session wins the collision
      RIG_ONLY: "r",
      SESSION_ONLY: "s",
    });
  });

  test("is deterministic — identical inputs across turns produce identical env (stability)", () => {
    const rigDefaults = { A: "1", B: "2" };
    const sessionValues = { C: "3" };
    expect(mergeRigDefaultVariableSetEnvironment(rigDefaults, sessionValues))
      .toEqual(mergeRigDefaultVariableSetEnvironment(rigDefaults, sessionValues));
  });

  test("a rig-less turn (empty rig defaults) yields exactly the session values", () => {
    const sessionValues = { ONLY: "x" };
    expect(mergeRigDefaultVariableSetEnvironment({}, sessionValues)).toEqual(sessionValues);
  });
});
