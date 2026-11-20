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

  test("follows the theme through prefers-color-scheme and data-og-theme", () => {
    expect(SITE_UI_CSS).toContain("@media (prefers-color-scheme:dark)");
    expect(SITE_UI_CSS).toContain(":root[data-og-theme=dark]");
    expect(SITE_UI_CSS).not.toMatch(/(^|[}\s])(body|html|\*)\s*\{/);
  });
});
