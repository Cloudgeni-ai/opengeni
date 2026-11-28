import { describe, expect, test } from "bun:test";
import { HTML_FRAME_STILL_POLICY } from "@opengeni/contracts/html-frame-host";

import {
  HTML_FRAME_PREVIEW_POLICY,
  SITE_PREVIEW_PAINTED_MESSAGE,
  sitePreviewDocument,
  sitePreviewPainted,
} from "../src/site-preview";

const scriptOf = (document: string) => {
  const match = /^<!doctype html><meta [^>]+><script>([\s\S]*?)<\/script>/.exec(document);
  if (!match) throw new Error("no preview script");
  return match[1]!;
};

/** Runs the preview script against a stand-in window and returns what it posts. */
function runPreviewScript(
  document: string,
  page: { text: string; media?: boolean; background?: string; box?: string },
) {
  const posted: unknown[] = [];
  const timers: Array<() => void> = [];
  const listeners: Array<() => void> = [];
  const named = new Map<string, Array<() => void>>();
  const fakeGlobal: Record<string, unknown> = {};
  const root = {
    style: {} as Record<string, string>,
    setAttribute: (name: string, value: string) => (fakeGlobal[name] = value),
  };
  const body = { innerText: page.text };
  const box = { box: page.box };
  const fakeDocument = {
    readyState: "loading",
    documentElement: root,
    body,
    querySelector: () => (page.media ? {} : null),
    elementsFromPoint: () => (page.box ? [box, body, root] : [body, root]),
  };
  new Function(
    "globalThis",
    "document",
    "addEventListener",
    "setTimeout",
    "getComputedStyle",
    "window",
    "parent",
    "innerWidth",
    "innerHeight",
    scriptOf(document),
  )(
    fakeGlobal,
    fakeDocument,
    (name: string, listener: () => void) => {
      if (name === "load") listeners.push(listener);
      else named.set(name, [...(named.get(name) ?? []), listener]);
    },
    (callback: () => void) => timers.push(callback),
    (element: unknown) => ({
      backgroundColor:
        element === root
          ? (root.style["backgroundColor"] ?? "rgba(0, 0, 0, 0)")
          : element === box
            ? page.box
            : (page.background ?? "rgba(0, 0, 0, 0)"),
      backgroundImage: "none",
      borderTopWidth: "0px",
    }),
    {},
    { postMessage: (message: unknown) => posted.push(message) },
    1024,
    768,
  );
  return {
    fakeGlobal,
    posted,
    root,
    fire(name: string) {
      for (const listener of named.get(name) ?? []) listener();
    },
    /** Fire load and let every pending timer and promise run. */
    async settle() {
      for (const listener of listeners) listener();
      for (let round = 0; round < 6; round += 1) {
        await Promise.resolve();
        await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
        for (const timer of timers.splice(0)) timer();
      }
    },
  };
}

describe("Site card preview document", () => {
  test("lets the page's own scripts run but blocks every call it could make", () => {
    expect(HTML_FRAME_PREVIEW_POLICY).toContain("script-src 'unsafe-inline'");
    for (const directive of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'"])
      expect(HTML_FRAME_PREVIEW_POLICY).toContain(directive);
    expect(HTML_FRAME_PREVIEW_POLICY.startsWith("default-src 'none'")).toBe(true);
    // The old still policy ran no scripts at all, so script-drawn apps were blank.
    expect(HTML_FRAME_STILL_POLICY).not.toContain("script-src");
  });

  test("puts the policy first, then the stand-in client, then the page", () => {
    const document = sitePreviewDocument(
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><div id="app"></div><script>render()</script></body></html>',
    );
    expect(
      document.startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_PREVIEW_POLICY}"><script>`,
      ),
    ).toBe(true);
    expect(document.indexOf("createOpenGeniSiteClient")).toBeLessThan(document.indexOf("<html>"));
    expect(document).toContain("<script>render()</script>");
    expect(document).toContain("overflow:hidden");
  });

  test("inlines the Opengeni look and drops the Site client script", () => {
    const document = sitePreviewDocument(
      [
        '<link rel="stylesheet" href="/__opengeni/ui.css">',
        '<script src="/__opengeni/site-tools/client.js"></script>',
        '<!-- <script src="/__opengeni/site-tools/client.js"></script> -->',
        '<h1 class="og-title">Issue tracker</h1>',
      ].join(""),
    );
    expect(document).toContain("<style data-opengeni-ui>");
    expect(document).not.toContain('href="/__opengeni/ui.css"');
    // The real tag is gone; the one inside a comment stays literal.
    expect(document.split("/__opengeni/site-tools/client.js")).toHaveLength(2);
    expect(document).toContain('<h1 class="og-title">Issue tracker</h1>');
  });

  test("drops the Site client however it is tagged, and any refresh", () => {
    const document = sitePreviewDocument(
      [
        '<meta http-equiv="refresh" content="0;url=https://example.com/">',
        "<META HTTP-EQUIV=Refresh CONTENT=5>",
        '<script defer type="module" src="https://site.example/__opengeni/site-tools/client.js?v=2"></script>',
        "<script src=/__opengeni/site-tools/client.js></script>",
        '<script src="/app.js"></script>',
        '<meta name="viewport" content="width=device-width">',
      ].join(""),
    );
    expect(document).not.toContain("site-tools/client.js");
    expect(document).not.toMatch(/refresh/i);
    expect(document).toContain('<script src="/app.js"></script>');
    expect(document).toContain('<meta name="viewport"');
  });

  test("sets the viewer's theme for the Opengeni look, unless the Site picks its own", () => {
    const run = runPreviewScript(sitePreviewDocument("<p>x</p>", { theme: "dark" }), { text: "x" });
    expect(run.fakeGlobal["data-og-theme"]).toBe("dark");
    const own = runPreviewScript(
      sitePreviewDocument('<html data-og-theme="light"><p>x</p></html>', { theme: "dark" }),
      { text: "x" },
    );
    expect(own.fakeGlobal["data-og-theme"]).toBeUndefined();
  });

  test("lays the page out at the preview width, also in a mobile web view", () => {
    expect(sitePreviewDocument("<p>x</p>")).toContain(
      '<meta name="viewport" content="width=1024">',
    );
  });

  test("a page that leaves says so, even after its report", async () => {
    const run = runPreviewScript(sitePreviewDocument("<p>x</p>"), { text: "x" });
    await run.settle();
    run.fire("pagehide");
    expect(run.posted).toEqual([
      { type: SITE_PREVIEW_PAINTED_MESSAGE, painted: true },
      { type: SITE_PREVIEW_PAINTED_MESSAGE, painted: false, left: true },
    ]);
  });

  test("the stand-in client never settles, so an app keeps its loading state", async () => {
    const run = runPreviewScript(sitePreviewDocument("<p>x</p>"), { text: "x" });
    const create = run.fakeGlobal["createOpenGeniSiteClient"] as () => Record<string, unknown>;
    const client = create();
    const call = (client["sql"] as (query: string) => Promise<unknown>)("select 1");
    let settled = false;
    void Promise.resolve(call).then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    // The real client, loaded anyway, can't replace the stand-in.
    (run.fakeGlobal as { createOpenGeniSiteClient: unknown }).createOpenGeniSiteClient = () =>
      "real";
    expect(() =>
      Object.defineProperty(run.fakeGlobal, "createOpenGeniSiteClient", { value: () => "real" }),
    ).toThrow();
    expect((run.fakeGlobal["createOpenGeniSiteClient"] as () => unknown)()).not.toBe("real");
  });

  test.each([
    [{ text: "Open issues 12" }, true],
    [{ text: "  ", media: true }, true],
    [{ text: "", background: "rgb(17, 17, 17)" }, true],
    [{ text: "" }, false],
    [{ text: "", background: "rgb(255, 255, 255)" }, false],
    // Cards and panels drawn with CSS alone, on a white page.
    [{ text: "", box: "rgb(37, 99, 235)" }, true],
    [{ text: "", box: "rgba(0, 0, 0, 0)" }, false],
    // An app still waiting on the stand-in client isn't a picture.
    [{ text: "Loading…", background: "rgb(17, 17, 17)" }, false],
    [{ text: "Loading issues: 12 open" }, true],
  ])("reports once whether the page painted: %o", async (page, painted) => {
    const run = runPreviewScript(sitePreviewDocument("<div id=app></div>"), page);
    await run.settle();
    expect(run.posted).toEqual([{ type: SITE_PREVIEW_PAINTED_MESSAGE, painted }]);
  });

  test("a painted page without a background of its own gets its canvas color", async () => {
    const plain = runPreviewScript(sitePreviewDocument("<p>Hi</p>"), { text: "Hi" });
    await plain.settle();
    expect(plain.root.style["backgroundColor"]).toBe("Canvas");
    const own = runPreviewScript(sitePreviewDocument("<p>Hi</p>"), {
      text: "Hi",
      background: "rgb(15, 17, 21)",
    });
    await own.settle();
    expect(own.root.style["backgroundColor"]).toBeUndefined();
  });

  test("reads a report from a frame or a mobile web view, and nothing else", () => {
    const report = { type: SITE_PREVIEW_PAINTED_MESSAGE, painted: true };
    expect(sitePreviewPainted(report)).toBe(true);
    expect(sitePreviewPainted(JSON.stringify({ ...report, painted: false }))).toBe(false);
    expect(sitePreviewPainted({ type: SITE_PREVIEW_PAINTED_MESSAGE, painted: "yes" })).toBeNull();
    expect(sitePreviewPainted({ type: "other", painted: true })).toBeNull();
    expect(sitePreviewPainted(`${SITE_PREVIEW_PAINTED_MESSAGE}{`)).toBeNull();
    expect(sitePreviewPainted("hello")).toBeNull();
    expect(sitePreviewPainted(null)).toBeNull();
  });
});
