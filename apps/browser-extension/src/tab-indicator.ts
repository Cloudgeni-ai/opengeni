/**
 * Shows a person which of their tabs an agent controls: while the extension's
 * debugger is attached to a tab, the tab sits in a tab group named after the
 * product, one group per window, so the tab strip says so without changing
 * the page, its title or its icon. Chrome's own debugger notification says
 * only that something is being debugged, not which tabs.
 *
 * - A tab the person had in a group of their own goes back to that group when
 *   control ends, if it still exists; any other tab is ungrouped, and one
 *   the group moved goes back to where it was in the window. A group
 *   left with no controlled tab is dissolved, along with any tab the person
 *   dragged into it.
 * - Control often ends for a moment and starts again (a dialog the agent lets
 *   Chrome close, a navigation Chrome detaches on), so a tab leaves the group
 *   only once control has stayed ended for `releaseDelayMs`.
 * - A tab the person drags out of the group (or a group they ungroup) stays
 *   out until control ends; the next time an agent takes the tab it is
 *   grouped again.
 * - Every session shares the window's one group: the extension cannot tell
 *   which session holds which tab.
 * - Pinned tabs and tabs outside normal windows cannot be grouped; they are
 *   left as they are.
 */

/** The part of Chrome's tabs and tabGroups APIs this uses. */
export type TabIndicatorChrome = {
  tabs: {
    get(tabId: number): Promise<IndicatorTab>;
    query(query: { groupId: number } | { windowId: number }): Promise<IndicatorTab[]>;
    move(tabId: number, properties: { index: number }): Promise<unknown>;
    group(options: {
      tabIds: number[];
      groupId?: number;
      createProperties?: { windowId: number };
    }): Promise<number>;
    ungroup(tabIds: number[]): Promise<void>;
  };
  tabGroups: {
    get(groupId: number): Promise<unknown>;
    query(query: { title: string; color: TabGroupColor }): Promise<{ id: number }[]>;
    update(groupId: number, properties: { title: string; color: TabGroupColor }): Promise<unknown>;
  };
};

export type IndicatorTab = {
  id?: number;
  windowId: number;
  groupId: number;
  pinned: boolean;
  index: number;
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

/** Chrome's groupId for a tab in no group. */
const NO_GROUP = -1;

/** A tab in the group: the group, the person's own group the tab came from,
 * and where it was in its window when joining the group moved it. */
export type IndicatedTabEntry = {
  groupId: number;
  restoreGroupId: number | null;
  restoreIndex: number | null;
};

/** What outlives the extension's worker (see LiveState in the worker). */
export type TabIndicatorState = {
  /** Tabs in the group, by tab id. */
  tabs: Record<string, IndicatedTabEntry>;
  /** Controlled tabs the person took out of the group. */
  declined: number[];
};

export type TabIndicatorOptions = {
  title: string;
  color: TabGroupColor;
  releaseDelayMs: number;
  /** Called after every change, to record the state for the next worker. */
  onChange?: (state: TabIndicatorState) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

// Chrome refuses tab edits while the person drags a tab.
const DRAGGING = /cannot be edited right now/iu;
const DRAG_RETRIES = 5;
const DRAG_RETRY_MS = 300;

export class TabIndicator {
  private readonly indicated = new Map<number, IndicatedTabEntry>();
  private readonly declined = new Set<number>();
  private readonly releases = new Map<number, unknown>();
  // Every change of the tab strip runs in order, so each one sees the last
  // one's result.
  private queue: Promise<void> = Promise.resolve();
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(
    private readonly chrome: TabIndicatorChrome,
    private readonly options: TabIndicatorOptions,
  ) {
    this.schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel =
      options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** The extension is controlling the tab: put it in the window's group. */
  show(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(async () => {
      if (this.indicated.has(tabId) || this.declined.has(tabId)) return;
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.pinned) return;
      const existing = await this.groupInWindow(tab.windowId);
      const restoreGroupId =
        tab.groupId !== NO_GROUP && tab.groupId !== existing ? tab.groupId : null;
      let groupId: number;
      try {
        if (existing !== null) {
          groupId = await this.edit(() =>
            this.chrome.tabs.group({ groupId: existing, tabIds: [tabId] }),
          );
        } else {
          groupId = await this.edit(() =>
            this.chrome.tabs.group({
              tabIds: [tabId],
              createProperties: { windowId: tab.windowId },
            }),
          );
          await this.chrome.tabGroups.update(groupId, {
            title: this.options.title,
            color: this.options.color,
          });
        }
      } catch {
        // A tab in a popup or app window, or one closed meanwhile.
        return;
      }
      const moved = await this.chrome.tabs.get(tabId).catch(() => null);
      const restoreIndex =
        moved && moved.windowId === tab.windowId && moved.index !== tab.index ? tab.index : null;
      this.indicated.set(tabId, { groupId, restoreGroupId, restoreIndex });
      this.changed();
    });
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
      this.changed();
      const tab = await this.chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.groupId === entry.groupId) {
        try {
          const restore =
            entry.restoreGroupId !== null &&
            (await this.chrome.tabGroups.get(entry.restoreGroupId).then(
              () => true,
              () => false,
            ));
          if (restore) {
            await this.edit(() =>
              this.chrome.tabs.group({ groupId: entry.restoreGroupId!, tabIds: [tabId] }),
            );
          } else {
            await this.edit(() => this.chrome.tabs.ungroup([tabId]));
            if (entry.restoreIndex !== null) {
              const count = (await this.chrome.tabs.query({ windowId: tab.windowId })).length;
              const index = Math.min(entry.restoreIndex, count - 1);
              await this.edit(() => this.chrome.tabs.move(tabId, { index }));
            }
          }
        } catch {
          // Closed meanwhile.
        }
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
      this.indicated.delete(tabId);
      this.declined.add(tabId);
      this.changed();
    });
  }

  /**
   * A new worker carries on with an earlier one's state. Tabs no longer
   * controlled leave the group; groups this extension left behind with no
   * record (after the extension reloaded or updated, or Chrome restarted)
   * are dissolved; controlled tabs get the indicator.
   */
  resume(state: TabIndicatorState | null, controlled: Iterable<number>): Promise<void> {
    const live = new Set(controlled);
    const work = this.run(async () => {
      for (const [tab, entry] of Object.entries(state?.tabs ?? {})) {
        this.indicated.set(Number(tab), entry);
      }
      for (const tabId of state?.declined ?? []) if (live.has(tabId)) this.declined.add(tabId);
      const groups = await this.chrome.tabGroups
        .query({ title: this.options.title, color: this.options.color })
        .catch(() => []);
      for (const group of groups) {
        const tabs = await this.chrome.tabs.query({ groupId: group.id }).catch(() => []);
        const leftovers = tabs
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined && !this.indicated.has(id));
        if (leftovers.length > 0)
          await this.edit(() => this.chrome.tabs.ungroup(leftovers)).catch(() => undefined);
      }
      this.changed();
    });
    const ended = [...this.indicatedAfter(state)].filter((tabId) => !live.has(tabId));
    return Promise.all([
      work,
      ...ended.map((tabId) => this.releaseNow(tabId)),
      ...[...live].map((tabId) => this.show(tabId)),
    ]).then(() => undefined);
  }

  state(): TabIndicatorState {
    return {
      tabs: Object.fromEntries([...this.indicated].map(([tabId, entry]) => [String(tabId), entry])),
      declined: [...this.declined],
    };
  }

  /** Resolves once every change asked for so far is done. */
  settled(): Promise<void> {
    return this.queue;
  }

  private indicatedAfter(state: TabIndicatorState | null): number[] {
    return Object.keys(state?.tabs ?? {}).map(Number);
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
        if (attempt >= DRAG_RETRIES || !(error instanceof Error) || !DRAGGING.test(error.message))
          throw error;
        await new Promise<void>((resolve) => this.schedule(resolve, DRAG_RETRY_MS));
      }
    }
  }

  private cancelRelease(tabId: number): void {
    const timer = this.releases.get(tabId);
    if (timer === undefined) return;
    this.cancel(timer);
    this.releases.delete(tabId);
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

/** Parses a recorded TabIndicatorState, or null. */
export function parseTabIndicatorState(value: unknown): TabIndicatorState | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { tabs?: unknown; declined?: unknown };
  const tabs: TabIndicatorState["tabs"] = {};
  if (raw.tabs !== null && typeof raw.tabs === "object") {
    for (const [tab, entry] of Object.entries(raw.tabs as Record<string, unknown>)) {
      if (!Number.isSafeInteger(Number(tab)) || entry === null || typeof entry !== "object")
        continue;
      const { groupId, restoreGroupId, restoreIndex } = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(groupId)) continue;
      tabs[tab] = {
        groupId: groupId as number,
        restoreGroupId: Number.isSafeInteger(restoreGroupId) ? (restoreGroupId as number) : null,
        restoreIndex: Number.isSafeInteger(restoreIndex) ? (restoreIndex as number) : null,
      };
    }
  }
  const declined = Array.isArray(raw.declined)
    ? raw.declined.filter((tabId): tabId is number => Number.isSafeInteger(tabId))
    : [];
  return { tabs, declined };
}
