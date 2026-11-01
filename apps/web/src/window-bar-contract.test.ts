import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The desktop window bar is one component for every page: the shells wire
// their canvas to it (`useWindowBarRow`, `WindowBarPageTitle`) and draw the
// sidebar toggle with it (`WindowBarControls`), and nothing else draws its own
// bar controls or bar row. A page that renders a different bar fails here; the
// geometry is checked in test/e2e/desktop-corner.browser.e2e.ts and
// desktop-rail.browser.e2e.ts.

const repo = join(import.meta.dir, "../../..");
const shared = "packages/react/src/app/components/window-bar.tsx";
const read = (path: string) => readFileSync(join(repo, path), "utf8");

function sources(dir: string): string[] {
  return readdirSync(join(repo, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

const appSources = [...sources("apps/web/src"), ...sources("packages/react/src")].filter(
  (file) => !file.startsWith("apps/web/src/dev/"),
);

describe("the desktop window bar", () => {
  test("both page shells draw it with the shared component", () => {
    for (const shell of [
      "packages/react/src/app/components/rail/session-shell.tsx",
      "apps/web/src/components/settings/settings-sidebar.tsx",
    ]) {
      const source = read(shell);
      expect({ shell, row: source.includes("useWindowBarRow(") }).toEqual({ shell, row: true });
      expect({ shell, title: source.includes("<WindowBarPageTitle") }).toEqual({
        shell,
        title: true,
      });
      expect({
        shell,
        imports: /from "[^"]*(components\/|\.\.\/)window-bar"/.test(source),
      }).toEqual({
        shell,
        imports: true,
      });
    }
    // The settings shell has the same sidebar toggle in the bar as the rail.
    expect(read("apps/web/src/components/settings/settings-sidebar.tsx")).toContain(
      "<WindowBarControls>",
    );
    expect(read("packages/react/src/app/components/rail/rail-sections.tsx")).toContain(
      "<WindowBarControls>",
    );
  });

  test("nothing else draws bar controls or a bar row of its own", () => {
    const own = (pattern: RegExp, allowed: string[]) =>
      appSources
        .filter((file) => !allowed.includes(file) && pattern.test(read(file)))
        .map((file) => relative(repo, join(repo, file)));
    // The toggle's host and the title line are the shared component's.
    expect(own(/data-window-bar-controls(?!\])/, [shared])).toEqual([]);
    expect(own(/data-window-bar-row(?!\])|"data-window-bar-row"/, [shared])).toEqual([]);
    // A title bar row is the shared title line, or a chat's own header, which
    // the session shell lifts into the bar the same way.
    expect(
      own(/\bdata-titlebar\b(?!\])/, [
        shared,
        "packages/react/src/app/components/rail/session-header.tsx",
      ]),
    ).toEqual([]);
  });
});
