import { defineConfig } from "tsup";

// @opengeni/worker-bundle is an ENGINE-DISTRIBUTION surface. Stage C publishes
// the full @opengeni/* runtime closure to npm, so every @opengeni/* and every
// @temporalio/* specifier is external — resolved by the consumer, never inlined.
//
// THE WORKFLOW BUNDLE IS PACKAGING-FRAGILE. Temporal does NOT consume a
// pre-compiled JS bundle: at `Worker.create` time it takes the workflow ENTRY
// SOURCE (`new URL("../src/workflows.ts", import.meta.url)`) and runs its OWN
// webpack over the deterministic workflow
// import closure. So `workflows.ts` + its entire `./workflows/*` tree must ship
// UN-bundled, on disk, adjacent to the worker entry. We do NOT add `workflows.ts`
// as a tsup entry (that would rewrite it to `.js` and defeat the source lookup).
// The package ships `src/` in `files`, and the ../src lookup works from both the
// committed source entry and the published dist entry.
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
