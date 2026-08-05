import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".xml",
]);
const MINIMUM_BYTES = 1_024;

export async function precompressWebDist(root: string): Promise<number> {
  const files = await listFiles(resolve(root));
  let written = 0;
  for (const path of files) {
    if (!COMPRESSIBLE_EXTENSIONS.has(extname(path)) || path.endsWith(".gz")) continue;
    const source = new Uint8Array(await Bun.file(path).arrayBuffer());
    if (source.byteLength < MINIMUM_BYTES) continue;
    const compressed = Bun.gzipSync(source, { level: 9 });
    if (compressed.byteLength >= source.byteLength) continue;
    await Bun.write(`${path}.gz`, compressed);
    written += 1;
  }
  return written;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? "apps/web/dist");
  const written = await precompressWebDist(root);
  console.log(`Precompressed ${written} web assets.`);
}
