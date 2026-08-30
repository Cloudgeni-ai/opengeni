# Maintenance release: migration 0382

Migration `0382_governed_apps_persistence.sql` installs the exact FORCE-RLS
tables, capability routines, and private App-host routing projection for
governed OpenGeni Apps. It is maintenance-only because a pre-0382 API or worker
rejects the new protected tables during its runtime-posture startup and
readiness checks.

The same cutover installs durable Apps object-cleanup ownership and the private
transaction capability used by its global FORCE-RLS maintenance routines.
Archive and workspace deletion preserve object keys before cascade, abandoned
uploads become terminal after 24 hours, and provider deletion is delayed for
one 15-minute signed-upload lifetime. After restart, at least one API replica
must have the deployment's object-storage configuration so the bounded cleanup
pump can claim and settle those rows.

Before applying the migration, stop and drain every API, control-plane worker,
and turn worker connected through any configured application database role.
Pass the exact role list through
`OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES`, apply the immutable migration
with the normal owner migration runner, provision the runtime role, and require
the runtime-posture assertion to pass through that restricted role.

Restart only binaries built from schema ordinal 0382 or newer. Never restart a
pre-0382 binary after the migration has committed, and do not attempt a
mixed-version application rollback. Existing `workspace_artifacts` and their
published HTML bytes are independent of this cutover and remain unchanged.
