-- deployment-mode: rolling
SET LOCAL lock_timeout = '2s';
-- Historical receipts still retain the opaque workspace IDs, but no longer
-- keep those workspaces alive. Do not hold these locks during other DDL.
ALTER TABLE self_service_organization_setup_receipts
  DROP CONSTRAINT self_service_organization_setup_rece_personal_workspace_id_fkey;
ALTER TABLE additional_organization_creation_receipts
  DROP CONSTRAINT additional_organization_creation_rec_personal_workspace_id_fkey,
  DROP CONSTRAINT additional_organization_creation_recei_shared_workspace_id_fkey;
