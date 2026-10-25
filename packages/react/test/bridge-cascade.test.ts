import { beforeAll, describe, expect, test } from "bun:test";
import tailwindcss from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postcss, { parse, type Root, type Rule } from "postcss";
import selectorParser, { type Node, type Selector } from "postcss-selector-parser";

// A Tailwind v4 host that compiles Opengeni through the source bridge (README)
// must cascade like the ready-made compiled.css. In the bridge, utilities sit
// in `@layer utilities`, so any unlayered package rule beats every utility
// whatever its specificity; compiled.css has no layers, and its zero-
// specificity base yields to every utility.

const packageRoot = join(import.meta.dir, "..");

// The host entry the README documents, plus the plain stylesheets components
// import themselves, which the host bundler adds to the same page.
const bridgeHost = `@import "tailwindcss";
@import "./index.css";
@import "./responsive.css";
@import "./app.css";
@import "./connect.css";
@import "./this-computer.css";
@import "../src/app/components/capabilities/session-capability-card.css";
@source "../src";
`;

type Specificity = [number, number, number];

const zero: Specificity = [0, 0, 0];

function compare(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function highest(values: Specificity[]): Specificity {
  return values.reduce<Specificity>(
    (best, value) => (compare(value, best) > 0 ? value : best),
    zero,
  );
}

/**
 * Selector specificity. With `lowerRoot`, it is the specificity compiled.css
 * ships for the same source selector: the build lowers `.og-root` to
 * `:where(.og-root)` (except in the typography guard, which names the root
 * twice) and maps the document root onto `:where(.og-root)`.
 */
function specificity(selector: Selector, lowerRoot: boolean): Specificity {
  const of = (node: Node): Specificity => {
    switch (node.type) {
      case "id":
        return [1, 0, 0];
      case "class":
        return lowerRoot && node.value === "og-root" ? zero : [0, 1, 0];
      case "attribute":
        return [0, 1, 0];
      case "tag":
        return [0, 0, 1];
      case "pseudo":
        if (node.value.startsWith("::")) return [0, 0, 1];
        if ([":before", ":after", ":first-line", ":first-letter"].includes(node.value)) {
          return [0, 0, 1];
        }
        if (node.value === ":where") return zero;
        if ([":is", ":not", ":has", ":matches"].includes(node.value)) {
          return highest(node.nodes.map((argument) => specificity(argument, lowerRoot)));
        }
        if (lowerRoot && (node.value === ":root" || node.value === ":host")) return zero;
        return [0, 1, 0];
      default:
        return zero;
    }
  };
  return selector.nodes.reduce<Specificity>((total, node) => {
    const value = of(node);
    return [total[0] + value[0], total[1] + value[1], total[2] + value[2]];
  }, zero);
}

function rootCount(selector: Selector): number {
  let count = 0;
  selector.walkClasses((className) => {
    if (className.value === "og-root") count += 1;
  });
  return count;
}

/** `:root` or `:host` alone: in a bridge host that is the host's document, not SDK markup. */
function isDocumentRoot(selector: Selector): boolean {
  const nodes = selector.nodes.filter((node) => node.type !== "comment");
  return (
    nodes.length === 1 &&
    nodes[0]?.type === "pseudo" &&
    (nodes[0].value === ":root" || nodes[0].value === ":host")
  );
}

type Parent = { type: string; name?: string; params?: string; parent?: Parent | undefined };

function ancestors(rule: Rule): Parent[] {
  const found: Parent[] = [];
  for (let parent = rule.parent as Parent | undefined; parent; parent = parent.parent) {
    found.push(parent);
  }
  return found;
}

function layerOf(rule: Rule): string | null {
  const layer = ancestors(rule).find(
    (parent) => parent.type === "atrule" && parent.name === "layer",
  );
  return layer ? (layer.params ?? "") : null;
}

async function buildBridgeHostCss(): Promise<Root> {
  const result = await postcss([tailwindcss({ optimize: false })]).process(bridgeHost, {
    from: join(packageRoot, "styles/bridge-host.input.css"),
  });
  return parse(result.css);
}

/**
 * Unlayered bridge rules whose compiled.css twin has no class-level
 * specificity: every utility beats them in compiled.css, and none can in the
 * bridge. Custom properties (tokens are the documented override surface) and
 * `!important` declarations (layered important wins in the bridge; compiled
 * keeps the more specific utility) resolve alike and are not counted.
 */
function utilityShadowingRules(css: Root): string[] {
  const offenders: string[] = [];
  css.walkRules((rule) => {
    if (layerOf(rule) !== null) return;
    const inKeyframes = ancestors(rule).some(
      (parent) => parent.type === "atrule" && parent.name?.endsWith("keyframes") === true,
    );
    if (inKeyframes) return;
    const properties = rule.nodes.flatMap((node) =>
      node.type === "decl" && !node.prop.startsWith("--") && !node.important ? [node.prop] : [],
    );
    if (properties.length === 0) return;
    const selectors = selectorParser().astSync(rule.selector).nodes;
    const typographyGuard = selectors.some((selector) => rootCount(selector) > 1);
    for (const selector of selectors) {
      if (isDocumentRoot(selector)) continue;
      const [ids, classes] = specificity(selector, !typographyGuard);
      if (ids === 0 && classes === 0) {
        offenders.push(`${selector.toString().trim()} { ${properties.join(", ")} }`);
      }
    }
  });
  return offenders;
}

/** The layer (null when unlayered) and position of each rule that sets `property` for `selector`. */
function rulesSetting(css: Root, selector: string, property: string) {
  const found: { layer: string | null; position: number }[] = [];
  let position = 0;
  css.walkRules((rule) => {
    position += 1;
    if (!rule.selectors.map((item) => item.trim()).includes(selector)) return;
    if (!rule.nodes.some((node) => node.type === "decl" && node.prop === property)) return;
    found.push({ layer: layerOf(rule), position });
  });
  return found;
}

let bridge: Root;
let compiled: Root;

// A full Tailwind compile of the bridge host stylesheet takes about a second
// alone and several seconds on a loaded CI runner, beyond the default hook limit.
beforeAll(async () => {
  bridge = await buildBridgeHostCss();
  compiled = parse(await readFile(join(packageRoot, "styles/compiled.css"), "utf8"));
}, 60_000);

describe("Tailwind v4 source bridge cascade", () => {
  test("keeps every zero-specificity default layered so call-site utilities win", () => {
    expect(utilityShadowingRules(bridge)).toEqual([]);
  });

  test("lets a root's own text utility beat the root's base colour in both builds", () => {
    // The composer's model pill with no usable model is a root of its own
    // (`og-root ... bg-og-primary text-og-primary-fg`). Its text must take the
    // utility's colour, not the root's default ink.
    const bridgeBase = rulesSetting(bridge, ".og-root", "color");
    const bridgeUtility = rulesSetting(bridge, ".text-og-primary-fg", "color");
    expect(bridgeBase.map((rule) => rule.layer)).toEqual(["base"]);
    expect(bridgeUtility.map((rule) => rule.layer)).toEqual(["utilities"]);

    // compiled.css has no layers: one class each, so source order decides.
    const [compiledBase] = rulesSetting(compiled, ".og-root", "color");
    const [compiledUtility] = rulesSetting(
      compiled,
      ":where(.og-root).text-og-primary-fg",
      "color",
    );
    expect(compiledBase).toBeDefined();
    expect(compiledUtility).toBeDefined();
    expect(compiledBase!.position).toBeLessThan(compiledUtility!.position);
    expect(rulesSetting(compiled, ":where(.og-root)", "color")).toEqual([]);
  });
});
