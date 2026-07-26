/* ----------------------------------------------------------------------------
   Terminal renderer unit probes of the pure cores behind the browser surface
   (no DOM / no WebGL context needed):
     E1  renderer fallback ladder (WebGL → …→ DOM), incl. context-loss downgrade
     E2  font resolution to a CONCRETE family (never `var(`)
     E3  full 16-color ANSI theme for BOTH modes (no default xterm palette)
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import {
  attachRenderer,
  nextRendererTier,
  type RendererLoaders,
  type RendererTier,
} from "../src/lib/xterm-renderer";
import {
  buildXtermTheme,
  ogAnsiPalette,
  resolveTerminalFontFromReader,
  type TokenReader,
} from "../src/lib/xterm-theme";
import type { XtermTheme } from "../src/components/sandbox-terminal";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

// ── E1: renderer fallback ladder ─────────────────────────────────────────────
describe("E1 renderer ladder (attachRenderer)", () => {
  test("nextRendererTier steps webgl → canvas → dom → null", () => {
    expect(nextRendererTier("webgl")).toBe("canvas");
    expect(nextRendererTier("canvas")).toBe("dom");
    expect(nextRendererTier("dom")).toBeNull();
  });

  test("WebGL that inits is chosen", async () => {
    const tiers: RendererTier[] = [];
    const loaders: RendererLoaders = { webgl: async () => ({ dispose() {} }) };
    const tier = await attachRenderer("webgl", loaders, (t) => tiers.push(t));
    expect(tier).toBe("webgl");
    expect(tiers).toEqual(["webgl"]);
  });

  test("WebGL init failure with no canvas loader falls to DOM (the shipped path)", async () => {
    const tiers: RendererTier[] = [];
    const loaders: RendererLoaders = {
      webgl: async () => {
        throw new Error("no GPU / blocklisted");
      },
    };
    const tier = await attachRenderer("webgl", loaders, (t) => tiers.push(t));
    expect(tier).toBe("dom");
    expect(tiers).toEqual(["dom"]);
  });

  test("WebGL init failure falls to a canvas tier when one is provided", async () => {
    const loaders: RendererLoaders = {
      webgl: async () => {
        throw new Error("forced");
      },
      canvas: async () => ({ dispose() {} }),
    };
    expect(await attachRenderer("webgl", loaders, () => {})).toBe("canvas");
  });

  test("WebGL context LOSS at runtime downgrades one tier (re-reports via onTier)", async () => {
    const tiers: RendererTier[] = [];
    let lose: (() => void) | undefined;
    let disposed = false;
    const loaders: RendererLoaders = {
      webgl: async (onLoss) => {
        lose = onLoss;
        return {
          dispose() {
            disposed = true;
          },
        };
      },
    };
    const tier = await attachRenderer("webgl", loaders, (t) => tiers.push(t));
    expect(tier).toBe("webgl");
    // Simulate the addon firing its context-loss callback.
    lose?.();
    await tick();
    // No canvas loader → the downgrade lands on DOM.
    expect(tiers).toEqual(["webgl", "dom"]);
    // (the component disposes the addon in its onContextLoss wrapper, mirrored here)
    void disposed;
  });
});

// ── E2: font resolution ──────────────────────────────────────────────────────
describe("E2 font resolution (no var())", () => {
  const reader =
    (map: Record<string, string>): TokenReader =>
    (name) =>
      map[name];

  test("resolves the concrete --og-font-mono family + px size", () => {
    const font = resolveTerminalFontFromReader(
      reader({
        "--og-font-mono": "'JetBrains Mono', ui-monospace, monospace",
        "--og-code-font-size": "12px",
      }),
    );
    expect(font.fontFamily).toBe("'JetBrains Mono', ui-monospace, monospace");
    expect(font.fontFamily).not.toContain("var(");
    expect(font.fontSize).toBe(12);
  });

  test("an unresolved var() family is replaced with a concrete fallback", () => {
    const font = resolveTerminalFontFromReader(reader({ "--og-font-mono": "var(--og-font-mono)" }));
    expect(font.fontFamily).not.toContain("var(");
    expect(font.fontFamily.toLowerCase()).toContain("monospace");
  });

  test("explicit overrides win over tokens; size defaults to 13 when absent", () => {
    const font = resolveTerminalFontFromReader(reader({}), { fontFamily: "Menlo", fontSize: 15 });
    expect(font.fontFamily).toBe("Menlo");
    expect(font.fontSize).toBe(15);
    expect(resolveTerminalFontFromReader(reader({}))).toMatchObject({ fontSize: 13 });
    expect(resolveTerminalFontFromReader(reader({}))?.fontFamily).not.toContain("var(");
  });
});

// ── E3: full ANSI theme both modes ───────────────────────────────────────────
describe("E3 full ANSI theme (both modes, no default palette)", () => {
  const tokenReader: TokenReader = (name) =>
    ({
      "--og-color-bg": "oklch(0.155 0.012 260)",
      "--og-color-fg": "oklch(0.955 0.005 260)",
      "--og-color-accent": "oklch(0.72 0.15 255)",
    })[name];

  for (const mode of ["dark", "light"] as const) {
    test(`${mode}: all 16 ANSI + cursor/selection are set to concrete colors`, () => {
      const theme = buildXtermTheme(tokenReader, mode) as Record<string, string>;
      for (const key of ANSI_KEYS) {
        expect(theme[key], `${mode}.${key}`).toBeTruthy();
        expect(theme[key]).not.toContain("var(");
      }
      for (const key of [
        "background",
        "foreground",
        "cursor",
        "cursorAccent",
        "selectionBackground",
        "selectionForeground",
        "selectionInactiveBackground",
      ]) {
        expect(theme[key], `${mode}.${key}`).toBeTruthy();
      }
    });
  }

  test("token bg/fg/accent flow into the theme (embedder rebrand)", () => {
    const theme = buildXtermTheme(tokenReader, "dark");
    expect(theme.background).toBe("oklch(0.155 0.012 260)");
    expect(theme.foreground).toBe("oklch(0.955 0.005 260)");
    expect(theme.cursor).toBe("oklch(0.72 0.15 255)");
    expect(theme.cursorAccent).toBe(theme.background);
  });

  test("dark and light palettes are genuinely different inks", () => {
    const dark = ogAnsiPalette("dark");
    const light = ogAnsiPalette("light");
    expect(light.red).not.toBe(dark.red);
    expect(light.blue).not.toBe(dark.blue);
    expect(light.selectionForeground).not.toBe(dark.selectionForeground);
  });

  test("empty tokens still yield a complete, concrete theme (no undefined slots)", () => {
    const empty: TokenReader = () => undefined;
    const theme = buildXtermTheme(empty, "light") as Record<string, string | undefined>;
    for (const key of [...ANSI_KEYS, "background", "foreground", "cursor"]) {
      expect(theme[key], key).toBeTruthy();
      expect(theme[key]).not.toContain("var(");
    }
  });

  test("XtermTheme type accepts the full built theme", () => {
    const theme: XtermTheme = buildXtermTheme(tokenReader, "dark");
    expect(Object.keys(theme).length).toBeGreaterThanOrEqual(23);
  });
});
