-- M3 runtime binding: stamp the frozen rig version onto the group lease so a
-- live shared box conflicts on a rig-version mismatch exactly as it does on an
-- image mismatch (a shared box is one filesystem; a different rig = different
-- setup/tooling baked in). Nullable: a legacy/cold row or a rig-less session
-- reads NULL = "rig unknown", which never conflicts (rig-less sessions share as
-- today). sandbox_leases carries NO row-level security (it is keyed by a bare
-- sandbox_group_id, not an FK — see schema.ts), so this is a bare ADD COLUMN
-- with no policy/grant changes, mirroring the existing `image` column.
ALTER TABLE "sandbox_leases" ADD COLUMN IF NOT EXISTS "rig_version_id" uuid;
