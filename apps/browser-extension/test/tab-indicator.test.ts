import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  TabIndicator,
  parseTabIndicatorState,
  removeMark,
  showMark,
  type TabIndicatorState,
} from "../src/tab-indicator";

const ICON = "data:image/png;base64,TUFSSw==";
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A page in a tab, with the extension's isolated world. Chrome runs an
 * injected function from its source in that world, so it is run here the same
 * way, from its source, with the page's DOM. A reloaded extension leaves its
 * world behind without `chrome.runtime.id`. */
function page(html: string) {
  const window = new Window({ url: "https://example.com/" });
  window.document.write(html);
  const world = (extensionId: string | undefined) => {
    const scope: Record<string, unknown> = { chrome: { runtime: { id: extensionId } } };
    const run = (func: (...args: never[]) => unknown, ...args: unknown[]) =>
      new Function(
        "document",
        "HTMLLinkElement",
        "MutationObserver",
        "globalThis",
        `return (${func.toString()})(...arguments[4]);`,
      )(window.document, window.HTMLLinkElement, window.MutationObserver, scope, args);
    return { scope, run };
  };
  return {
    window,
    document: window.document,
    world,
    /** The icons Chrome would consider: the head's links whose rel names an icon. */
    icons: () =>
      Array.from(window.document.head.querySelectorAll("link"))
        .filter((link) => /(^|\s)icon(\s|$)/iu.test(link.getAttribute("rel") ?? ""))
        .map((link) => link.getAttribute("href")),
  };
}

const PAGE = `<!doctype html><html><head><title>Docs</title>
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/touch.png">
<link rel="stylesheet" href="/site.css">
</head><body><p>Hello</p></body></html>`;

describe("the mark in a page", () => {
  test("is the only icon while shown, and the page's own icons come back exactly", async () => {
    const tab = page(PAGE);
    const before = tab.document.documentElement.outerHTML;
    const extension = tab.world("abc");
    extension.run(showMark, ICON);
    expect(tab.icons()).toEqual([ICON]);
    expect(tab.document.title).toBe("Docs");
    expect(tab.document.body.innerHTML).toBe("<p>Hello</p>");
    // Untouched: not an icon Chrome shows in the tab strip.
    expect(tab.document.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull();

    extension.run(removeMark);
    await flush();
    expect(tab.icons()).toEqual(["/favicon-32.png", "/favicon.ico"]);
    expect(tab.document.documentElement.outerHTML).toBe(before);
  });

  test("stays while the page changes its icon, and the page's change survives", async () => {
    const tab = page(PAGE);
    const extension = tab.world("abc");
    extension.run(showMark, ICON);
    // A page that shows a count in its icon adds a new one.
    const unread = tab.document.createElement("link");
    unread.setAttribute("rel", "icon");
    unread.setAttribute("href", "/unread.png");
    tab.document.head.append(unread);
    // And one that rewrites its head drops the mark.
    tab.document.head.querySelector("link[data-opengeni-icon]")!.remove();
    await flush();
    expect(tab.icons()).toEqual([ICON]);

    extension.run(removeMark);
    await flush();
    expect(tab.icons()).toEqual(["/favicon-32.png", "/favicon.ico", "/unread.png"]);
  });

  test("a page with no icon of its own goes back to having none", async () => {
    const tab = page("<html><head><title>Plain</title></head><body></body></html>");
    const extension = tab.world("abc");
    extension.run(showMark, ICON);
    extension.run(showMark, ICON);
    expect(tab.icons()).toEqual([ICON]);
    extension.run(removeMark);
    await flush();
    expect(tab.document.head.querySelectorAll("link").length).toBe(0);
  });

  test("a page still loading gets the mark once its head exists", async () => {
    const window = new Window({ url: "https://example.com/" });
    const document = window.document;
    document.documentElement.remove();
    const scope = { chrome: { runtime: { id: "abc" } } };
    new Function(
      "document",
      "HTMLLinkElement",
      "MutationObserver",
      "globalThis",
      `return (${showMark.toString()})(arguments[4]);`,
    )(document, window.HTMLLinkElement, window.MutationObserver, scope, ICON);
    const html = document.createElement("html");
    document.append(html);
    const head = document.createElement("head");
    html.append(head);
    const own = document.createElement("link");
    own.setAttribute("rel", "icon");
    own.setAttribute("href", "/own.png");
    head.append(own);
    await flush();
    const icons = Array.from(head.querySelectorAll("link"))
      .filter((link) => link.getAttribute("rel") === "icon")
      .map((link) => link.getAttribute("href"));
    expect(icons).toEqual([ICON]);
  });

  test("a reloaded extension's next run cleans up what the last one left", async () => {
    const tab = page(PAGE);
    const before = tab.document.documentElement.outerHTML;
    const old = tab.world("abc");
    old.run(showMark, ICON);
    // Reloading leaves the old world behind, its observer still attached.
    (old.scope.chrome as { runtime: { id?: string } }).runtime.id = undefined;
    const next = tab.world("abc");
    next.run(removeMark);
    await flush();
    expect(tab.document.documentElement.outerHTML).toBe(before);
    // A mark shown by the next run replaces one the old run left.
    old.run(showMark, ICON);
    (old.scope.chrome as { runtime: { id?: string } }).runtime.id = undefined;
    next.run(showMark, ICON);
    await flush();
    expect(tab.document.querySelectorAll("link[data-opengeni-icon]").length).toBe(1);
    next.run(removeMark);
    await flush();
    expect(tab.document.documentElement.outerHTML).toBe(before);
  });
});

function indicator(options: { failing?: Set<number>; saved?: TabIndicatorState[] } = {}) {
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  const instance = new TabIndicator(
    {
      scripting: {
        executeScript: async ({ target, func, args, world, injectImmediately }) => {
          expect(world).toBe("ISOLATED");
          expect(injectImmediately).toBe(true);
          if (options.failing?.has(target.tabId))
            throw new Error("Cannot access contents of the page.");
          calls.push(`${func.name} ${target.tabId}${args.length > 0 ? ` ${String(args[0])}` : ""}`);
          return [];
        },
      },
    },
    {
      icon: async () => ICON,
      releaseDelayMs: 2_000,
      onChange: (state) => options.saved?.push(state),
      setTimeout: (callback) => timers.push(callback) - 1,
      clearTimeout: (timer) => {
        timers[timer as number] = () => {};
      },
    },
  );
  return {
    tabs: instance,
    calls,
    /** The release delay passes. */
    elapse: async () => {
      for (const run of timers.splice(0)) run();
      await instance.settled();
    },
  };
}

describe("the controlled tabs' icons", () => {
  test("a controlled tab shows the mark, and gets its own icon back once released", async () => {
    const { tabs, calls, elapse } = indicator();
    await tabs.show(4);
    expect(calls).toEqual([`showMark 4 ${ICON}`]);
    tabs.release(4);
    await tabs.settled();
    expect(calls).toHaveLength(1);
    await elapse();
    expect(calls).toEqual([`showMark 4 ${ICON}`, "removeMark 4"]);
    expect(tabs.state()).toEqual({ tabs: [] });
  });

  test("control that ends for a moment keeps the mark", async () => {
    const { tabs, calls, elapse } = indicator();
    await tabs.show(4);
    tabs.release(4);
    await tabs.show(4);
    await elapse();
    expect(calls).not.toContain("removeMark 4");
    expect(tabs.state()).toEqual({ tabs: [4] });
  });

  test("a new page in a controlled tab gets the mark again; other tabs are left alone", async () => {
    const { tabs, calls } = indicator();
    await tabs.show(4);
    await tabs.navigated(4);
    await tabs.navigated(5);
    expect(calls).toEqual([`showMark 4 ${ICON}`, `showMark 4 ${ICON}`]);
  });

  test("a page it cannot script keeps its icon, and nothing fails", async () => {
    const { tabs, calls, elapse } = indicator({ failing: new Set([6]) });
    await tabs.show(6);
    tabs.release(6);
    await elapse();
    expect(calls).toEqual([]);
    expect(tabs.state()).toEqual({ tabs: [] });
  });

  test("a closed tab is forgotten without touching it", async () => {
    const saved: TabIndicatorState[] = [];
    const { tabs, calls, elapse } = indicator({ saved });
    await tabs.show(4);
    tabs.release(4);
    tabs.closed(4);
    await elapse();
    expect(calls).toEqual([`showMark 4 ${ICON}`]);
    expect(saved.at(-1)).toEqual({ tabs: [] });
  });

  test("a new run gives ended tabs their icons back and marks controlled ones", async () => {
    const saved: TabIndicatorState[] = [];
    const first = indicator({ saved });
    await first.tabs.show(4);
    await first.tabs.show(5);
    const recorded = parseTabIndicatorState(JSON.parse(JSON.stringify(saved.at(-1))));
    // Tab 5 is still controlled, tab 4 no longer, tab 7 is now.
    const next = indicator();
    await next.tabs.resume(Promise.resolve(recorded), [5, 7]);
    expect(next.calls.sort()).toEqual(["removeMark 4", `showMark 5 ${ICON}`, `showMark 7 ${ICON}`]);
    expect(next.tabs.state().tabs.sort()).toEqual([5, 7]);
  });

  test("parses only well-formed recorded state", () => {
    expect(parseTabIndicatorState(null)).toBeNull();
    expect(parseTabIndicatorState({ tabs: [3, "x", 1.5] })).toEqual({ tabs: [3] });
  });
});
