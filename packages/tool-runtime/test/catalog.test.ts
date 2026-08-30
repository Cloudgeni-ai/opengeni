import { describe, expect, test } from "bun:test";
import { CanonicalToolDescriptor } from "@opengeni/contracts";
import {
  CanonicalToolCatalogBoundsError,
  CanonicalToolCatalogCollisionError,
  allocateCanonicalToolProjections,
  allocateProgrammaticPaths,
  assertCanonicalToolCatalogBounds,
  assertCanonicalToolDescriptorUniqueness,
  canonicalSafeReadToolIneligibility,
  canonicalToolIdentitiesEqual,
  canonicalToolIdentityKey,
  digestCanonicalJson,
  encodeCanonicalJson,
  isCanonicalSafeReadToolEligible,
  sortCanonicalToolDescriptors,
} from "../src";

function descriptor(serverId: string, toolName: string) {
  return CanonicalToolDescriptor.parse({
    identity: { serverId, toolName },
    modelName: `${serverId}__${toolName}`,
    programmaticPath: [serverId, toolName],
    inputSchema: { type: "object", additionalProperties: false },
    source: "docs",
    effect: "read",
    replaySafety: "safe",
    openWorld: false,
    approval: "none",
    supportedSurfaces: ["model", "codemode", "app"],
    requiredPermissions: [],
  });
}

describe("canonical tool catalog mechanics", () => {
  test("keys and compares opaque identities without parsing display projections", () => {
    const identity = { serverId: "docs", toolName: "search" };
    expect(canonicalToolIdentityKey(identity)).toBe("docs\u0000search");
    expect(canonicalToolIdentitiesEqual(identity, { ...identity })).toBe(true);
    expect(canonicalToolIdentitiesEqual(identity, { ...identity, toolName: "fetch" })).toBe(false);
  });

  test("allocates the exact collision-safe Code Mode-compatible paths", () => {
    const inputs = [
      { identity: { serverId: "foo-bar", toolName: "1-search" } },
      { identity: { serverId: "foo_bar", toolName: "1_search" } },
      { identity: { serverId: "constructor", toolName: "__proto__" } },
    ];
    const paths = allocateProgrammaticPaths(inputs);
    expect(paths[0]![0]).toBe("foo_bar");
    expect(paths[0]![1]).toMatch(/^_1_search_[0-9a-f]{10}$/u);
    expect(paths[1]![1]).toMatch(/^_1_search_[0-9a-f]{10}$/u);
    expect(paths[0]).not.toEqual(paths[1]);
    expect(paths[2]).toEqual(["_constructor", "___proto__"]);
  });

  test("allocates model and programmatic projections together", () => {
    const projections = allocateCanonicalToolProjections([
      {
        identity: { serverId: "one", toolName: "search" },
        modelName: "search",
        programmaticPath: ["tools", "search"],
      },
      {
        identity: { serverId: "two", toolName: "search" },
        modelName: "search",
        programmaticPath: ["tools", "search"],
      },
    ]);
    expect(projections[0]!.modelName).toMatch(/^search_[0-9a-f]{10}$/u);
    expect(projections[1]!.modelName).toMatch(/^search_[0-9a-f]{10}$/u);
    expect(projections[0]!.modelName).not.toBe(projections[1]!.modelName);
    expect(projections[0]!.programmaticPath).not.toEqual(projections[1]!.programmaticPath);
  });

  test("keeps the neutral default collision-safe while exposing legacy rejection parity", () => {
    const colliding = [
      { identity: { serverId: "foo-bar", toolName: "search" } },
      { identity: { serverId: "foo_bar", toolName: "search" } },
    ];
    const firstAllocation = allocateProgrammaticPaths(colliding, {
      resolveSecondaryCollisions: false,
    });
    const inputs = [
      ...colliding,
      {
        identity: { serverId: "other", toolName: "exact" },
        programmaticPath: firstAllocation[0]!,
      },
    ];
    const legacy = allocateProgrammaticPaths(inputs, { resolveSecondaryCollisions: false });
    const safe = allocateProgrammaticPaths(inputs);
    expect(new Set(legacy.map((path) => path.join("."))).size).toBeLessThan(legacy.length);
    expect(new Set(safe.map((path) => path.join("."))).size).toBe(safe.length);
  });

  test("sorts and digests canonical JSON deterministically", () => {
    const sorted = sortCanonicalToolDescriptors([
      descriptor("zeta", "fetch"),
      descriptor("alpha", "search"),
    ]);
    expect(sorted.map((entry) => entry.identity.serverId)).toEqual(["alpha", "zeta"]);
    expect(encodeCanonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(digestCanonicalJson({ z: 1, a: 2 })).toBe(digestCanonicalJson({ a: 2, z: 1 }));
  });

  test("fails safe-read eligibility closed on every authoritative safety dimension", () => {
    const safe = descriptor("docs", "search");
    expect(isCanonicalSafeReadToolEligible(safe, "app")).toBe(true);
    expect(canonicalSafeReadToolIneligibility(safe, "app")).toBeNull();

    const cases = [
      [{ ...safe, supportedSurfaces: ["model"] }, "surface_ineligible"],
      [{ ...safe, effect: "unknown" }, "effect_ineligible"],
      [{ ...safe, effect: "write" }, "effect_ineligible"],
      [{ ...safe, effect: "destructive" }, "effect_ineligible"],
      [{ ...safe, replaySafety: "unknown" }, "replay_ineligible"],
      [{ ...safe, replaySafety: "unsafe" }, "replay_ineligible"],
      [{ ...safe, approval: "human" }, "approval_required"],
      [{ ...safe, approval: "policy" }, "approval_required"],
      [{ ...safe, openWorld: true }, "open_world_ineligible"],
    ] as const;
    for (const [candidate, reason] of cases) {
      expect(canonicalSafeReadToolIneligibility(candidate, "app")).toBe(reason);
      expect(isCanonicalSafeReadToolEligible(candidate, "app")).toBe(false);
    }

    const favorableHints = {
      ...safe,
      effect: "unknown" as const,
      replaySafety: "unknown" as const,
      openWorld: true,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    };
    expect(canonicalSafeReadToolIneligibility(favorableHints, "app")).toBe("effect_ineligible");
  });

  test("detects duplicate projections and caller-owned bounds", () => {
    const first = descriptor("docs", "search");
    expect(() => assertCanonicalToolDescriptorUniqueness([first, first])).toThrow(
      CanonicalToolCatalogCollisionError,
    );
    expect(() =>
      assertCanonicalToolCatalogBounds(
        [first],
        { entries: [first] },
        {
          maxEntries: 0,
          maxBytes: 1_000_000,
          maxPathSegments: 8,
        },
      ),
    ).toThrow(CanonicalToolCatalogBoundsError);
  });
});
