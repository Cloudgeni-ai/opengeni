import { defineConfig } from "tsup";

// @opengeni/worker-bundle is an ENGINE-DISTRIBUTION surface, not a registry-clean
// leaf: its runtime closure includes the deliberately-unpublished engine-internal
// packages (@opengeni/runtime, @opengeni/storage, @opengeni/observability,
// @opengeni/codex), so a host that consumes it consumes the whole engine
// (a workspace/git install, not a bare `npm install`). Every @opengeni/* and
// every @temporalio/* specifier is therefore marked external — resolved by the
// consumer, never inlined.
//
// THE WORKFLOW BUNDLE IS PACKAGING-FRAGILE. Temporal does NOT consume a
// pre-compiled JS bundle: at `Worker.create` time it takes the workflow ENTRY
// SOURCE (`resolveWorkflowsPath()` -> `new URL("./workflows.ts",
// import.meta.url)`) and runs its OWN webpack over the deterministic workflow
// import closure. So `workflows.ts` + its entire `./workflows/*` tree must ship
// UN-bundled, on disk, adjacent to the worker entry. We do NOT add `workflows.ts`
// as a tsup entry (that would rewrite it to `.js` and defeat the source lookup);
// instead the package keeps its committed `./src/index.ts` entry points and ships
// `src/` in `files`, so the `import.meta.url`-relative `./workflows.ts` lookup
// resolves the bundled source in a published tarball exactly as in standalone.
//
// This `dist` build exists to PROVE the worker library surface (runOpenGeniWorker
// + createOpenGeniWorker + the signaler/reaper helpers) type-checks and compiles
// cleanly for the closure guard; the runtime entry stays on src.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, /^@temporalio\//],
});
