import { describe, expect, test } from "bun:test";

import {
  SHARED_TEST_PG_IMAGE,
  sharedTestContainerNeedsReplacement,
  sharedTestContainerRunArgs,
  sharedTestContainerSpec,
} from "../src/shared-pg";

describe("shared test PostgreSQL container", () => {
  test("gets enough shared memory for parallel queries across hundreds of connections", () => {
    const args = sharedTestContainerRunArgs();
    const image = args.indexOf(SHARED_TEST_PG_IMAGE);
    expect(image).toBeGreaterThan(0);
    // Docker flags must precede the image; anything after it goes to postgres.
    expect(args.slice(0, image)).toContain("--shm-size=1g");
    expect(args.slice(image + 1)).toEqual([
      "-c",
      "max_connections=1000",
      "-c",
      "shared_buffers=256MB",
    ]);
  });

  test("stamps its run spec on the container", () => {
    const args = sharedTestContainerRunArgs();
    const image = args.indexOf(SHARED_TEST_PG_IMAGE);
    expect(sharedTestContainerSpec()).toMatch(/^[0-9a-f]{16}$/u);
    expect(args.slice(0, image)).toContain(
      `com.opengeni.shared-pg-spec=${sharedTestContainerSpec()}`,
    );
  });

  test("an outdated container is replaced only while nobody holds it", () => {
    const current = sharedTestContainerSpec();
    // A container from before the spec label (for example 64 MB shm) upgrades when idle.
    expect(sharedTestContainerNeedsReplacement({ runningSpec: "", liveHolders: 0 })).toBe(true);
    expect(
      sharedTestContainerNeedsReplacement({ runningSpec: "0123456789abcdef", liveHolders: 0 }),
    ).toBe(current !== "0123456789abcdef");
    // In use: never disturbed; a later idle acquire upgrades it.
    expect(sharedTestContainerNeedsReplacement({ runningSpec: "", liveHolders: 1 })).toBe(false);
    // Current spec, or Docker could not answer: keep it.
    expect(sharedTestContainerNeedsReplacement({ runningSpec: current, liveHolders: 0 })).toBe(
      false,
    );
    expect(sharedTestContainerNeedsReplacement({ runningSpec: null, liveHolders: 0 })).toBe(false);
  });
});
