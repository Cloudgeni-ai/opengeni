import { describe, expect, test } from "bun:test";

const primaryNav = await Bun.file(new URL("./primary-nav.tsx", import.meta.url)).text();
const railShell = await Bun.file(new URL("./rail-shell.tsx", import.meta.url)).text();

describe("session-first rail density", () => {
  test("defaults short viewports to compact shortcuts and persists the user's choice", () => {
    expect(primaryNav).toContain("window.innerHeight >= 760");
    expect(primaryNav).toContain("window.localStorage.getItem(WORKSPACE_SHORTCUTS_EXPANDED_KEY)");
    expect(primaryNav).toContain("window.localStorage.setItem(WORKSPACE_SHORTCUTS_EXPANDED_KEY");
    expect(primaryNav).toContain("aria-expanded={shortcutsExpanded}");
  });

  test("moves workspace shortcuts out of the mobile Sessions tab", () => {
    expect(primaryNav).toContain("rail.isMobile ? null");
    expect(railShell).toContain('<WorkspaceShortcutLinks className="px-2" />');
  });
});
