import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OPEN_GENI_COMPONENTS,
  OPEN_GENI_ICON_ROLES,
  defineOpenGeniIconMap,
  openGeniAnatomy,
  sessionStatusPresentation,
} from "../src";

describe("@opengeni/ui contract", () => {
  test("keeps anatomy and icon roles closed and exhaustive", () => {
    expect(OPEN_GENI_COMPONENTS).toContain("composer");
    const icons = defineOpenGeniIconMap(
      Object.fromEntries(OPEN_GENI_ICON_ROLES.map((role) => [role, role])) as Record<
        (typeof OPEN_GENI_ICON_ROLES)[number],
        string
      >,
    );
    expect(Object.keys(icons)).toHaveLength(OPEN_GENI_ICON_ROLES.length);
    expect(openGeniAnatomy({ component: "composer", part: "input", state: "ready" })).toEqual({
      "data-og-component": "composer",
      "data-og-part": "input",
      "data-og-state": "ready",
    });
  });

  test("projects semantic status metadata without framework classes", () => {
    expect(sessionStatusPresentation("running")).toEqual({
      label: "Running",
      tone: "accent",
      live: true,
    });
    expect(sessionStatusPresentation("failed")).toEqual({
      label: "Failed",
      tone: "danger",
      live: false,
    });
  });

  test("compiled CSS is scoped and contains no framework scan directives", async () => {
    const css = await readFile(join(import.meta.dir, "../styles/compiled.css"), "utf8");
    expect(css).toContain(".og-root");
    expect(css).not.toContain("@source");
    expect(css).not.toContain("packages/react");
    expect(css).not.toContain("packages/svelte");
  });

  test("scopes browser color scheme and standalone session responsiveness to OpenGeni roots", async () => {
    const tokens = await readFile(join(import.meta.dir, "../styles/tokens.css"), "utf8");
    const responsive = await readFile(join(import.meta.dir, "../styles/responsive.css"), "utf8");
    const rootDefaults = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("\n}"));

    expect(rootDefaults).not.toContain("color-scheme");
    expect(tokens).toContain(".og-root {\n  color-scheme: dark;");
    expect(tokens).toContain('.og-root[data-og-theme="light"]');
    expect(responsive).toContain(".og-root.og-session, .og-root .og-session");
  });

  test("owns byte-identical React token and responsive compatibility sources", async () => {
    const pairs = [
      ["react-compat-tokens.css", "../../react/styles/tokens.css"],
      ["react-compat-responsive.css", "../../react/styles/responsive.css"],
    ] as const;
    for (const [canonical, compatibility] of pairs) {
      expect(await readFile(join(import.meta.dir, `../styles/${canonical}`), "utf8")).toBe(
        await readFile(join(import.meta.dir, compatibility), "utf8"),
      );
    }
  });
});
