import { describe, expect, test } from "bun:test";
import { SITE_UI_CSS, resolveSiteUiStylesheet } from "./site-ui";

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
