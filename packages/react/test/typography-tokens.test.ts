import { describe, expect, test } from "bun:test";

import { cn } from "../src/lib/cn";

const tokens = await Bun.file(`${import.meta.dir}/../styles/tokens.css`).text();
const styles = await Bun.file(`${import.meta.dir}/../styles/index.css`).text();
const responsive = await Bun.file(`${import.meta.dir}/../styles/responsive.css`).text();

describe("public typography token contract", () => {
  test("keeps apps/web's current default metrics", () => {
    for (const declaration of [
      "--og-font-size-xs: 11px",
      "--og-line-height-xs: 1.45",
      "--og-font-size-sm: 12px",
      "--og-line-height-sm: 1.5",
      "--og-font-size-base: 13px",
      "--og-line-height-base: 1.55",
      "--og-font-size-md: 15px",
      "--og-line-height-md: 1.6",
      "--og-font-size-control: 12px",
      "--og-line-height-control: 16px",
      "--og-font-size-menu: 14px",
      "--og-line-height-menu: 20px",
      "--og-font-size-composer: 16px",
      "--og-line-height-composer: 24px",
      "--og-font-size-composer-wide: 15px",
      "--og-line-height-composer-wide: 24px",
      "--og-model-picker-trigger-height: 2rem",
      "--og-model-picker-menu-width: 18rem",
      "--og-model-picker-row-padding-x: 0.625rem",
      "--og-model-picker-row-padding-y: 0.5rem",
      "--og-realtime-menu-width: 18rem",
    ]) {
      expect(tokens).toContain(declaration);
    }
  });

  test("maps every SDK typography utility to runtime variables", () => {
    for (const name of ["xs", "sm", "base", "md", "control", "menu", "composer", "composer-wide"]) {
      expect(styles).toContain(`--text-og-${name}: var(--og-font-size-${name})`);
      expect(styles).toContain(`--text-og-${name}--line-height: var(--og-line-height-${name})`);
      expect(styles).toContain(`@utility text-og-${name}`);
      expect(styles).toContain(`--og-component-font-size: var(--og-font-size-${name})`);
      expect(styles).toContain(`--og-component-line-height: var(--og-line-height-${name})`);
    }
  });

  test("shields SDK typography from higher-specificity host font resets", () => {
    expect(styles).toContain(":is(.og-root.og-root, .og-root .og-root)");
    expect(styles).toContain("font-size: var(--og-component-font-size)");
    expect(styles).toContain("line-height: var(--tw-leading, var(--og-component-line-height))");
    expect(styles).not.toContain("font-size: var(--og-component-font-size) !important");
  });

  test("keeps font-size and color utilities together after class merging", () => {
    expect(cn("text-og-menu", "text-og-fg-muted")).toBe("text-og-menu text-og-fg-muted");
    expect(cn("text-og-composer-wide", "text-og-fg")).toBe("text-og-composer-wide text-og-fg");
  });

  test("ships a compact preset without changing brand tokens", () => {
    const compact = tokens.slice(
      tokens.indexOf('[data-og-density="compact"]'),
      tokens.indexOf("/* Light theme"),
    );
    expect(compact).toContain("--og-font-size-menu: 12px");
    expect(compact).toContain("--og-font-size-composer-wide: 13px");
    expect(compact).toContain("--og-model-picker-menu-width: 15rem");
    expect(compact).toContain("--og-realtime-menu-width: 15rem");
    expect(compact).not.toContain("--og-color-accent:");
  });

  test("ships additive container-query hooks and panel-bounded portal menus", () => {
    expect(responsive).toContain('data-og-responsive-basis="container"');
    expect(responsive).toContain("container: og-composer / inline-size");
    expect(responsive).toContain("@container og-composer (max-width: 39.999rem)");
    expect(responsive).toContain("@media (pointer: coarse)");
    expect(responsive).toContain("var(--og-portal-source-inline-size, 100vw)");
    expect(responsive).toContain("var(--radix-dropdown-menu-content-available-width, 100vw)");
  });
});
