# Maintenance release: migration 0381

Migration `0381_governed_apps_persistence.sql` installs the exact FORCE-RLS
tables, capability routines, and private App-host routing projection for
governed OpenGeni Apps. It is maintenance-only because a pre-0381 API or worker
rejects the new protected tables during its runtime-posture startup and
readiness checks.

Before applying the migration, stop and drain every API, control-plane worker,
and turn worker connected through any configured application database role.
Pass the exact role list through
`OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES`, apply the immutable migration
with the normal owner migration runner, provision the runtime role, and require
the runtime-posture assertion to pass through that restricted role.

Restart only binaries built from schema ordinal 0381 or newer. Never restart a
pre-0381 binary after the migration has committed, and do not attempt a
mixed-version application rollback. Existing `workspace_artifacts` and their
published HTML bytes are independent of this cutover and remain unchanged.
