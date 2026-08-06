#!/usr/bin/env bun
import tailwindcss from "@tailwindcss/postcss";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import postcss, { parse, type AcceptedPlugin, type Declaration, type Rule } from "postcss";
import selectorParser, { type Selector } from "postcss-selector-parser";

const packageRoot = resolve(import.meta.dir, "..");
const stylesRoot = join(packageRoot, "styles");
const inputPath = join(stylesRoot, "compiled.input.css");
const outputPath = join(stylesRoot, "compiled.css");
const tokensPath = join(stylesRoot, "tokens.css");
const effectiveTokensPath = join(stylesRoot, "effective-tokens.css");
const checkOnly = process.argv.includes("--check");

const input = `@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities) source(none);
@import "./index.css";
@import "./responsive.css";
@source "../src";
`;

const scope = selectorParser().astSync(":where(.og-root)").nodes[0]!.nodes[0]!;
const tokenContextAttributes = new Set(["data-og-density", "data-og-theme"]);
const tokenContextClasses = new Set(["og-density-compact", "og-light"]);

type ParentNode = {
  name?: string;
  parent?: ParentNode;
  selector?: string;
  type: string;
};

function parentsOf(rule: Rule): ParentNode[] {
  const parents: ParentNode[] = [];
  let parent = rule.parent as ParentNode | undefined;
  while (parent) {
    parents.push(parent);
    parent = parent.parent;
  }
  return parents;
}

function isInsideKeyframes(rule: Rule): boolean {
  return parentsOf(rule).some(
    (parent) => parent.type === "atrule" && parent.name?.endsWith("keyframes") === true,
  );
}

function parentRule(rule: Rule): Rule | null {
  return (parentsOf(rule).find((parent) => parent.type === "rule") as Rule | undefined) ?? null;
}

function hasScopedRuleAncestor(rule: Rule): boolean {
  for (const parent of parentsOf(rule)) {
    if (parent.type === "rule") {
      const selectors = selectorParser().astSync(parent.selector ?? "");
      if (selectors.nodes.every((selector) => containsRoot(selector))) return true;
    }
  }
  return false;
}

function containsRoot(selector: Selector): boolean {
  let found = false;
  selector.walkClasses((className) => {
    if (className.value === "og-root") found = true;
  });
  return found;
}

function rootClassCount(selector: Selector): number {
  let count = 0;
  selector.walkClasses((className) => {
    if (className.value === "og-root") count += 1;
  });
  return count;
}

function lowerRootSpecificity(selector: Selector): Selector {
  const lowered = selector.clone();
  lowered.walkClasses((className) => {
    if (className.value !== "og-root") return;
    if (className.parent?.type === "pseudo" && className.parent.value === ":where") return;
    className.replaceWith(scope.clone());
  });
  return lowered;
}

function isDocumentRoot(selector: Selector): boolean {
  const meaningful = selector.nodes.filter((node) => node.type !== "comment");
  return (
    meaningful.length === 1 &&
    meaningful[0]?.type === "pseudo" &&
    (meaningful[0].value === ":root" || meaningful[0].value === ":host")
  );
}

function isTokenContext(selector: Selector): boolean {
  let found = false;
  selector.walkAttributes((attribute) => {
    if (tokenContextAttributes.has(attribute.attribute)) found = true;
  });
  selector.walkClasses((className) => {
    if (tokenContextClasses.has(className.value)) found = true;
  });
  return found;
}

function wrapWhere(selector: Selector) {
  return selectorParser.pseudo({
    value: ":where",
    nodes: [
      selectorParser.selector({
        value: "",
        nodes: selector.nodes.map((node) => node.clone()),
      }),
    ],
  });
}

function rootAndDescendant(selector: Selector): Selector[] {
  const descendant = selectorParser.selector({ value: "" });
  descendant.append(scope.clone());
  descendant.append(selectorParser.combinator({ value: " " }));
  for (const node of selector.nodes) descendant.append(node.clone());

  const direct = selector.clone();
  const firstCombinator = direct.nodes.findIndex((node) => node.type === "combinator");
  const firstCompoundEnd = firstCombinator === -1 ? direct.nodes.length : firstCombinator;
  let insertionIndex = 0;
  while (
    insertionIndex < firstCompoundEnd &&
    (direct.nodes[insertionIndex]?.type === "tag" ||
      direct.nodes[insertionIndex]?.type === "universal")
  ) {
    insertionIndex += 1;
  }
  const insertionPoint = direct.nodes[insertionIndex];
  if (insertionPoint) direct.insertBefore(insertionPoint, scope.clone());
  else direct.append(scope.clone());
  return [direct, descendant];
}

function hasRoot() {
  return selectorParser.pseudo({
    value: ":has",
    nodes: [selectorParser.selector({ value: "", nodes: [scope.clone()] })],
  });
}

function tokenContextTargets(selector: Selector): Selector[] {
  const condition = wrapWhere(selector);
  const direct = selectorParser.selector({
    value: "",
    nodes: [condition.clone(), scope.clone()],
  });
  const ancestor = selectorParser.selector({
    value: "",
    nodes: [condition.clone(), hasRoot()],
  });
  const nested = selectorParser.selector({
    value: "",
    nodes: [scope.clone(), selectorParser.combinator({ value: " " }), condition.clone()],
  });
  return [direct, ancestor, nested];
}

function isTopLevelDocumentRoot(rule: Rule): boolean {
  if (rule.parent?.type !== "root") return false;
  const selectors = selectorParser().astSync(rule.selector);
  return (
    selectors.nodes.length > 0 && selectors.nodes.every((selector) => isDocumentRoot(selector))
  );
}

function collectTokenDefaults(root: ReturnType<typeof parse>): Map<string, string> {
  const defaults = new Map<string, string>();
  root.walkRules((rule) => {
    if (!isTopLevelDocumentRoot(rule)) return;
    rule.walkDecls(/^--og-/u, (declaration) => {
      defaults.set(declaration.prop, declaration.value);
      declaration.remove();
    });
  });
  if (defaults.size === 0) throw new Error("Compiled CSS did not expose top-level --og-* defaults");
  return defaults;
}

function isDerivedToken(value: string): boolean {
  return /var\(\s*--og-[\w-]+\s*\)/u.test(value);
}

function effectiveToken(token: string): string {
  return token.replace(/^--og-/u, "--_og-");
}

function effectiveDerivedDefault(value: string, defaults: ReadonlyMap<string, string>): string {
  return value.replace(/var\(\s*(--og-[\w-]+)\s*\)/gu, (_match, dependency: string) => {
    const dependencyDefault = defaults.get(dependency);
    return dependencyDefault && isDerivedToken(dependencyDefault)
      ? `var(${effectiveToken(dependency)})`
      : `var(${dependency})`;
  });
}

function tokenRegistrations(defaults: ReadonlyMap<string, string>): string {
  return [...defaults]
    .filter(([, value]) => !isDerivedToken(value))
    .map(
      ([token, value]) =>
        `@property ${token} {\n  syntax: "*";\n  inherits: true;\n  initial-value: ${value};\n}`,
    )
    .join("\n");
}

export async function buildEffectiveTokensCss(): Promise<string> {
  const tokens = parse(await readFile(tokensPath, "utf8"));
  const defaults = collectTokenDefaults(tokens);
  const declarations = [...defaults]
    .filter(([, value]) => isDerivedToken(value))
    .map(
      ([token, value]) =>
        `  ${effectiveToken(token)}: var(${token}, ${effectiveDerivedDefault(value, defaults)});`,
    )
    .join("\n");
  return `/* Generated by scripts/build-compiled-css.ts; do not edit directly. */\n.og-root,\n[data-og-density="compact"],\n.og-density-compact,\n[data-og-theme="light"],\n.og-light {\n${declarations}\n}\n`;
}

function rewriteDerivedTokenConsumers(
  root: ReturnType<typeof parse>,
  defaults: ReadonlyMap<string, string>,
): void {
  const derived = new Set(
    [...defaults].filter(([, value]) => isDerivedToken(value)).map(([token]) => token),
  );
  root.walkDecls((declaration) => {
    declaration.value = declaration.value.replace(
      /var\(\s*(--og-[\w-]+)\s*\)/gu,
      (match, token: string) => (derived.has(token) ? `var(${effectiveToken(token)})` : match),
    );
  });
}

function preserveColorSchemeInheritance(root: ReturnType<typeof parse>): void {
  root.walkRules((rule) => {
    const selectors = selectorParser().astSync(rule.selector);
    const documentDefault = isTopLevelDocumentRoot(rule);
    const context = selectors.nodes.some((selector) => isTokenContext(selector));
    if (!documentDefault && !context) return;
    rule.walkDecls("color-scheme", (declaration) => {
      if (documentDefault) {
        declaration.value = `var(--_og-color-scheme, ${declaration.value})`;
      }
      if (context) rule.append(declaration.clone({ prop: "--_og-color-scheme" }));
    });
  });
}

function extractTailwindInitializers(root: ReturnType<typeof parse>): Declaration[] {
  let initializers: Declaration[] | null = null;
  root.walkRules((rule) => {
    const declarations = rule.nodes.filter(
      (node): node is Declaration => node.type === "decl" && node.prop.startsWith("--tw-"),
    );
    if (
      declarations.length < 20 ||
      !declarations.some((node) => node.prop === "--tw-border-style")
    ) {
      return;
    }
    if (initializers) throw new Error("Compiled CSS exposed multiple Tailwind initializer rules");
    initializers = declarations.map((declaration) => declaration.clone());
    rule.remove();
  });
  if (!initializers) throw new Error("Compiled CSS did not expose Tailwind utility initializers");
  return initializers;
}

function tailwindInitializerRule(declarations: readonly Declaration[]): string {
  const selectors = [
    ":where(.og-root)",
    ":where(.og-root) *",
    ":where(.og-root)::before",
    ":where(.og-root)::after",
    ":where(.og-root) *::before",
    ":where(.og-root) *::after",
    ":where(.og-root)::backdrop",
    ":where(.og-root) *::backdrop",
  ].join(",");
  const body = declarations.map((declaration) => `  ${declaration.toString()};`).join("\n");
  return `${selectors} {\n${body}\n}`;
}

function removeEmptyContainers(root: ReturnType<typeof parse>): void {
  let removed = true;
  while (removed) {
    removed = false;
    root.walkAtRules((atRule) => {
      if (atRule.nodes?.length !== 0) return;
      atRule.remove();
      removed = true;
    });
  }
}

export function scopeSelectors(css: string): string {
  const root = parse(css);
  const tokenDefaults = collectTokenDefaults(root);
  const tailwindInitializers = extractTailwindInitializers(root);
  rewriteDerivedTokenConsumers(root, tokenDefaults);
  preserveColorSchemeInheritance(root);
  root.walkAtRules("property", (atRule) => {
    if (atRule.params.startsWith("--tw-")) atRule.remove();
  });
  root.walkAtRules("keyframes", (atRule) => {
    if (atRule.params === "spin" || atRule.params === "pulse") atRule.remove();
  });
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule) || parentRule(rule)) return;
    const parsed = selectorParser().astSync(rule.selector);
    const preservesTypographyGuard = parsed.nodes.some((selector) => rootClassCount(selector) > 1);
    const scoped = parsed.nodes.flatMap((selector) => {
      if (containsRoot(selector)) {
        return [preservesTypographyGuard ? selector.clone() : lowerRootSpecificity(selector)];
      }
      if (isDocumentRoot(selector)) {
        return [selectorParser.selector({ value: "", nodes: [scope.clone()] })];
      }
      if (isTokenContext(selector)) return tokenContextTargets(selector);
      return rootAndDescendant(selector);
    });
    const unique = new Map(scoped.map((selector) => [selector.toString(), selector]));
    parsed.removeAll();
    for (const selector of unique.values()) parsed.append(selector);
    rule.selector = parsed.toString();
  });
  root.walkAtRules("layer", (atRule) => {
    if (atRule.nodes) atRule.replaceWith(...atRule.nodes);
    else atRule.remove();
  });
  removeEmptyContainers(root);
  root.prepend(
    ...parse(
      `${tokenRegistrations(tokenDefaults)}\n${tailwindInitializerRule(tailwindInitializers)}`,
    ).nodes,
  );
  return root.toString();
}

export function assertScoped(css: string): void {
  const root = parse(css);
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule)) return;
    if (parentRule(rule)) {
      if (hasScopedRuleAncestor(rule)) return;
      throw new Error(`Nested compiled CSS rule has an unscoped ancestor: ${rule.selector}`);
    }
    const parsed = selectorParser().astSync(rule.selector);
    for (const selector of parsed.nodes) {
      if (!containsRoot(selector)) {
        throw new Error(`Compiled CSS selector escaped .og-root: ${selector.toString()}`);
      }
    }
  });
}

export async function buildCompiledCss(): Promise<string> {
  const effectiveTokens = await buildEffectiveTokensCss();
  if ((await readFile(effectiveTokensPath, "utf8").catch(() => null)) !== effectiveTokens) {
    throw new Error(
      "styles/effective-tokens.css is stale; run `bun run build:css` in packages/react",
    );
  }
  const plugin: AcceptedPlugin = tailwindcss({ optimize: false });
  const result = await postcss([plugin]).process(input, {
    from: inputPath,
    to: outputPath,
  });
  const compiled = scopeSelectors(result.css);
  assertScoped(compiled);
  return `${compiled.trim()}\n`;
}

if (import.meta.main) {
  const effectiveTokens = await buildEffectiveTokensCss();
  const currentEffectiveTokens = await readFile(effectiveTokensPath, "utf8").catch(() => null);
  if (checkOnly && currentEffectiveTokens !== effectiveTokens) {
    throw new Error(
      "styles/effective-tokens.css is stale; run `bun run build:css` in packages/react",
    );
  }
  if (!checkOnly && currentEffectiveTokens !== effectiveTokens) {
    await writeFile(effectiveTokensPath, effectiveTokens, "utf8");
  }
  const compiled = await buildCompiledCss();
  const current = await readFile(outputPath, "utf8").catch(() => null);
  if (checkOnly) {
    if (current !== compiled) {
      throw new Error("styles/compiled.css is stale; run `bun run build:css` in packages/react");
    }
    process.stdout.write("Compiled CSS is current and fully scoped.\n");
  } else if (current !== compiled) {
    await writeFile(outputPath, compiled, "utf8");
    process.stdout.write(`Wrote ${outputPath}.\n`);
  } else {
    process.stdout.write("Compiled CSS is already current.\n");
  }
}
