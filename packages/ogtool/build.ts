import { chmod, readFile, writeFile } from "node:fs/promises";
import { build } from "tsup";

const library = Bun.spawn(["bun", "../../scripts/build-typescript-package.ts"], {
  cwd: import.meta.dir,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await library.exited;
if (exitCode !== 0) throw new Error(`ogtool library build failed with exit code ${exitCode}`);

await build({
  entry: { ogtool: "src/cli.ts" },
  outDir: "dist/bin",
  outExtension: () => ({ js: ".cjs" }),
  format: ["cjs"],
  target: "node22",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  noExternal: [/.*/u],
  sourcemap: false,
  minify: false,
  clean: false,
  config: false,
});
const executable = "dist/bin/ogtool.cjs";
const bundled = await readFile(executable, "utf8");
await writeFile(executable, bundled.replace(/[\t ]+$/gmu, ""), "utf8");
await chmod(executable, 0o755);
