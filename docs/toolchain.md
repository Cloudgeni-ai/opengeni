# Toolchain

The fast path for contributors: what runs typecheck, lint, and format, and why.

## Package manager & runtime

**Bun** end to end — install, run, test, and script execution. There is no `npm`/`pnpm`/`yarn`
lockfile in this repo; use `bun install`, `bun run <script>`, `bun test`. Libraries build
JavaScript with `tsup` (esbuild) and declarations with stable TypeScript 7 `tsc`; `apps/web`
builds with Vite.

The one intentional exception is the publish step: `bun run release:publish`
(`scripts/release-publish.sh`) shells out to `npx changeset publish`, which falls back to
`npm publish` for the actual registry push. That's deliberate — `bun publish` cannot emit npm
provenance attestations, so the release workflow (`.github/workflows/release.yml`) sets up Node
and the npm registry for that one step only. Don't "fix" this to use bun; provenance is the reason
it exists.

## Typecheck: stable TypeScript 7

Typecheck runs on the exact pinned stable **TypeScript 7** `tsc`. `bun run typecheck` invokes
`bun scripts/typecheck.ts`, which runs `tsc --noEmit` over every project's `tsconfig.json` with a
bounded worker pool. Per-package `typecheck` scripts invoke the same compiler. Preview compiler
packages and executables are not part of the toolchain.

Publishable packages use `scripts/build-typescript-package.ts`: `tsup` still creates JavaScript
and source maps, then stable TypeScript 7 `tsc` emits declarations. This split is intentional;
`tsup` 8's declaration bundler requires the legacy JavaScript compiler API, which stable
TypeScript 7 no longer exports. The generated package declarations remain release-gated by the
external-consumer and publish-closure tests.

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

## Where this fits

For the full local check sequence contributors run before opening a PR, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md#checks). This doc is intentionally narrow: it explains
*which tool* does typecheck/lint/format and why, not the day-to-day contributor workflow.
