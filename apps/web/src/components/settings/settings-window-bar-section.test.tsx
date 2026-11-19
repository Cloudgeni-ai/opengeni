import { describe, expect, test } from "bun:test";

import { SlidersHorizontalIcon } from "lucide-react";

import { settingsWindowBarSection } from "./settings-rail";
import { settingsSectionHome } from "./settings-sidebar";

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

describe("where the settings crumb in the window bar goes", () => {
  const item = (id: string) => ({ id, label: id, icon: SlidersHorizontalIcon, link: <a /> });
  const sections = [
    {
      id: "workspace",
      label: "Workspace",
      groups: [{ items: [] }, { items: [item("workspace:general"), item("workspace:models")] }],
    },
    {
      id: "organization",
      label: "Organization",
      groups: [{ items: [item("organization:people")] }],
    },
  ];

  test("opens the first page of the settings you're in", () => {
    expect(settingsSectionHome(sections, "workspace:models")?.id).toBe("workspace:general");
    expect(settingsSectionHome(sections, "organization:people")?.id).toBe("organization:people");
    expect(settingsSectionHome(sections, null)).toBeNull();
    expect(settingsSectionHome(sections, "account:security")).toBeNull();
  });
});
