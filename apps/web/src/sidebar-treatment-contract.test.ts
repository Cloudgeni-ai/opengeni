import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The session rail and the settings rail are one sidebar: their docked column,
// surface and brand row come only from the shared rail pieces
// (packages/react/src/app/components/rail/rail-surface.tsx), so the macOS
// window glass, the hairline, the glow and the draggable brand row can't drift
// apart again. The rendered structure is checked in
// components/settings/settings-sidebar.test.tsx and, against the real main
// rail on every platform, in test/e2e/desktop-corner.browser.e2e.ts.

const repo = join(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const shared = "packages/react/src/app/components/rail/rail-surface.tsx";

function sources(dir: string): string[] {
  return readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

describe("the sidebar treatment", () => {
  test("only the shared pieces mark a docked rail column, surface or brand row", () => {
    // App code and the desktop previews the browser tests compare against.
    const offenders = [
      ...sources("apps/web/src"),
      ...sources("apps/web/test"),
      ...sources("packages/react/src"),
    ]
      .filter((file) => file !== shared && !file.startsWith("apps/web/src/dev/"))
      .filter((file) => /data-(?:shell-rail|rail-brand)\b|["\s]og-rail-glow[\s"]/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  test("the macOS app clears the docked rail surface for the window glass", () => {
    const styles = read("apps/web/src/styles.css");
    expect(styles).toMatch(
      /html\[data-desktop="macos"\] \[data-shell-rail\] \.og-rail-glow \{\s*background: transparent;/,
    );
  });
});
