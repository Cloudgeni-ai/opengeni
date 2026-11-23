import { describe, expect, test } from "bun:test";
import { SITE_CHARTS_JS, SITE_UI_CSS, resolveSiteUiStylesheet } from "./site-ui";

describe("chart helpers", () => {
  test("inline the opt-in script tag and leave other scripts alone", () => {
    for (const tag of [
      '<script src="/__opengeni/charts.js"></script>',
      "<script src='/__opengeni/charts.js' defer></script>",
      "<SCRIPT src=/__opengeni/charts.js></SCRIPT>",
    ]) {
      const out = resolveSiteUiStylesheet(`<head>${tag}</head>`);
      expect(out).toContain("<script data-opengeni-charts>");
      expect(out).not.toContain("/__opengeni/charts.js");
    }
    const html = [
      '<script src="/__opengeni/charts.jsx"></script>',
      '<script src="/__opengeni/charts.js">alert(1)</script>',
      '<!-- <script src="/__opengeni/charts.js"></script> -->',
      "<script>const s = '<script src=\"/__opengeni/charts.js\"><\\/script>';</script>",
    ].join("");
    expect(resolveSiteUiStylesheet(html)).toBe(html);
  });

  test("the runtime defines og once with formats that read well", () => {
    const scope = globalThis as unknown as { window?: Record<string, unknown> };
    const previous = scope.window;
    scope.window = {};
    try {
      new Function(SITE_CHARTS_JS)();
      const og = scope.window.og as {
        fmt: Record<string, (v: unknown, o?: unknown) => unknown>;
      } & Record<string, unknown>;
      for (const name of ["kpis", "bars", "line", "scatter", "table"])
        expect(typeof og[name]).toBe("function");
      new Function(SITE_CHARTS_JS)();
      expect(scope.window.og).toBe(og);
      expect(og.fmt.pct(56.14)).toBe("56.1%");
      expect(og.fmt.money(0.531)).toBe("$0.53");
      expect(og.fmt.money(3_120_000)).toBe("$3.1M");
      expect(og.fmt.compact(2_286_002)).toBe("2.3M");
      expect(og.fmt.ms(1840)).toBe("1.8 s");
      expect(og.fmt.num(null)).toBe("\u2014");
      expect(og.fmt.delta(-18, { better: "lower" })).toEqual({
        text: "\u25BC \u221218%",
        tone: "good",
      });
      expect(og.fmt.delta(1.7, { unit: "pp" })).toEqual({ text: "\u25B2 +1.7 pp", tone: "good" });
    } finally {
      scope.window = previous;
    }
  });

  test("the stylesheet defines every series colour for light and both dark forms", () => {
    for (let i = 1; i <= 6; i++)
      expect(SITE_UI_CSS.match(new RegExp(`--og-series-${i}:`, "g"))).toHaveLength(3);
  });
});

describe("resolveSiteUiStylesheet", () => {
  test("inlines the opt-in stylesheet tag in any attribute order", () => {
    for (const tag of [
      '<link rel="stylesheet" href="/__opengeni/ui.css">',
      "<link href='/__opengeni/ui.css' rel='stylesheet' />",
      '<LINK rel=stylesheet href="/__opengeni/ui.css">',
    ]) {
      const out = resolveSiteUiStylesheet(`<head>${tag}</head>`);
      expect(out).toContain("<style data-opengeni-ui>");
      expect(out).toContain(SITE_UI_CSS);
      expect(out).not.toContain("/__opengeni/ui.css");
    }
  });

  test("leaves other links, comments and scripts alone", () => {
    const html = [
      '<link rel="stylesheet" href="/app.css">',
      '<link rel="preload" href="/__opengeni/ui.css">',
      '<!-- <link rel="stylesheet" href="/__opengeni/ui.css"> -->',
      '<script>const t = \'<link rel="stylesheet" href="/__opengeni/ui.css">\';</script>',
    ].join("");
    expect(resolveSiteUiStylesheet(html)).toBe(html);
    expect(resolveSiteUiStylesheet("<p>plain</p>")).toBe("<p>plain</p>");
  });

  test("inlines a style that only imports the stylesheet, as bundlers leave it", () => {
    for (const tag of [
      '<style>@import "/__opengeni/ui.css";</style>',
      "<style>\n  @import url('/__opengeni/ui.css');\n</style>",
      "<STYLE type=text/css>@import url(/__opengeni/ui.css)</STYLE>",
    ]) {
      const out = resolveSiteUiStylesheet(`<head>${tag}</head>`);
      expect(out).toBe(`<head><style data-opengeni-ui>${SITE_UI_CSS}</style></head>`);
    }
    const mixed = '<style>@import "/__opengeni/ui.css"; body { color: red }</style>';
    expect(resolveSiteUiStylesheet(mixed)).toBe(mixed);
  });

  test("the bundler-safe form survives a Bun HTML build", async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "og-site-ui-"));
    try {
      await writeFile(join(dir, "app.js"), "console.log('app');\n");
      await writeFile(
        join(dir, "index.html"),
        '<!doctype html><html><head><style>@import "/__opengeni/ui.css";</style></head><body class="og-app"><script type="module" src="./app.js"></script></body></html>',
      );
      const built = await Bun.build({
        entrypoints: [join(dir, "index.html")],
        outdir: join(dir, "dist"),
        target: "browser",
      });
      expect(built.success).toBe(true);
      const html = await readFile(join(dir, "dist", "index.html"), "utf8");
      expect(resolveSiteUiStylesheet(html)).toContain("<style data-opengeni-ui>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("follows the theme through prefers-color-scheme and data-og-theme", () => {
    expect(SITE_UI_CSS).toContain("@media (prefers-color-scheme:dark)");
    expect(SITE_UI_CSS).toContain(":root[data-og-theme=dark]");
    expect(SITE_UI_CSS).not.toMatch(/(^|[}\s])(body|html|\*)\s*\{/);
  });

  test("sizes text in rem, so the reader's text size applies, and keeps phone inputs at 16px", () => {
    expect(SITE_UI_CSS).not.toMatch(/(font-size|line-height):\s*[\d.]+px|font:[^;}]*\d+px/);
    expect(SITE_UI_CSS).toContain("@media (pointer:coarse){.og-input{font-size:1rem}}");
  });
});
