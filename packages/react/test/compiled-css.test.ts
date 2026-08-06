import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, type AtRule, type Declaration } from "postcss";
import selectorParser, { type Selector } from "postcss-selector-parser";

import {
  assertScoped,
  buildCompiledCss,
  buildEffectiveTokensCss,
} from "../scripts/build-compiled-css";

const packageRoot = join(import.meta.dir, "..");
const compiledPath = join(packageRoot, "styles/compiled.css");
const compiled = await readFile(compiledPath, "utf8");
const effectiveTokens = await readFile(join(packageRoot, "styles/effective-tokens.css"), "utf8");
const parsed = parse(compiled);

function classesIn(node: { walkClasses(callback: (className: { value: string }) => void): void }) {
  const classes = new Set<string>();
  node.walkClasses((className) => classes.add(className.value));
  return classes;
}

function selectorHasDirectRootUtility(selector: Selector, utility: string): boolean {
  const firstCombinator = selector.nodes.findIndex((node) => node.type === "combinator");
  const firstCompound = selectorParser.selector({
    value: "",
    nodes: selector.nodes
      .slice(0, firstCombinator === -1 ? selector.nodes.length : firstCombinator)
      .map((node) => node.clone()),
  });
  const classes = classesIn(firstCompound);
  return classes.has("og-root") && classes.has(utility);
}

function selectorHasDescendantUtility(selector: Selector, utility: string): boolean {
  const firstCombinator = selector.nodes.findIndex((node) => node.type === "combinator");
  if (firstCombinator === -1) return false;
  const rootCompound = selectorParser.selector({
    value: "",
    nodes: selector.nodes.slice(0, firstCombinator).map((node) => node.clone()),
  });
  const descendant = selectorParser.selector({
    value: "",
    nodes: selector.nodes.slice(firstCombinator + 1).map((node) => node.clone()),
  });
  return classesIn(rootCompound).has("og-root") && classesIn(descendant).has(utility);
}

function selectorsForUtility(utility: string): Selector[] {
  const matches: Selector[] = [];
  parsed.walkRules((rule) => {
    const selectors = selectorParser().astSync(rule.selector).nodes;
    for (const selector of selectors) {
      if (classesIn(selector).has(utility)) matches.push(selector);
    }
  });
  return matches;
}

function hasForcedColorsOutlineFallback(utility: string): boolean {
  let found = false;
  parsed.walkRules((rule) => {
    if (!classesIn(selectorParser().astSync(rule.selector)).has(utility)) return;
    rule.walkAtRules("media", (atRule) => {
      if (atRule.params !== "(forced-colors: active)") return;
      const declarations = new Map<string, string>();
      atRule.walkDecls((declaration) => {
        declarations.set(declaration.prop, declaration.value);
      });
      if (
        declarations.get("outline") === "2px solid transparent" &&
        declarations.get("outline-offset") === "2px"
      ) {
        found = true;
      }
    });
  });
  return found;
}

function hasTokenRule(property: string, context?: { attribute: string; value: string }): boolean {
  let found = false;
  parsed.walkRules((rule) => {
    if (!rule.nodes.some((node) => node.type === "decl" && node.prop === property)) return;
    const selectors = selectorParser().astSync(rule.selector).nodes;
    for (const selector of selectors) {
      if (!classesIn(selector).has("og-root")) continue;
      if (!context) {
        found = true;
        return;
      }
      selector.walkAttributes((attribute) => {
        if (attribute.attribute === context.attribute && attribute.value === context.value) {
          found = true;
        }
      });
    }
  });
  return found;
}

function tokenRegistration(property: string) {
  const registrations: AtRule[] = [];
  parsed.walkAtRules("property", (atRule) => {
    registrations.push(atRule);
  });
  const registration = registrations.find((atRule) => atRule.params === property);
  const declarations = registration?.nodes?.filter(
    (node): node is Declaration => node.type === "decl",
  );
  if (!declarations) return null;
  return {
    inherits: declarations.find((declaration) => declaration.prop === "inherits")?.value,
    initialValue: declarations.find((declaration) => declaration.prop === "initial-value")?.value,
  };
}

describe("compiled CSS contract", () => {
  test("is deterministic, directive-free, scoped, and bounded", async () => {
    expect(await buildCompiledCss()).toBe(compiled);
    expect(await buildEffectiveTokensCss()).toBe(effectiveTokens);
    expect(() => assertScoped(compiled)).not.toThrow();

    const forbiddenDirectives = new Set([
      "config",
      "custom-variant",
      "import",
      "layer",
      "plugin",
      "source",
      "tailwind",
      "theme",
      "utility",
      "variant",
    ]);
    const foundDirectives = new Set<string>();
    parsed.walkAtRules((atRule) => {
      if (forbiddenDirectives.has(atRule.name)) foundDirectives.add(atRule.name);
      if (atRule.name === "property" && atRule.params.startsWith("--tw-")) {
        foundDirectives.add(`property ${atRule.params}`);
      }
      if (atRule.name === "keyframes" && !atRule.params.startsWith("og-")) {
        foundDirectives.add(`keyframes ${atRule.params}`);
      }
    });
    expect([...foundDirectives]).toEqual([]);
    expect(Buffer.byteLength(compiled)).toBeGreaterThan(120_000);
    expect(Buffer.byteLength(compiled)).toBeLessThan(256_000);
  });

  test("contains representative utilities for roots and descendants", () => {
    for (const utility of ["fixed", "flex", "bg-og-surface-1", "rounded-og-lg"]) {
      const selectors = selectorsForUtility(utility);
      expect(selectors.some((selector) => selectorHasDirectRootUtility(selector, utility))).toBe(
        true,
      );
      expect(selectors.some((selector) => selectorHasDescendantUtility(selector, utility))).toBe(
        true,
      );
    }
  });

  test("keeps outline-hidden focus utilities safe in forced-colors mode", () => {
    expect(selectorsForUtility("outline-none")).toEqual([]);
    expect(hasForcedColorsOutlineFallback("outline-hidden")).toBe(true);
    expect(hasForcedColorsOutlineFallback("focus:outline-hidden")).toBe(true);
    expect(hasForcedColorsOutlineFallback("focus-visible:outline-hidden")).toBe(true);
  });

  test("registers independent defaults and keeps derived defaults live", () => {
    expect(tokenRegistration("--og-color-bg")).toEqual({
      inherits: "true",
      initialValue: "oklch(0.155 0.012 260)",
    });
    expect(tokenRegistration("--og-color-accent-soft")).toBeNull();
    expect(effectiveTokens).toContain(
      "--_og-color-accent-soft: var(--og-color-accent-soft, color-mix(in oklch, var(--og-color-accent) 16%, transparent))",
    );
    expect(compiled).toContain("background-color: var(--_og-color-accent-soft)");
    const effective = parse(effectiveTokens);
    const derivedTokens = new Set<string>();
    effective.walkDecls(/^--_og-/u, (declaration) => {
      derivedTokens.add(declaration.prop.replace(/^--_og-/u, "--og-"));
    });
    expect(derivedTokens.size).toBeGreaterThan(15);
    for (const token of derivedTokens) expect(tokenRegistration(token)).toBeNull();
    expect(hasTokenRule("--og-color-bg", { attribute: "data-og-theme", value: "light" })).toBe(
      true,
    );
    expect(
      hasTokenRule("--og-font-size-menu", {
        attribute: "data-og-density",
        value: "compact",
      }),
    ).toBe(true);
  });

  test("initializes Tailwind runtime variables only inside component roots", () => {
    for (const property of [
      "--tw-translate-x",
      "--tw-border-style",
      "--tw-shadow",
      "--tw-ring-shadow",
      "--tw-blur",
    ]) {
      let found = false;
      parsed.walkRules((rule) => {
        if (!rule.selector.includes(":where(.og-root) *")) return;
        if (rule.nodes.some((node) => node.type === "decl" && node.prop === property)) found = true;
      });
      expect(found).toBe(true);
    }
  });

  test("keeps portal surfaces independently rooted and token-propagated", async () => {
    for (const relativePath of [
      "src/components/file-browser.tsx",
      "src/components/model-policy-picker.tsx",
      "src/components/tooltip.tsx",
      "src/realtime/dropdown-menu.tsx",
      "src/timeline/screenshot-lightbox.tsx",
    ]) {
      const source = await readFile(join(packageRoot, relativePath), "utf8");
      expect(source).toContain("usePortalTokenStyle");
      expect(source).toContain('"og-root');
    }
    const fileBrowser = await readFile(
      join(packageRoot, "src/components/file-browser.tsx"),
      "utf8",
    );
    const lightbox = await readFile(
      join(packageRoot, "src/timeline/screenshot-lightbox.tsx"),
      "utf8",
    );
    const timelineShared = await readFile(join(packageRoot, "src/timeline/shared.tsx"), "utf8");
    expect(fileBrowser).toContain('<AlertDialog.Overlay className="og-root');
    expect(lightbox.match(/style=\{portalStyle\}/gu)?.length).toBe(2);
    expect(
      timelineShared.match(/lightbox\.open\(src, caption, event\.currentTarget\)/gu)?.length,
    ).toBe(2);
    expect(
      selectorsForUtility("fixed").some((selector) =>
        selectorHasDirectRootUtility(selector, "fixed"),
      ),
    ).toBe(true);
  });
});
