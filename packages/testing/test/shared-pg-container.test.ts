import { describe, expect, test } from "bun:test";

import { SHARED_TEST_PG_IMAGE, sharedTestContainerRunArgs } from "../src/shared-pg";

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
});
