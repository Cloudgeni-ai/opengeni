import { defineConfig } from "tsup";

// @opengeni/worker-bundle is an ENGINE-DISTRIBUTION surface. Stage C publishes
// the full @opengeni/* runtime closure to npm, so every @opengeni/* and every
// @temporalio/* specifier is external — resolved by the consumer, never inlined.
//
// Temporal workflows are bundled separately, after tsup, by
// scripts/build-workflow-bundle.ts. The generated dist/workflow-bundle.js is a
// WorkerOptions.workflowBundle artifact, not a Node entry point. Keeping that
// step separate prevents tsup from rewriting the deterministic workflow graph
// while ensuring installed consumers never have to copy raw TypeScript out of
// node_modules for Temporal's webpack loader.
//
// This `dist` build exists to PROVE the worker library surface (runOpenGeniWorker
// + createOpenGeniWorker + the signaler/reaper helpers) type-checks and compiles
// cleanly for the release package.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, /^@temporalio\//],
});
