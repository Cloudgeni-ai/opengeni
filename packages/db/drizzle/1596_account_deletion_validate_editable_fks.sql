-- deployment-mode: rolling
-- Validation runs in its own transaction with no ACCESS EXCLUSIVE DDL.
SET LOCAL lock_timeout = '5s';
ALTER TABLE editable_artifacts VALIDATE CONSTRAINT editable_artifacts_current_snapshot_fk;
ALTER TABLE editable_artifact_sequence_checkpoints VALIDATE CONSTRAINT editable_artifact_sequence_checkpoints_transaction_fk;
ALTER TABLE organization_user_retention_object_obligations VALIDATE CONSTRAINT organization_user_retention_object_obligations_shape_check;
