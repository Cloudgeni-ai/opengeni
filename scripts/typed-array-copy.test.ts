import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Server code copies bytes with `new Uint8Array(source)`, never
// `Uint8Array.from(source)`. Both make the same copy, but Bun sends
// `Uint8Array.from` of a Node Buffer (what base64 decoding, file reads,
// sockets, object storage and Postgres bytea all return) through its generic
// iterator path: about 16x the bytes in transient memory and two orders of
// magnitude slower. On a large workspace archive that took a worker past 15 GB.
// `Uint8Array.from(source, mapFn)` stays allowed: it builds bytes from a
// string or index range rather than copying a buffer.
const root = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_ROOTS = ["apps", "packages"];
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "target",
  "test",
  "tests",
  "gen",
]);
// Browser bundles have no Node Buffer to copy.
const BROWSER_ONLY_ROOTS = [
  "apps/web/",
  "packages/sdk/",
  "packages/react/",
  "packages/react-native/",
];
// Code-owner-reviewed paths that still copy this way. Each is converted in its
// own reviewed change; remove the entry with it.
const PENDING_REVIEWED_PATHS = new Set(["apps/worker/src/activities/agent-turn/agent-build.ts"]);
const BUFFER_COPY = /\bUint8Array\.from\(/;

function posix(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function sourceFiles(directory: string, out: string[]): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) sourceFiles(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|gen)\.tsx?$/.test(entry.name)) continue;
    const file = posix(path);
    if (PENDING_REVIEWED_PATHS.has(file)) continue;
    if (!BROWSER_ONLY_ROOTS.some((prefix) => file.startsWith(prefix))) out.push(file);
  }
  return out;
}

describe("typed array copies", () => {
  test("server code copies bytes with new Uint8Array, not Uint8Array.from", () => {
    const violations: string[] = [];
    for (const sourceRoot of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(root, sourceRoot), [])) {
        readFileSync(join(root, file), "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (BUFFER_COPY.test(line) && !line.includes("=>")) {
              violations.push(`${file}:${index + 1}: ${line.trim()}`);
            }
          });
      }
    }
    expect(violations).toEqual([]);
  });
});
