#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function developmentSchemaFingerprint(repositoryRoot: string): Promise<string> {
  const directory = join(repositoryRoot, "packages/db/drizzle");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(directory, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function watchDevelopmentSchema(
  repositoryRoot: string,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<"changed" | "aborted"> {
  const initial = await developmentSchemaFingerprint(repositoryRoot);
  const intervalMs = options.intervalMs ?? 500;
  for (;;) {
    if (options.signal?.aborted) return "aborted";
    await Bun.sleep(intervalMs);
    if (options.signal?.aborted) return "aborted";
    if ((await developmentSchemaFingerprint(repositoryRoot)) !== initial) return "changed";
  }
}

if (import.meta.main) {
  const repositoryRoot = process.argv[2] ?? process.cwd();
  const outcome = await watchDevelopmentSchema(repositoryRoot);
  if (outcome === "changed") {
    console.error(
      "Database migrations changed while the dev stack was running; stopping before watched code can use a stale schema. Restart bun run dev.",
    );
    process.exit(78);
  }
}
