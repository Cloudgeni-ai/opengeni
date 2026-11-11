#!/usr/bin/env bun
/**
 * Drops changesets that name only ignored packages.
 *
 * `changeset version` never consumes a changeset whose packages are all in
 * `.changeset/config.json` `ignore` (for example `opengeni-web`), so such a
 * file would stay in the Version PR tree forever. The release candidate
 * refuses any pending changeset, so one leftover note blocks every release.
 * Ignored packages are not versioned by Changesets, so these notes have no
 * other consumer and are removed together with the consumed ones.
 *
 * Usage (part of `bun run changeset:version`, after `changeset version`):
 *   bun scripts/release/drop-ignored-changesets.ts
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../publishable-workspaces";

/** Package names in a changeset's front matter, or undefined if it has none. */
export function changesetPackages(source: string): string[] | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---/.exec(source);
  if (!match) return undefined;
  const packages: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const entry = /^(["']?)([^"':]+)\1\s*:\s*(major|minor|patch|none)\s*$/.exec(trimmed);
    if (!entry) throw new Error(`unrecognized changeset front matter line: ${line}`);
    packages.push(entry[2]!);
  }
  return packages;
}

export function ignoredOnlyChangesets(directory: string, ignored: readonly string[]): string[] {
  const ignoredSet = new Set(ignored);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .filter((name) => {
      const packages = changesetPackages(readFileSync(join(directory, name), "utf8"));
      return (
        packages !== undefined &&
        packages.length > 0 &&
        packages.every((pkg) => ignoredSet.has(pkg))
      );
    })
    .sort();
}

if (import.meta.main) {
  const directory = join(repoRoot, ".changeset");
  const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as {
    ignore?: string[];
  };
  for (const name of ignoredOnlyChangesets(directory, config.ignore ?? [])) {
    rmSync(join(directory, name));
    console.log(`dropped ignored-package changeset .changeset/${name}`);
  }
}
