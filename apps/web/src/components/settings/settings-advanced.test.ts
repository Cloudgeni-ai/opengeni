import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { CodeIcon, PanelLeftIcon, SlidersHorizontalIcon } from "lucide-react";

import { foldAdvancedSettings } from "./settings-advanced";
import type { SettingsRailSection } from "./settings-sidebar";

const link = createElement("a");
const item = (id: string, icon = SlidersHorizontalIcon) => ({ id, label: id, icon, link });

const SECTIONS: SettingsRailSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    groups: [
      {
        items: [
          item("workspace:general"),
          item("workspace:developer", CodeIcon),
          item("workspace:api-keys"),
        ],
      },
      { items: [item("workspace:/workspaces/$workspaceId/computer-use")] },
    ],
    searchOnly: [item("sidebar", PanelLeftIcon)],
  },
  {
    id: "organization",
    label: "Organization",
    groups: [
      { items: [item("organization:people")] },
      { items: [item("organization:billing"), item("organization:developer", CodeIcon)] },
    ],
  },
  {
    id: "account",
    label: "Your account",
    groups: [{ items: [item("account:security")] }],
  },
];

const ids = (sections: SettingsRailSection[]) =>
  sections.map((section) => [
    section.id,
    section.groups.map((group) => [group.label ?? null, group.items.map((each) => each.id)]),
  ]);

describe("foldAdvancedSettings", () => {
  test("rarely used pages go under one collapsed Advanced at the end, grouped by scope", () => {
    const folded = foldAdvancedSettings(SECTIONS);
    expect(ids(folded)).toEqual([
      ["workspace", [[null, ["workspace:general"]]]],
      [
        "organization",
        [
          [null, ["organization:people"]],
          [null, ["organization:billing"]],
        ],
      ],
      ["account", [[null, ["account:security"]]]],
      [
        "advanced",
        [
          [
            "Workspace",
            [
              "workspace:api-keys",
              "workspace:developer",
              "workspace:/workspaces/$workspaceId/computer-use",
            ],
          ],
          ["Organization", ["organization:developer"]],
        ],
      ],
    ]);
    const advanced = folded.at(-1);
    expect([advanced?.label, advanced?.collapsible]).toEqual(["Advanced", true]);
  });

  test("a rail without any Advanced entry is unchanged", () => {
    const plain = [SECTIONS[2]!];
    expect(ids(foldAdvancedSettings(plain))).toEqual(ids(plain));
  });

  test("a section emptied by Advanced stays for search only", () => {
    const folded = foldAdvancedSettings([
      { ...SECTIONS[0]!, groups: [{ items: [item("workspace:developer")] }] },
    ]);
    expect(folded[0]?.searchOnlySection).toBe(true);
    expect(folded[0]?.searchOnly?.length).toBe(1);
  });
});
