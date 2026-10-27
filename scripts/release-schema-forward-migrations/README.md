# Release schema forward migrations

Every new migration under `packages/db/drizzle/` is registered here as a forward
migration: one file per migration, named after it, containing exactly its file
name.

```sh
printf '%s\n' 0999_example_change.sql > scripts/release-schema-forward-migrations/0999_example_change.txt
```

`scripts/release-schema-contract.test.ts` excludes the registered migrations
from the governed host-export checkpoint input, so its pinned aggregate SHA-256
never moves when a migration is added. Registering a migration is a new file,
not an edit to a shared list, so independent migration pull requests do not
conflict with each other. File order carries no meaning; the set is read and
sorted by `scripts/release-schema-forward-registrations.ts`.

`bun run check:migration-schema-contract` (a CI guard) fails on any migration
a head adds without a registration here and prints the exact command.
`bun run migration:renumber` renames the registration together with the
migration. Never pin a fresh `releaseSchemaContractHash` instead: it is stale
the moment another migration merges first.
