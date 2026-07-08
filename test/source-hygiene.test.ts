import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Source files must stay text. A single raw 0x00 byte (e.g. a literal NUL
 * typed into a template literal instead of the "\u0000" escape) makes git and
 * grep treat the file as binary: PR diffs collapse to "Bin 0 -> N bytes"
 * (unreviewable), and text tooling silently skips the file. This happened to
 * use-turn-queue.ts, internal.ts, and account.tsx in #54/#55 — never again.
 */
describe("source hygiene", () => {
  const repoRoot = resolve(import.meta.dir, "..");

  test("no tracked TypeScript source contains a raw NUL byte", () => {
    const list = spawnSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx"], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(list.status).toBe(0);
    const files = list.stdout
      .toString("utf8")
      .split("\u0000")
      .filter((file) => file.length > 0);
    expect(files.length).toBeGreaterThan(100);

    const binaryFiles = files.filter((file) => readFileSync(join(repoRoot, file)).includes(0));
    expect(binaryFiles).toEqual([]);
  }, 30_000);
});
