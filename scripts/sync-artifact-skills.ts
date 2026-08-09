#!/usr/bin/env bun

import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_SKILL_NAMES = [
  "opengeni-spreadsheets",
  "opengeni-documents",
  "opengeni-presentations",
] as const;

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = join(repoRoot, ".agents", "skills");
const targetRoot = join(repoRoot, "packages", "runtime", "src", "bundled_artifact_skills");

export async function checkArtifactSkillBundle(): Promise<void> {
  const expected = await skillFiles(sourceRoot);
  const actual = await skillFiles(targetRoot);
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Bundled artifact skill paths differ. Run: bun scripts/sync-artifact-skills.ts`,
    );
  }
  for (const path of expectedPaths) {
    const source = expected.get(path)!;
    const bundled = actual.get(path)!;
    if (!source.equals(bundled)) {
      throw new Error(
        `Bundled artifact skill is stale: ${path}. Run: bun scripts/sync-artifact-skills.ts`,
      );
    }
  }
}

export async function syncArtifactSkillBundle(): Promise<void> {
  const temporary = `${targetRoot}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const name of ARTIFACT_SKILL_NAMES) {
      await cp(join(sourceRoot, name), join(temporary, name), {
        recursive: true,
        errorOnExist: true,
      });
    }
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(dirname(targetRoot), { recursive: true });
    await rename(temporary, targetRoot);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await checkArtifactSkillBundle();
}

async function skillFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const skill of ARTIFACT_SKILL_NAMES) {
    const directory = join(root, skill);
    await walk(directory, async (path) => {
      files.set(relative(root, path).replaceAll("\\", "/"), await readFile(path));
    });
  }
  return files;
}

async function walk(directory: string, visit: (path: string) => Promise<void>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    } else {
      throw new Error(`Artifact skill bundle contains unsupported entry: ${path}`);
    }
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some((argument) => argument !== "--check")) {
    throw new Error("Usage: bun scripts/sync-artifact-skills.ts [--check]");
  }
  if (process.argv.includes("--check")) await checkArtifactSkillBundle();
  else await syncArtifactSkillBundle();
}
