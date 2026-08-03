import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

describe("pack sandbox image runtime settings", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "activities", "agent-turn.ts"),
    "utf8",
  );

  test("passes run-scoped image settings to eager and lazy provider creation", () => {
    const scopedCallSites = source.match(/resumeBoxForTurn\(\s*\{\s*db,\s*settings: runSettings,/g);
    expect(scopedCallSites).toHaveLength(2);
    expect(source).not.toMatch(/resumeBoxForTurn\(\s*\{\s*db,\s*settings,/);
  });
});
