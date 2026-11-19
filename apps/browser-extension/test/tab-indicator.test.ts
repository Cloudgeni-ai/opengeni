import { describe, expect, test } from "bun:test";
import {
  TabIndicator,
  parseTabIndicatorState,
  type IndicatorTab,
  type TabGroupColor,
  type TabIndicatorChrome,
  type TabIndicatorState,
} from "../src/tab-indicator";

type Group = { id: number; windowId: number; title: string; color: TabGroupColor };

/** Chrome's tab strip as far as groups go: a group disappears with its last
 * tab, a group's tabs stay in its window, and pinned tabs or tabs of popup
 * windows cannot be grouped. */
class TabStrip {
  readonly tabs = new Map<number, Omit<IndicatorTab, "index"> & { id: number }>();
  // Every tab, in tab strip order; a tab's index counts its window's tabs.
  readonly order: number[] = [];
  readonly groups = new Map<number, Group>();
  readonly popupWindows = new Set<number>();
  private nextGroup = 100;
  dragging = 0;

  constructor(tabs: { id: number; windowId?: number; groupId?: number; pinned?: boolean }[]) {
    for (const tab of tabs)
      this.tabs.set(tab.id, {
        id: tab.id,
        windowId: tab.windowId ?? 1,
        groupId: tab.groupId ?? -1,
        pinned: tab.pinned ?? false,
      });
    this.order.push(...tabs.map((tab) => tab.id));
  }

  /** The window's tabs, in order. */
  strip(windowId = 1): number[] {
    return this.order.filter((id) => this.tabs.get(id)!.windowId === windowId);
  }

  private indexOf(tabId: number): number {
    return this.strip(this.tabs.get(tabId)!.windowId).indexOf(tabId);
  }

  private view(tabId: number): IndicatorTab & { id: number } {
    return { ...this.tab(tabId), index: this.indexOf(tabId) };
  }

  /** Puts a tab at an index of its window. */
  private place(tabId: number, index: number) {
    const windowTabs = this.strip(this.tabs.get(tabId)!.windowId).filter((id) => id !== tabId);
    this.order.splice(this.order.indexOf(tabId), 1);
    const before = windowTabs[index];
    this.order.splice(
      before === undefined ? this.order.length : this.order.indexOf(before),
      0,
      tabId,
    );
  }

  userGroup(windowId: number, title: string): number {
    const id = this.nextGroup++;
    this.groups.set(id, { id, windowId, title, color: "blue" });
    return id;
  }

  /** What a person does: move a tab to a group, or out of any. */
  move(tabId: number, groupId: number) {
    this.tabs.get(tabId)!.groupId = groupId;
    this.prune();
  }

  close(tabId: number) {
    this.tabs.delete(tabId);
    this.order.splice(this.order.indexOf(tabId), 1);
    this.prune();
  }

  groupOf(tabId: number): Group | null {
    return this.groups.get(this.tabs.get(tabId)?.groupId ?? -1) ?? null;
  }

  private prune() {
    for (const id of this.groups.keys()) {
      if (![...this.tabs.values()].some((tab) => tab.groupId === id)) this.groups.delete(id);
    }
  }

  private tab(tabId: number) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }

  private busy() {
    if (this.dragging > 0) {
      this.dragging -= 1;
      throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
    }
  }

  readonly api: TabIndicatorChrome = {
    tabs: {
      get: async (tabId) => this.view(tabId),
      query: async (query) =>
        [...this.tabs.values()]
          .filter((tab) =>
            "groupId" in query ? tab.groupId === query.groupId : tab.windowId === query.windowId,
          )
          .map((tab) => this.view(tab.id)),
      move: async (tabId, { index }) => {
        this.busy();
        const count = this.strip(this.tab(tabId).windowId).length;
        if (index < 0 || index >= count) throw new Error("Invalid index.");
        this.place(tabId, index);
        return this.view(tabId);
      },
      group: async ({ tabIds, groupId, createProperties }) => {
        this.busy();
        const tabs = tabIds.map((id) => this.tab(id));
        if (tabs.some((tab) => tab.pinned)) throw new Error("Cannot group pinned tabs.");
        if (tabs.some((tab) => this.popupWindows.has(tab.windowId)))
          throw new Error("Tabs can only be moved to and from normal windows.");
        let id = groupId;
        if (id === undefined) {
          id = this.nextGroup++;
          this.groups.set(id, {
            id,
            windowId: createProperties?.windowId ?? tabs[0]!.windowId,
            title: "",
            color: "grey",
          });
        }
        const group = this.groups.get(id);
        if (!group) throw new Error(`No group with id: ${id}.`);
        for (const tab of tabs) {
          // Joining a group moves a tab next to the group's other tabs.
          const members = this.strip(group.windowId).filter(
            (other) => other !== tab.id && this.tabs.get(other)!.groupId === id,
          );
          tab.windowId = group.windowId;
          tab.groupId = id;
          if (members.length > 0) this.place(tab.id, this.indexOf(members.at(-1)!) + 1);
        }
        this.prune();
        return id;
      },
      ungroup: async (tabIds) => {
        this.busy();
        for (const id of tabIds) this.tab(id).groupId = -1;
        this.prune();
      },
    },
    tabGroups: {
      get: async (groupId) => {
        const group = this.groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        return group;
      },
      query: async ({ title, color }) =>
        [...this.groups.values()].filter((group) => group.title === title && group.color === color),
      update: async (groupId, properties) => {
        Object.assign(this.groups.get(groupId)!, properties);
        return this.groups.get(groupId);
      },
    },
  };
}

function indicator(strip: TabStrip, saved: TabIndicatorState[] = []) {
  const timers: (() => void)[] = [];
  const instance = new TabIndicator(strip.api, {
    title: "Opengeni",
    color: "grey",
    releaseDelayMs: 2_000,
    onChange: (state) => saved.push(state),
    setTimeout: (callback, ms) => {
      // Drag retries run at once; release delays wait for `elapse`.
      if (ms < 2_000) {
        queueMicrotask(callback);
        return -1;
      }
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimeout: (timer) => {
      if (typeof timer === "number" && timer >= 0) timers[timer] = () => {};
    },
  });
  return {
    indicator: instance,
    /** The release delay passes. */
    elapse: async () => {
      for (const run of timers.splice(0)) run();
      await instance.settled();
    },
  };
}

describe("the controlled tabs' group", () => {
  test("a controlled tab joins a group named after the product, and leaves it when released", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const { indicator: tabs, elapse } = indicator(strip);
    await tabs.show(2);
    expect(strip.groupOf(2)).toMatchObject({ title: "Opengeni", color: "grey", windowId: 1 });
    expect(strip.groupOf(1)).toBeNull();
    expect(strip.groupOf(3)).toBeNull();

    tabs.release(2);
    await tabs.settled();
    // Still shown until control stays ended for the release delay.
    expect(strip.groupOf(2)?.title).toBe("Opengeni");
    await elapse();
    expect(strip.groupOf(2)).toBeNull();
    expect(strip.groups.size).toBe(0);
    expect(tabs.state()).toEqual({ tabs: {}, declined: [] });
  });

  test("control that ends for a moment keeps the tab in the group", async () => {
    const strip = new TabStrip([{ id: 1 }]);
    const { indicator: tabs, elapse } = indicator(strip);
    await tabs.show(1);
    const group = strip.groupOf(1)!.id;
    tabs.release(1);
    await tabs.show(1);
    await elapse();
    expect(strip.groupOf(1)?.id).toBe(group);
  });

  test("one group per window, shared by every controlled tab in it", async () => {
    const strip = new TabStrip([
      { id: 1 },
      { id: 2 },
      { id: 3, windowId: 2 },
      { id: 4, windowId: 2 },
    ]);
    const { indicator: tabs, elapse } = indicator(strip);
    await Promise.all([tabs.show(1), tabs.show(2), tabs.show(3), tabs.show(4)]);
    expect(strip.groupOf(1)!.id).toBe(strip.groupOf(2)!.id);
    expect(strip.groupOf(3)!.id).toBe(strip.groupOf(4)!.id);
    expect(strip.groupOf(1)!.id).not.toBe(strip.groupOf(3)!.id);
    expect(strip.groupOf(3)).toMatchObject({ title: "Opengeni", windowId: 2 });

    // Releasing one keeps the group for the other.
    tabs.release(1);
    await elapse();
    expect(strip.groupOf(1)).toBeNull();
    expect(strip.groupOf(2)?.title).toBe("Opengeni");
  });

  test("a tab taken from the person's own group goes back to it", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const work = strip.userGroup(1, "Work");
    strip.move(1, work);
    strip.move(2, work);
    const { indicator: tabs, elapse } = indicator(strip);
    await tabs.show(2);
    expect(strip.groupOf(2)?.title).toBe("Opengeni");
    expect(strip.groupOf(1)?.title).toBe("Work");
    tabs.release(2);
    await elapse();
    expect(strip.groupOf(2)?.id).toBe(work);
  });

  test("a tab the group moved goes back to where it was", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    const { indicator: tabs } = indicator(strip);
    await tabs.show(4);
    await tabs.show(2);
    expect(strip.strip()).toEqual([1, 3, 4, 2]);
    await tabs.releaseNow(2);
    expect(strip.strip()).toEqual([1, 2, 3, 4]);
    expect(strip.groupOf(2)).toBeNull();
    // A tab the group did not move stays where it is.
    await tabs.releaseNow(4);
    expect(strip.strip()).toEqual([1, 2, 3, 4]);
  });

  test("a tab whose own group is gone by then is just ungrouped", async () => {
    const strip = new TabStrip([{ id: 1 }]);
    strip.move(1, strip.userGroup(1, "Work"));
    const { indicator: tabs } = indicator(strip);
    await tabs.show(1);
    expect(strip.groups.size).toBe(1);
    await tabs.releaseNow(1);
    expect(strip.groupOf(1)).toBeNull();
  });

  test("a tab the person drags out stays out until control ends", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }]);
    const saved: TabIndicatorState[] = [];
    const { indicator: tabs, elapse } = indicator(strip, saved);
    await tabs.show(1);
    await tabs.show(2);
    strip.move(1, -1);
    await tabs.groupChanged(1);
    await tabs.show(1);
    expect(strip.groupOf(1)).toBeNull();
    expect(saved.at(-1)!.declined).toEqual([1]);
    // Releasing it does not touch where the person put it, nor the group.
    tabs.release(1);
    await elapse();
    expect(strip.groupOf(1)).toBeNull();
    expect(strip.groupOf(2)?.title).toBe("Opengeni");
    // The next control shows it again.
    await tabs.show(1);
    expect(strip.groupOf(1)?.title).toBe("Opengeni");
  });

  test("its own group changes are not taken for the person's", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }]);
    const { indicator: tabs } = indicator(strip);
    await tabs.show(1);
    // Chrome reports every group change, including the indicator's own.
    await tabs.groupChanged(1);
    await tabs.show(2);
    await tabs.groupChanged(2);
    expect(tabs.state().declined).toEqual([]);
    expect(Object.keys(tabs.state().tabs)).toEqual(["1", "2"]);
  });

  test("the last controlled tab leaving dissolves the group, with tabs the person dragged in", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }]);
    const { indicator: tabs } = indicator(strip);
    await tabs.show(1);
    strip.move(2, strip.groupOf(1)!.id);
    await tabs.releaseNow(1);
    expect(strip.groups.size).toBe(0);
    expect(strip.groupOf(2)).toBeNull();
  });

  test("a closed tab is forgotten, and the group goes with its last controlled tab", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }]);
    const { indicator: tabs } = indicator(strip);
    await tabs.show(1);
    strip.move(2, strip.groupOf(1)!.id);
    strip.close(1);
    await tabs.closed(1);
    expect(tabs.state().tabs).toEqual({});
    expect(strip.groupOf(2)).toBeNull();
  });

  test("pinned tabs and tabs of popup windows are left as they are", async () => {
    const strip = new TabStrip([
      { id: 1, pinned: true },
      { id: 2, windowId: 9 },
    ]);
    strip.popupWindows.add(9);
    const { indicator: tabs } = indicator(strip);
    await tabs.show(1);
    await tabs.show(2);
    expect(strip.groups.size).toBe(0);
    expect(tabs.state().tabs).toEqual({});
  });

  test("waits for the person to finish dragging a tab", async () => {
    const strip = new TabStrip([{ id: 1 }]);
    strip.dragging = 2;
    const { indicator: tabs } = indicator(strip);
    await tabs.show(1);
    expect(strip.groupOf(1)?.title).toBe("Opengeni");
  });

  test("a new worker carries on: ended control leaves, left-behind groups dissolve", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);
    const saved: TabIndicatorState[] = [];
    const first = indicator(strip, saved).indicator;
    await first.show(1);
    await first.show(2);
    // A group the extension left with no record (it reloaded meanwhile).
    const orphan = strip.userGroup(1, "Opengeni");
    strip.groups.get(orphan)!.color = "grey";
    strip.move(5, orphan);
    // A person's group that happens to share the title in another colour.
    const theirs = strip.userGroup(1, "Opengeni");
    strip.move(4, theirs);

    const state = parseTabIndicatorState(JSON.parse(JSON.stringify(saved.at(-1))))!;
    // Tab 1 is still controlled; tab 2 no longer; tab 3 became controlled.
    const second = indicator(strip).indicator;
    await second.resume(state, [1, 3]);
    expect(strip.groupOf(1)?.title).toBe("Opengeni");
    expect(strip.groupOf(3)?.id).toBe(strip.groupOf(1)!.id);
    expect(strip.groupOf(2)).toBeNull();
    expect(strip.groupOf(5)).toBeNull();
    expect(strip.groupOf(4)?.id).toBe(theirs);
    expect(Object.keys(second.state().tabs).sort()).toEqual(["1", "3"]);
  });

  test("a fresh start dissolves every group a former run left", async () => {
    const strip = new TabStrip([{ id: 1 }, { id: 2 }]);
    await indicator(strip).indicator.show(1);
    await indicator(strip).indicator.resume(null, []);
    expect(strip.groups.size).toBe(0);
  });

  test("parses only well-formed recorded state", () => {
    expect(parseTabIndicatorState(null)).toBeNull();
    expect(
      parseTabIndicatorState({
        tabs: {
          "4": { groupId: 7, restoreGroupId: "x", restoreIndex: 2 },
          x: { groupId: 1 },
          "5": { groupId: "y" },
        },
        declined: [3, "z"],
      }),
    ).toEqual({
      tabs: { "4": { groupId: 7, restoreGroupId: null, restoreIndex: 2 } },
      declined: [3],
    });
  });
});
