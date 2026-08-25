# Maintenance release: migration 0345

Migration `0345_tenant_scoped_session_tenancy_fence.sql` replaces the
schema-wide session-tenancy table locks with workspace-scoped advisory fences.
It is a maintenance-only cutover because the migration also installs guards on
all 17 session-tenancy mutation tables. Those guards reject application writes
that do not already hold the canonical workspace fence.

Before applying the migration, stop and drain every API, control-plane, and
turn-worker process that can write session-tenancy state. Apply the immutable
migration with the normal owner migration runner, then verify that PostgreSQL
reports 17 non-internal triggers named `session_tenancy_workspace_fence`.

Restart only binaries built from schema ordinal 0345 or newer. Never restart a
pre-0345 binary after the migration has run: older writers do not enter the
workspace fence and will fail closed. Rolling back only the application binary
is therefore unsupported; recovery requires a coordinated database and runtime
plan under the production maintenance gate.
