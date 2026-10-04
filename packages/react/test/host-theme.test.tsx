import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STOCK_COLOR_TOKENS,
  hostSurfaceStyle,
  hostTokenOverrides,
  parseComputedColor,
  resolveHostTheme,
  resolveHostThemeState,
  themeForBackground,
} from "../src/lib/host-theme";
import { registerDom } from "./render-hook";

registerDom();

function mount(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.querySelector<HTMLElement>("[data-embed]")!;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-theme");
});

describe("resolveHostTheme follows the host, not the OS", () => {
  test("an enclosing data-og-theme wins", () => {
    document.documentElement.classList.add("dark");
    expect(resolveHostTheme(mount(`<div data-og-theme="light"><div data-embed></div></div>`))).toBe(
      "light",
    );
    expect(resolveHostTheme(mount(`<div class="og-light"><div data-embed></div></div>`))).toBe(
      "light",
    );
  });

  test("class or data-theme on html/body", () => {
    document.documentElement.classList.add("dark");
    expect(resolveHostTheme(mount(`<div data-embed></div>`))).toBe("dark");
    document.documentElement.className = "";
    document.body.setAttribute("data-theme", "dark");
    expect(resolveHostTheme(mount(`<div data-embed></div>`))).toBe("dark");
    document.body.setAttribute("data-theme", "light");
    expect(resolveHostTheme(mount(`<div data-embed></div>`))).toBe("light");
  });

  test("the background the chat sits on decides when nothing is declared", () => {
    expect(
      resolveHostTheme(
        mount(`<div style="background-color: rgb(11, 16, 32)"><div data-embed></div></div>`),
      ),
    ).toBe("dark");
    expect(
      resolveHostTheme(
        mount(`<div style="background-color: rgb(255, 255, 255)"><div data-embed></div></div>`),
      ),
    ).toBe("light");
  });

  test("a page with no signal and no paint is light even when the OS is dark", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({ matches: query.includes("dark"), media: query }) as MediaQueryList) as never;
    try {
      expect(resolveHostTheme(mount(`<div data-embed></div>`))).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("host surfaces", () => {
  test("parses computed colors", () => {
    expect(parseComputedColor("rgb(11, 16, 32)")).toEqual({ r: 11, g: 16, b: 32, a: 1 });
    expect(parseComputedColor("rgba(0, 0, 0, 0)")?.a).toBe(0);
    expect(parseComputedColor("transparent")).toBeNull();
  });

  test("blends opaque surfaces from the host background", () => {
    const style = hostSurfaceStyle("dark", { r: 11, g: 16, b: 32 });
    expect(style["--og-color-canvas"]).toBe("rgb(11 16 32)");
    expect(style["--og-color-surface-2"]).toBe(
      "color-mix(in srgb, var(--og-color-fg) 8%, rgb(11 16 32))",
    );
    // Without host paint the browser canvas shows through.
    expect(hostSurfaceStyle("light", null)["--og-color-bg"]).toBe("Canvas");
  });

  test("host-customized tokens are detected so they survive a theme switch", () => {
    const embed = mount(
      `<div style="--og-color-accent: #7c3aed; --og-color-bg: #303030"><div data-embed></div></div>`,
    );
    expect(hostTokenOverrides(embed)).toEqual({ "--og-color-accent": "#7c3aed" });
  });

  test("the stock token table mirrors styles/tokens.css", () => {
    const css = readFileSync(join(import.meta.dir, "../styles/tokens.css"), "utf8");
    const block = (start: string) => {
      const from = css.indexOf(start);
      return css.slice(from, css.indexOf("}", from));
    };
    const read = (text: string) =>
      Object.fromEntries(
        [...text.matchAll(/(--og-[\w-]+):\s*([^;]+);/g)].map((match) => [
          match[1]!,
          match[2]!.trim(),
        ]),
      );
    const dark = read(block(":root {"));
    const light = read(block('[data-og-theme="light"],\n.og-light {'));
    for (const [token, [darkValue, lightValue]] of Object.entries(STOCK_COLOR_TOKENS)) {
      expect([token, dark[token]]).toEqual([token, darkValue]);
      expect([token, light[token]]).toEqual([token, lightValue]);
    }
  });
});

describe("review regressions", () => {
  test("a stylesheet color-scheme does not outrank the painted background", () => {
    // tokens.css declares `:root { color-scheme: dark }` on Tailwind hosts.
    document.documentElement.style.colorScheme = "dark";
    expect(
      resolveHostTheme(
        mount(`<div style="background-color: rgb(255, 255, 255)"><div data-embed></div></div>`),
      ),
    ).toBe("light");
  });

  test("mid-tone and saturated backgrounds pick the legible text", () => {
    expect(themeForBackground({ r: 0x99, g: 0x99, b: 0x99 })).toBe("light");
    expect(themeForBackground({ r: 0x3b, g: 0x82, b: 0xf6 })).toBe("light");
    expect(themeForBackground({ r: 0x0b, g: 0x10, b: 0x20 })).toBe("dark");
  });

  test("surfaces never blend from a background that contradicts the theme", () => {
    const embed = mount(
      `<div style="background-color: rgb(11, 16, 32)"><div data-embed></div></div>`,
    );
    const forced = resolveHostThemeState(embed, "light", "host");
    expect(forced.style?.["--og-color-canvas"]).toBeUndefined();
    const auto = resolveHostThemeState(embed, "auto", "host");
    expect(auto.theme).toBe("dark");
    expect(auto.style?.["--og-color-canvas"]).toBe("rgb(11 16 32)");
  });

  test("light-designed neutrals stay behind when a root is forced dark; brand colors travel", () => {
    const embed = mount(
      `<div data-og-theme="light" style="--og-color-fg: #111111; --og-color-accent: #7c3aed"><div data-embed></div></div>`,
    );
    const state = resolveHostThemeState(embed, "dark", "theme");
    expect(state.style?.["--og-color-fg"]).toBe("#e6e6e6");
    expect(state.style?.["--og-color-accent"]).toBe("#7c3aed");
    expect(state.style?.["--og-session-chrome-surface"]).toContain("--og-color-surface-2");
  });
});
