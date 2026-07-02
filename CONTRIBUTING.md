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

## Code Style

- Prefer existing repository patterns over new abstractions.
- Keep public API and contract changes explicit.
- Treat agent activity retries carefully because model calls, sandbox commands, GitHub operations, and cloud-provider actions can be side-effectful.

## Migration Authoring

- Migrations must be schema-agnostic: they run under a caller-selected schema/search path. Use `current_schema()` in policy/guard queries, and never pin OpenGeni tables to `public` or issue `SET search_path` inside a migration.
