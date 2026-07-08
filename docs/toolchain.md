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
sequentially over every project's `tsconfig.json` (one process at a time, fail-fast). This
replaced an 18-step chain of per-package `tsc --noEmit` calls that used to be the dominant cost of
local verification, both in wall time and peak memory.

`typescript@6` is still a dependency, but only as `tsup`'s internal `.d.ts` emitter for
publishable packages (`dts: true`) — it is never invoked as a gating typecheck. If you see a
`tsc`-shaped error during a package build, that's the dts emit path, not the typecheck gate.

CI runs the same `bun run typecheck` step (`.github/workflows/ci.yml`), so there is nothing
special to configure locally beyond `bun install`.

## Lint: oxlint (landing in a follow-up PR)

**oxlint** is the planned linter — there is no ESLint/Prettier/Biome config in this repo today, so
this is a greenfield add rather than a migration. It is not wired up yet; when it lands, `bun run
lint` will run it and CI will gate on it. See `docs/architecture.md` for where package boundaries
live if you're setting up per-package lint scope.

## Format: oxfmt (landing in a follow-up PR)

**oxfmt** is the planned formatter (Prettier-compatible output). Also not wired up yet; when it
lands, `bun run format` / `bun run format:check` will run it and CI will gate on `format:check`.
The initial adoption reformats the whole repo in one dedicated commit (large, mechanical diff) —
don't hand-format ahead of that landing to avoid fighting it.

## Where this fits

For the full local check sequence contributors run before opening a PR, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md#checks). This doc is intentionally narrow: it explains
*which tool* does typecheck/lint/format and why, not the day-to-day contributor workflow.
