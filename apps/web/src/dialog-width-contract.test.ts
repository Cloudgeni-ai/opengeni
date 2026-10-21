import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// The web app and the shared session UI in @opengeni/react both render dialogs.
const SOURCE_ROOTS = [import.meta.dir, `${import.meta.dir}/../../../packages/react/src`];

/**
 * `DialogContent` caps its width with `sm:max-w-lg`. An unprefixed `max-w-*`
 * from the caller loses to that breakpoint rule from 640px up, so a dialog
 * asking for `max-w-2xl` silently renders at 512px and squeezes its fields.
 * Widths must use the same `sm:` prefix to take effect.
 */
describe("DialogContent width", () => {
  test("callers set their width with an sm: prefix", async () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for await (const path of new Glob("**/*.tsx").scan({ cwd: root })) {
        if (path.startsWith("dev/")) continue;
        const source = await Bun.file(`${root}/${path}`).text();
        for (const match of source.matchAll(/<DialogContent\b([^>]*?)>/gs)) {
          const classNames = match[1]?.match(/className=(?:"([^"]*)"|\{[^}]*\})/s)?.[0] ?? "";
          if (/(?<![\w:-])max-w-/.test(classNames)) {
            const line = source.slice(0, match.index).split("\n").length;
            offenders.push(`${path}:${line}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
