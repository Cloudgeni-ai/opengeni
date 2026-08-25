import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const library = Bun.spawn(["bun", "../../scripts/build-typescript-package.ts"], {
  cwd: import.meta.dir,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await library.exited;
if (exitCode !== 0) throw new Error(`ogtool library build failed with exit code ${exitCode}`);

const binaryDirectory = resolve(import.meta.dir, "dist/bin");
await rm(binaryDirectory, { recursive: true, force: true });
await mkdir(binaryDirectory, { recursive: true });
const binaryBuild = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/cli.ts")],
  outdir: binaryDirectory,
  naming: "ogtool.cjs",
  format: "cjs",
  target: "node",
  banner: "#!/usr/bin/env node",
  sourcemap: "none",
  minify: false,
});
if (!binaryBuild.success) {
  for (const log of binaryBuild.logs) console.error(log);
  throw new Error("ogtool Bun bundle failed");
}

const executable = resolve(binaryDirectory, "ogtool.cjs");
const bundled = await readFile(executable, "utf8");
await writeFile(executable, bundled.replace(/[\t ]+$/gmu, ""), "utf8");
await chmod(executable, 0o755);
