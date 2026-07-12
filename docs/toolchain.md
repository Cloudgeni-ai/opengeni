# Toolchain

The fast path for contributors: what runs typecheck, lint, and format, and why.

## Package manager & runtime

**Bun** end to end — install, run, test, and script execution. There is no `npm`/`pnpm`/`yarn`
lockfile in this repo; use `bun install`, `bun run <script>`, `bun test`. Libraries build with
`tsup` (esbuild); `apps/web` builds with Vite.

The one intentional exception is the publish step: `bun run release:publish`
(`scripts/release-publish.sh`) shells out to `npx changeset publish`, which falls back to
`npm publish` for the actual registry push. That's deliberate — `bun publish` cannot emit npm
provenance attestations, so the release workflow (`.github/workflows/release.yml`) sets up Node
and the npm registry for that one step only. Don't "fix" this to use bun; provenance is the reason
it exists.

## Typecheck: tsgo

Typecheck runs on **tsgo** (`@typescript/native-preview`, the native-Go TypeScript 7 compiler),
not `tsc`. `bun run typecheck` invokes `bun scripts/typecheck.ts`, which runs `tsgo --noEmit`
over every discovered workspace `tsconfig.json` plus the typed CI/operator scripts. It uses a
cgroup-aware bounded pool (one worker by default) and caps retained failure output. The impact
planner calls the same driver with exact `--project` selections; main/full mode selects every
project. This replaced an 18-step chain of per-package `tsc --noEmit` calls that used to be the
dominant cost of local verification, both in wall time and peak memory.

`typescript@6` is still a dependency, but only as `tsup`'s internal `.d.ts` emitter for
publishable packages (`dts: true`) — it is never invoked as a gating typecheck. If you see a
`tsc`-shaped error during a package build, that's the dts emit path, not the typecheck gate.

CI runs the same `bun run typecheck` step (`.github/workflows/ci.yml`), so there is nothing
special to configure locally beyond `bun install`.

## Lint: oxlint

**oxlint** is the linter — a greenfield add (there was never an ESLint/Prettier/Biome config in
this repo). `bun run lint` runs it and CI gates on it (0 errors; warnings are advisory). Config is
`.oxlintrc.json` at the repo root: a lean plugin set (`react`, `react-hooks`, `typescript`,
`import`) to stay clear of the multi-plugin perf cliff. Notable rule choices:

- `react/react-in-jsx-scope` off (React 19's automatic JSX runtime — no `import React` needed).
- `react-hooks/exhaustive-deps` at `warn` (oxlint asks for whole-object deps where the intent is
  member-level; audit before adding a dep, don't mass-autofix).
- `no-control-regex` off (this repo's control-char sanitizers legitimately match them, and even the
  recommended `\u`-escape form trips the rule).
- A test-scoped override drops `no-unsafe-optional-chaining` to `warn` and turns off
  `no-this-alias` — both fire only on test scaffolding, so the rules stay strict for `src`.

Warnings are intentionally non-blocking. Run `bun run lint` locally to see them.

## Format: oxfmt

**oxfmt** is the formatter (Prettier-compatible output, printWidth 100). `bun run format` writes,
`bun run format:check` verifies, and CI gates on `format:check`. Config is `.oxfmtrc.json`, scoped
to **TS/JS/JSON only**. It deliberately excludes markdown/YAML/TOML/CSS, `*.d.ts`, generated files
(`*.gen.*`), drizzle migrations/meta, the golden event-grammar fixtures, all `fixtures/` and
`evidence/` directories, and the Rust `agent/` crate — reformatting byte-exact fixtures or
templated YAML would break tests or Helm rendering. If you add a new byte-exact fixture directory,
add it to `ignorePatterns`.

## Fast checks, full checks, and cache fences

`bun run check` is the default local fast path. It compares the branch and dirty
worktree with `origin/main`, writes the exact explainable plan to
`.cache/opengeni/local-impact-plan.json`, and runs impacted typechecks, isolated
memory-bounded unit tests, publishable builds, and selected static/docs guards.
Each phase writes wall/CPU/RSS/cgroup/I/O evidence under
`.cache/opengeni/local-profiles/`; `bun scripts/ci/summarize-profiles.ts <json>...`
reports successful-run median, nearest-rank p95, population variance/stddev/CV,
and separately inventories failed samples.
Use `bun run check -- --services` to include selected real PostgreSQL/pgvector,
Temporal/NATS/object-storage and browser/Docker gates locally. Use
`bun run check:full` for the fail-closed full local safety net; main, scheduled,
and manually dispatched GitHub CI always use that same full mapping regardless
of the diff.

Change impact is derived from workspace manifests plus explicit root integration
and E2E dependencies. Unknown paths, missing changed-file input, CI/toolchain,
lockfile, generated agent protocol, migrations, deployment, image, and build-map
changes select the full gate. Renames and copies fence both old and new paths.
Every plan explains why each path ran or why analysis failed closed.

Unit files run in deterministic size-balanced shards, bounded process batches,
and fresh globals; DOM, environment-mutating tests, and process-global mocks get
a fresh process. Concurrency is the minimum of the requested cap, available
CPUs, and a cgroup/host memory budget that subtracts current usage plus an
explicit reserve. Override only for measured runner constraints
with `OPENGENI_TEST_MAX_CONCURRENCY`,
`OPENGENI_TEST_MEMORY_PER_WORKER_MB`, or
`OPENGENI_TEST_FILES_PER_PROCESS`; invalid values fail closed.
Only the E2E shard that actually owns `browser.e2e.ts` installs Playwright's
Chromium runtime; Docker/sandbox-only shards do not repeat that apt/browser
setup. Selected React and web changes still run their demo/application builds
on the local fast path; impact selection never substitutes typecheck for a
real affected artifact build.

The path-filtered weekly `Desktop image e2e` workflow owns the full desktop OCI
build, the provider-live suite requires explicit provider credentials, the
workspace-capture gate requires an already-running stack, and the Rust
op-stream E2E requires an explicitly built runner plus `nats-server`. They are
listed as dedicated opt-in ownership in `scripts/ci/workspace.ts`; ordinary CI
must not invoke them in a configuration that only skips and then claim proof.

Publishable package outputs use a content-addressed cache. Its key binds the
complete package boundary (excluding output/cache directories), workspace and
lock manifests, build scripts, transitive workspace dependency fingerprints,
Bun/platform/architecture, and relevant build environment. Every restored file
is manifest-, digest-, mode-, path-, and symlink-validated; corruption becomes a
cache miss and rebuild, never a trusted output. `.bun-version` is the canonical
Bun pin for local/CI/release, and the workload Docker base is version- and
digest-pinned. The worker copies Docker CLI and its plugins from a separately
digest-pinned official image rather than installing a floating apt package.
Per-target GHA cache scopes prevent API/worker/web cache exports from replacing
one another, while the shared Dockerfile graph still reuses common layers.
CI restores the exact lockfile/manifests-fenced `node_modules` tree into each
downstream job and keeps Bun's equivalent global package store only in the one
install/verification job; it does not transfer both ~1 GiB copies into every
shard. The frozen install still verifies the restored exact tree before the
cache is made available to dependent jobs, and each downstream job performs a
warm frozen verification so a stale or damaged restore is repaired/fails closed
instead of being trusted. That verification is a no-op on a valid tree.
The remote cache snapshot keeps at most two immutable fingerprints per package,
so restore-forward-save cannot grow every per-SHA cache without bound. The
publish-closure guard is validation-only: selected builds produce outputs once,
and the guard never rebuilds the rest of the npm closure behind the impact
planner's back.

Cold package builds remain bounded by the largest single `tsup` declaration
emitter rather than package-level parallelism. The build driver supplies a
fingerprinted 1536 MiB Node heap ceiling: a measured 1 GiB ceiling fails the API
declaration build, while 1536 MiB produces byte-identical output. Warm verified
hits skip that emitter entirely.

## Where this fits

For the full local check sequence contributors run before opening a PR, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md#checks). This doc is intentionally narrow: it explains
*which tool* does typecheck/lint/format and why, not the day-to-day contributor workflow.
