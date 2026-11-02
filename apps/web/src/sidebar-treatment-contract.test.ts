import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The session rail and the settings rail are one sidebar: both draw their
// docked column, surface and brand row with the shared rail pieces
// (packages/react/src/app/components/rail/rail-surface.tsx), so the macOS
// window glass, the hairline, the glow and the draggable brand row can't drift
// apart again. The rendered structure is checked in
// components/settings/settings-sidebar.test.tsx.

const repo = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const shared = "packages/react/src/app/components/rail/rail-surface.tsx";

function sources(dir: string): string[] {
  return readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

describe("the sidebar treatment", () => {
  test("both shells draw the rail with the shared column, surface and brand row", () => {
    const session = read("packages/react/src/app/components/rail/session-shell.tsx");
    const sessionHeader = read("packages/react/src/app/components/rail/rail-sections.tsx");
    const settings = read("apps/web/src/components/settings/settings-sidebar.tsx");
    for (const [shell, source] of [
      ["session", session],
      ["settings", settings],
    ] as const) {
      expect({ shell, column: source.includes("<ShellRail") }).toEqual({ shell, column: true });
      expect({ shell, surface: source.includes("<RailSurface") }).toEqual({
        shell,
        surface: true,
      });
    }
    for (const [shell, source] of [
      ["session", sessionHeader],
      ["settings", settings],
    ] as const) {
      expect({ shell, brand: source.includes("<RailBrandRow") }).toEqual({ shell, brand: true });
      expect({ shell, link: source.includes("RAIL_BRAND_LINK_CLASS") }).toEqual({
        shell,
        link: true,
      });
    }
  });

  test("only the shared pieces mark a docked rail column, surface or brand row", () => {
    const offenders = [...sources("apps/web/src"), ...sources("packages/react/src")]
      .filter((file) => file !== shared && !file.startsWith("apps/web/src/dev/"))
      .filter((file) => /data-(?:shell-rail|rail-brand)\b|["\s]og-rail-glow[\s"]/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  test("the settings rail is as wide as the main rail", () => {
    const settings = read("apps/web/src/components/settings/settings-sidebar.tsx");
    expect(settings).toContain("rail?.width ?? RAIL_DEFAULT_WIDTH");
    expect(settings).not.toMatch(/grid-cols-\[(?:15|18)rem_/);
  });

  test("the macOS app clears the docked rail surface for the window glass", () => {
    const styles = read("apps/web/src/styles.css");
    expect(styles).toMatch(
      /html\[data-desktop="macos"\] \[data-shell-rail\] \.og-rail-glow \{\s*background: transparent;/,
    );
  });
});
