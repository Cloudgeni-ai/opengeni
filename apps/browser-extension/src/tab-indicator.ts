/**
 * Shows a person which of their tabs an agent controls: while the extension's
 * debugger is attached to a tab, the tab shows the product's mark as its icon
 * in the tab strip. Chrome's own debugger notification says only that
 * something is being debugged, not which tabs.
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
export type TabIndicatorChrome = {
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
export type TabIndicatorState = {
  /** Tabs showing the mark. */
  tabs: number[];
};

export type TabIndicatorOptions = {
  /** The mark, as an image URL a page can load (a data: URL). */
  icon: () => Promise<string>;
  releaseDelayMs: number;
  /** Called after every change, to record the state for the next run. */
  onChange?: (state: TabIndicatorState) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

export class TabIndicator {
  private readonly marked = new Set<number>();
  private readonly releases = new Map<number, unknown>();
  // Every change runs in order, so a release never overtakes a later show.
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

  /** The extension is controlling the tab: show the mark. */
  show(tabId: number): Promise<void> {
    this.cancelRelease(tabId);
    return this.run(async () => {
      if (!this.marked.has(tabId)) {
        this.marked.add(tabId);
        this.changed();
      }
      await this.mark(tabId);
    });
  }

  /** A new page committed in the tab (webNavigation.onCommitted, top frame). */
  navigated(tabId: number): Promise<void> {
    if (!this.marked.has(tabId)) return this.queue;
    return this.run(async () => {
      if (this.marked.has(tabId)) await this.mark(tabId);
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
    return this.run(async () => {
      if (!this.marked.delete(tabId)) return;
      this.changed();
      await this.unmark(tabId);
    });
  }

  /** The tab was closed. */
  closed(tabId: number): void {
    this.cancelRelease(tabId);
    if (this.marked.delete(tabId)) this.changed();
  }

  /** A new run carries on: recorded tabs no longer controlled get their own
   * icons back, controlled tabs show the mark. */
  resume(
    recorded: TabIndicatorState | null | Promise<TabIndicatorState | null>,
    controlled: Iterable<number>,
  ): Promise<void> {
    const live = new Set(controlled);
    return this.run(async () => {
      const state = await Promise.resolve(recorded).catch(() => null);
      for (const tabId of state?.tabs ?? []) this.marked.add(tabId);
    }).then(async () => {
      const ended = [...this.marked].filter((tabId) => !live.has(tabId));
      await Promise.all([
        ...ended.map((tabId) => this.releaseNow(tabId)),
        ...[...live].map((tabId) => this.show(tabId)),
      ]);
    });
  }

  state(): TabIndicatorState {
    return { tabs: [...this.marked] };
  }

  /** Resolves once every change asked for so far is done. */
  settled(): Promise<void> {
    return this.queue;
  }

  private async mark(tabId: number): Promise<void> {
    const icon = await this.options.icon();
    await this.inject(tabId, showMark, [icon]);
  }

  private async unmark(tabId: number): Promise<void> {
    await this.inject(tabId, removeMark, []);
  }

  private async inject(
    tabId: number,
    func: (...args: never[]) => unknown,
    args: unknown[],
  ): Promise<void> {
    try {
      await this.chrome.scripting.executeScript({
        target: { tabId },
        // The page's scripts cannot see or undo it there.
        world: "ISOLATED",
        // At once: a new page gets the mark before it has loaded.
        injectImmediately: true,
        func,
        args,
      });
    } catch {
      // A closed tab, or a page Chrome lets no extension script.
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
      console.warn("could not update a controlled tab's icon", error);
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
  const tabs = (value as { tabs?: unknown }).tabs;
  return {
    tabs: Array.isArray(tabs)
      ? tabs.filter((tabId): tabId is number => Number.isSafeInteger(tabId))
      : [],
  };
}

/** The state showMark keeps in the extension's isolated world of a page. */
type MarkState = { link: HTMLLinkElement; observer: MutationObserver; icon: string };

/**
 * Runs in the page's top frame, in this extension's isolated world: shows
 * `icon` as the tab's icon. The page's own icon links are set aside by
 * renaming their `rel` (kept in `data-opengeni-rel`), the mark is added as
 * the only icon in the head, and an observer keeps it so while the page
 * changes its head. Running it again only updates the icon. An observer left
 * by a version of the extension that was since reloaded stops on its own.
 * Self-contained, since Chrome runs it from its source.
 */
export function showMark(icon: string): void {
  const KEPT = "data-opengeni-rel";
  const MARK = "data-opengeni-icon";
  const scope = globalThis as typeof globalThis & { __opengeniMark?: MarkState };
  const isPageIcon = (node: Node): node is HTMLLinkElement =>
    node instanceof HTMLLinkElement &&
    !node.hasAttribute(MARK) &&
    /(^|\s)icon(\s|$)/iu.test(node.getAttribute("rel") ?? "");
  const ensure = (state: MarkState) => {
    for (const link of Array.from(document.querySelectorAll("link"))) {
      if (!isPageIcon(link)) continue;
      link.setAttribute(KEPT, link.getAttribute("rel") ?? "");
      link.setAttribute("rel", "opengeni-kept-icon");
    }
    const head = document.head;
    if (head && state.link.parentNode !== head) head.append(state.link);
    if (state.link.getAttribute("href") !== state.icon) state.link.setAttribute("href", state.icon);
  };
  let state = scope.__opengeniMark;
  if (!state) {
    // A mark a version of the extension that was since reloaded left.
    for (const old of Array.from(document.querySelectorAll(`link[${MARK}]`))) old.remove();
    const link = document.createElement("link");
    link.setAttribute("rel", "icon");
    link.setAttribute(MARK, "");
    const observer = new MutationObserver(() => {
      // The extension was reloaded or removed: its next run cleans up.
      if (!(globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id) {
        observer.disconnect();
        return;
      }
      if (scope.__opengeniMark === state) ensure(state!);
    });
    state = { link, observer, icon };
    scope.__opengeniMark = state;
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["rel", "href"],
    });
  }
  state.icon = icon;
  ensure(state);
}

/** Runs in the page's top frame, in this extension's isolated world: takes
 * the mark away and gives the page's own icons back exactly. Also cleans up
 * after a version of the extension that was since reloaded.
 * Self-contained, since Chrome runs it from its source. */
export function removeMark(): void {
  const KEPT = "data-opengeni-rel";
  const MARK = "data-opengeni-icon";
  const scope = globalThis as typeof globalThis & { __opengeniMark?: MarkState };
  scope.__opengeniMark?.observer.disconnect();
  delete scope.__opengeniMark;
  for (const link of Array.from(document.querySelectorAll(`link[${MARK}]`))) link.remove();
  for (const link of Array.from(document.querySelectorAll(`link[${KEPT}]`))) {
    link.setAttribute("rel", link.getAttribute(KEPT) ?? "icon");
    link.removeAttribute(KEPT);
  }
}
