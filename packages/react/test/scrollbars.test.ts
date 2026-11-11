import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type AtRule } from "postcss";
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
    const blocks: AtRule[] = [];
    parse(css).walkAtRules("supports", (rule) => {
      if (rule.params === "selector(::-webkit-scrollbar)") blocks.push(rule);
    });
    expect(blocks).toHaveLength(1);
    let selectors = 0;
    let resets = 0;
    blocks[0]!.walkRules((rule) => {
      // Visit every comma-separated selector, not just lines beginning :where.
      // An unscoped rule or a missing block must not make this guard vacuous.
      for (const selector of rule.selectors) {
        expect(selector).toContain(':root[data-og-scrollbars="classic"]');
        selectors += 1;
      }
      rule.walkDecls("scrollbar-width", (declaration) => {
        expect(declaration.value).toBe("auto");
        resets += 1;
      });
    });
    expect(selectors).toBeGreaterThan(0);
    expect(resets).toBeGreaterThan(0);
  });
});
