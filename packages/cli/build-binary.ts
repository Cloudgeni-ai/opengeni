import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Bundle `src/bin.ts` into the Node-runnable CommonJS `opengeni.cjs` executable
 * in `directory` and return its path. The package build and the tests use this
 * same function, so the tests run exactly what the package ships.
 */
export async function buildBinary(directory: string): Promise<string> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "src/bin.ts")],
    outdir: directory,
    naming: "opengeni.cjs",
    format: "cjs",
    target: "node",
    banner: "#!/usr/bin/env node",
    sourcemap: "none",
    minify: false,
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error("opengeni Bun bundle failed");
  }
  const executable = resolve(directory, "opengeni.cjs");
  const bundled = await readFile(executable, "utf8");
  await writeFile(executable, bundled.replace(/[\t ]+$/gmu, ""), "utf8");
  await chmod(executable, 0o755);
  return executable;
}
