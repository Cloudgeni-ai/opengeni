import { expect, test } from "bun:test";
import { AttachedBrowserInventorySnapshot, AttachedBrowserBridge } from "../src/interaction";

test("native base64url bridge generations survive inventory and discovery unchanged", () => {
  // The native bridge emits URL_SAFE_NO_PAD random bytes, including either prefix.
  for (const bridgeGeneration of ["_native-generation", "-native-generation", "old-generation"]) {
    expect(
      AttachedBrowserBridge.parse({
        enrollmentId: "11111111-1111-4111-8111-111111111111",
        state: "online",
        bridgeGeneration,
        inventoryRevision: 1,
        connectedProfileCount: 0,
        lastSeenAt: "2026-09-27T00:00:00Z",
      }).bridgeGeneration,
    ).toBe(bridgeGeneration);
    expect(
      AttachedBrowserInventorySnapshot.parse({ bridgeGeneration, revision: 1, devices: [] })
        .bridgeGeneration,
    ).toBe(bridgeGeneration);
  }
});

test("bridge generation still rejects whitespace, path separators, empty and oversized values", () => {
  for (const bridgeGeneration of ["", "../other", "a/b", "a b", "a\n", "a".repeat(257)]) {
    expect(
      AttachedBrowserInventorySnapshot.safeParse({ bridgeGeneration, revision: 1, devices: [] })
        .success,
    ).toBe(false);
  }
});
