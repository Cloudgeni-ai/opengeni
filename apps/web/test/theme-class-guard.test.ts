import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/*
 * Tailwind silently drops a utility it does not know. A size or colour class
 * that no theme defines (`text-control`, `text-og-muted`, `bg-warning/10`)
 * therefore renders with the parent's size or colour, or none at all. Flag
 * every size- or colour-shaped class in the app and SDK sources that the
 * stylesheets they ship with do not define.
 *
 * It lives in apps/web because apps/web depends on @opengeni/react, so PR CI
 * selects it for changes in either package.
 */

const repo = join(import.meta.dir, "../../..");

/** Names that only make sense as a font size, with or without the `og-` prefix. */
const SIZE_SHAPED =
  /^text-(?:og-)?(?:\d*x[sl]|sm|base|md|lg|control|menu|composer(?:-[\w]+)?|caption|label|body|title|heading|display|tiny|small|medium|large)$/;
/** Utilities whose value is a theme colour. */
const COLOUR_UTILITY =
  /^(text|bg|border(?:-[xytrblse])?|ring-offset|ring|outline|fill|stroke|divide|decoration|caret|accent|from|via|to)-(.+)$/;
/** A value that reads as a colour token rather than a width, style or keyword. */
const COLOUR_WORD =
  /(?:^|-)(?:og|fg|bg|muted|subtle|surface|status|success|warning|error|danger|info|accent|primary|secondary|brand|destructive|foreground|background|canvas|hover|selection|ring|card|popover|sidebar|chart|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)(?:-|$)/;
/**
 * A whole class token, optionally behind variants (`sm:`, `group-hover/row:`,
 * `data-[size=sm]:`) and with an optional modifier or important suffix
 * (`text-sm/6`, `bg-warning/10`, `text-sm!`).
 */
const CLASS_TOKEN =
  /(?<=^|[\s"'`{}])(?:[\w[\]&>:@*.=/%()-]+:)?!?((?:text|bg|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|divide|decoration|caret|accent|from|via|to)-[a-z0-9][\w-]*)(?:\/[\w.[\]-]+)?!?(?=$|[\s"'`{}])/g;
const BUILT_IN_COLOURS = new Set(["inherit", "current", "transparent", "black", "white"]);

type Theme = { sizes: Set<string>; colours: Set<string> };

async function themeFrom(stylesheets: string[]): Promise<Theme> {
  const theme: Theme = { sizes: new Set(), colours: new Set(BUILT_IN_COLOURS) };
  for (const stylesheet of stylesheets) {
    const css = await readFile(stylesheet, "utf8");
    for (const match of css.matchAll(/--text-([\w-]+?)\s*:/g)) {
      if (!match[1]!.includes("--")) theme.sizes.add(`text-${match[1]}`);
    }
    for (const match of css.matchAll(/@utility\s+(text-[\w-]+)/g)) theme.sizes.add(match[1]!);
    for (const match of css.matchAll(/--color-([\w-]+?)\s*:/g)) theme.colours.add(match[1]!);
  }
  return theme;
}

function unknownThemeClasses(source: string, theme: Theme): string[] {
  const unknown = new Set<string>();
  for (const match of source.matchAll(CLASS_TOKEN)) {
    const utility = match[1]!;
    if (theme.sizes.has(utility)) continue;
    if (SIZE_SHAPED.test(utility)) {
      unknown.add(utility);
      continue;
    }
    const value = COLOUR_UTILITY.exec(utility)?.[2];
    if (value && COLOUR_WORD.test(value) && !theme.colours.has(value)) unknown.add(utility);
  }
  return [...unknown];
}

const reactRoot = join(repo, "packages/react");
const tailwindTheme = createRequire(join(reactRoot, "package.json")).resolve(
  "tailwindcss/theme.css",
);
const reactStylesheets = async () => [
  tailwindTheme,
  ...(await Array.fromAsync(new Glob("packages/react/styles/*.css").scan(repo))).map((file) =>
    join(repo, file),
  ),
];

async function offenders(globs: string[], theme: Theme): Promise<string[]> {
  const found: string[] = [];
  for (const pattern of globs) {
    for await (const file of new Glob(pattern).scan(repo)) {
      if (file.includes("visualization-assets")) continue;
      for (const utility of unknownThemeClasses(await readFile(join(repo, file), "utf8"), theme)) {
        found.push(`${file}: ${utility}`);
      }
    }
  }
  return found.sort();
}

describe("theme class guard", () => {
  test("flags size and colour classes no theme defines, and nothing else", async () => {
    const theme = await themeFrom(await reactStylesheets());
    expect(theme.sizes.has("text-og-control")).toBe(true);
    expect(theme.colours.has("og-fg-muted")).toBe(true);
    expect(theme.colours.has("status-waiting")).toBe(true);
    expect(
      unknownThemeClasses(
        'className="px-2 text-control sm:text-og-lg text-og-control text-og-fg-muted text-[11px]"',
        theme,
      ),
    ).toEqual(["text-control", "text-og-lg"]);
    expect(
      unknownThemeClasses(
        "border border-warning/40 bg-warning/10 hover:text-og-muted data-[on=true]:bg-og-surface text-status-error! ring-og-ring/40 text-red bg-amber-450 text-red-500 bg-emerald-600/20",
        theme,
      ),
    ).toEqual([
      "border-warning",
      "bg-warning",
      "text-og-muted",
      "bg-og-surface",
      "text-status-error",
      "ring-og-ring",
      "text-red",
      "bg-amber-450",
    ]);
    expect(
      unknownThemeClasses(
        "text-og-status-waiting bg-og-status-waiting/[0.07] border-2 border-box text-left text-only bg-cover ring-2 outline-hidden to-do accent-insensitive text-current bg-transparent ring-offset-og-bg ring-offset-background",
        theme,
      ),
    ).toEqual([]);
  });

  test("packages/react source and demos use only defined size and colour classes", async () => {
    const theme = await themeFrom(await reactStylesheets());
    expect(
      await offenders(
        ["packages/react/src/**/*.{ts,tsx}", "packages/react/demo/**/*.{ts,tsx}"],
        theme,
      ),
    ).toEqual([]);
  });

  test("apps/web source uses only defined size and colour classes", async () => {
    const theme = await themeFrom([
      ...(await reactStylesheets()),
      join(repo, "apps/web/src/styles.css"),
    ]);
    expect(await offenders(["apps/web/src/**/*.{ts,tsx}"], theme)).toEqual([]);
  });
});
