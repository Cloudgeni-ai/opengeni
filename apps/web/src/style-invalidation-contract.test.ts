import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * Chromium restyles the WHOLE page on every DOM change (each keystroke in the
 * composer, each streamed token) while any stylesheet rule uses `:has()`
 * anywhere but on the element being styled: `.a:has(.b) .c`, `:not(:has(…))`,
 * Tailwind's `group-has-*`. On a long chat that was tens of milliseconds per
 * keystroke. Style from a `data-*` attribute the component sets instead.
 * `.a:has(.b)` styling `.a` itself stays allowed.
 */
const CSS_ROOTS = [import.meta.dir, `${import.meta.dir}/../../../packages/react/styles`];
const SOURCE_ROOTS = [import.meta.dir, `${import.meta.dir}/../../../packages/react/src`];

function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return text.length;
}

function splitTopLevel(selectorList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selectorList.length; index++) {
    const char = selectorList[index];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(selectorList.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selectorList.slice(start));
  return parts;
}

/** True when a `:has()` in this selector list is not on the styled element. */
function hasOutsideSubject(selectorList: string): boolean {
  for (const selector of splitTopLevel(selectorList)) {
    let from = 0;
    for (;;) {
      const at = selector.indexOf(":has(", from);
      if (at < 0) break;
      const before = selector.slice(0, at);
      const openBefore = (before.match(/[([]/g) ?? []).length;
      const closedBefore = (before.match(/[)\]]/g) ?? []).length;
      if (openBefore > closedBefore) return true;
      const end = closingParen(selector, at + 4);
      if (/[\s>+~]\s*\S/.test(selector.slice(end + 1).trimEnd())) return true;
      from = end + 1;
    }
  }
  return false;
}

function selectorPreludes(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const preludes: string[] = [];
  for (const match of source.matchAll(/(?:^|[{};])\s*([^{};]+)\{/g)) {
    const prelude = match[1]!.trim();
    if (prelude && !prelude.startsWith("@")) preludes.push(prelude);
  }
  return preludes;
}

describe("style invalidation", () => {
  test("stylesheets only use :has() on the element they style", async () => {
    const offenders: string[] = [];
    for (const root of CSS_ROOTS) {
      for await (const path of new Glob("**/*.css").scan({ cwd: root })) {
        const css = await Bun.file(`${root}/${path}`).text();
        for (const prelude of selectorPreludes(css)) {
          if (prelude.includes(":has(") && hasOutsideSubject(prelude)) {
            offenders.push(`${path}: ${prelude.replace(/\s+/g, " ").slice(0, 160)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("class names use no group-has, peer-has or ancestor :has() variants", async () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
        if (path.includes(".test.")) continue;
        const source = await Bun.file(`${root}/${path}`).text();
        for (const [index, line] of source.split("\n").entries()) {
          if (/^\s*(\*|\/\/)/.test(line)) continue;
          if (/\b(group|peer)-has-|\[[^\]\s]*:has\([^\]\s]*\)_[^\]\s]*\]:/.test(line)) {
            offenders.push(`${path}:${index + 1}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the selector check tells the styled element from its surroundings", () => {
    expect(hasOutsideSubject(".a:has(.b)")).toBe(false);
    expect(hasOutsideSubject(".a:has(> svg):hover")).toBe(false);
    expect(hasOutsideSubject(".a:has(:is(input:focus-visible))")).toBe(false);
    expect(hasOutsideSubject(".x .a:has(.b), .c")).toBe(false);
    expect(hasOutsideSubject(".a:has(.b) .c")).toBe(true);
    expect(hasOutsideSubject(".a:has(.b) > .c")).toBe(true);
    expect(hasOutsideSubject(`html[data-x]:has(nav[data-y="true"]) [data-z]`)).toBe(true);
    expect(hasOutsideSubject(".a > :not(:has(.b))")).toBe(true);
    expect(hasOutsideSubject(".g:is(:where(.group):has([data-size=lg]) *)")).toBe(true);
    expect(hasOutsideSubject(".c, .a:has(.b) .d")).toBe(true);
  });
});
