import { describe, expect, test } from "bun:test";

// Selected text must stand out in both themes. A highlight mixed from the
// neutral grey accent read as one more surface step in dark mode; the
// dedicated `--og-color-text-selection` token carries hue, keeps the
// selected text readable and drives every selection surface.

const styles = `${import.meta.dir}/../styles`;
const tokens = await Bun.file(`${styles}/tokens.css`).text();
const app = await Bun.file(`${styles}/app.css`).text();
const index = await Bun.file(`${styles}/index.css`).text();

type Rgb = [number, number, number];

function block(start: string): Record<string, string> {
  const from = tokens.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const text = tokens.slice(from, tokens.indexOf("}", from));
  return Object.fromEntries(
    [...text.matchAll(/(--og-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
  );
}

function hex(value: string | undefined): { rgb: Rgb; alpha: number } {
  const match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(value ?? "");
  if (!match) throw new Error(`expected a hex color, got ${value}`);
  const digits = match[1]!;
  const rgb = [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as Rgb;
  return { rgb, alpha: match[2] ? Number.parseInt(match[2], 16) / 255 : 1 };
}

function over(top: { rgb: Rgb; alpha: number }, under: Rgb): Rgb {
  return top.rgb.map((channel, i) => channel * top.alpha + under[i]! * (1 - top.alpha)) as Rgb;
}

function contrast(first: Rgb, second: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  dark: block(":root {"),
  light: block('[data-og-theme="light"],\n.og-light {'),
};

describe("text selection", () => {
  for (const [name, theme] of Object.entries(themes)) {
    test(`${name}: the highlight is visible on every surface and keeps text readable`, () => {
      const selection = hex(theme["--og-color-text-selection"]);
      const fg = hex(theme["--og-color-fg"]).rgb;
      for (const surface of [
        "--og-color-bg",
        "--og-color-canvas",
        "--og-color-surface-1",
        "--og-color-surface-2",
        "--og-color-surface-3",
        "--og-color-selection",
      ]) {
        const ground = hex(theme[surface]).rgb;
        const highlight = over(selection, ground);
        // Hue, not one more grey step: the neutral surfaces have none.
        const chroma = Math.max(...highlight) - Math.min(...highlight);
        expect([surface, chroma >= 40]).toEqual([surface, true]);
        expect([surface, contrast(highlight, ground) >= 1.3]).toEqual([surface, true]);
        expect([surface, contrast(fg, highlight) >= 4.5]).toEqual([surface, true]);
      }
    });
  }

  test("page, field and editor selections all use the token", () => {
    const pageRule = /::selection\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(pageRule).toContain("background: var(--og-color-text-selection)");
    // The editor's focused and unfocused selection layers.
    for (const selector of [
      ".og-cm-editor .cm-editor .cm-selectionLayer .cm-selectionBackground",
      ".og-cm-editor .cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground",
    ]) {
      const rule = [...index.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((match) =>
        match[1]!.split(",").some((part) => part.trim() === selector),
      );
      expect([selector, rule?.[2]?.trim()]).toEqual([
        selector,
        "background-color: var(--og-color-text-selection);",
      ]);
    }
  });
});
