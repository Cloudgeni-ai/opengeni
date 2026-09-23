import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, ".agents/skills/opengeni-client");
const destination = join(root, "packages/runtime/src/bundled_default_skills/opengeni-client");

async function files(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        result.set(relative(directory, child).replaceAll("\\", "/"), await readFile(child, "utf8"));
      else throw new Error(`Unsupported client Skill entry: ${child}`);
    }
  }
  await visit(directory);
  return result;
}

/** The repository guide is the sole authored copy. Runtime assets are exact copies. */
export async function checkClientSkill(): Promise<void> {
  const expected = await files(source);
  let actual: Map<string, string>;
  try {
    actual = await files(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Bundled client Skill is missing; run bun run sync:client-skill", {
      cause: error,
    });
  }
  if (
    expected.size !== actual.size ||
    [...expected].some(([path, text]) => actual.get(path) !== text)
  )
    throw new Error("Bundled client Skill is stale; run bun run sync:client-skill");
}

export async function syncClientSkill(): Promise<void> {
  const expected = await files(source);
  // Only this generated directory is replaced, including obsolete references.
  await rm(destination, { recursive: true, force: true });
  for (const [path, text] of expected) {
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("Usage: bun scripts/sync-client-skill.ts [--check]");
  if (process.argv.includes("--check")) await checkClientSkill();
  else await syncClientSkill();
}
