/**
 * Shows a person which of their tabs an agent controls: while the extension's
 * debugger is attached to a tab, the tab shows a mark (the agent's cursor) as
 * its icon in the tab strip, alongside the tab group (tab-group.ts), which
 * pinned tabs and some windows cannot join.
 *
 * - The page's own icons stay in the page, set aside (their `rel` kept in a
 *   data attribute) while the mark is shown, and come back exactly when
 *   control ends. Icons the page adds meanwhile are set aside too. Nothing
 *   else on the page, nor its title, changes.
 * - A new page in the tab (a navigation or reload) gets the mark again.
 * - Control often ends for a moment and starts again (a dialog the agent lets
 *   Chrome close, a navigation Chrome detaches on), so a tab gets its own icon
 *   back only once control has stayed ended for `releaseDelayMs`.
 * - Pages Chrome lets no extension script (its own pages, the Web Store, a
 *   PDF viewer) keep their icon.
 * - The marked tabs are recorded in storage that outlives the worker and an
 *   update or reload of the extension (which ends every control), so the
 *   next run gives those tabs their icons back.
 */

/** The part of Chrome's scripting API this uses. */
export type TabIconChrome = {
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      world: "ISOLATED";
      injectImmediately: boolean;
      func: (...args: never[]) => unknown;
      args: unknown[];
    }): Promise<unknown>;
  };
};

/** What the next run carries on with. */
export type TabIconState = {
  /** Tabs showing the mark. */
  tabs: number[];
};

export type TabIconOptions = {
  /** The mark, as an image URL a page can load (a web-accessible resource of
   * the extension: page CSPs often refuse data: icons). */
  icon: () => Promise<string>;
  releaseDelayMs: number;
  /** How long one page may take to run a script before the next change to its
   * tab goes ahead (a page with an open dialog or paused in the debugger runs
   * none). */
  injectTimeoutMs?: number;
  /** Called after every change, to record the state for the next run. */
  onChange?: (state: TabIconState) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

const INJECT_TIMEOUT_MS = 5_000;

export class TabIcon {
  private readonly marked = new Set<number>();
  // Tabs whose mark this run took away: a page kept in the back-forward cache
  // still has it and may come back.
  private readonly unmarked = new Set<number>();
  // Released tabs whose page has not run the script yet (a dialog is open):
  // still recorded, and cleared on their next page or by the next run.
  private readonly releasing = new Set<number>();
  // Chrome never reuses a tab's ID.
  private readonly closedTabs = new Set<number>();
  private readonly releases = new Map<number, unknown>();
  // Each tab's changes run in order, so a release never overtakes a later
  // show; a page that runs no scripts holds up only its own tab.
  private readonly queues = new Map<number, Promise<void>>();
  private resumed: Promise<void> = Promise.resolve();
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(
    private readonly chrome: TabIconChrome,
    private readonly options: TabIconOptions,
  ) {
    this.schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel =
      options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** The extension is controlling the tab: show the mark. */
  show(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(tabId, async () => {
      if (this.closedTabs.has(tabId)) return;
      this.unmarked.delete(tabId);
      this.releasing.delete(tabId);
      if (!this.marked.has(tabId)) {
        this.marked.add(tabId);
        this.changed();
      }
      await this.mark(tabId);
    });
  }

  /** A new page committed in the tab (webNavigation.onCommitted, top frame);
   * `backForward` when it came from the history, possibly from the
   * back-forward cache with a mark it kept. */
  navigated(tabId: number, backForward = false): Promise<void> {
    const unmarked = backForward && this.unmarked.has(tabId);
    if (!this.marked.has(tabId) && !unmarked && !this.releasing.has(tabId))
      return Promise.resolve();
    return this.run(tabId, async () => {
      if (this.marked.has(tabId)) await this.mark(tabId);
      else if (this.releasing.has(tabId)) await this.unmarkAndRecord(tabId);
      else if (unmarked) await this.unmark(tabId);
    });
  }

  /** Control of the tab ended: give it its own icon back unless control
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

  /** Give the tab its own icon back now. */
  releaseNow(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(tabId, async () => {
      if (!this.marked.delete(tabId)) return;
      this.releasing.add(tabId);
      await this.unmarkAndRecord(tabId);
    });
  }

  /** The tab was closed. */
  closed(tabId: number): void {
    this.cancelRelease(tabId);
    this.closedTabs.add(tabId);
    this.unmarked.delete(tabId);
    const wasReleasing = this.releasing.delete(tabId);
    if (this.marked.delete(tabId) || wasReleasing) this.changed();
    void this.run(tabId, async () => {
      this.queues.delete(tabId);
    });
  }

  /** A new run carries on: recorded tabs no longer controlled get their own
   * icons back, controlled tabs show the mark. `controlled` is read once the
   * record is, so a tab attached meanwhile counts. */
  resume(
    recorded: TabIconState | null | Promise<TabIconState | null>,
    controlled: () => Iterable<number>,
  ): Promise<void> {
    this.resumed = this.resumed.then(async () => {
      const state = await Promise.resolve(recorded).catch(() => null);
      for (const tabId of state?.tabs ?? []) {
        if (!this.closedTabs.has(tabId)) this.marked.add(tabId);
      }
      const live = new Set(controlled());
      await Promise.all([
        ...[...this.marked]
          .filter((tabId) => !live.has(tabId))
          .map((tabId) => this.releaseNow(tabId)),
        ...[...live].map((tabId) => this.show(tabId)),
      ]);
    });
    return this.resumed;
  }

  state(): TabIconState {
    return { tabs: [...this.marked, ...this.releasing] };
  }

  /** Resolves once every change asked for so far is done. */
  async settled(): Promise<void> {
    await this.resumed;
    let pending: Promise<void>[];
    do {
      pending = [...this.queues.values()];
      await Promise.all(pending);
    } while ([...this.queues.values()].some((queue) => !pending.includes(queue)));
  }

  private async mark(tabId: number): Promise<void> {
    const icon = await this.options.icon();
    await this.inject(tabId, showMark, [icon]);
  }

  /** Takes a releasing tab's mark away. It stays recorded until that is done,
   * so a run that ends meanwhile leaves the tab to the next one. */
  private async unmarkAndRecord(tabId: number): Promise<void> {
    if ((await this.unmark(tabId)) === "timeout" || !this.releasing.delete(tabId)) return;
    this.unmarked.add(tabId);
    this.changed();
  }

  private unmark(tabId: number): Promise<"done" | "timeout"> {
    return this.inject(tabId, removeMark, []);
  }

  /** "done" also when Chrome refused: a closed tab, or a page no extension
   * may script, has nothing to undo. */
  private async inject(
    tabId: number,
    func: (...args: never[]) => unknown,
    args: unknown[],
  ): Promise<"done" | "timeout"> {
    let timer: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = this.schedule(
        () => resolve("timeout"),
        this.options.injectTimeoutMs ?? INJECT_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([
        this.chrome.scripting
          .executeScript({
            target: { tabId },
            // The page's scripts cannot see or undo it there.
            world: "ISOLATED",
            // At once, even while a page loads: showMark waits for the load.
            injectImmediately: true,
            func,
            args,
          })
          .then(() => "done" as const),
        timedOut,
      ]);
    } catch {
      // A closed tab, or a page Chrome lets no extension script.
      return "done";
    } finally {
      this.cancel(timer);
    }
  }

  private cancelRelease(tabId: number): void {
    const timer = this.releases.get(tabId);
    if (timer === undefined) return;
    this.cancel(timer);
    this.releases.delete(tabId);
  }

  private run(tabId: number, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(tabId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        console.warn("could not update a controlled tab's icon", error);
      });
    if (!this.closedTabs.has(tabId) || this.queues.has(tabId)) this.queues.set(tabId, next);
    return next;
  }

  private changed(): void {
    this.options.onChange?.(this.state());
  }
}

/** Parses a recorded TabIconState, or null. */
export function parseTabIconState(value: unknown): TabIconState | null {
  if (value === null || typeof value !== "object") return null;
  const tabs = (value as { tabs?: unknown }).tabs;
  return {
    tabs: Array.isArray(tabs)
      ? tabs.filter((tabId): tabId is number => Number.isSafeInteger(tabId))
      : [],
  };
}

/** The state showMark keeps in the extension's isolated world of a page. */
type MarkState = {
  link: HTMLLinkElement;
  observer: MutationObserver;
  icon: string;
  /** When the observer last put the mark back, to stop fighting a page that
   * insists on its own icon. */
  repairs: number[];
  /** A repair put off by that limit. */
  later?: ReturnType<typeof setTimeout>;
  /** An icon the page set on the mark (an unread count, say), for its own
   * icon once the mark goes. */
  pageHref?: string;
};

/** A mark waiting for its page to load. */
type PendingMark = { icon: string; cancel: () => void };

/**
 * Runs in the page's top frame, in this extension's isolated world: shows
 * `icon` as the tab's icon. The page's own icon links in the head (the only
 * ones Chrome reads) are set aside by renaming their `rel` (kept in
 * `data-opengeni-rel`), the mark is added as the only icon in the head, and
 * an observer keeps it so while the page changes its links, at most a few
 * times a second. A page still loading gets the mark once it has loaded (and
 * its scripts have had a moment), so the head is not changed under scripts
 * that hydrate it. Running it again only updates the icon. An observer left
 * by a version of the extension that was since reloaded stops on its own.
 * Self-contained, since Chrome runs it from its source.
 */
export function showMark(icon: string): void {
  const KEPT = "data-opengeni-rel";
  const MARK = "data-opengeni-icon";
  const REPAIRS_PER_SECOND = 10;
  const LOAD_WAIT_MS = 10_000;
  const scope = globalThis as typeof globalThis & {
    __opengeniMark?: MarkState;
    __opengeniPendingMark?: PendingMark;
  };
  const isPageIcon = (node: Node): node is HTMLLinkElement =>
    node instanceof HTMLLinkElement &&
    !node.hasAttribute(MARK) &&
    /(^|\s)icon(\s|$)/iu.test(node.getAttribute("rel") ?? "");
  const ensure = (state: MarkState) => {
    const head = document.head;
    if (!head) return;
    for (const link of Array.from(head.children)) {
      if (!isPageIcon(link)) continue;
      link.setAttribute(KEPT, link.getAttribute("rel") ?? "");
      link.setAttribute("rel", "opengeni-kept-icon");
    }
    if (state.link.parentNode !== head) head.append(state.link);
    if (state.link.getAttribute("href") !== state.icon) state.link.setAttribute("href", state.icon);
  };
  const alive = () =>
    Boolean((globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id);
  const touchesLinks = (records: MutationRecord[]) =>
    records.some((record) =>
      record.type === "attributes"
        ? record.target instanceof HTMLLinkElement
        : [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
            ["LINK", "HEAD", "HTML"].includes(node.nodeName),
          ),
    );
  const apply = (url: string) => {
    let state = scope.__opengeniMark;
    if (!state) {
      // A mark a version of the extension that was since reloaded left.
      for (const old of Array.from(document.querySelectorAll(`link[${MARK}]`))) old.remove();
      const link = document.createElement("link");
      link.setAttribute("rel", "icon");
      link.setAttribute(MARK, "");
      const observer = new MutationObserver((records) => {
        // The extension was reloaded or removed: its next run cleans up.
        if (!alive()) {
          observer.disconnect();
          return;
        }
        const current = state!;
        if (scope.__opengeniMark !== current || !touchesLinks(records)) return;
        for (const record of records) {
          const href = current.link.getAttribute("href");
          if (record.target === current.link && href !== null && href !== current.icon)
            current.pageHref = href;
        }
        const now = Date.now();
        current.repairs = current.repairs.filter((at) => now - at < 1_000);
        if (current.repairs.length >= REPAIRS_PER_SECOND) {
          current.later ??= setTimeout(() => {
            current.later = undefined;
            if (!alive()) observer.disconnect();
            else if (scope.__opengeniMark === current) ensure(current);
          }, 1_000);
          return;
        }
        current.repairs.push(now);
        ensure(current);
      });
      state = { link, observer, icon: url, repairs: [] };
      scope.__opengeniMark = state;
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["rel", "href"],
      });
    }
    state.icon = url;
    ensure(state);
  };
  if (scope.__opengeniMark || document.readyState === "complete") {
    scope.__opengeniPendingMark?.cancel();
    delete scope.__opengeniPendingMark;
    apply(icon);
    return;
  }
  const pending = scope.__opengeniPendingMark;
  if (pending) {
    pending.icon = icon;
    return;
  }
  const next: PendingMark = { icon, cancel: () => {} };
  scope.__opengeniPendingMark = next;
  const run = () => {
    if (scope.__opengeniPendingMark !== next) return;
    delete scope.__opengeniPendingMark;
    if (alive()) apply(next.icon);
  };
  const loaded = () => {
    next.cancel();
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1_000 });
    else setTimeout(run, 0);
  };
  const onState = () => {
    if (document.readyState === "complete") loaded();
  };
  // A page whose load never ends gets the mark anyway.
  const cap = setTimeout(loaded, LOAD_WAIT_MS);
  document.addEventListener("readystatechange", onState);
  next.cancel = () => {
    clearTimeout(cap);
    document.removeEventListener("readystatechange", onState);
  };
}

/** Runs in the page's top frame, in this extension's isolated world: takes
 * the mark away and gives the page's own icons back exactly. Also cleans up
 * after a version of the extension that was since reloaded.
 * Self-contained, since Chrome runs it from its source. */
export function removeMark(): void {
  const KEPT = "data-opengeni-rel";
  const MARK = "data-opengeni-icon";
  const scope = globalThis as typeof globalThis & {
    __opengeniMark?: MarkState;
    __opengeniPendingMark?: PendingMark;
  };
  scope.__opengeniPendingMark?.cancel();
  delete scope.__opengeniPendingMark;
  const pageHref = scope.__opengeniMark?.pageHref;
  scope.__opengeniMark?.observer.disconnect();
  clearTimeout(scope.__opengeniMark?.later);
  delete scope.__opengeniMark;
  for (const link of Array.from(document.querySelectorAll(`link[${MARK}]`))) link.remove();
  let first: Element | null = null;
  for (const link of Array.from(document.querySelectorAll(`link[${KEPT}]`))) {
    link.setAttribute("rel", link.getAttribute(KEPT) ?? "icon");
    link.removeAttribute(KEPT);
    if (!first && /(^|\s)icon(\s|$)/iu.test(link.getAttribute("rel") ?? "")) first = link;
  }
  // The icon the page set on the mark meanwhile is its latest.
  if (pageHref !== undefined) {
    if (first) first.setAttribute("href", pageHref);
    else {
      const link = document.createElement("link");
      link.setAttribute("rel", "icon");
      link.setAttribute("href", pageHref);
      document.head?.append(link);
    }
  }
}
