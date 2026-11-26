import { describe, expect, test } from "bun:test";

import {
  arrangeNav,
  keepSavedElsewhere,
  moveNavEntry,
  NAV_GROUP_KEY,
  stepNavEntry,
} from "./nav-order";

const defaults = {
  top: ["new_session", "inbox", "agents", "apps", NAV_GROUP_KEY],
  group: ["get_started", "capabilities", "automations"],
};

describe("rail entry order", () => {
  test("without a saved order the rail keeps its own", () => {
    expect(arrangeNav(defaults, null, null)).toEqual(defaults);
  });

  test("a saved order wins, and entries it doesn't name keep their place", () => {
    expect(
      arrangeNav(defaults, ["agents", "new_session", NAV_GROUP_KEY, "gone"], ["automations"]),
    ).toEqual({
      // inbox and apps follow the entry before them in the rail's own order.
      top: ["agents", "apps", "new_session", "inbox", NAV_GROUP_KEY],
      group: ["get_started", "capabilities", "automations"],
    });
  });

  test("an entry moved out of the group stays out", () => {
    expect(arrangeNav(defaults, ["capabilities", ...defaults.top], [])).toEqual({
      top: ["capabilities", ...defaults.top],
      group: ["get_started", "automations"],
    });
  });

  test("a drop moves an entry before or after another, or into the group", () => {
    expect(moveNavEntry(defaults, "apps", "new_session", "before")?.top).toEqual([
      "apps",
      "new_session",
      "inbox",
      "agents",
      NAV_GROUP_KEY,
    ]);
    expect(moveNavEntry(defaults, "agents", NAV_GROUP_KEY, "into")).toEqual({
      top: ["new_session", "inbox", "apps", NAV_GROUP_KEY],
      group: ["get_started", "capabilities", "automations", "agents"],
    });
    expect(moveNavEntry(defaults, "automations", "inbox", "after")).toEqual({
      top: ["new_session", "inbox", "automations", "agents", "apps", NAV_GROUP_KEY],
      group: ["get_started", "capabilities"],
    });
    // The group never goes inside itself: next to one of its entries is where it already is.
    expect(moveNavEntry(defaults, NAV_GROUP_KEY, "capabilities", "before")).toBeNull();
    expect(moveNavEntry(defaults, NAV_GROUP_KEY, "inbox", "before")?.top).toEqual([
      "new_session",
      NAV_GROUP_KEY,
      "inbox",
      "agents",
      "apps",
    ]);
    expect(moveNavEntry(defaults, "apps", "apps", "before")).toBeNull();
  });

  test("Alt+Arrow steps one place, into and out of an open group", () => {
    expect(stepNavEntry(defaults, "inbox", -1, false)?.top).toEqual([
      "inbox",
      "new_session",
      "agents",
      "apps",
      NAV_GROUP_KEY,
    ]);
    expect(stepNavEntry(defaults, "new_session", -1, false)).toBeNull();
    // Down past the open group's name goes inside it, first.
    expect(stepNavEntry(defaults, "apps", 1, true)).toEqual({
      top: ["new_session", "inbox", "agents", NAV_GROUP_KEY],
      group: ["apps", "get_started", "capabilities", "automations"],
    });
    // Closed, it passes the group.
    expect(stepNavEntry(defaults, "apps", 1, false)?.top).toEqual([
      "new_session",
      "inbox",
      "agents",
      NAV_GROUP_KEY,
      "apps",
    ]);
    // Up from the group's first entry leaves the group, above its name.
    expect(stepNavEntry(defaults, "get_started", -1, true)).toEqual({
      top: ["new_session", "inbox", "agents", "apps", "get_started", NAV_GROUP_KEY],
      group: ["capabilities", "automations"],
    });
  });

  test("New session and Inbox never go inside the group", () => {
    expect(moveNavEntry(defaults, "inbox", NAV_GROUP_KEY, "into")).toBeNull();
    // Dropped next to one of the group's entries, it stays next to the group instead.
    expect(moveNavEntry(defaults, "new_session", "capabilities", "after")).toEqual({
      top: ["inbox", "agents", "apps", NAV_GROUP_KEY, "new_session"],
      group: defaults.group,
    });
    // Stepping down past the open group passes it.
    const atEnd = { top: ["agents", "apps", "inbox", NAV_GROUP_KEY], group: defaults.group };
    expect(stepNavEntry(atEnd, "inbox", 1, true)?.top).toEqual([
      "agents",
      "apps",
      NAV_GROUP_KEY,
      "inbox",
    ]);
    // A saved order that put them inside is read with them at the top.
    expect(arrangeNav(defaults, null, ["inbox", "capabilities"]).group).not.toContain("inbox");
  });

  test("Alt+Arrow steps over entries the rail doesn't show", () => {
    const shown = (key: string) => key !== "agents";
    expect(stepNavEntry(defaults, "inbox", 1, false, shown)?.top).toEqual([
      "new_session",
      "agents",
      "apps",
      "inbox",
      NAV_GROUP_KEY,
    ]);
    // In a group, too.
    expect(
      stepNavEntry(defaults, "get_started", 1, true, (key) => key !== "capabilities")?.group,
    ).toEqual(["capabilities", "automations", "get_started"]);
    // Nothing shown beyond it: no move.
    expect(stepNavEntry(defaults, "apps", 1, false, (key) => key !== NAV_GROUP_KEY)).toBeNull();
  });

  test("a move in one interface keeps the saved places of entries only the other shows", () => {
    // Saved in the full interface: meetings at the top after agents, rigs in the group.
    const savedTop = ["new_session", "agents", "meetings", "inbox", "apps", NAV_GROUP_KEY];
    const savedGroup = ["get_started", "rigs", "capabilities", "automations"];
    // The simplified interface has neither; it moves apps up.
    const shown = arrangeNav(defaults, savedTop, savedGroup);
    const moved = moveNavEntry(shown, "apps", "new_session", "before")!;
    expect(keepSavedElsewhere(moved, savedTop, savedGroup)).toEqual({
      top: ["apps", "new_session", "agents", "meetings", "inbox", NAV_GROUP_KEY],
      group: ["get_started", "rigs", "capabilities", "automations"],
    });
    expect(keepSavedElsewhere(moved, null, null)).toEqual(moved);
  });
});
