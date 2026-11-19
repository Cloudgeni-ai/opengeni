/**
 * Shows a person which of their tabs an agent controls: while the extension's
 * debugger is attached to a tab, the tab sits in a tab group named after the
 * product, one group per window (and shows the agent's cursor as its icon,
 * see tab-icon.ts). Chrome's own debugger notification says only that
 * something is being debugged, not which tabs.
 *
 * - A tab the person had in a group of their own goes back to that group when
 *   control ends (made again, as it looked, if the tab was its only one);
 *   any other tab is ungrouped, and one the group moved goes back to where it
 *   was in the window. A group left with no controlled tab is dissolved,
 *   along with any tab the person dragged into it.
 * - A tab opened from a controlled tab, which Chrome puts in the group,
 *   leaves it unless an agent takes it within `releaseDelayMs`.
 * - Control often ends for a moment and starts again (a dialog the agent lets
 *   Chrome close, a navigation Chrome detaches on), so a tab leaves the group
 *   only once control has stayed ended for `releaseDelayMs`.
 * - A tab the person drags out of the group (or a group they ungroup) stays
 *   out until control ends; the next time an agent takes the tab it is
 *   grouped again. A group the person drags to another window stays the
 *   group.
 * - Every session shares the window's one group: the extension cannot tell
 *   which session holds which tab.
 * - Pinned tabs and tabs outside normal windows cannot be grouped; they are
 *   left as they are.
 * - The state is recorded in storage that outlives the worker and an
 *   extension update or reload (which end every control), so the next run
 *   puts tabs back where they were. Only when the recorded groups are gone
 *   (Chrome restarted, and restored them with new ids) are groups found by
 *   their title and colour.
 */

/** The part of Chrome's tabs and tabGroups APIs this uses. */
export type TabGroupChrome = {
  tabs: {
    get(tabId: number): Promise<GroupedTab>;
    query(query: { groupId: number } | { windowId: number }): Promise<GroupedTab[]>;
    move(tabId: number, properties: { index: number }): Promise<unknown>;
    group(options: {
      tabIds: number[];
      groupId?: number;
      createProperties?: { windowId: number };
    }): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
  };
  tabGroups: {
    get(groupId: number): Promise<GroupLook>;
    query(query: { title: string; color: TabGroupColor }): Promise<{ id: number }[]>;
    update(groupId: number, properties: GroupLook): Promise<unknown>;
  };
};

export type GroupedTab = {
  id?: number;
  windowId: number;
  groupId: number;
  pinned: boolean;
  index: number;
  active?: boolean;
};

export type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

/** How a group looks in the tab strip. */
export type GroupLook = { title?: string; color: TabGroupColor; collapsed?: boolean };

/** Ends the group's title, unseen: a group the person names after the
 * product is never taken for this one. */
export const GROUP_TITLE_MARK = "\u200b";

/** Chrome's groupId for a tab in no group. */
const NO_GROUP = -1;

/** A tab in the group: the group, the person's own group the tab came from
 * (and how that group looked, if the tab was its only one: Chrome deletes a
 * group with its last tab), and where it was in its window when joining the
 * group moved it. */
export type GroupedTabEntry = {
  groupId: number;
  restoreGroupId: number | null;
  restoreGroup?: GroupLook | null;
  restoreIndex: number | null;
};

/** What the next run carries on with. */
export type TabGroupState = {
  /** Tabs in the group, by tab id. */
  tabs: Record<string, GroupedTabEntry>;
  /** Controlled tabs the person took out of the group. */
  declined: number[];
};

export type TabGroupOptions = {
  title: string;
  color: TabGroupColor;
  releaseDelayMs: number;
  /** Called after every change, to record the state for the next run. */
  onChange?: (state: TabGroupState) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

// Chrome refuses tab edits while the person drags a tab.
const DRAGGING = /cannot be edited right now/iu;
const DRAG_RETRIES = 5;
const DRAG_RETRY_MS = 300;

const dragging = (error: unknown) => error instanceof Error && DRAGGING.test(error.message);

export class TabGroup {
  private readonly indicated = new Map<number, GroupedTabEntry>();
  private readonly declined = new Set<number>();
  private readonly releases = new Map<number, unknown>();
  // Releases refused while the person dragged a tab, tried again later.
  private readonly retries = new Map<number, unknown>();
  // Every change of the tab strip runs in order, so each one sees the last
  // one's result.
  private queue: Promise<void> = Promise.resolve();
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  private readonly title: string;

  constructor(
    private readonly chrome: TabGroupChrome,
    private readonly options: TabGroupOptions,
  ) {
    this.title = options.title + GROUP_TITLE_MARK;
    this.schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel =
      options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** The extension is controlling the tab: put it in the window's group. */
  show(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(async () => {
      // A release refused while the person dragged a tab may be waiting to
      // be tried again.
      this.cancelRetry(tabId);
      if (this.indicated.has(tabId) || this.declined.has(tabId)) return;
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.pinned) return;
      const existing = await this.groupInWindow(tab.windowId);
      const restoreGroupId =
        tab.groupId !== NO_GROUP && tab.groupId !== existing ? tab.groupId : null;
      const restoreGroup = restoreGroupId === null ? null : await this.lookIfOnly(tab);
      let groupId: number;
      try {
        groupId =
          existing !== null
            ? await this.edit(() => this.chrome.tabs.group({ groupId: existing, tabIds: [tabId] }))
            : await this.newGroup(tabId, tab.windowId);
      } catch {
        // A tab in a popup or app window, or one closed meanwhile, or a group
        // that could not be titled: the tab goes back to the person's group.
        if (restoreGroupId !== null)
          await this.rejoin(
            tabId,
            tab.windowId,
            restoreGroupId,
            restoreGroup,
            tab.active ?? false,
          ).catch(() => undefined);
        return;
      }
      const moved = await this.chrome.tabs.get(tabId).catch(() => null);
      const restoreIndex =
        moved && moved.windowId === tab.windowId && moved.index !== tab.index ? tab.index : null;
      this.indicated.set(tabId, { groupId, restoreGroupId, restoreGroup, restoreIndex });
      this.changed();
    });
  }

  /** A tab was created (tabs.onCreated). Chrome puts a tab opened from a
   * grouped tab in that group: one opened from a controlled tab leaves the
   * group unless an agent takes it within the release delay. */
  opened(tabId: number): void {
    this.schedule(() => {
      void this.run(async () => {
        if (this.indicated.has(tabId)) return;
        const tab = await this.chrome.tabs.get(tabId).catch(() => null);
        if (!tab || tab.groupId === NO_GROUP) return;
        if (![...this.indicated.values()].some((entry) => entry.groupId === tab.groupId)) return;
        await this.edit(() => this.chrome.tabs.ungroup([tabId])).catch(() => undefined);
      });
    }, this.options.releaseDelayMs);
  }

  /** Control of the tab ended: take it out of the group unless control
   * starts again within the release delay. */
  release(tabId: number): void {
    this.cancelRelease(tabId);
    this.releases.set(
      tabId,
      this.schedule(() => {
        this.releases.delete(tabId);
        void this.releaseNow(tabId);
      }, this.options.releaseDelayMs),
    );
  }

  /** Take the tab out of the group now. */
  releaseNow(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(async () => {
      const hadDecline = this.declined.delete(tabId);
      const entry = this.indicated.get(tabId);
      if (!entry) {
        if (hadDecline) this.changed();
        return;
      }
      this.indicated.delete(tabId);
      try {
        await this.putBack(tabId, entry);
      } catch (error) {
        if (dragging(error)) {
          // The person is still dragging a tab: try again later.
          this.indicated.set(tabId, entry);
          this.retries.set(
            tabId,
            this.schedule(() => {
              this.retries.delete(tabId);
              void this.releaseNow(tabId);
            }, this.options.releaseDelayMs),
          );
          return;
        }
        // Closed meanwhile.
      } finally {
        this.changed();
      }
      await this.dissolveIfUnused(entry.groupId);
    });
  }

  /** The tab was closed. */
  closed(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(async () => {
      const entry = this.indicated.get(tabId);
      const hadDecline = this.declined.delete(tabId);
      if (!entry) {
        if (hadDecline) this.changed();
        return;
      }
      this.indicated.delete(tabId);
      this.changed();
      await this.dissolveIfUnused(entry.groupId);
    });
  }

  /** Chrome reports the tab's group changed (tabs.onUpdated). A change this
   * class did not make is the person's: the tab stays out of the group. */
  groupChanged(tabId: number): Promise<void> {
    if (!this.indicated.has(tabId)) return this.queue;
    return this.run(async () => {
      const entry = this.indicated.get(tabId);
      if (!entry) return;
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.groupId === entry.groupId) return;
      // Dragging a whole group to another window gives it a new id there.
      if (tab.groupId !== NO_GROUP && (await this.isOurs(tab.groupId))) {
        this.indicated.set(tabId, { ...entry, groupId: tab.groupId, restoreIndex: null });
      } else {
        this.indicated.delete(tabId);
        this.declined.add(tabId);
      }
      this.changed();
    });
  }

  /**
   * A new run carries on with the state the last one recorded: tabs no
   * longer controlled leave the group and go back where they were;
   * controlled tabs get the indicator. A recorded group that is gone means
   * Chrome restarted and restored its groups with new ids: then groups with
   * this title and colour that hold no controlled tab are dissolved.
   * `controlled` is read once the record is, so a tab attached meanwhile
   * counts.
   */
  resume(
    recorded: TabGroupState | null | Promise<TabGroupState | null>,
    controlled: () => Iterable<number>,
  ): Promise<void> {
    return this.run(async () => {
      const state = await Promise.resolve(recorded).catch(() => null);
      const live = new Set(controlled());
      let lost = false;
      for (const [tab, entry] of Object.entries(state?.tabs ?? {})) {
        const tabId = Number(tab);
        if (!(await this.isOurs(entry.groupId))) {
          lost = true;
          continue;
        }
        const current = await this.chrome.tabs.get(tabId).catch(() => null);
        if (current?.groupId === entry.groupId) this.indicated.set(tabId, entry);
      }
      for (const tabId of state?.declined ?? []) if (live.has(tabId)) this.declined.add(tabId);
      if (lost) await this.dissolveLeftBehind();
      this.changed();
    }).then(async () => {
      // Read again: a tab attached or detached while the record was checked
      // counts as it is now.
      const now = new Set(controlled());
      const ended = [...this.indicated.keys()].filter((tabId) => !now.has(tabId));
      await Promise.all([
        ...ended.map((tabId) => this.releaseNow(tabId)),
        ...[...now].map((tabId) => this.show(tabId)),
      ]);
    });
  }

  state(): TabGroupState {
    return {
      tabs: Object.fromEntries([...this.indicated].map(([tabId, entry]) => [String(tabId), entry])),
      declined: [...this.declined],
    };
  }

  /** Resolves once every change asked for so far is done. */
  settled(): Promise<void> {
    return this.queue;
  }

  private async newGroup(tabId: number, windowId: number): Promise<number> {
    const groupId = await this.edit(() =>
      this.chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } }),
    );
    try {
      await this.edit(() =>
        this.chrome.tabGroups.update(groupId, {
          title: this.title,
          color: this.options.color,
        }),
      );
    } catch (error) {
      // An untitled group would say nothing, and nothing would remove it.
      await this.edit(() => this.chrome.tabs.ungroup([tabId])).catch(() => undefined);
      throw error;
    }
    return groupId;
  }

  /** How the tab's group looks, if the tab is its only one. */
  private async lookIfOnly(tab: GroupedTab): Promise<GroupLook | null> {
    const members = await this.chrome.tabs.query({ groupId: tab.groupId }).catch(() => []);
    if (members.length !== 1) return null;
    const group = await this.chrome.tabGroups.get(tab.groupId).catch(() => null);
    return group
      ? { title: group.title ?? "", color: group.color, collapsed: group.collapsed ?? false }
      : null;
  }

  /** Takes a tab still in its group out of it: back to the person's group it
   * came from (made again if the tab was its only one), or else to where it
   * was. */
  private async putBack(tabId: number, entry: GroupedTabEntry): Promise<void> {
    const tab = await this.chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.groupId !== entry.groupId) return;
    const restoreGroupId = entry.restoreGroupId;
    if (restoreGroupId !== null && (await this.exists(restoreGroupId))) {
      await this.edit(() => this.chrome.tabs.group({ groupId: restoreGroupId, tabIds: [tabId] }));
      return;
    }
    await this.edit(() => this.chrome.tabs.ungroup([tabId]));
    if (entry.restoreIndex !== null) {
      const count = (await this.chrome.tabs.query({ windowId: tab.windowId })).length;
      const index = Math.min(entry.restoreIndex, count - 1);
      await this.edit(() => this.chrome.tabs.move(tabId, { index }));
      // Tabs have moved since, so that place may now be inside a group.
      const moved = await this.chrome.tabs.get(tabId);
      if (moved.groupId !== NO_GROUP) await this.edit(() => this.chrome.tabs.ungroup([tabId]));
    }
    if (entry.restoreGroup)
      await this.rejoin(tabId, tab.windowId, null, entry.restoreGroup, tab.active ?? false);
  }

  /** Puts the tab in the person's group it came from, or makes that group
   * again as it looked if it is gone (the tab was its only one). */
  private async rejoin(
    tabId: number,
    windowId: number,
    groupId: number | null,
    look: GroupLook | null | undefined,
    active: boolean,
  ): Promise<void> {
    if (groupId !== null && (await this.exists(groupId))) {
      await this.edit(() => this.chrome.tabs.group({ groupId, tabIds: [tabId] }));
      return;
    }
    if (!look) return;
    const made = await this.edit(() =>
      this.chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } }),
    );
    // Collapsing the group of the active tab would make another tab active.
    const shown = active ? { ...look, collapsed: false } : look;
    await this.edit(() => this.chrome.tabGroups.update(made, shown)).catch(() => undefined);
  }

  private exists(groupId: number): Promise<boolean> {
    return this.chrome.tabGroups.get(groupId).then(
      () => true,
      () => false,
    );
  }

  /** Dissolves groups with this title and colour holding no controlled tab. */
  private async dissolveLeftBehind(): Promise<void> {
    const groups = await this.chrome.tabGroups
      .query({ title: this.title, color: this.options.color })
      .catch(() => []);
    for (const group of groups) {
      const tabs = await this.chrome.tabs.query({ groupId: group.id }).catch(() => []);
      if (tabs.some((tab) => tab.id !== undefined && this.indicated.has(tab.id))) continue;
      const left = tabs.map((tab) => tab.id).filter((id): id is number => id !== undefined);
      if (left.length > 0)
        await this.edit(() => this.chrome.tabs.ungroup(left)).catch(() => undefined);
    }
  }

  /** Whether the group exists with this indicator's title and colour. */
  private async isOurs(groupId: number): Promise<boolean> {
    const group = await this.chrome.tabGroups.get(groupId).catch(() => null);
    return group?.title === this.title && group.color === this.options.color;
  }

  private async groupInWindow(windowId: number): Promise<number | null> {
    const groups = new Set([...this.indicated.values()].map((entry) => entry.groupId));
    for (const groupId of groups) {
      const tabs = await this.chrome.tabs.query({ groupId }).catch(() => []);
      if (tabs.some((tab) => tab.windowId === windowId)) return groupId;
    }
    return null;
  }

  private async dissolveIfUnused(groupId: number): Promise<void> {
    if ([...this.indicated.values()].some((entry) => entry.groupId === groupId)) return;
    const left = (await this.chrome.tabs.query({ groupId }).catch(() => []))
      .map((tab) => tab.id)
      .filter((id): id is number => id !== undefined);
    if (left.length > 0)
      await this.edit(() => this.chrome.tabs.ungroup(left)).catch(() => undefined);
  }

  private async edit<T>(change: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await change();
      } catch (error) {
        if (attempt >= DRAG_RETRIES || !dragging(error)) throw error;
        await new Promise<void>((resolve) => this.schedule(resolve, DRAG_RETRY_MS));
      }
    }
  }

  private cancelRelease(tabId: number): void {
    this.cancelRetry(tabId);
    const timer = this.releases.get(tabId);
    if (timer === undefined) return;
    this.cancel(timer);
    this.releases.delete(tabId);
  }

  private cancelRetry(tabId: number): void {
    const timer = this.retries.get(tabId);
    if (timer === undefined) return;
    this.cancel(timer);
    this.retries.delete(tabId);
  }

  private run(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work).catch((error: unknown) => {
      console.warn("could not update the controlled tabs' group", error);
    });
    this.queue = next;
    return next;
  }

  private changed(): void {
    this.options.onChange?.(this.state());
  }
}

/** Parses a recorded TabGroupState, or null. */
export function parseTabGroupState(value: unknown): TabGroupState | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { tabs?: unknown; declined?: unknown };
  const tabs: TabGroupState["tabs"] = {};
  if (raw.tabs !== null && typeof raw.tabs === "object") {
    for (const [tab, entry] of Object.entries(raw.tabs as Record<string, unknown>)) {
      if (!Number.isSafeInteger(Number(tab)) || entry === null || typeof entry !== "object")
        continue;
      const { groupId, restoreGroupId, restoreGroup, restoreIndex } = entry as Record<
        string,
        unknown
      >;
      if (!Number.isSafeInteger(groupId)) continue;
      tabs[tab] = {
        groupId: groupId as number,
        restoreGroupId: Number.isSafeInteger(restoreGroupId) ? (restoreGroupId as number) : null,
        restoreGroup: parseLook(restoreGroup),
        restoreIndex: Number.isSafeInteger(restoreIndex) ? (restoreIndex as number) : null,
      };
    }
  }
  const declined = Array.isArray(raw.declined)
    ? raw.declined.filter((tabId): tabId is number => Number.isSafeInteger(tabId))
    : [];
  return { tabs, declined };
}

const COLORS: readonly TabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

function parseLook(value: unknown): GroupLook | null {
  if (value === null || typeof value !== "object") return null;
  const { title, color, collapsed } = value as Record<string, unknown>;
  if (!COLORS.includes(color as TabGroupColor)) return null;
  return {
    title: typeof title === "string" ? title : "",
    color: color as TabGroupColor,
    collapsed: collapsed === true,
  };
}
