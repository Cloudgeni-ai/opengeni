import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildManagedCodemodeClient } from "../packages/runtime/src/sandbox/codemode-client";

export async function writeManagedCodemodeClient(root: string, path: string): Promise<void> {
  const client = await buildManagedCodemodeClient(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(client));
}

if (import.meta.main) {
  await writeManagedCodemodeClient(resolve(import.meta.dir, ".."), resolve(process.argv[2]!));
}
