import { cp, mkdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { copyRuntimeSkillAssets } from "../../build-runtime-processes";
import { writeManagedCodemodeClient } from "../../build-managed-codemode-client";

const root = resolve(import.meta.dir, "../../..");
const outdir = resolve(import.meta.dir, "dist");
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/host.ts`],
  outdir,
  target: "bun",
  format: "esm",
  splitting: true,
  minify: { syntax: true, whitespace: true, identifiers: false },
  sourcemap: "none",
  external: [
    "@temporalio/*",
    "@llamaindex/liteparse",
    "sharp",
    "better-auth",
    "better-auth/*",
    "@better-auth/*",
  ],
});
if (!result.success) throw new AggregateError(result.logs, "Experiment bundle failed");
const workflow = Bun.spawn([process.execPath, "scripts/build-workflow-bundle.ts"], {
  cwd: `${root}/apps/worker`,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await workflow.exited) !== 0) throw new Error("Workflow build failed");
await cp(`${root}/apps/worker/dist/workflow-bundle.js`, `${outdir}/workflow-bundle.js`);
await copyRuntimeSkillAssets(root, outdir);
await mkdir(`${outdir}/assets/agent-install`, { recursive: true });
await cp(`${root}/agent/install`, `${outdir}/assets/agent-install`, { recursive: true });
await writeManagedCodemodeClient(root, `${outdir}/assets/codemode-client.json`);
// Local benchmark closure, not an installable release image. Keep native and
// Temporal externals on their ordinary package dependency graph.
for (const [name, owner] of [
  ["@temporalio/workflow", "worker"],
  ["@llamaindex/liteparse", "worker"],
  ["better-auth", "api"],
]) {
  const destination = `${outdir}/node_modules/${name}`;
  await mkdir(resolve(destination, ".."), { recursive: true });
  if (!existsSync(destination))
    await symlink(`${root}/apps/${owner}/node_modules/${name}`, destination);
}
console.log(
  JSON.stringify({
    bundleFiles: result.outputs.length,
    bytes: result.outputs.reduce((sum, file) => sum + file.size, 0),
  }),
);
