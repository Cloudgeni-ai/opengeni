import { describe, expect, test } from "bun:test";
import {
  FRAMEWORK_SESSION_ADVERSARIAL_SEEDS,
  runFrameworkSessionAdversarialSeed,
  runFrameworkSessionBoundaryCases,
  runFrameworkSessionFaultProbes,
} from "./framework-session-adversarial-lib";

describe("framework session adversarial qualification", () => {
  for (const seed of FRAMEWORK_SESSION_ADVERSARIAL_SEEDS) {
    test(`seed 0x${seed.toString(16).padStart(8, "0")} matches every reference model`, () => {
      const result = runFrameworkSessionAdversarialSeed(seed);
      expect(result.eventOperations).toBe(64);
      expect(result.ownershipOperations).toBe(192);
      expect(result.humanInputCases).toBe(128);
      expect(result.manifestRows).toBe(114);
      expect(result.ownershipControllersCreated).toBe(result.ownershipControllersDestroyed);
      expect(Object.values(result.finalResources).every((value) => value === 0)).toBe(true);
    }, 30_000);
  }

  test("exercises the exact 10,000-event and 8 MiB browser boundaries", () => {
    const boundaries = runFrameworkSessionBoundaryCases();
    expect(boundaries.countRetained).toBe(10_000);
    expect(boundaries.countInput).toBeGreaterThan(boundaries.countRetained);
    expect(boundaries.byteInput).toBeGreaterThan(boundaries.byteBudget);
    expect(boundaries.byteRetained).toBeLessThanOrEqual(boundaries.byteBudget);
  }, 30_000);

  test("all seven qualification mutation probes fail closed", () => {
    const probes = runFrameworkSessionFaultProbes();
    expect(probes.map(({ id }) => id)).toEqual([
      "generation-fencing",
      "final-owner-refcount",
      "cursor-monotonicity",
      "idempotency-key-reuse",
      "optional-answer-preservation",
      "focus-restoration",
      "css-compatibility-copying",
    ]);
    expect(probes.every(({ detected, errors }) => detected && errors.length > 0)).toBe(true);
  });
});
