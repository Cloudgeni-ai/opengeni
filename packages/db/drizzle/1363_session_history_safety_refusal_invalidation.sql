-- deployment-mode: rolling
-- Widens session_history_items_provider_artifact_invalidation_shape_chk so a
-- provider safety refusal can mark the tool results that were new to the
-- refused request ('provider_safety_refusal' on tool result rows). The
-- existing 'encrypted_content_rejected' shape is unchanged, so the previous
-- release keeps writing exactly what it wrote before. NOT VALID, like the
-- constraint it replaces: existing rows already satisfy it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE session_history_items
  DROP CONSTRAINT session_history_items_provider_artifact_invalidation_shape_chk,
  ADD CONSTRAINT session_history_items_provider_artifact_invalidation_shape_chk CHECK (
    (
      provider_artifact_invalidated_at IS NULL
      AND provider_artifact_invalidation_reason IS NULL
      AND provider_artifact_invalidated_by_attempt_id IS NULL
    )
    OR (
      provider_artifact_invalidated_at IS NOT NULL
      AND provider_artifact_invalidation_reason = 'encrypted_content_rejected'
      AND provider_artifact_invalidated_by_attempt_id IS NOT NULL
      AND (item ->> 'type') IN ('reasoning', 'compaction')
    )
    OR (
      provider_artifact_invalidated_at IS NOT NULL
      AND provider_artifact_invalidation_reason = 'provider_safety_refusal'
      AND provider_artifact_invalidated_by_attempt_id IS NOT NULL
      AND (item ->> 'type') IN (
        'function_call_result',
        'function_call_output',
        'custom_tool_call_output',
        'program_output',
        'apply_patch_call_output',
        'computer_call_result',
        'shell_call_output'
      )
    )
  ) NOT VALID;
