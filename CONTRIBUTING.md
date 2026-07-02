# Contributing To OpenGeni

Thanks for considering a contribution.

## Development Setup

1. Install Bun and Docker.
2. Copy `.env.example` to `.env`.
3. Fill in the required `OPENGENI_*` values for the workflow you want to test.
4. Start the full local stack:

```bash
bun run dev
```

## Checks

Run the normal PR check before opening a pull request:

```bash
bun run check
```

For quick local iteration, run:

```bash
bun run typecheck
bun test
```

For broader changes that touch persistence, orchestration, sandboxing, or the web/API boundary, also run:

```bash
bun run test:integration
bun run test:e2e
```

## Pull Requests

- Keep changes focused.
- Include tests for behavior changes.
- Update README or docs when setup, public API, configuration, or user-facing behavior changes.
- Do not commit secrets, local `.env` files, generated credentials, or private infrastructure details.

## Keeping Docs True

Use [`docs/README.md`](docs/README.md) as the docs map. If you move or rename files or packages, run `bun run check:docs-refs` and fix the current-tier references it reports. New packages need a package README plus an update to the [`docs/architecture.md`](docs/architecture.md) package table. New embed surfaces or ports belong in [`docs/embedding.md`](docs/embedding.md). New processes or commands belong in their canonical home from the docs map; link there instead of copying volatile details into multiple docs.

## Release / Publishing

Release and publishing guidance starts here; executable truth lives in [`package.json`](package.json) and the workflow files under `.github/workflows/`. When publishable packages change, keep changesets, package manifests, and the release workflow expectations aligned.

Two publish-coherence rules learned the hard way (all versions are 0.x):

- **A minor bump of a package must cascade to its dependents.** Published manifests carry caret ranges (`^0.3.0`), and under 0.x caret semantics a minor bump (0.3.0 → 0.4.0) leaves every dependent's range. Add a patch changeset covering the dependent closure in the same release, or external consumers nest a stale copy of the bumped package.
- **Publish-mode Release runs only on a Version-Packages-PR merge commit.** Any other push to `main` produces a version-mode run that just refreshes the Version PR. To ship a publish, merge the Version PR deliberately and watch that specific run.

## Code Style

- Prefer existing repository patterns over new abstractions.
- Keep public API and contract changes explicit.
- Treat agent activity retries carefully because model calls, sandbox commands, GitHub operations, and cloud-provider actions can be side-effectful.

## Migration Authoring

- Migrations must be schema-agnostic: they run under a caller-selected schema/search path. Use `current_schema()` in policy/guard queries, and never pin OpenGeni tables to `public` or issue `SET search_path` inside a migration.
