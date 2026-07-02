import { describe, expect, test } from "bun:test";
import { listCapabilityPacks } from "@opengeni/core";

describe("built-in capability packs", () => {
  // The worker's pack-scoped runtime resolution
  // (apps/worker/src/activities/packs.ts) only reads manifest-registered
  // packs from the database. That stays correct only while built-in packs
  // never declare a sandbox image or skills; a built-in pack that needs
  // either must move pack resolution into a shared module first.
  test("never declare a pack-scoped runtime", () => {
    for (const pack of listCapabilityPacks()) {
      expect(pack.sandboxImage).toBeUndefined();
      expect(pack.skills).toEqual([]);
    }
  });
});
