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

## Toolchain

Package manager is Bun everywhere (one intentional npm exception for release publishing).
Typecheck runs on the pinned stable TypeScript 7 `tsc`. See
[`docs/toolchain.md`](docs/toolchain.md) for what runs typecheck/lint/format and why.

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
- Keep a reviewable candidate head frozen while CI and review run. Ordinary PRs
  into `main` do not run freeze-head source admission; that check is for
  `hotfix/*` into `production`. If `main` advances, verify mergeability and
  material compatibility; do not merge or rebase unrelated `main` commits into
  the branch solely to make it look current.
- Treat candidate/version labels as substantive source revisions. Base-only
  evidence refreshes stay on the same head. Change the head only for a source
  defect, actual conflict, or material semantic incompatibility.

## Keeping Docs True

Use [`docs/README.md`](docs/README.md) as the docs map. If you move or rename files or packages, run `bun run check:docs-refs` and fix the current-tier references it reports. New packages need a package README plus an update to the [`docs/architecture.md`](docs/architecture.md) package table. New embed surfaces or ports belong in [`docs/embedding.md`](docs/embedding.md). New processes or commands belong in their canonical home from the docs map; link there instead of copying volatile details into multiple docs.

## Release / Publishing

Release and publishing guidance starts here; executable truth lives in [`package.json`](package.json) and the workflow files under `.github/workflows/`. When publishable packages change, keep changesets, package manifests, and the release workflow expectations aligned.

`main` is the daily integration branch. GitHub's default branch stays `main`. `production` is the official source pointer, not a live-cluster deploy. Staging pins already-baked `canary-sha-<commit>` images from a `main` SHA; it does not auto-deploy on merge.

**Promote `main` → `production`:** open a GitHub PR with base `production` and compare `main`. Merge with a **merge commit** (never squash, never GitHub rebase-and-merge: both rewrite SHAs and poison the next promote). The extra merge commit lives only on `production`. The next ship is the same PR shape again. Do not PR `production` back to `main` just because of that merge commit. Do not force-push `production`.

**Hotfix:** PR `hotfix/*` into `production` (freeze-head source admission applies). Then merge `production` → `main` with a merge commit so daily work is not stranded. Squash remains allowed on PRs into `main`.

**Official cut:** dispatch `open-version-pr.yml` on `main` (or set `VERSION_PR_ON_PUSH=true`). Merge the Version PR, promote that SHA to `production`, then `workflow_dispatch` the evidence-bound candidate / acceptance / publication workflows. Do not commit version bumps onto `production`. Official source ancestry is `origin/production`. Bootstrap the pointer once with `git push origin origin/main:refs/heads/production` before the first official cut; that is not a cluster deploy.

**Staging:** dispatch `staging-canary-dispatch.yml` with any `main` SHA whose `canary-sha-*` tags already exist. Pending changesets are allowed. Missing tags fail closed; do not rebuild unsigned `:ci` images.

**Canary npm:** dispatch `publish-canary.yml` to publish `{version}-canary.N` with dist-tag `canary`. This does not consume changeset files or move `latest`.

Two publish-coherence rules learned the hard way (all versions are 0.x):

- **A minor bump of a package must cascade to its dependents.** Published manifests carry caret ranges (`^0.3.0`), and under 0.x caret semantics a minor bump (0.3.0 → 0.4.0) leaves every dependent's range. Add a patch changeset covering the dependent closure in the same release, or external consumers nest a stale copy of the bumped package.
- **Merging a Version PR only creates versioned source; it does not publish.** Obtain the required native pre-merge review (including a human approval for a bot-authored Version PR), merge deliberately, then run the evidence-bound candidate, acceptance, and release workflows for that exact retained source.

## Code Style

- Prefer existing repository patterns over new abstractions.
- Keep public API and contract changes explicit.
- Treat agent activity retries carefully because model calls, sandbox commands, GitHub operations, and cloud-provider actions can be side-effectful.

## Migration Authoring

- Migrations must be schema-agnostic: they run under a caller-selected schema/search path. Use `current_schema()` in policy/guard queries, and never pin OpenGeni tables to `public` or issue `SET search_path` inside a migration.
- `opengeni_app` grant blocks must also be schema-agnostic: use `current_schema()` with dynamic SQL (`EXECUTE format(... %I ...)`) instead of `IN SCHEMA public`, and include default privileges when future tables or sequences must inherit app-role access.
