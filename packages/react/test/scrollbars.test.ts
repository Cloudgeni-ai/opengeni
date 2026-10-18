import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markClassicScrollbars } from "../src/lib/scrollbars";
import { registerDom } from "./render-hook";

registerDom();

/** A fresh document whose probe reports the given scrollbar width. */
function documentWithScrollbar(width: number): Document {
  const doc = document.implementation.createHTMLDocument("probe");
  const createElement = doc.createElement.bind(doc);
  doc.createElement = ((tag: string) => {
    const element = createElement(tag);
    Object.defineProperty(element, "offsetWidth", { get: () => 100 });
    Object.defineProperty(element, "clientWidth", { get: () => 100 - width });
    return element;
  }) as Document["createElement"];
  return doc;
}

describe("markClassicScrollbars", () => {
  test("marks documents whose platform draws classic scrollbars", () => {
    const doc = documentWithScrollbar(17);
    markClassicScrollbars(doc);
    expect(doc.documentElement.getAttribute("data-og-scrollbars")).toBe("classic");
    expect(doc.documentElement.children).toHaveLength(2);
  });

  test("leaves overlay-scrollbar documents unmarked", () => {
    const doc = documentWithScrollbar(0);
    doc.documentElement.setAttribute("data-og-scrollbars", "classic");
    markClassicScrollbars(doc);
    expect(doc.documentElement.hasAttribute("data-og-scrollbars")).toBe(false);
  });

  test("probes each document once", () => {
    const doc = documentWithScrollbar(17);
    markClassicScrollbars(doc);
    doc.documentElement.removeAttribute("data-og-scrollbars");
    markClassicScrollbars(doc);
    expect(doc.documentElement.hasAttribute("data-og-scrollbars")).toBe(false);
  });

  test("styles only documents marked classic", () => {
    const css = readFileSync(join(import.meta.dir, "../styles/index.css"), "utf8");
    const block = css.slice(css.indexOf("@supports selector(::-webkit-scrollbar)"));
    for (const selector of block.match(/^\s*:where[^{]+\{/gm) ?? []) {
      expect(selector).toContain(':root[data-og-scrollbars="classic"]');
    }
    expect(block).toContain("scrollbar-width: auto");
  });
});
