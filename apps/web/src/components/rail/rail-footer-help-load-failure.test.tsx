import { afterAll, describe, expect, mock, test } from "bun:test";

// A tab older than a deploy can no longer fetch the Help chunk it references.
mock.module("@/components/help-menu", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const { loadRailFooterMenuHarness } = await import("./rail-footer-menu-harness");
const { renderOpenAccountMenu, menuSequence, expectNoAdjacentSeparators, teardown } =
  await loadRailFooterMenuHarness();

afterAll(teardown);

describe("rail footer account menu when the Help chunk fails to load", () => {
  test("hides the Help section and keeps the rest of the menu working", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: "https://docs.example.test/",
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      expect(sequence).not.toContain("Help");
      expect(sequence.at(-1)).toContain("access");
    } finally {
      await unmount();
    }
  });
});
