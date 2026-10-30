import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/*
 * Tailwind silently drops a utility it does not know. A size class that is
 * not on the type ramp (`text-control` instead of `text-og-control`) therefore
 * renders at whatever size the parent has, which is how the header's Waiting
 * pill ended up larger than every other status pill. Flag any size-shaped
 * `text-*` class in the package source that no theme defines.
 */

const packageRoot = join(import.meta.dir, "..");
const require = createRequire(import.meta.url);

/** Names that only make sense as a font size, with or without the `og-` prefix. */
const SIZE_SHAPED =
  /^text-(?:og-)?(?:\d*x[sl]|sm|base|md|lg|control|menu|composer(?:-[\w]+)?|caption|label|body|title|heading|display|tiny|small|medium|large)$/;
/** A whole class token, optionally behind variants such as `sm:` or `hover:`. */
const CLASS_TOKEN = /(?<=^|[\s"'`{}])(?:[\w[\]&>:@*.-]+:)?!?(text-[a-z0-9][\w-]*)(?=$|[\s"'`{}])/g;

async function definedTextSizes(): Promise<Set<string>> {
  const stylesheets = [
    require.resolve("tailwindcss/theme.css"),
    ...(await Array.fromAsync(new Glob("styles/*.css").scan(packageRoot))).map((file) =>
      join(packageRoot, file),
    ),
  ];
  const sizes = new Set<string>();
  for (const stylesheet of stylesheets) {
    const css = await readFile(stylesheet, "utf8");
    for (const match of css.matchAll(/--text-([\w-]+?)\s*:/g)) {
      if (!match[1]!.includes("--")) sizes.add(`text-${match[1]}`);
    }
    for (const match of css.matchAll(/@utility\s+(text-[\w-]+)/g)) sizes.add(match[1]!);
  }
  return sizes;
}

function unknownTextSizeClasses(source: string, defined: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  for (const match of source.matchAll(CLASS_TOKEN)) {
    const utility = match[1]!;
    if (SIZE_SHAPED.test(utility) && !defined.has(utility)) unknown.add(utility);
  }
  return [...unknown];
}

describe("text size utilities", () => {
  test("the detector catches size classes no theme defines", async () => {
    const defined = await definedTextSizes();
    expect(defined.has("text-og-control")).toBe(true);
    expect(defined.has("text-sm")).toBe(true);
    expect(defined.has("text-2xs")).toBe(true);
    expect(
      unknownTextSizeClasses(
        'className="px-2 text-control font-medium sm:text-og-lg text-og-control text-og-fg-muted text-[11px]"',
        defined,
      ),
    ).toEqual(["text-control", "text-og-lg"]);
  });

  test("every text size class in packages/react/src is defined by a theme", async () => {
    const defined = await definedTextSizes();
    const offenders: string[] = [];
    for await (const file of new Glob("src/**/*.{ts,tsx}").scan(packageRoot)) {
      if (file.includes("visualization-assets")) continue;
      const source = await readFile(join(packageRoot, file), "utf8");
      for (const utility of unknownTextSizeClasses(source, defined)) {
        offenders.push(`${file}: ${utility}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
