import { describe, expect, test } from "bun:test";

// The sharp, high-contrast palette (DESIGN.md "Colour"). Pins the agreed values and
// keeps every text step AA-readable on every surface it sits on, in both themes.
const tokens = await Bun.file(`${import.meta.dir}/../styles/tokens.css`).text();

function block(selector: string): Map<string, string> {
  const start = tokens.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = tokens.indexOf("\n}", start + 1);
  const values = new Map<string, string>();
  for (const match of tokens
    .slice(start, end)
    .matchAll(/--og-color-([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    values.set(match[1]!, match[2]!.toLowerCase());
  }
  return values;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string): number {
  const [hi, lo] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = { dark: block(":root"), light: block(".og-light") };

const spec = {
  dark: {
    fg: "#f5f5f5",
    "fg-muted": "#a6a6a6",
    "fg-subtle": "#8c8c8c",
    border: "#363636",
    primary: "#f2f2f2",
    "primary-fg": "#171717",
  },
  light: {
    fg: "#171717",
    "fg-muted": "#525252",
    "fg-subtle": "#6b6b6b",
    border: "#e4e4e4",
    "border-strong": "#c9c9c9",
    primary: "#171717",
    "primary-fg": "#ffffff",
  },
} as const;

const textTokens = ["fg", "fg-label", "fg-muted", "fg-subtle"];
const grounds = ["canvas", "bg", "surface-1", "surface-2"];

for (const [name, values] of Object.entries(themes)) {
  const read = (token: string) => {
    const value = values.get(token);
    expect([token, value === undefined]).toEqual([token, false]);
    return value!;
  };

  describe(`${name} design tokens`, () => {
    test("match the agreed palette", () => {
      for (const [token, value] of Object.entries(spec[name as keyof typeof spec])) {
        expect([token, read(token)]).toEqual([token, value]);
      }
    });

    test("every text step meets WCAG AA on every surface", () => {
      for (const text of textTokens) {
        for (const ground of grounds) {
          const ratio = contrast(read(text), read(ground));
          expect([text, ground, ratio >= 4.5]).toEqual([text, ground, true]);
        }
      }
      for (const text of ["fg", "fg-label", "fg-muted"]) {
        expect([text, contrast(read(text), read("selection")) >= 4.5]).toEqual([text, true]);
      }
    });

    test("the solid primary reads clearly", () => {
      expect(contrast(read("primary-fg"), read("primary"))).toBeGreaterThanOrEqual(7);
    });

    test("titles, body and subtle text are distinct steps", () => {
      const surface = read("surface-1");
      const title = contrast(read("fg"), surface);
      const body = contrast(read("fg-muted"), surface);
      const subtle = contrast(read("fg-subtle"), surface);
      expect(title).toBeGreaterThanOrEqual(15);
      expect(title / body).toBeGreaterThanOrEqual(1.9);
      expect(body / subtle).toBeGreaterThanOrEqual(1.15);
    });

    test("page, card and raised surfaces step apart", () => {
      const order = ["canvas", "bg", "surface-2", "surface-3"].map((token) =>
        luminance(read(token)),
      );
      if (name === "dark") {
        expect(luminance(read("canvas"))).toBeLessThan(luminance(read("bg")));
        expect(luminance(read("bg"))).toBeLessThan(luminance(read("surface-1")));
        expect(luminance(read("surface-1"))).toBeLessThan(luminance(read("surface-2")));
        expect(luminance(read("surface-2"))).toBeLessThan(luminance(read("surface-3")));
      } else {
        expect(order[1]!).toBeLessThan(order[0]!);
        expect(order[2]!).toBeLessThan(order[1]!);
        expect(order[3]!).toBeLessThan(order[2]!);
      }
    });
  });
}
