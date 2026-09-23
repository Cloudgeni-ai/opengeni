import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { APPEARANCE_KEY, parseAppearance } from "./appearance";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const bootstrap = html.match(
  /<script id="opengeni-appearance-bootstrap">([\s\S]*?)<\/script>/,
)![1]!;

describe("appearance before first paint", () => {
  for (const stored of [null, "system", "light", "dark", "invalid"]) {
    for (const systemDark of [true, false]) {
      test(`${stored} with system dark=${systemDark}`, () => {
        const root = {
          dataset: {} as Record<string, string>,
          classList: {
            toggle: (_: string, on: boolean) => {
              dark = on;
            },
          },
        };
        let dark = false;
        runInNewContext(bootstrap, {
          document: { documentElement: root },
          localStorage: {
            getItem: (key: string) => {
              expect(key).toBe(APPEARANCE_KEY);
              return stored;
            },
          },
          matchMedia: () => ({ matches: systemDark }),
        });
        const preference = parseAppearance(stored);
        const expected = preference === "system" ? (systemDark ? "dark" : "light") : preference;
        expect(root.dataset.ogTheme).toBe(expected);
        expect(dark).toBe(expected === "dark");
      });
    }
  }
  test("blocked storage falls back to system without breaking startup", () => {
    const root = { dataset: {} as Record<string, string>, classList: { toggle: () => {} } };
    runInNewContext(bootstrap, {
      document: { documentElement: root },
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
      matchMedia: () => ({ matches: false }),
    });
    expect(root.dataset.ogTheme).toBe("light");
  });
});
