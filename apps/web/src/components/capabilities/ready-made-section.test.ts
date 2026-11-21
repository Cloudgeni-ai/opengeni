import { describe, expect, test } from "bun:test";

import { readyMadeGroups, type ReadyMadeEntry } from "./ready-made-section";

function entry(
  key: string,
  team: string | null,
  kind: ReadyMadeEntry["kind"] = "agent",
): ReadyMadeEntry {
  return { key, kind, name: key, description: `About ${key}`, team, icon: null, added: false };
}

describe("ready-made groups", () => {
  test("groups by each entry's own team, alphabetically, with no team last", () => {
    const groups = readyMadeGroups([
      entry("a", "Sales"),
      entry("b", null),
      entry("c", "Engineering"),
      entry("d", "Sales", "skill"),
      entry("e", "  "),
    ]);
    expect(groups.map((group) => group.team)).toEqual(["Engineering", "Sales", "More"]);
    expect(groups[1]!.entries.map((each) => each.key)).toEqual(["a", "d"]);
    expect(groups[2]!.entries.map((each) => each.key)).toEqual(["b", "e"]);
  });

  test("the page search matches name, description, team and kind", () => {
    const entries = [entry("triage", "Engineering"), entry("notes", "Product", "app")];
    expect(readyMadeGroups(entries, "product").map((group) => group.team)).toEqual(["Product"]);
    expect(readyMadeGroups(entries, "app")[0]!.entries.map((each) => each.key)).toEqual(["notes"]);
    expect(readyMadeGroups(entries, "nothing")).toEqual([]);
  });
});
