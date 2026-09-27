import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { loadRailFooterMenuHarness } from "./rail-footer-menu-harness";

const { renderOpenAccountMenu, menuSequence, expectNoAdjacentSeparators, teardown } =
  await loadRailFooterMenuHarness();

afterAll(teardown);

beforeEach(() => {
  document.body.replaceChildren();
});

describe("rail footer account menu Help section", () => {
  test("follows Appearance directly without a doubled separator in local mode", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: "https://docs.example.test/",
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      const help = sequence.indexOf("Help");
      expect(help).toBeGreaterThan(0);
      expect(sequence[help - 1]).toBe("|");
      expect(sequence[help + 1]).toContain("Documentation");
      expect(sequence[help + 2]).toBe("|");
      expect(sequence.at(-1)).toContain("access");
    } finally {
      await unmount();
    }
  });

  test("opens its own separator after optional account items", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: true,
      documentationUrl: "https://docs.example.test/",
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      const help = sequence.indexOf("Help");
      expect(sequence[help - 2]).toBe("Analytics preferences");
      expect(sequence[help - 1]).toBe("|");
    } finally {
      await unmount();
    }
  });

  test("leaves no stray separator when the deployment hides documentation", async () => {
    const unmount = await renderOpenAccountMenu({
      managed: false,
      analytics: false,
      documentationUrl: null,
    });
    try {
      const sequence = menuSequence();
      expectNoAdjacentSeparators(sequence);
      expect(sequence).not.toContain("Help");
    } finally {
      await unmount();
    }
  });
});
