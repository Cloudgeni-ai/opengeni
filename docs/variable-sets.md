# Variable Sets (removed)

Variable Sets were replaced by vaults. Existing sets were migrated into vaults
with the same IDs, their values are referenced as `{{secret:…}}` instead of
being injected as environment variables, and the Variable Set routes and
fields now return `variable_sets_removed`.

See [secrets.md](secrets.md), in particular
[Migrating from Variable Sets](secrets.md#migrating-from-variable-sets).
