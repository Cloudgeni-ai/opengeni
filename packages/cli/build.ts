import { resolve } from "node:path";
import { buildBinary } from "./build-binary";

const library = Bun.spawn(["bun", "../../scripts/build-typescript-package.ts"], {
  cwd: import.meta.dir,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await library.exited;
if (exitCode !== 0) throw new Error(`opengeni library build failed with exit code ${exitCode}`);

await buildBinary(resolve(import.meta.dir, "dist/bin"));
