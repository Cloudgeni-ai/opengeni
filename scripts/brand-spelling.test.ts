import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Agent-facing prose spells the product "Opengeni". The capitalized form stays
// only where it is functional: code identifiers (`OpenGeniClient`), header and
// user-agent tokens (`X-OpenGeni-*`, `OpenGeni-Signature`), persisted or wire
// values, immutable migrations, and pinned curated Skill artifacts.
const root = fileURLToPath(new URL("..", import.meta.url));

// A standalone prose word: not part of a longer identifier, a hyphenated
// protocol token, a dotted method name, or an inline-code span.
const PROSE_MISSPELLING = /(?<![A-Za-z0-9_\-.`])OpenGeni(?![A-Za-z0-9_`]|-[A-Z]|\.[A-Za-z])/;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".turbo", "target"]);
const SKIPPED_PATHS = [
  // Released notes and the immutable migration ledger are historical records.
  /(^|\/)CHANGELOG\.md$/,
  /^packages\/db\/drizzle\//,
  // Reviewed curated Skills are digest-pinned, immutable artifacts.
  /^packages\/runtime\/src\/curated_skill_library\//,
];

// Prompt modules, bundled Skills, and the main agent tool-description sources.
// `skill-library.ts` is deliberately absent: its entry provenance strings are
// frozen records that migration 0233 pins and installations retain.
const AGENT_FACING_SOURCE_ROOTS = [
  "packages/runtime/src/agent-instructions",
  "packages/runtime/src/bundled_artifact_skills",
  "packages/runtime/src/bundled_default_skills",
  "packages/runtime/src/bundled_management_skills",
  "packages/runtime/src/bundled_project_skills",
  "packages/runtime/src/bundled_schedule_skills",
  "packages/runtime/src/bundled_secret_skills",
  "packages/runtime/src/bundled_site_skills",
  "packages/runtime/src/bundled_video_skills",
  "packages/runtime/src/interaction-tools.ts",
  "packages/core/src/domain/capabilities.ts",
  "apps/api/src/mcp/server.ts",
  "data/catalog/curated.json",
];

function posix(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function walk(path: string, accept: (file: string) => boolean, out: string[]): void {
  const stats = statSync(path);
  if (stats.isFile()) {
    if (accept(path)) out.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    walk(join(path, entry.name), accept, out);
  }
}

function misspellings(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const path = posix(file);
    if (SKIPPED_PATHS.some((pattern) => pattern.test(path))) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (PROSE_MISSPELLING.test(line)) found.push(`${path}:${index + 1}`);
      });
  }
  return found;
}

describe("Opengeni product spelling", () => {
  test("the guard distinguishes prose from functional identifiers", () => {
    for (const prose of [
      "OpenGeni runs agents.",
      "an OpenGeni-owned key",
      "use OpenGeni's tools",
    ]) {
      expect(PROSE_MISSPELLING.test(prose)).toBe(true);
    }
    for (const functional of [
      "new OpenGeniClient()",
      "X-OpenGeni-Session-Id",
      "OpenGeni-Signature: t=1",
      "OpenGeni.debuggerDetached",
      "the existing `OpenGeni` export",
      "Opengeni runs agents.",
    ]) {
      expect(PROSE_MISSPELLING.test(functional)).toBe(false);
    }
  });

  test("Markdown docs, Skills, and agent notes use Opengeni", () => {
    const files: string[] = [];
    walk(root, (file) => /\.mdx?$/.test(file), files);
    expect(files.length).toBeGreaterThan(100);
    expect(misspellings(files)).toEqual([]);
  });

  test("prompts, bundled Skills, and tool descriptions use Opengeni", () => {
    const files: string[] = [];
    for (const source of AGENT_FACING_SOURCE_ROOTS) {
      walk(join(root, source), () => true, files);
    }
    expect(misspellings(files)).toEqual([]);
  });
});
