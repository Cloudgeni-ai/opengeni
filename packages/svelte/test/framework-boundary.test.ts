import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("the native Svelte package has no React runtime boundary", () => {
  const root = resolve(import.meta.dir, "../src");
  const queue = [root];
  const sources: string[] = [];
  while (queue.length > 0) {
    const directory = queue.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (/\.(?:ts|svelte)$/u.test(entry.name)) sources.push(readFileSync(path, "utf8"));
    }
  }
  expect(sources.join("\n")).not.toMatch(/(?:from|import\()\s*["'](?:react|@opengeni\/react)/u);
});
