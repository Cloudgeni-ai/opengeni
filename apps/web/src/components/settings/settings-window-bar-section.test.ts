import { describe, expect, test } from "bun:test";

import { settingsWindowBarSection } from "./settings-rail";

describe("which settings the macOS window bar names", () => {
  test("names workspace, organization and account settings apart", () => {
    expect(settingsWindowBarSection({ kind: "settings", section: "general" })).toBe(
      "Workspace settings",
    );
    expect(settingsWindowBarSection({ kind: "settings", section: null })).toBe(
      "Workspace settings",
    );
    expect(settingsWindowBarSection({ kind: "organization", section: null })).toBe(
      "Organization settings",
    );
    expect(settingsWindowBarSection({ kind: "account" })).toBe("Account settings");
    expect(settingsWindowBarSection({ kind: "settings", section: "mine" })).toBe(
      "Account settings",
    );
  });
});
