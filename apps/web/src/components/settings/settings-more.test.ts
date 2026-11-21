import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { KeyRoundIcon, PanelLeftIcon, SlidersHorizontalIcon } from "lucide-react";

import { foldSettingsRail } from "./settings-more";
import type { SettingsRailSection } from "./settings-sidebar";

const link = createElement("a");
const item = (id: string, icon = SlidersHorizontalIcon) => ({ id, label: id, icon, link });

const SECTIONS: SettingsRailSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    groups: [{ items: [item("workspace:general"), item("workspace:keys", KeyRoundIcon)] }],
    searchOnly: [item("sidebar", PanelLeftIcon)],
  },
  {
    id: "account",
    label: "Your account",
    groups: [{ items: [item("account:security")] }],
  },
  { id: "organization", label: "Organization", meta: "Org", groups: [] },
];

const ids = (sections: SettingsRailSection[]) =>
  sections.map((section) => [
    section.id,
    section.groups.flatMap((group) => group.items.map((each) => each.id)),
  ]);

describe("foldSettingsRail", () => {
  test("unset keeps every entry at the top, without More", () => {
    const folded = foldSettingsRail(SECTIONS, null, () => {});
    expect(ids(folded)).toEqual(ids(SECTIONS));
    expect(folded.some((section) => section.collapsible)).toBe(false);
  });

  test("entries outside the list go under one collapsed More at the end", () => {
    const folded = foldSettingsRail(SECTIONS, ["workspace:general"], () => {});
    expect(ids(folded)).toEqual([
      ["workspace", ["workspace:general"]],
      ["organization", []],
      ["more", ["workspace:keys", "account:security"]],
    ]);
    expect(folded.at(-1)?.collapsible).toBe(true);
  });

  test("a section emptied by More stays for search only", () => {
    const folded = foldSettingsRail(SECTIONS, ["account:security"], () => {});
    const workspace = folded.find((section) => section.id === "workspace");
    expect(workspace?.searchOnlySection).toBe(true);
    expect(workspace?.searchOnly?.length).toBe(1);
  });

  test("row menus move entries and save the new list", () => {
    const saved: string[][] = [];
    const folded = foldSettingsRail(SECTIONS, ["workspace:general"], (shown) => saved.push(shown));
    folded[0]?.groups[0]?.items[0]?.place?.run();
    folded.at(-1)?.groups[0]?.items[1]?.place?.run();
    expect(saved).toEqual([[], ["workspace:general", "account:security"]]);
  });
});
